import assert from 'node:assert/strict';
import { HistoryReadSuperseded } from '../refresh/history.js';
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer, historicalMessages } from './app-server.js';
import { describeBatch } from './queued-batch.js';
import { RolloutProjectionBuilder } from './rollout-projection.js';
import { SessionFileRebuilds } from '../messages/session-file-rebuild.js';

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-history-shape-'));
  const users = new ConnectorUserStore(':memory:');
  const store = new DeckStore({ sessionTitlesFile: join(dir, 'titles.json') });
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: dir,
    defaultModel: 'synthetic', approvalPolicy: 'never', store, turnQueue: users.turns,
    executions: users.codexExecutions, fileIndex: users.fileIndex, authorizeTurn: () => true });
  const runtime = codex as any, key = 'codex:synthetic';
  runtime.ensureStarted = async () => {}; runtime.setConnection('synthetic-connection');
  store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Known', status: 'unknown' });
  store.addMessage({ id: 'known', sessionKey: key, role: 'assistant', text: 'Known projection', createdAt: 1 });
  t.after(async () => { await codex.close(); users.close(); rmSync(dir, { recursive: true, force: true }); });
  return { codex, runtime, store, users, key, dir };
}

test('historical projection accepts absent native turns without weakening rollout ownership', async () => {
  for (const turns of [undefined, null, {}, []]) {
    assert.deepEqual(await historicalMessages('codex:synthetic', turns), []);
  }
});

test('only full native history reads use the larger default, with explicit deadlines preserved', async t => {
  const f = fixture(t);
  f.runtime.dispatchRequest = async (_method: string, _params: unknown, timeout: number) => timeout;
  assert.equal(await f.runtime.request('thread/read', { includeTurns: true }), 120_000);
  assert.equal(await f.runtime.request('thread/read', { includeTurns: false }), 30_000);
  assert.equal(await f.runtime.request('thread/goal/get', {}), 30_000);
  assert.equal(await f.runtime.request('turn/start', {}), 30_000);
  assert.equal(await f.runtime.request('thread/read', { includeTurns: true }, 75), 75);
  f.runtime.options.requestTimeoutMs = 90;
  assert.equal(await f.runtime.request('thread/read', { includeTurns: true }), 90);
});

for (const mode of ['large', 'expired', 'explicit'] as const) {
  test(`final verification shares one bounded large-history budget (${mode})`, async t => {
    const f = fixture(t);
    f.users.codexExecutions.begin(f.key, 'command', 'synthetic-connection');
    f.users.codexExecutions.acknowledge(f.key, 'command', 'synthetic-connection', 'turn', () => {});
    f.users.codexExecutions.observe(f.key, 'synthetic-connection', 'turn', 'completed');
    f.users.turns.enqueue('codex', { id: 'original-input', sessionKey: f.key, createdAt: 1,
      payload: { text: 'Preserve original queued input', images: [] } });
    const queued = f.users.turns.list('codex', f.key);
    let now = 1, wakes = 0, projects = 0;
    t.mock.method(performance, 'now', () => now);
    if (mode === 'explicit') f.runtime.options.requestTimeoutMs = 100;
    f.runtime.turnWorker.wake = () => { wakes++; };
    f.runtime.request = async (method: string, _params: unknown, timeout: number) => {
      assert.equal(method, 'thread/read');
      assert.equal(timeout, mode === 'explicit' ? 100 : 120_000);
      now += mode === 'large' ? 35_000 : mode === 'expired' ? 120_001 : 101;
      return { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [
        { id: 'turn', status: 'completed', items: [{ id: 'reply', type: 'agentMessage', text: 'Original final response' }] },
      ] } };
    };
    const project = f.runtime.rolloutReader.readProjectedSnapshotWithin.bind(f.runtime.rolloutReader);
    f.runtime.rolloutReader.readProjectedSnapshotWithin = async (...args: any[]) => {
      projects++;
      assert.equal(args[2], 85_000, 'projection receives the remaining budget, not a new deadline');
      const result = await project(...args);
      now += 35_000;
      return result;
    };
    f.runtime.requireBackgroundTerminalsDrained = async () => {};
    f.runtime.reconcileCompletedTurn(f.key, 'synthetic', 100, 'turn');
    await f.runtime.completingTurns.get(f.key);
    assert.deepEqual(f.users.turns.list('codex', f.key), queued, 'verification must never replay or remove queued input');
    assert.equal(f.users.codexExecutions.get(f.key)?.runId, 'turn');
    assert.equal(f.users.codexExecutions.get(f.key)?.commandId, 'command');
    if (mode === 'large') {
      assert.equal(projects, 1);
      assert.equal(f.users.codexExecutions.get(f.key)?.sync, 'current');
      assert.equal(f.codex.isSessionHistoryReady(f.key), true);
      assert.equal(wakes, 1);
    } else {
      assert.equal(projects, 0);
      assert.equal(f.users.codexExecutions.get(f.key)?.sync, 'error');
      assert.equal(f.codex.isSessionHistoryReady(f.key), false);
      assert.equal(wakes, 0);
    }
  });
}

