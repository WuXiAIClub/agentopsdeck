import assert from 'node:assert/strict';
import test from 'node:test';
import { DeckStore } from '../projection/deck-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { HistoryReadSuperseded } from '../refresh/history.js';
import { createOpenClawHistory, projectOpenClawHistoryRows, readOpenClawHistoryRows,
  type OpenClawHistoryOptions } from './history-projection.js';

const key = 'agent:main:dashboard:private-history';
const rows = [{ id: 'original-assistant', role: 'assistant', text: 'private original text', createdAt: 1, stopReason: 'stop' }] as const;
const bridge = async () => ({ media: [], bridgedReferences: new Set<string>() });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture() {
  let connection: string | undefined = 'original', reads = 0, publishes = 0;
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  const deck = new DeckStore(); deck.upsertSession({ sessionKey: key, agentId: 'main', title: 'Original', status: 'running', hasActiveRun: true });
  const hooks: { source?: () => Promise<void>; media?: () => Promise<void>; publish?: () => void } = {};
  const options: OpenClawHistoryOptions = {
    gateway: { connectionId: () => connection, requestWithConnection: async <T>() => {
      reads++; const connectionId = connection!; await hooks.source?.(); return { connectionId, payload: { messages: rows } as T };
    } }, local: false, readLocal: async () => [], diagnostics,
    projection: { replaceMessages: (session, messages) => { publishes++; deck.replaceMessages(session, messages); hooks.publish?.(); },
      replaceActivities: (session, activities) => deck.replaceActivities(session, activities) },
    bridgeMedia: async () => { await hooks.media?.(); return bridge(); }, bridgeArtifacts: bridge,
  };
  // History is not an execution owner. Bind the original execution projection
  // so terminal-looking rows cannot make a currently running fact look idle.
  deck.bindOpenClawExecutionProjection({ get: session => session === key ? {
    sessionKey: key, commandId: 'original-command', phase: 'running', origin: 'gateway',
    gatewayConnectionId: 'original', startedAt: 1, updatedAt: 1,
  } : undefined, sessionPage: () => [key] }, () => 'original');
  const history = createOpenClawHistory(options);
  return { history, options, hooks, deck, logs, reads: () => reads, publishes: () => publishes,
    connection: (value: string | undefined) => { connection = value; } };
}

test('original source uses Gateway rows and enriches raw failure detail, not local replacement', async () => {
  const f = fixture(); let locals = 0;
  f.options.local = true;
  f.options.readLocal = async session => { assert.equal(session, key); locals++; return [
    { id: 'failed', role: 'assistant', status: 'failed', errorMessage: 'original failure detail' },
    { id: 'local-only', role: 'assistant', text: 'not authoritative' },
  ]; };
  f.options.gateway.requestWithConnection = async <T>(method: string, params: Record<string, unknown>) => {
    assert.equal(method, 'chat.history'); assert.deepEqual(params, { sessionKey: key, limit: 400 });
    return { connectionId: 'original', payload: { sessionKey: key,
      messages: [{ id: 'failed', role: 'assistant', status: 'failed', text: 'Assistant turn failed before producing content.' }] } as T };
  };
  const result = await readOpenClawHistoryRows(f.options, key, true);
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].failureReason, 'original failure detail'); assert.equal(locals, 1);
  await f.history.close();
});

for (const source of ['empty', 'error', 'malformed'] as const) {
  test(`${source}: only best-effort history may fall back to original local transcript`, async () => {
    const f = fixture(); f.options.local = true; let locals = 0;
  f.options.readLocal = async () => { locals++; return [...rows]; };
    f.options.gateway.requestWithConnection = async <T>() => {
      if (source === 'error') throw Error('private source failure');
      return { connectionId: 'original', payload: (source === 'empty' ? { messages: [] } : { messages: [null] }) as T };
    };
    assert.deepEqual((await readOpenClawHistoryRows(f.options, key, false)).rows, rows);
    if (source === 'empty') assert.deepEqual((await readOpenClawHistoryRows(f.options, key, true)).rows, []);
    else await assert.rejects(readOpenClawHistoryRows(f.options, key, true));
    assert.equal(locals, source === 'empty' ? 2 : 1);
    f.options.local = false;
    if (source === 'empty') assert.deepEqual((await readOpenClawHistoryRows(f.options, key, false)).rows, []);
    else await assert.rejects(readOpenClawHistoryRows(f.options, key, false));
    await f.history.close();
  });
}

test('original normalization preserves tool linkage, activities, usage, terminal and failure fields', async () => {
  const result = await projectOpenClawHistoryRows(key, [
    { id: 'call-row', role: 'assistant', createdAt: 2, stopReason: 'stop', content: [
      { type: 'text', text: 'original explanation' }, { type: 'toolCall', id: 'original-tool', name: 'exec', arguments: { cmd: 'read' } },
    ] },
    { id: 'tool-row', role: 'toolResult', toolCallId: 'original-tool', toolName: 'exec', content: 'original result', createdAt: 3,
      usage: { input: 10, output: 4 } },
    { id: 'failed-row', role: 'assistant', text: 'original failed response', status: 'failed', errorMessage: 'original diagnostic', createdAt: 4 },
    { id: 'terminal-row', role: 'assistant', text: 'original final response', stopReason: 'stop', createdAt: 5 },
  ], { bridgeMedia: bridge, bridgeArtifacts: bridge });
  assert.deepEqual(result.messages.map(message => message.id), ['call-row', 'original-tool', 'tool-row', 'failed-row', 'terminal-row']);
  assert.equal(result.messages[0]!.text, 'original explanation'); assert.equal(result.messages[0]!.status, 'sent');
  assert.equal(result.messages[1]!.toolPhase, 'call'); assert.equal(result.messages[2]!.toolCallId, 'original-tool');
  assert.equal(result.messages[2]!.toolPhase, 'result'); assert.equal(result.messages[2]!.totalTokens, 14);
  assert.equal(result.messages[3]!.status, 'failed'); assert.equal(result.messages[3]!.failureReason, 'original diagnostic');
  assert.equal(result.messages[4]!.status, 'sent');
  assert.deepEqual(result.activities.map(activity => [activity.toolCallId, activity.status]), [['original-tool', 'running'], ['original-tool', 'done']]);
});

