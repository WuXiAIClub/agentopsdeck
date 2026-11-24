import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from './app-server.js';

async function fixture(context: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-unmaterialized-'));
  const users = new ConnectorUserStore(':memory:');
  const store = new DeckStore({ sessionTitlesFile: join(directory, 'titles.json') });
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: directory,
    defaultModel: 'synthetic', approvalPolicy: 'never', store, turnQueue: users.turns,
    executions: users.codexExecutions, authorizeTurn: () => true });
  const runtime = codex as any;
  const threadId = 'fresh-thread', key = `codex:${threadId}`, connectionId = 'original-connection';
  runtime.ensureStarted = async () => {};
  runtime.setConnection(connectionId);
  runtime.request = async (method: string) => {
    if (method === 'thread/name/set') return {};
    assert.equal(method, 'thread/start');
    return { thread: { id: threadId, status: { type: 'idle' }, turns: [] } };
  };
  context.after(async () => { await codex.close(); users.close(); rmSync(directory, { recursive: true, force: true }); });
  await codex.createSession({ title: 'Fresh' }, () => {}, () => {});
  const unavailable = new Error(`thread ${threadId} is not materialized yet; includeTurns is unavailable before first user message`);
  const reads: boolean[] = [];
  const metadata = { thread: { id: threadId, path: join(directory, 'not-materialized.jsonl'), status: { type: 'idle' }, turns: [] as unknown[] } };
  runtime.request = async (method: string, params: { includeTurns: boolean }) => {
    assert.equal(method, 'thread/read'); reads.push(params.includeTurns);
    if (params.includeTurns) throw unavailable;
    return metadata;
  };
  return { codex, runtime, users, store, threadId, key, connectionId, unavailable, reads, metadata };
}

test('fresh Codex thread uses verified idle metadata only until the first dispatch', async context => {
  const fixtureState = await fixture(context);
  const { codex, runtime, key, threadId, reads, users, unavailable } = fixtureState;
  await codex.refreshSession(key);
  assert.deepEqual(reads, [true, false]);
  assert.equal(codex.isSessionHistoryReady(key), true);
  const read = runtime.request;
  runtime.request = async (method: string) => {
    assert.equal(method, 'turn/start');
    assert.equal(runtime.unmaterializedThreadIds.has(threadId), false);
    return { turn: { id: 'original-run' } };
  };
  await runtime.startTurn(key, threadId, [], 'original-command');
  assert.equal(users.codexExecutions.get(key)?.runId, 'original-run');
  runtime.request = read;
  await assert.rejects(codex.refreshSession(key), error => error === unavailable);
  assert.deepEqual(reads, [true, false, true]);
});

test('ordinary full history still rejects an unavailable rollout', async context => {
  const { codex, runtime, key, metadata } = await fixture(context);
  runtime.request = async () => metadata;
  await assert.rejects(codex.refreshSession(key), /Codex rollout unavailable/);
  assert.equal(codex.isSessionHistoryReady(key), false);
});

test('cold exact empty-thread metadata restores display without native resume or dispatch', async context => {
  const { codex, runtime, store, key, threadId, reads } = await fixture(context);
  runtime.setConnection('replacement-connection'); store.removeSession(key);
  assert.equal(runtime.unmaterializedThreadIds.has(threadId), false);
  await codex.refreshSession(key, { readOnly: true, fresh: true });
  assert.deepEqual(reads, [true, false]); assert.ok(store.getSession(key));
  assert.equal(runtime.unmaterializedThreadIds.has(threadId), true);
});

test('creation acknowledges only after native metadata persistence without dispatching a turn', async context => {
  const { codex, runtime } = await fixture(context);
  const calls: string[] = [];
  runtime.request = async (method: string, params: unknown) => {
    calls.push(method);
    if (method === 'thread/start') return { thread: { id: 'durable-empty' } };
    assert.equal(method, 'thread/name/set');
    assert.deepEqual(params, { threadId: 'durable-empty', name: 'Durable empty' });
    return {};
  };
  await codex.createSession({ title: 'Durable empty' }, () => calls.push('accepted'), () => {}, () => calls.push('validated'));
  assert.deepEqual(calls, ['thread/start', 'validated', 'thread/name/set', 'accepted']);
});

test('failed empty-thread persistence does not acknowledge, project or repeat native creation', async context => {
  const { codex, runtime, store } = await fixture(context);
  const calls: string[] = [];
  runtime.request = async (method: string) => {
    calls.push(method);
    if (method === 'thread/start') return { thread: { id: 'uncertain-empty' } };
    throw new Error('metadata outcome unknown');
  };
  await assert.rejects(codex.createSession({}, () => assert.fail('unexpected acceptance'), () => {}), /metadata outcome unknown/);
  assert.deepEqual(calls, ['thread/start', 'thread/name/set']);
  assert.equal(store.getSession('codex:uncertain-empty'), undefined);
});