for (const mutation of ['activity', 'connection', 'execution', 'projection', 'closed', 'continuous-activity'] as const) {
  test(`final proof discards a conflicted snapshot and only retries unchanged ownership (${mutation})`, async t => {
    const f = fixture(t);
    f.users.codexExecutions.begin(f.key, 'command', 'synthetic-connection');
    f.users.codexExecutions.acknowledge(f.key, 'command', 'synthetic-connection', 'turn', () => {});
    f.users.codexExecutions.observe(f.key, 'synthetic-connection', 'turn', 'completed');
    let proofs = 0, reads = 0;
    f.runtime.request = async (method: string) => {
      assert.equal(method, 'thread/read'); reads++;
      return { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [
        { id: 'turn', status: 'completed', items: [{ id: 'reply', type: 'agentMessage', text: `Snapshot ${reads}` }] },
      ] } };
    };
    f.runtime.requireBackgroundTerminalsDrained = async (_id: unknown, _turn: unknown, check: () => void) => {
      if (++proofs === 1 || mutation === 'continuous-activity') {
        f.runtime.nativeUnscopedActivityEpoch++;
        if (mutation === 'connection') f.runtime.setConnection('replacement');
        if (mutation === 'execution') f.users.codexExecutions.settleHistory(f.users.codexExecutions.get(f.key)!, 'error');
        if (mutation === 'projection') f.runtime.touchProjection(f.key);
        if (mutation === 'closed') f.runtime.closed = true;
      }
      check();
    };
    f.runtime.reconcileCompletedTurn(f.key, 'synthetic', 100, 'turn');
    await f.runtime.completingTurns.get(f.key);
    if (mutation === 'activity') {
      assert.equal(proofs, 2);
      assert.equal(reads, 2);
      assert.equal(f.users.codexExecutions.get(f.key)?.sync, 'current');
      assert.ok(f.store.getMessages(f.key).some(message => message.text === 'Snapshot 2'));
      assert.ok(!f.store.getMessages(f.key).some(message => message.text === 'Snapshot 1'));
    } else {
      assert.notEqual(f.users.codexExecutions.get(f.key)?.sync, 'current');
      assert.equal(f.store.getMessages(f.key)[0]?.text, 'Known projection');
      assert.equal(reads, mutation === 'continuous-activity' ? 5 : 1);
    }
  });
}

for (const phase of ['completed', 'failed', 'interrupted'] as const) {
  for (const nativeStatus of ['idle', 'notLoaded'] as const) {
    test(`read-only ${phase}/${nativeStatus} history survives failed completion without certifying execution`, async t => {
      const f = fixture(t), file = join(f.dir, 'rollout.jsonl');
      writeFileSync(file, JSON.stringify({ type: 'session_meta' }) + '\n');
      f.users.codexExecutions.begin(f.key, 'command', 'synthetic-connection');
      f.users.codexExecutions.acknowledge(f.key, 'command', 'synthetic-connection', 'turn', () => {});
      f.users.codexExecutions.observe(f.key, 'synthetic-connection', 'turn', phase);
      f.users.codexExecutions.settleHistory(f.users.codexExecutions.get(f.key)!, 'error');
      f.store.upsertSession({ ...f.store.getSession(f.key)!, runtime: {
        turnId: 'turn', phase, sync: 'error', connection: 'connected', lastEventAt: 1,
      } });
      const execution = f.users.codexExecutions.get(f.key), runtime = f.store.getSession(f.key)?.runtime;
      for (const id of ['queued-1', 'queued-2']) f.users.turns.enqueue('codex', {
        id, sessionKey: f.key, createdAt: 5, payload: { text: 'Preserve queued input', images: [] },
      });
      const queue = f.users.turns.list('codex', f.key);
      let reads = 0, wakes = 0;
      f.runtime.turnWorker.wake = () => { wakes++; };
      f.runtime.hydrateGoal = async () => {};
      f.runtime.requireBackgroundTerminalsDrained = async () => { throw Error('Execution proof must not gate read-only display'); };
      f.runtime.request = async (method: string) => {
        assert.equal(method, 'thread/read', 'display must not resume, start, or cancel work'); reads++;
        return { thread: { id: 'synthetic', path: file, status: { type: nativeStatus }, turns: [
          { id: 'turn', status: phase, items: [{ id: 'reply', type: 'agentMessage', text: 'Readable protected reply' }] },
        ] } };
      };
      // A final-history owner has failed. A joining browser must start its own
      // guarded display hydration; lifecycle callers must still reject it.
      const completion = new Promise<void>(resolve => setImmediate(() => {
        f.runtime.completingTurns.delete(f.key); resolve();
      }));
      f.runtime.completingTurns.set(f.key, completion);
      const options = { readOnly: true, maxAgeMs: 1500 };
      await f.codex.refreshSession(f.key, options);
      assert.equal(f.codex.isSessionHistoryReady(f.key), true);
      assert.ok(f.store.getMessages(f.key).some(message => message.text === 'Readable protected reply'));
      const cached = f.runtime.threadRefreshResult.get(f.key);
      assert.ok(cached.display, 'fenced display should retain an exact, source-validated cache');
      cached.at -= 10_000;
      await f.codex.refreshSession(f.key, options);
      assert.equal(reads, 1, 'warm display must not replay the full native transcript');
      assert.deepEqual(f.users.codexExecutions.get(f.key), execution);
      assert.deepEqual(f.store.getSession(f.key)?.runtime, runtime);
      assert.deepEqual(f.users.turns.list('codex', f.key), queue);
      assert.equal(f.users.codexExecutions.canStart(f.key), false);
      assert.equal(wakes, 0);
      appendFileSync(file, JSON.stringify({ type: 'session_meta' }) + '\n');
      await f.codex.refreshSession(f.key, options);
      assert.equal(reads, 2, 'source change requires a new native snapshot');
      if (nativeStatus === 'idle')
        await assert.rejects(f.codex.refreshSession(f.key, { fresh: true }), /Execution proof/);
      else await f.codex.refreshSession(f.key, { fresh: true });
      assert.equal(reads, 3, 'lifecycle reads cannot reuse a display-only snapshot');
    });
  }
}

