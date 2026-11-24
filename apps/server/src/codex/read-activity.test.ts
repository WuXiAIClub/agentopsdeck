import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { CodexAppServer } from './app-server.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { DeckStore } from '../projection/deck-store.js';

function fixture(context: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-read-activity-'));
  const users = new ConnectorUserStore(':memory:');
  const store = new DeckStore({ sessionTitlesFile: join(directory, 'titles.json') });
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: directory,
    defaultModel: 'synthetic', approvalPolicy: 'never', store, turnQueue: users.turns,
    executions: users.codexExecutions, authorizeTurn: () => true });
  const runtime = codex as any;
  runtime.setConnection('connection');
  runtime.ensureStarted = async () => {};
  runtime.write = (message: { id: number }) => runtime.receive(JSON.stringify({ id: message.id, result: { data: [] } }));
  context.after(async () => { await codex.close(); users.close(); rmSync(directory, { recursive: true, force: true }); });
  return { codex, runtime, users, store };
}

test('runtime model discovery follows effective provider, not a stale native catalog or configured default', async context => {
  const { codex, runtime } = fixture(context);
  let hits = 0;
  const server = createServer((request, response) => {
    hits++;
    assert.equal(request.url, '/v1/models');
    assert.equal(request.headers.authorization, 'Bearer synthetic-private-key');
    response.end(JSON.stringify({ data: [{ id: 'gemini-4-argon' }, { id: 'auto' }] }));
  });
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  context.after(() => new Promise<void>(ok => { server.closeAllConnections(); server.close(() => ok()); }));
  let effective = { config: { model_provider: 'openai' } } as any;
  const methods: string[] = [];
  runtime.write = (message: { id: number; method: string; params: unknown }) => {
    methods.push(message.method);
    if (message.method === 'config/read') assert.deepEqual(message.params, { includeLayers: false, cwd: null });
    runtime.receive(JSON.stringify({ id: message.id, result: message.method === 'config/read' ? effective
      : { data: [{ id: 'official', model: 'official', displayName: 'Official' }], nextCursor: null } }));
  };
  assert.equal((await codex.listModels())[0]?.id, 'official');
  effective = { config: { model_provider: 'private', model_providers: { private: {
    base_url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    http_headers: { authorization: 'Bearer synthetic-private-key' },
  } } } };
  const guard = runtime.nativeHistoryActivityGuard('synthetic');
  const models = await Promise.all(Array.from({ length: 6 }, () => codex.listModels()));
  assert.deepEqual(models[0]?.map(row => row.id), ['gemini-4-argon', 'auto']);
  assert.equal(hits, 1);
  assert.deepEqual(methods, ['config/read', 'model/list', 'config/read']);
  assert.equal(guard.current(), true, 'opening model choices never invalidates history');
  effective.config.model_providers.private.base_url = 'not-a-url';
  await assert.rejects(codex.listModels(), /unavailable/);
  assert.equal(methods.filter(method => method === 'model/list').length, 1, 'custom provider failure cannot fall back to unrelated native choices');
});

for (const method of ['thread/list', 'model/list', 'config/read', 'thread/loaded/list', 'thread/read',
  'thread/backgroundTerminals/list', 'thread/goal/get', 'skills/list']) {
  test(`${method} cannot invalidate a native history observation`, async context => {
    const { runtime } = fixture(context);
    const guard = runtime.nativeHistoryActivityGuard('synthetic');
    const epoch = runtime.maintenanceEpoch;
    await runtime.request(method, {});
    assert.equal(guard.current(), true);
    assert.equal(runtime.maintenanceEpoch, epoch + (['thread/list', 'model/list', 'config/read'].includes(method) ? 1 : 0));
  });
}

test('native read deprecation advisory does not invalidate its own final-history proof', async context => {
  const { runtime } = fixture(context);
  runtime.write = (message: { id: number }) => {
    runtime.receive(JSON.stringify({ method: 'deprecationNotice',
      params: { summary: 'Read parameter is deprecated', details: null } }));
    runtime.receive(JSON.stringify({ id: message.id, result: { data: [] } }));
  };
  const guard = runtime.nativeHistoryActivityGuard('synthetic');
  const epoch = runtime.maintenanceEpoch;
  await runtime.request('thread/read', { threadId: 'synthetic', includeTurns: true });
  assert.equal(guard.current(), true);
  assert.equal(runtime.maintenanceEpoch, epoch);
});