for (const boundary of ['valid', 'missing-rollout', 'new-turn', 'changed-connection'] as const) {
  test(`cold persisted empty session recovery: ${boundary}`, async context => {
    const { codex, runtime, key, metadata, threadId, store } = await fixture(context);
    runtime.setConnection('restarted');
    runtime.loadedThreadIds.clear();
    if (boundary !== 'missing-rollout') writeFileSync(metadata.thread.path, '{}\n');
    let reads = 0;
    const calls: string[] = [];
    runtime.request = async (method: string, params: { threadId: string }) => {
      calls.push(method);
      assert.equal(params.threadId, threadId);
      if (method === 'thread/resume') {
        if (boundary === 'changed-connection') runtime.setConnection('replacement');
        return metadata;
      }
      assert.equal(method, 'thread/read');
      const thread = structuredClone(metadata.thread);
      thread.status.type = ++reads === 1 ? 'notLoaded' : 'idle';
      if (reads > 1 && boundary === 'new-turn') thread.turns.push({ id: 'external', status: 'inProgress', items: [] });
      return { thread };
    };
    if (boundary === 'valid') {
      await codex.refreshSession(key);
      assert.equal(codex.isSessionHistoryReady(key), true);
      assert.equal(store.getSession(key)?.runtime?.threadActivity, 'idle');
      assert.deepEqual(calls, ['thread/read', 'thread/resume', 'thread/read']);
    } else {
      await assert.rejects(codex.refreshSession(key));
      assert.equal(codex.isSessionHistoryReady(key), false);
      assert.equal(calls.includes('turn/start'), false);
      if (boundary === 'missing-rollout') assert.deepEqual(calls, ['thread/read']);
    }
  });
}

test('cold read-only notLoaded snapshot never resumes native execution', async context => {
  const { codex, runtime, store, key, metadata } = await fixture(context);
  runtime.setConnection('restarted');
  store.removeSession(key);
  writeFileSync(metadata.thread.path, '{}\n');
  const calls: string[] = [];
  runtime.request = async (method: string) => {
    calls.push(method);
    if (method === 'thread/goal/get') return { goal: null };
    assert.equal(method, 'thread/read');
    const thread = structuredClone(metadata.thread); thread.status.type = 'notLoaded';
    return { thread };
  };
  await codex.refreshSession(key, { readOnly: true, fresh: true });
  assert.deepEqual(calls, ['thread/read', 'thread/goal/get']);
  assert.equal(store.getSession(key)?.status, 'unknown');
  assert.equal(store.getSession(key)?.runtime, undefined);
  assert.equal(runtime.activeTurnIds.size, 0);
});

for (const boundary of ['reconnected', 'existing-execution', 'external-turn', 'materialized-history', 'other-error', 'wrong-thread-error']) {
  test(`unmaterialized fallback refuses ${boundary}`, async context => {
    const { codex, runtime, users, key, threadId, connectionId, reads, metadata } = await fixture(context);
    if (boundary === 'reconnected') runtime.setConnection('new-connection');
    if (boundary === 'existing-execution') users.codexExecutions.begin(key, 'original-command', connectionId);
    if (boundary === 'external-turn') runtime.handleNotification('turn/started', { threadId, turn: { id: 'external-run' } });
    if (boundary === 'materialized-history') {
      metadata.thread.path = '';
      const read = runtime.request;
      runtime.request = async () => metadata;
      await codex.refreshSession(key);
      runtime.request = read;
    }
    if (boundary === 'other-error' || boundary === 'wrong-thread-error') {
      runtime.request = async (_method: string, params: { includeTurns: boolean }) => {
        reads.push(params.includeTurns);
        throw new Error(boundary === 'other-error' ? 'transport unavailable'
          : 'thread other-thread is not materialized yet; includeTurns is unavailable before first user message');
      };
    }
    await assert.rejects(codex.refreshSession(key));
    assert.deepEqual(reads, [true]);
    assert.equal(codex.isSessionHistoryReady(key), false);
  });
}

for (const readOnly of [false, true]) for (const boundary of ['active', 'not-loaded', 'wrong-identity', 'unexpected-turn', 'connection-race', 'execution-race']) {
  test(`unmaterialized metadata cannot certify ${boundary} as idle history, readOnly=${readOnly}`, async context => {
    const { codex, runtime, users, key, threadId, connectionId, reads, metadata } = await fixture(context);
    if (boundary === 'active') metadata.thread.status.type = 'active';
    if (boundary === 'not-loaded') metadata.thread.status.type = 'notLoaded';
    if (boundary === 'wrong-identity') metadata.thread.id = 'other-thread';
    if (boundary === 'unexpected-turn') metadata.thread.turns.push({ id: 'external', status: 'completed', items: [] });
    if (boundary.endsWith('-race')) {
      const read = runtime.request;
      runtime.request = async (method: string, params: { includeTurns: boolean }) => {
        const result = await read(method, params);
        if (boundary === 'connection-race') runtime.setConnection('new-connection');
        else users.codexExecutions.begin(key, 'racing-command', connectionId);
        return result;
      };
    }
    await assert.rejects(codex.refreshSession(key, { readOnly, fresh: true }));
    assert.deepEqual(reads, [true, false]);
    assert.equal(codex.isSessionHistoryReady(key), false);
    assert.equal(runtime.activeTurnIds.has(threadId), false);
  });
}