for (const nativeStatus of ['idle', 'notLoaded'] as const) for (const change of ['none', 'append', 'replace', 'delete', 'projection', 'connection', 'execution', 'fresh', 'lifecycle',
  'validation-projection', 'validation-connection', 'validation-execution', 'validation-failure', 'validation-close'] as const) {
  test(`unchanged ${nativeStatus} display avoids full native replay without widening execution freshness (${change})`, async t => {
    const f = fixture(t), file = join(f.dir, 'rollout.jsonl');
    writeFileSync(file, JSON.stringify({ type: 'session_meta' }) + '\n');
    let nativeReads = 0;
    f.runtime.request = async (method: string) => {
      assert.equal(method, 'thread/read'); nativeReads++;
      return { thread: { id: 'synthetic', path: file, status: { type: nativeStatus }, turns: [
        { id: 'turn', status: 'completed', items: [{ id: 'reply', type: 'agentMessage', text: 'Prepared reply' }] },
      ] } };
    };
    f.runtime.requireBackgroundTerminalsDrained = async (_id: unknown, _turn: unknown, check: () => void) => check();
    f.runtime.hydrateGoal = async () => {};
    const options = { maxAgeMs: 1500, readOnly: true };
    await f.codex.refreshSession(f.key, options);
    assert.equal(nativeReads, 1);
    const original = f.runtime.threadRefreshResult.get(f.key);
    assert.ok(original.display);
    original.at -= 10_000;
    const originalAt = original.at;
    if (change === 'append') appendFileSync(file, JSON.stringify({ type: 'session_meta' }) + '\n');
    if (change === 'replace') { renameSync(file, `${file}.old`); writeFileSync(file, JSON.stringify({ type: 'session_meta' }) + '\n'); }
    if (change === 'delete') rmSync(file);
    if (change === 'projection') f.runtime.touchProjection(f.key);
    if (change === 'connection') f.runtime.setConnection('replacement');
    if (change === 'execution') f.users.codexExecutions.begin(f.key, 'new-command', 'synthetic-connection');
    if (change.startsWith('validation-')) {
      const validate = f.runtime.rolloutReader.sourceUnchanged.bind(f.runtime.rolloutReader);
      f.runtime.rolloutReader.sourceUnchanged = async (...args: unknown[]) => {
        const result = await validate(...args);
        if (change === 'validation-projection') f.runtime.touchProjection(f.key);
        if (change === 'validation-connection') f.runtime.setConnection('replacement');
        if (change === 'validation-execution') f.users.codexExecutions.begin(f.key, 'new-command', 'synthetic-connection');
        if (change === 'validation-failure') throw Error('Source validation unavailable');
        if (change === 'validation-close') f.runtime.closed = true;
        return result;
      };
    }
    const read = f.codex.refreshSession(f.key, change === 'fresh' ? { ...options, fresh: true }
      : change === 'lifecycle' ? { maxAgeMs: 1500 } : options);
    if (['delete', 'validation-projection', 'validation-connection', 'validation-execution', 'validation-failure', 'validation-close'].includes(change)) await assert.rejects(read);
    else await read;
    assert.equal(nativeReads, ['none', 'validation-failure', 'validation-close'].includes(change) ? 1 : 2);
    if (change === 'none') {
      assert.equal(f.runtime.threadRefreshResult.get(f.key), original);
      assert.equal(original.at, originalAt);
      assert.equal(f.codex.isSessionHistoryReady(f.key), true);
      await f.codex.refreshSession(f.key, { maxAgeMs: 1500 });
      assert.equal(nativeReads, 2);
    }
  });
}

for (const change of ['none', 'connection', 'execution', 'projection', 'closed', 'read-failure'] as const) {
  test(`original hydration rechecks guards after async storage preparation (${change})`, async t => {
    const f = fixture(t), before = f.store.getMessages(f.key);
    const builder = new RolloutProjectionBuilder(0), projection = await builder.finish();
    f.runtime.rolloutReader.readSnapshot = async () => projection;
    f.runtime.requireBackgroundTerminalsDrained = async (_id: unknown, _turn: unknown, check: () => void) => check();
    const methods: string[] = [];
    f.runtime.request = async (method: string) => {
      methods.push(method); assert.equal(method, 'thread/read');
      return { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [
        { id: 'turn', status: 'completed', items: [{ id: 'reply', type: 'agentMessage', text: 'Prepared reply' }] },
      ] } };
    };
    let reads = 0;
    f.runtime.options.historyReader = { close: async () => {}, prepare: async (key: string, messages: any[]) => {
      reads++;
      const plan = f.runtime.prepareHistorySync(key, messages);
      await Promise.resolve();
      assert.deepEqual(f.store.getMessages(f.key), before, 'no publication before the read settles');
      if (change === 'connection') f.runtime.setConnection('replacement');
      if (change === 'execution') f.users.codexExecutions.begin(f.key, 'new-command', 'synthetic-connection');
      if (change === 'projection') f.runtime.touchProjection(f.key);
      if (change === 'closed') f.runtime.closed = true;
      if (change === 'read-failure') throw Error('storage unavailable');
      return plan;
    } };
    if (change === 'none') {
      await f.codex.refreshSession(f.key);
      assert.ok(f.store.getMessages(f.key).some(message => message.text === 'Prepared reply'));
    } else {
      await assert.rejects(f.codex.refreshSession(f.key));
      assert.deepEqual(f.store.getMessages(f.key), before);
    }
    assert.equal(reads, 1); assert.deepEqual(methods, ['thread/read']);
  });
}

test('normal Codex hydration indexes older files once; file pagination never scans rollout or tool bodies', async t => {
  const f = fixture(t);
  const builder = new RolloutProjectionBuilder(0);
  await builder.add(JSON.stringify({ type: 'session_meta' }) + '\n');
  const projection = await builder.finish();
  let snapshots = 0, scans = 0, rpc = 0;
  const iterate = projection[Symbol.asyncIterator].bind(projection);
  projection[Symbol.asyncIterator] = async function* () { scans++; yield* iterate(); };
  f.runtime.rolloutReader.readSnapshot = async () => { snapshots++; return projection; };
  f.runtime.requireBackgroundTerminalsDrained = async (_id: string, _turn: unknown, check: () => void) => check();
  f.runtime.request = async (method: string) => {
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    assert.equal(method, 'thread/read'); rpc++;
    return { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [{ id: 'turn', status: 'completed', items:
      Array.from({ length: 250 }, (_, i) => ({ id: `change-${i}`, type: 'fileChange', status: 'completed', changes: [{ path: `/repo/${i}.ts`, kind: { type: 'update' }, diff: 'private tool diff' }] })) }] } };
  };
  await f.codex.refreshSession(f.key, { readOnly: true });
  assert.equal(snapshots, 1); assert.equal(scans, 1); assert.equal(rpc, 1);
  let cursor: string | undefined, total = 0;
  do {
    const page = f.users.fileIndex.page(f.key, cursor);
    assert.equal(page.source, 'verified-projection'); assert.equal(page.coverage, 'partial');
    assert.ok(!JSON.stringify(page).includes('private tool diff'));
    total += page.entries.length; cursor = page.nextCursor;
  } while (cursor);
  assert.equal(total, 250, 'index is independent of latest 200 displayed messages');
  let clock = 0;
  const jobs = new SessionFileRebuilds(f.users.fileIndex, key => f.users.fileIndex.projectionBinding(key),
    (key, before) => f.users.fileIndex.projectionEvidencePage(key, before), () => clock, () => 'verified-projection');
  let progress = jobs.start(f.key, 'fixture');
  while (progress.state === 'scanning') { clock += 251; progress = jobs.step(f.key, 'fixture', progress.id, progress.step); }
  assert.equal(progress.state, 'completed'); assert.equal(progress.found, 250);
  assert.equal(f.users.fileIndex.page(f.key).source, 'verified-projection');
  assert.equal(snapshots, 1); assert.equal(scans, 1); assert.equal(rpc, 1);
});