for (const params of [
  { summary: 'Advisory', details: null, threadId: 'synthetic' },
  { summary: 'Advisory', details: null, turnId: 'tracked' },
  { summary: 'Advisory', details: null, threadId: 'synthetic', thread: { id: 'conflict' } },
  { summary: null, details: null },
  { summary: 'Advisory', details: { unknown: true } },
]) {
  test('scoped, contradictory or malformed deprecation metadata remains a native-activity fence', async context => {
    const { runtime } = fixture(context);
    const guard = runtime.nativeHistoryActivityGuard('synthetic');
    runtime.handleNotification('deprecationNotice', params);
    assert.equal(guard.current(), false);
  });
}

for (const method of ['thread/resume', 'turn/start', 'thread/goal/set', 'unknown/method']) {
  test(`${method} still invalidates the exact native history observation`, async context => {
    const { runtime } = fixture(context);
    const affected = runtime.nativeHistoryActivityGuard('synthetic');
    const unrelated = runtime.nativeHistoryActivityGuard('other');
    await runtime.request(method, { threadId: 'synthetic' });
    assert.equal(affected.current(), false);
    assert.equal(unrelated.current(), true);
    const unscoped = runtime.nativeHistoryActivityGuard('other');
    await runtime.request(method, {});
    assert.equal(unscoped.current(), false);
  });
}

for (const advisory of [false, true]) test(`concurrent directory polling preserves final-history proof and queued input (read advisory: ${advisory})`, async context => {
  const { codex, runtime, users, store } = fixture(context);
  const key = 'codex:synthetic';
  store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'Synthetic', status: 'unknown',
    runtime: { turnId: 'tracked', phase: 'completed', connection: 'connected', sync: 'syncing', lastEventAt: 1 } });
  users.codexExecutions.begin(key, 'command', 'connection');
  users.codexExecutions.acknowledge(key, 'command', 'connection', 'tracked', () => {});
  users.codexExecutions.observe(key, 'connection', 'tracked', 'completed');
  users.codexExecutions.invalidateNativeHistory(key, 'restarted');
  users.turns.enqueue('codex', { id: 'preserved-input', sessionKey: key, createdAt: 5,
    payload: { text: 'Original queued input', images: [] } });
  const queued = structuredClone(users.turns.list('codex', key));
  if (advisory) runtime.write = (message: { id: number; method: string }) => {
    if (message.method === 'thread/read') runtime.receive(JSON.stringify({
      method: 'deprecationNotice', params: { summary: 'Read parameter is deprecated', details: null },
    }));
    runtime.receive(JSON.stringify({ id: message.id, result: { data: [] } }));
  };
  const request = runtime.request.bind(runtime);
  let reads = 0;
  runtime.request = async (method: string, params: unknown, timeout?: number) => {
    if (method === 'thread/goal/get') return { goal: null };
    if (method === 'thread/backgroundTerminals/list') return { data: [] };
    if (method !== 'thread/read') return request(method, params, timeout);
    reads++;
    if (advisory) await request(method, params, timeout);
    await request('thread/list', { limit: 100 });
    await request('model/list', {});
    await request('config/read', { includeLayers: false, cwd: null });
    return { thread: { id: 'synthetic', status: { type: 'idle' }, canAcceptDirectInput: true,
      turns: [{ id: 'tracked', status: 'completed', itemsView: 'full',
        items: [{ id: 'reply', type: 'agentMessage', text: 'Completed reply' }] }] } };
  };
  runtime.turnWorker.wake = () => {};
  runtime.reconcileCompletedTurn(key, 'synthetic', 10, 'tracked', 'completed');
  await runtime.completingTurns.get(key);
  assert.equal(users.codexExecutions.get(key)?.sync, 'current');
  assert.equal(users.codexExecutions.get(key)?.nativeHistory?.state, 'verified');
  assert.equal(codex.isSessionHistoryReady(key), true);
  assert.equal(reads, 2);
  assert.deepEqual(users.turns.list('codex', key), queued);
});