test('media/artifact preparation keeps original normalization and best-effort bridge failure', async () => {
  let media = 0, artifacts = 0;
  const result = await projectOpenClawHistoryRows(key, [...rows], {
    bridgeMedia: async (row, role) => { assert.equal(row.id, rows[0].id); assert.equal(role, 'assistant'); media++; throw Error('private path'); },
    bridgeArtifacts: async () => { artifacts++; return bridge(); },
  });
  assert.equal(media, 1); assert.equal(artifacts, 1); assert.equal(result.messages[0]!.text, rows[0].text);
});

for (const phase of ['source', 'media'] as const) for (const change of ['invalidate', 'connection', 'aba'] as const) {
  test(`${phase}/${change}: obsolete physical work cannot publish, restore ready or release execution`, async () => {
    const f = fixture(), gate = deferred(); let entered = false;
    f.hooks[phase] = async () => { entered = true; await gate.promise; };
    const work = f.history(key); const rejected = assert.rejects(work, HistoryReadSuperseded);
    await tick(); assert.equal(entered, true);
    if (change === 'connection') f.connection('new');
    else if (change === 'aba') { f.connection('new'); f.history.invalidate(); f.connection('original'); }
    else f.history.invalidate();
    gate.resolve(); await rejected;
    assert.equal(f.publishes(), 0); assert.equal(f.history.ready(key), false);
    assert.equal(f.deck.getSession(key)?.hasActiveRun, true);
    delete f.hooks[phase];
    await f.history(key, { maxAgeMs: 60_000 });
    assert.equal(f.publishes(), 1); assert.equal(f.history.ready(key), true); assert.equal(f.reads(), 2);
    await f.history.close();
  });
}

test('same revision is cached only inside its original connection and invalidation generation', async () => {
  const f = fixture();
  await f.history(key); await f.history(key); assert.equal(f.reads(), 2); assert.equal(f.publishes(), 1);
  f.history.invalidate(); assert.equal(f.history.ready(key), false);
  await f.history(key, { maxAgeMs: 60_000 }); assert.equal(f.publishes(), 2);
  f.connection('new'); assert.equal(f.history.ready(key), false);
  // A connection change without the required runtime callback must still not
  // advertise ready. Explicit invalidation also revokes maxAge cache entries.
  f.history.invalidate(); await f.history(key); assert.equal(f.publishes(), 3);
  assert.equal(f.deck.getSession(key)?.hasActiveRun, true); await f.history.close();
});

test('invalidation during projection publication cannot acknowledge a warm ready cache', async () => {
  const f = fixture(); f.hooks.publish = () => f.history.invalidate();
  await assert.rejects(f.history(key), HistoryReadSuperseded);
  assert.equal(f.history.ready(key), false); delete f.hooks.publish;
  await f.history(key, { maxAgeMs: 60_000 }); assert.equal(f.publishes(), 2); assert.equal(f.history.ready(key), true);
  await f.history.close();
});

test('concurrent readers share original physical task; fresh follower reads again after it drains', async () => {
  const f = fixture(), gate = deferred(); let entered = false;
  f.hooks.source = async () => { entered = true; await gate.promise; };
  const work = f.history(key), joined = f.history(key), fresh = f.history(key, { fresh: true });
  await tick(); assert.equal(entered, true); assert.equal(f.reads(), 1);
  gate.resolve(); await Promise.all([work, joined, fresh]); assert.equal(f.reads(), 2);
  await f.history.close();
});

for (const phase of ['source', 'media'] as const) test(`close freezes admission and retains physical ${phase} until actual completion`, async () => {
  const f = fixture(), gate = deferred(); let entered = false, closed = false;
  f.hooks[phase] = async () => { entered = true; await gate.promise; };
  const work = f.history(key), rejected = assert.rejects(work, HistoryReadSuperseded);
  await tick(); assert.equal(entered, true);
  const closing = f.history.close(); assert.equal(f.history.close(), closing);
  void closing.then(() => { closed = true; });
  await assert.rejects(f.history(key)); await tick(); assert.equal(closed, false);
  gate.resolve(); await rejected; await closing;
  assert.equal(f.publishes(), 0); assert.equal(f.history.ready(key), false);
});

test('history diagnostics are sanitized observations; broken sinks never replace original work', async () => {
  const f = fixture(); await f.history(key);
  const logs = f.logs.join(''); assert.match(logs, /openclaw-history-projection/);
  assert.ok(!logs.includes(key)); assert.ok(!logs.includes(rows[0].text));
  await f.history.close();
  const broken = createOpenClawHistory({ ...f.options, diagnostics: { start() { throw Error('broken sink'); } } as unknown as PerformanceDiagnostics });
  await broken(key); assert.equal(broken.ready(key), true); await broken.close();
});