for (const change of ['none', 'override', 'obsolete'] as const) test(`refresh consumes combined facts once and preserves post-await fences (${change})`, async t => {
  const f = fixture(t);
  const builder = new RolloutProjectionBuilder(0);
  for (const entry of [{ type: 'session_meta' }, { type: 'turn_context', payload: { model: 'persisted' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 42 }, model_context_window: 32000 } } }]) {
    await builder.add(JSON.stringify(entry) + '\n');
  }
  const projection = await builder.finish();
  t.after(() => projection.dispose());
  let scans = 0, proofs = 0;
  const iterate = projection[Symbol.asyncIterator].bind(projection);
  projection[Symbol.asyncIterator] = async function* () { scans++; yield* iterate(); };
  f.runtime.rolloutReader.readSnapshot = async () => projection;
  f.runtime.request = async (method: string) => {
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    assert.equal(method, 'thread/read', 'No resume or message dispatch');
    return { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [
      { id: 'turn', status: 'completed', items: [{ id: 'reply', type: 'agentMessage', text: 'Projected reply' }] },
    ] } };
  };
  f.runtime.requireBackgroundTerminalsDrained = async (_thread: string, _turn: unknown, check: () => void, source: unknown) => {
    proofs++; assert.equal(source, projection); check();
    assert.equal(f.store.getSession(f.key)?.contextUsedTokens, undefined, 'Facts cannot apply before cleanup proof');
    if (change === 'override') f.runtime.threadModelOverrides.set('synthetic', 'selected-during-proof');
    if (change === 'obsolete') f.runtime.connectionId = 'replaced-connection';
  };
  if (change === 'obsolete') {
    await assert.rejects(f.codex.refreshSession(f.key), /snapshot obsolete/);
    assert.equal(f.store.getSession(f.key)?.model, undefined);
    assert.equal(f.store.getSession(f.key)?.contextUsedTokens, undefined);
    assert.equal(f.store.getMessages(f.key)[0]?.text, 'Known projection');
  } else {
    await f.codex.refreshSession(f.key);
    assert.equal(f.store.getSession(f.key)?.model, change === 'override' ? 'selected-during-proof' : 'persisted');
    assert.equal(f.store.getSession(f.key)?.contextUsedTokens, 42);
    assert.equal(f.store.getSession(f.key)?.contextTokens, 32000);
    assert.equal(f.store.getSession(f.key)?.compactionCount, 0);
    assert.ok(f.store.getMessages(f.key).some(m => m.text === 'Projected reply'));
    assert.equal(f.codex.isSessionHistoryReady(f.key), true);
  }
  assert.equal(scans, 1, 'No model or usage rescan in production refresh');
  assert.equal(proofs, 1, 'Execution safety remains a separate required step');
});

for (const collision of ['user', 'assistant', 'other-turn'] as const) test(`streaming history validates native batch before overlaying stale ${collision} projection`, async t => {
  const f = fixture(t);
  const entries = ['first', 'second'].map((id, index) => ({ id, sessionKey: f.key, state: 'queued' as const,
    createdAt: index + 1, payload: { text: id, images: [] } }));
  const batch = describeBatch(entries)!;
  f.users.codexExecutions.begin(f.key, 'first', 'synthetic-connection', false, batch);
  f.users.codexExecutions.acknowledge(f.key, 'first', 'synthetic-connection', 'batch-turn', () => {});
  f.users.codexExecutions.observe(f.key, 'synthetic-connection', 'batch-turn', 'completed');
  f.users.codexExecutions.settleHistory(f.users.codexExecutions.get(f.key)!, 'current');
  f.runtime.activeTurnIds.set(f.key, 'turn');
  // Keep a managed current turn, independent of the completed batch above.
  f.users.codexExecutions.begin(f.key, 'current', 'synthetic-connection');
  f.users.codexExecutions.acknowledge(f.key, 'current', 'synthetic-connection', 'turn', () => {});
  f.store.upsertSession({ ...f.store.getSession(f.key)!, runtime: {
    turnId: 'turn', phase: 'running', sync: 'current', connection: 'connected', lastEventAt: 1,
  } });
  f.store.addMessage({ id: `${f.key}:codex-input`, sessionKey: f.key,
    turnId: collision === 'other-turn' ? 'wrong-turn' : 'batch-turn',
    role: collision === 'assistant' ? 'assistant' : 'user', text: 'Stale positional item', createdAt: 3 });
  f.runtime.request = async () => {
    f.runtime.handleNotification('item/agentMessage/delta', { threadId: 'synthetic', turnId: 'turn', itemId: 'reply', delta: 'Live reply' });
    return { thread: { id: 'synthetic', status: { type: 'active' }, turns: [
      { id: 'batch-turn', status: 'completed', items: [{ id: 'input', type: 'userMessage',
        content: [{ type: 'text', text: entries.map(e => e.payload.text).join(batch.separator) }] }] },
      { id: 'turn', status: 'inProgress', items: [{ id: 'reply', type: 'agentMessage', text: 'Old reply' }] },
    ] } };
  };
  await f.codex.refreshSession(f.key);
  assert.equal(f.codex.isSessionHistoryReady(f.key), true);
  const users = f.store.getMessages(f.key).filter(m => m.role === 'user' && m.turnId === 'batch-turn');
  assert.deepEqual(users.map(m => [m.id, m.text]), [['first', 'first'], ['second', 'second']]);
  assert.ok(f.store.getMessages(f.key).some(m => m.text === 'Live reply'));
  assert.equal(f.users.codexExecutions.get(f.key)?.runId, 'turn');
  assert.equal(f.users.turns.list('codex', f.key).length, 0);
});

for (const copies of [0, 2]) test(`live cache cannot conceal ${copies} native batch matches or release queued input`, async t => {
  const f = fixture(t);
  const entries = ['first', 'second'].map((id, index) => ({ id, sessionKey: f.key, state: 'queued' as const,
    createdAt: index + 1, payload: { text: id, images: [] } }));
  const batch = describeBatch(entries)!;
  const input = entries.map(e => e.payload.text).join(batch.separator);
  f.users.codexExecutions.begin(f.key, 'first', 'synthetic-connection', false, batch);
  f.users.codexExecutions.acknowledge(f.key, 'first', 'synthetic-connection', 'turn', () => {});
  f.users.turns.enqueue('codex', { id: 'pending', sessionKey: f.key, createdAt: 5, payload: { text: 'Keep waiting', images: [] } });
  f.store.upsertSession({ ...f.store.getSession(f.key)!, runtime: {
    turnId: 'turn', phase: 'running', sync: 'current', connection: 'connected', lastEventAt: 1,
  } });
  f.store.addMessage({ id: `${f.key}:codex-input`, sessionKey: f.key, turnId: 'turn', role: 'user', text: input, createdAt: 3 });
  f.runtime.request = async (method: string) => {
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    assert.equal(method, 'thread/read', 'No dispatch, resume or replay is permitted');
    f.runtime.handleNotification('item/agentMessage/delta', { threadId: 'synthetic', turnId: 'turn', itemId: 'reply', delta: 'Live reply' });
    return { thread: { id: 'synthetic', status: { type: 'active' }, turns: [
      { id: 'turn', status: 'inProgress', items: [
        { id: 'input', type: 'userMessage', content: [{ type: 'text', text: copies ? input : 'Missing boundary' }] },
        ...(copies === 2 ? [{ id: 'duplicate', type: 'userMessage', content: [{ type: 'text', text: input }] }] : []),
        { id: 'reply', type: 'agentMessage', text: 'Old reply' },
      ] },
    ] } };
  };
  await assert.rejects(f.codex.refreshSession(f.key), new RegExp(`Native batch history identity.*matches=${copies}`));
  assert.equal(f.codex.isSessionHistoryReady(f.key), false);
  assert.deepEqual(f.users.turns.list('codex', f.key).map(e => [e.id, e.state]), [['pending', 'queued']]);
  assert.equal(f.store.getMessages(f.key).find(m => m.id === `${f.key}:codex-input`)?.text, input);
});

test('expanded batch identity collision cannot remove existing projection or pending input', t => {
  const f = fixture(t);
  const entries = ['first', 'second'].map((id, index) => ({ id, sessionKey: f.key, state: 'queued' as const,
    createdAt: index + 1, payload: { text: id, images: [] } }));
  const batch = describeBatch(entries)!;
  f.users.codexExecutions.begin(f.key, 'first', 'synthetic-connection', false, batch);
  f.users.codexExecutions.acknowledge(f.key, 'first', 'synthetic-connection', 'turn', () => {});
  f.users.turns.enqueue('codex', { id: 'pending', sessionKey: f.key, createdAt: 5, payload: { text: 'Keep waiting', images: [] } });
  f.store.addMessage({ id: 'envelope', sessionKey: f.key, role: 'user', text: 'Prior input', createdAt: 1 });
  const previous = f.store.getMessages(f.key);
  assert.throws(() => f.runtime.replaceHistory(f.key, [
    { id: 'envelope', sessionKey: f.key, turnId: 'turn', role: 'user', text: entries.map(e => e.payload.text).join(batch.separator), createdAt: 1 },
    { id: 'second', sessionKey: f.key, turnId: 'turn', role: 'assistant', text: 'Conflicting identity', createdAt: 2 },
  ], false), /Invalid Codex expanded history message identity/);
  assert.deepEqual(f.store.getMessages(f.key), previous);
  assert.deepEqual(f.users.turns.list('codex', f.key).map(e => [e.id, e.state]), [['pending', 'queued']]);
});

for (const fail of [false, true]) test(`page refresh joins final synchronization without duplicate reads (failure=${fail})`, async t => {
  const f = fixture(t);
  let reads = 0, release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.runtime.request = async (method: string) => {
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    assert.equal(method, 'thread/read');
    reads++; entered(); await gate;
    if (fail) throw new Error('Final read failed');
    return { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [
      { id: 'turn', status: 'completed', items: [{ id: 'reply', type: 'agentMessage', text: 'Latest final response' }] },
    ] } };
  };
  f.runtime.reconcileCompletedTurn(f.key, 'synthetic', 10);
  await started;
  let settled = false;
  const refreshing = f.codex.refreshSession(f.key).finally(() => { settled = true; });
  const checked = fail ? assert.rejects(refreshing, /final history unavailable/) : refreshing;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  assert.equal(settled, false);
  release(); await checked;
  assert.equal(f.codex.isSessionHistoryReady(f.key), !fail);
  assert.equal(reads, fail ? 5 : 1, 'refresh joins the same bounded final-read retry sequence');
  if (!fail) assert.ok(f.store.getMessages(f.key).some(m => m.text === 'Latest final response'));
});

test('an obsolete page read cannot invalidate newer terminal history', async t => {
  const f = fixture(t);
  let release!: () => void, entered!: () => void, reads = 0;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.runtime.request = async (method: string) => {
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    assert.equal(method, 'thread/read');
    if (++reads === 1) { entered(); await gate; throw new Error('Old read failed'); }
    return { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [
      { id: 'turn', status: 'completed', items: [{ id: 'reply', type: 'agentMessage', text: 'Final history' }] },
    ] } };
  };
  const checked = assert.rejects(f.codex.refreshSession(f.key), /Old read failed/);
  await started;
  f.runtime.reconcileCompletedTurn(f.key, 'synthetic', 10);
  await f.runtime.completingTurns.get(f.key);
  release(); await checked;
  assert.equal(f.codex.isSessionHistoryReady(f.key), true);
  assert.ok(f.store.getMessages(f.key).some(m => m.text === 'Final history'));
  await f.codex.refreshSession(f.key, { maxAgeMs: 1_500, readOnly: true });
  assert.equal(reads, 2);
});

for (const managed of [false, true]) test(`history hydrates during same-turn streaming without overwriting newer live text (managed=${managed})`, async t => {
  const f = fixture(t);
  if (managed) {
    f.users.codexExecutions.begin(f.key, 'command', 'synthetic-connection');
    f.users.codexExecutions.acknowledge(f.key, 'command', 'synthetic-connection', 'turn', () => {});
  } else f.runtime.activeTurnIds.set(f.key, 'turn');
  f.store.upsertSession({ ...f.store.getSession(f.key)!, runtime: {
    turnId: 'turn', phase: 'running', sync: 'current', connection: 'connected', lastEventAt: 1,
  } });
  f.runtime.request = async () => {
    f.runtime.handleNotification('item/agentMessage/delta', { threadId: 'synthetic', turnId: 'turn', itemId: 'reply', delta: 'New live text' });
    f.runtime.handleNotification('item/agentMessage/delta', { threadId: 'synthetic', turnId: 'turn', itemId: 'new-item', delta: 'Not yet in snapshot' });
    return { thread: { id: 'synthetic', status: { type: 'active' }, turns: [
      { id: 'older', status: 'completed', items: [{ id: 'old-reply', type: 'agentMessage', text: 'Earlier history' }] },
      { id: 'turn', status: 'inProgress', items: [{ id: 'reply', type: 'agentMessage', text: 'Stale snapshot' }] },
    ] } };
  };
  await f.codex.refreshSession(f.key);
  assert.equal(f.codex.isSessionHistoryReady(f.key), true);
  const text = f.store.getMessages(f.key).map(m => m.text);
  assert.ok(text.includes('Earlier history'));
  assert.ok(text.includes('New live text'));
  assert.ok(text.includes('Not yet in snapshot'));
  assert.ok(!text.includes('Stale snapshot'));
  assert.equal(f.store.getSession(f.key)?.runtime?.phase, 'running');
});

for (const managed of [false, true]) test(`read-only live history reuses hydrated deltas with bounded reconciliation (managed=${managed})`, async t => {
  const f = fixture(t);
  if (managed) {
    f.users.codexExecutions.begin(f.key, 'command', 'synthetic-connection');
    f.users.codexExecutions.acknowledge(f.key, 'command', 'synthetic-connection', 'turn', () => {});
  } else f.runtime.activeTurnIds.set(f.key, 'turn');
  f.store.upsertSession({ ...f.store.getSession(f.key)!, runtime: {
    turnId: 'turn', phase: 'running', sync: 'current', connection: 'connected', lastEventAt: 1,
  } });
  let reads = 0;
  f.runtime.request = async () => {
    reads++;
    return { thread: { id: 'synthetic', status: { type: 'active' }, turns: [
      { id: 'turn', status: 'inProgress', items: [{ id: 'reply', type: 'agentMessage', text: 'Snapshot' }] },
    ] } };
  };
  const options = { maxAgeMs: 1_500, readOnly: true };
  const historyRequest = f.runtime.request;
  let goalReads = 0;
  f.runtime.request = async (method: string, ...args: unknown[]) => {
    if (method === 'thread/goal/get') { goalReads++; return { goal: null }; }
    return historyRequest(method, ...args);
  };
  await f.codex.refreshSession(f.key, options);
  assert.equal(reads, 1, 'Cold reads always hydrate');
  f.runtime.threadRefreshResult.get(f.key).at -= 2_000;
  const hydratedAt = f.runtime.threadRefreshResult.get(f.key).at;
  for (let i = 0; i < 20; i++) {
    f.runtime.handleNotification('thread/status/changed', { threadId: 'synthetic', status: { type: 'active' } });
    f.runtime.handleNotification('item/agentMessage/delta', { threadId: 'synthetic', turnId: 'turn', itemId: 'reply', delta: ' live' });
    await f.codex.refreshSession(f.key, options);
  }
  assert.equal(reads, 1, 'Polling does not reread all native turns');
  assert.equal(f.runtime.threadRefreshResult.get(f.key).at, hydratedAt, 'Deltas never postpone reconciliation');
  assert.ok(f.store.getMessages(f.key).some(m => m.text.includes('live')));
  f.runtime.threadRefreshResult.get(f.key).at -= 30_000;
  await f.codex.refreshSession(f.key, options);
  assert.equal(reads, 2, 'Periodic reconciliation remains mandatory');
  await f.codex.refreshSession(f.key, { ...options, fresh: true });
  assert.equal(reads, 3, 'Explicit fresh bypasses both caches');
  await f.codex.refreshSession(f.key);
  assert.equal(reads, 4, 'Lifecycle reads do not use the browser-only cache');
  assert.equal(goalReads, 2, 'Goal metadata reads once at open and once at explicit fresh, never on each history poll');
});

test('read-only completed history avoids repeated full reads within a bounded window', async t => {
  const fixtureResult = fixture(t);
  let reads = 0;
  fixtureResult.runtime.request = async (method: string) => {
    if (method === 'thread/goal/get') return { goal: null };
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    assert.equal(method, 'thread/read');
    reads++;
    return { thread: { id: 'synthetic', status: { type: 'idle' }, turns: [
      { id: 'turn', status: 'completed', items: [{ id: 'reply', type: 'agentMessage', text: 'Final reply' }] },
    ] } };
  };
  const options = { maxAgeMs: 1_500, readOnly: true };
  await fixtureResult.codex.refreshSession(fixtureResult.key, options);
  fixtureResult.runtime.threadRefreshResult.get(fixtureResult.key).at -= 2_000;
  for (let poll = 0; poll < 5; poll++) await fixtureResult.codex.refreshSession(fixtureResult.key, options);
  assert.equal(reads, 1);
  fixtureResult.runtime.threadRefreshResult.get(fixtureResult.key).at -= 30_000;
  await fixtureResult.codex.refreshSession(fixtureResult.key, options);
  assert.equal(reads, 2);
  await fixtureResult.codex.refreshSession(fixtureResult.key, { ...options, fresh: true });
  assert.equal(reads, 3);
  await fixtureResult.codex.refreshSession(fixtureResult.key);
  assert.equal(reads, 4);
});

for (const change of ['turn', 'connection', 'sync', 'phase', 'execution', 'projection', 'unavailable', 'invalidation'] as const) {
  test(`completed read cache cannot conceal changed ${change}`, async testContext => {
    const fixtureResult = fixture(testContext);
    const runtime = { turnId: 'turn', phase: 'completed', sync: 'current', connection: 'connected', lastEventAt: 1 };
    fixtureResult.store.upsertSession({ ...fixtureResult.store.getSession(fixtureResult.key)!, runtime: runtime as any });
    fixtureResult.runtime.threadRefreshResult.set(fixtureResult.key, { at: Date.now() - 2_000, available: true,
      terminalIdentity: fixtureResult.runtime.terminalReadIdentity(fixtureResult.key) });
    if (change === 'turn') runtime.turnId = 'different';
    if (change === 'connection') fixtureResult.runtime.setConnection('replacement');
    if (change === 'sync') runtime.sync = 'error';
    if (change === 'phase') runtime.phase = 'running';
    if (change === 'execution') fixtureResult.users.codexExecutions.begin(fixtureResult.key, 'new-command', 'synthetic-connection');
    if (change === 'projection') fixtureResult.runtime.projectionVersions.set(fixtureResult.key, fixtureResult.runtime.projectionVersion(fixtureResult.key) + 1);
    if (change === 'unavailable') fixtureResult.runtime.executionUnavailable = true;
    if (change === 'invalidation') fixtureResult.runtime.threadRefreshResult.delete(fixtureResult.key);
    fixtureResult.store.upsertSession({ ...fixtureResult.store.getSession(fixtureResult.key)!, runtime: runtime as any });
    fixtureResult.runtime.request = async () => { throw new Error('Native recheck required'); };
    await assert.rejects(fixtureResult.codex.refreshSession(fixtureResult.key, { maxAgeMs: 1_500, readOnly: true }), /Native recheck required/);
  });
}

for (const change of ['turn', 'connection', 'sync', 'phase', 'ownership', 'unavailable'] as const) test(`live read cache cannot conceal changed ${change}`, async t => {
  const f = fixture(t);
  f.runtime.activeTurnIds.set(f.key, 'turn');
  const runtime = { turnId: 'turn', phase: 'running', sync: 'current', connection: 'connected', lastEventAt: 1 };
  if (change === 'turn') runtime.turnId = 'different';
  if (change === 'connection') runtime.connection = 'disconnected';
  if (change === 'sync') runtime.sync = 'error';
  if (change === 'phase') runtime.phase = 'finalizing';
  if (change === 'ownership') f.runtime.activeTurnIds.delete(f.key);
  if (change === 'unavailable') f.runtime.executionUnavailable = true;
  f.store.upsertSession({ ...f.store.getSession(f.key)!, runtime: runtime as any });
  f.runtime.threadRefreshResult.set(f.key, { at: Date.now() - 2_000, available: true, liveTurnId: 'turn' });
  f.runtime.request = async () => { throw new Error('Native recheck required'); };
  await assert.rejects(f.codex.refreshSession(f.key, { maxAgeMs: 1_500, readOnly: true }), /Native recheck required/);
  assert.equal(f.runtime.threadRefreshResult.get(f.key)?.available, false);
});

for (const change of ['unavailable', 'connection', 'generation', 'closed'] as const) {
  test(`failed history read retains only a same-connection negative cache (${change})`, async t => {
    const f = fixture(t);
    const messages = f.store.getMessages(f.key);
    const methods: string[] = [];
    f.runtime.request = async (method: string) => {
      methods.push(method);
      if (change === 'unavailable') f.runtime.executionUnavailable = true;
      if (change === 'connection') f.runtime.setConnection('replacement');
      if (change === 'generation') f.runtime.nativeConnectionGeneration++;
      if (change === 'closed') f.runtime.closed = true;
      throw new Error('Synthetic unavailable read');
    };
    await assert.rejects(f.codex.refreshSession(f.key), {name: 'Error',
      message: change === 'closed' ? 'Codex App Server closed' : 'Synthetic unavailable read'});
    assert.deepEqual(methods, ['thread/read'], 'failed history read must not replay native work');
    assert.equal(f.runtime.threadRefreshResult.get(f.key)?.available, change === 'unavailable' ? false : undefined);
    assert.deepEqual(f.store.getMessages(f.key), messages);
    assert.equal(f.codex.isSessionHistoryReady(f.key), false);
  });
}

for (const change of ['turn', 'connection', 'sync', 'phase'] as const) test(`streaming history does not certify changed ${change}`, async t => {
  const f = fixture(t);
  f.runtime.activeTurnIds.set(f.key, 'turn');
  f.store.upsertSession({ ...f.store.getSession(f.key)!, runtime: {
    turnId: 'turn', phase: 'running', sync: 'current', connection: 'connected', lastEventAt: 1,
  } });
  f.runtime.request = async () => {
    f.runtime.touchProjection(f.key);
    const runtime = { ...f.store.getSession(f.key)!.runtime! };
    if (change === 'turn') runtime.turnId = 'successor';
    if (change === 'connection') runtime.connection = 'disconnected';
    if (change === 'sync') runtime.sync = 'error';
    if (change === 'phase') runtime.phase = 'finalizing';
    f.store.upsertSession({ ...f.store.getSession(f.key)!, runtime });
    return { thread: { id: 'synthetic', turns: [{ id: 'turn', status: 'inProgress', items: [] }] } };
  };
  await assert.rejects(f.codex.refreshSession(f.key), error => {
    assert.match((error as Error).message, /snapshot obsolete/);
    assert.equal(error instanceof HistoryReadSuperseded, change === 'turn' || change === 'phase');
    return true;
  });
  assert.equal(f.codex.isSessionHistoryReady(f.key), false);
});

for (const invalid of ['missing-id', 'wrong-id', 'invalid-turns', 'null-turn', 'missing-items', 'invalid-items', 'null-item', 'array-item'] as const) {
  test(`terminal reconciliation without a local execution rejects ${invalid} and can recover`, async t => {
    const f = fixture(t);
    const turn: any = { id: 'turn', status: 'completed', items: [] }, thread: any = { id: 'synthetic', turns: [turn] };
    if (invalid === 'missing-id') delete thread.id;
    if (invalid === 'wrong-id') thread.id = 'other-session';
    if (invalid === 'invalid-turns') thread.turns = {};
    if (invalid === 'null-turn') thread.turns = [null];
    if (invalid === 'missing-items') delete turn.items;
    if (invalid === 'invalid-items') turn.items = {};
    if (invalid === 'null-item') turn.items = [null];
    if (invalid === 'array-item') turn.items = [[]];
    f.runtime.request = async (method: string) => { assert.equal(method, 'thread/read'); return { thread }; };
    f.runtime.reconcileCompletedTurn(f.key, 'synthetic', 100);
    await f.runtime.completingTurns.get(f.key);
    assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'error');
    assert.equal(f.store.getMessages(f.key)[0]?.text, 'Known projection');
    assert.equal(f.codex.isSessionHistoryReady(f.key), false);
    assert.equal(f.users.codexExecutions.get(f.key), undefined);
    f.runtime.request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: 'synthetic', turns: [{ id: 'turn', status: 'completed', items: [] }] } });
    f.runtime.reconcileCompletedTurn(f.key, 'synthetic', 100);
    await f.runtime.completingTurns.get(f.key);
    assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'current');
    assert.equal(f.codex.isSessionHistoryReady(f.key), true);
  });
}

test('a failed final history read cannot reuse an earlier successful history cache', async t => {
  const f = fixture(t);
  f.runtime.request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: 'synthetic', turns: [] } });
  await f.codex.refreshSession(f.key);
  assert.equal(f.codex.isSessionHistoryReady(f.key), true);
  f.runtime.request = async () => { throw new Error('Synthetic final read failure'); };
  f.runtime.reconcileCompletedTurn(f.key, 'synthetic', 100);
  await f.runtime.completingTurns.get(f.key);
  assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'error');
  assert.equal(f.codex.isSessionHistoryReady(f.key), false);
  await assert.rejects(f.codex.refreshSession(f.key, { maxAgeMs: 60_000 }), /Synthetic final read failure/);
});

test('history accepts unknown item kinds without inventing messages or rejecting compatible extensions', async t => {
  const f = fixture(t);
  f.runtime.request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: 'synthetic', turns: [{ id: 'turn', status: 'completed',
    items: [{ id: 'extension', type: 'futureKind', extra: {} }, { id: 'reply', type: 'agentMessage', text: 'Valid reply' }] }] } });
  await f.codex.refreshSession(f.key);
  assert.equal(f.codex.isSessionHistoryReady(f.key), true);
  assert.deepEqual(f.store.getMessages(f.key).map(message => message.text), ['Valid reply']);
});

for (const phase of ['completed', 'failed', 'interrupted'] as const) for (const sync of ['current', 'error'] as const) {
  test(`ordinary external history cannot reinterpret the same ${phase}/${sync} terminal turn`, async t => {
    const f = fixture(t);
    f.store.upsertSession({ ...f.store.getSession(f.key)!, runtime: {
      turnId: 'turn', phase, sync, connection: 'connected', lastEventAt: 1,
    } });
    f.runtime.completedTurnIds.set(f.key, 'turn');
    const turn = { id: 'turn', status: phase === 'completed' ? 'failed' : 'completed',
      items: [{ id: 'reply', type: 'agentMessage', text: 'Historical reply' }] };
    let projections = 0;
    f.runtime.options.projectAssistant = async (text: string) => { projections++; return { text, media: [] }; };
    f.runtime.request = async (method: string) => {
      if (method === 'thread/backgroundTerminals/list') return { data: [] };
      assert.equal(method, 'thread/read'); return { thread: { id: 'synthetic', turns: [turn] } };
    };
    await assert.rejects(f.codex.refreshSession(f.key), /outcome/i);
    assert.equal(f.codex.isSessionHistoryReady(f.key), false);
    assert.equal(f.store.getSession(f.key)?.runtime?.phase, phase);
    assert.equal(f.store.getSession(f.key)?.runtime?.sync, sync);
    assert.equal(f.store.getMessages(f.key)[0]?.text, 'Known projection');
    assert.equal(projections, 0);
    assert.equal(f.runtime.completingTurns.size, 0);
    assert.equal(f.users.codexExecutions.get(f.key), undefined);
    turn.status = phase;
    await f.codex.refreshSession(f.key);
    await f.runtime.completingTurns.get(f.key);
    assert.equal(f.codex.isSessionHistoryReady(f.key), true);
    assert.equal(f.store.getSession(f.key)?.runtime?.phase, phase);
    assert.equal(f.store.getSession(f.key)?.runtime?.sync, 'current');
  });
}

test('ordinary external history may discover a distinct later turn after a known terminal turn', async t => {
  const f = fixture(t);
  f.store.upsertSession({ ...f.store.getSession(f.key)!, runtime: {
    turnId: 'old', phase: 'completed', sync: 'current', connection: 'connected', lastEventAt: 1,
  } });
  f.runtime.completedTurnIds.set(f.key, 'old');
  f.runtime.request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: 'synthetic', turns: [{ id: 'new', status: 'inProgress', items: [] }] } });
  await f.codex.refreshSession(f.key);
  assert.equal(f.codex.isSessionHistoryReady(f.key), true);
  assert.equal(f.store.getSession(f.key)?.runtime?.turnId, 'new');
  assert.equal(f.store.getSession(f.key)?.runtime?.phase, 'running');
});

test('a projected failure without a native completion marker does not freeze an external turn outcome', async t => {
  const f = fixture(t);
  f.store.upsertSession({ ...f.store.getSession(f.key)!, runtime: {
    turnId: 'turn', phase: 'failed', sync: 'error', connection: 'connected', lastEventAt: 1,
  } });
  f.runtime.request = async (method: string) => method === 'thread/backgroundTerminals/list' ? { data: [] } : ({ thread: { id: 'synthetic', turns: [{ id: 'turn', status: 'inProgress', items: [] }] } });
  await f.codex.refreshSession(f.key);
  assert.equal(f.codex.isSessionHistoryReady(f.key), true);
  assert.equal(f.store.getSession(f.key)?.runtime?.phase, 'running');
});
