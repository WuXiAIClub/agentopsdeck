import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { Hono } from 'hono';
import { CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { HubStore } from '../hub/hub-store.js';
import { loadConfig } from '../config.js';
import { PerformanceDiagnostics, performanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubRoutes } from '../routes/hub.js';
import { ConnectorClient } from '../hub/connector-client.js';

const body = JSON.stringify({ groups: [{ agentId: 'codex', sessions: [{ sessionKey: 'synthetic-session', label: 'PRIVATE synthetic', agentId: 'codex', updatedAt: 1 }] }], sourceCursor: 'private-cursor', padding: 'é'.repeat(20) });
const bytes = Buffer.byteLength(body);
function fixture(t: TestContext, count = 11, requestBytes = bytes * 4, retainedBytes = bytes * 32) {
  const rows: any[] = [], diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)));
  t.mock.method(performanceDiagnostics, 'start', (...args: Parameters<typeof performanceDiagnostics.start>) => diagnostics.start(...args));
  const store = new HubStore(':memory:', 'fixture-secret');
  store.upsertConnection({ id: 'local', kind: 'remote', label: 'Disabled local', connectorUrl: 'https://fixture.invalid', status: 'disabled' });
  for (let index = 0; index < count; index++) store.upsertConnection({ id: `node-${String(index).padStart(2, '0')}`, kind: 'remote',
    label: `Node ${index}`, connectorUrl: 'https://fixture.invalid', status: 'enabled' });
  const app = new Hono(), calls: string[] = [];
  const waiting = new Map<string, { resolve(response: Response): void; reject(error: unknown): void }>();
  let actor: { userId: string; admin: boolean } | undefined = { userId: 'default', admin: true }, immediate = false, reply = body;
  const response = () => new Response(reply, { headers: { [CONNECTOR_PROTOCOL_HEADER]: '1' } });
  const hub = registerHubRoutes(app, { config: loadConfig({ AOD_HUB_DATABASE_FILE: ':memory:' }), hubStore: store,
    principal: () => actor, normalizeError: () => 'unavailable', sessionStateResponseLimits: { requestBytes, retainedBytes },
    connectorClient: id => new ConnectorClient('https://fixture.invalid', 'synthetic', request => {
      assert.equal(request.method, 'GET'); assert.equal(new URL(request.url).pathname, '/api/connector/v1/sessions/state');
      const key = `${id}:${calls.length}`; calls.push(key);
      return immediate ? response() : new Promise<Response>((resolve, reject) => waiting.set(key, { resolve, reject }));
    }),
  });
  const release = (key: string, error?: unknown) => { const entry = waiting.get(key); assert.ok(entry); waiting.delete(key); error ? entry.reject(error) : entry.resolve(response()); };
  const drain = async () => { for (let attempt = 0; attempt < count * 3 + 10; attempt++) { await turn(); for (const key of [...waiting.keys()]) release(key); if (!waiting.size) { await turn(); if (!waiting.size) return; } } throw new Error('Fixture did not drain'); };
  t.after(async () => { immediate = true; for (const key of [...waiting.keys()]) release(key); await hub?.close(); await store.close(); });
  return { app, store, rows, calls, waiting, release, drain, setActor: (value: typeof actor) => { actor = value; },
    immediate: () => { immediate = true; }, tiny: () => { reply = '{"groups":[]}'; immediate = true; },
    request: (signal?: AbortSignal) => Promise.resolve(app.fetch(new Request('http://hub/api/hub/v1/sessions/state', { ...(signal ? { signal } : {}) }))) };
}

test('real route refuses the whole aggregate before parsing excess bytes, holds original reads, and recovers using a fresh GET', async t => {
  const f = fixture(t, 11, bytes - 1), pending = f.request(); let settled = false; void pending.then(() => { settled = true; });
  await turn(); assert.equal(f.calls.length, 4);
  f.release(f.calls[0]!); await turn(); assert.equal(settled, false); assert.equal(f.calls.length, 4);
  await f.drain(); const denied = await pending;
  assert.equal(denied.status, 503); assert.equal(denied.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await denied.json(), { error: 'hub_session_response_busy' });
  assert.equal(f.calls.length, 4); assert.equal(f.rows.find(row => row.phase === 'finished' && row.operation === 'hub-session-state-read').busy, 1);
  // A fresh small response fits the same route; no original message or write is replayed.
  f.tiny();
  const recovered = await f.request(); assert.equal(recovered.status, 200); assert.deepEqual((await recovered.json() as any).groups, []);
});

test('successful real aggregate keeps original source contract and logs exact collected bytes without private content', async t => {
  const f = fixture(t, 4); const pending = f.request(); await f.drain(); const response = await pending, snapshot = await response.json() as any;
  assert.equal(response.status, 200); assert.equal(snapshot.sources.length, 4); assert.equal(snapshot.sourceStates.length, 5);
  assert.equal(snapshot.groups[0].sessions.length, 4); assert.equal(typeof snapshot.revision, 'string'); assert.equal(typeof snapshot.viewKey, 'string');
  const log = f.rows.find(row => row.phase === 'finished' && row.operation === 'hub-session-state-read');
  assert.equal(log.snapshotBytes, bytes * 4); assert.equal(log.records, 4); assert.equal(log.busy, undefined);
  assert.doesNotMatch(JSON.stringify(f.rows), /PRIVATE|private-cursor|synthetic-session|fixture-secret|Bearer/);
});

test('two requests share retained bytes and refusal cannot turn into partial ready/unavailable source rows', async t => {
  const f = fixture(t, 4, bytes * 4, bytes * 4), first = f.request(), second = f.request();
  await turn(); assert.equal(f.calls.length, 8);
  for (const key of f.calls.slice(0, 3)) { f.release(key); await turn(); }
  f.release(f.calls[4]!); await turn(); f.release(f.calls[5]!); await turn();
  let returned = false; void second.then(() => { returned = true; }); await turn(); assert.equal(returned, false);
  await f.drain(); const a = await first, b = await second;
  assert.equal(a.status, 503); assert.equal(b.status, 503);
  assert.deepEqual(await b.json(), { error: 'hub_session_response_busy' });
  f.immediate(); const fresh = await f.request(); assert.equal(fresh.status, 200); assert.equal((await fresh.json() as any).sources.length, 4);
});

test('aggregate refusal after four successful responses stops new lanes and retains every original pending client', async t => {
  const f = fixture(t), pending = f.request(); let returned = false; void pending.then(() => { returned = true; });
  await turn(); for (const key of f.calls.slice(0, 4)) { f.release(key); await turn(); }
  assert.equal(f.calls.length, 8); f.release(f.calls[4]!); await turn();
  assert.equal(returned, false); assert.equal(f.calls.length, 8);
  await f.drain(); assert.equal((await pending).status, 503); assert.equal(f.calls.length, 8);
  const log = f.rows.find(row => row.phase === 'finished' && row.operation === 'hub-session-state-read');
  assert.equal(log.snapshotBytes, bytes * 4); assert.equal(log.busy, 1);
  f.tiny(); assert.equal((await f.request()).status, 200);
});

test('abort during original preferences wait cannot refund successfully collected response bytes', async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); t.after(() => release());
  const f = fixture(t, 4, bytes * 4, bytes * 4), original = f.store.sessionPreferencesAsync.bind(f.store);
  let entered = false;
  t.mock.method(f.store, 'sessionPreferencesAsync', async (userId: string) => {
    if (!entered) { entered = true; await gate; } return original(userId);
  });
  const controller = new AbortController(), first = f.request(controller.signal);
  await f.drain(); assert.equal(entered, true);
  controller.abort(); f.immediate();
  assert.equal((await f.request()).status, 503); assert.equal((await f.request()).status, 503);
  release(); const cancelled = await first; assert.equal(cancelled.status, 503);
  assert.deepEqual(await cancelled.json(), { error: 'request_aborted' });
  assert.equal((await f.request()).status, 200);
});

test('eight requests keep thirty-two original client reads; ninth refusal neither dispatches nor consumes bytes', async t => {
  const f = fixture(t, 4), pending = Array.from({ length: 8 }, () => f.request()); await turn();
  assert.equal(f.calls.length, 32); const ninth = await f.request();
  assert.equal(ninth.status, 503); assert.deepEqual(await ninth.json(), { error: 'hub_session_reads_busy' }); assert.equal(f.calls.length, 32);
  await f.drain(); for (const response of await Promise.all(pending)) assert.equal(response.status, 200);
  f.immediate(); assert.equal((await f.request()).status, 200);
});

for (const change of ['revoked', 'aborted'] as const)
test(`budget refusal with ${change} preserves final authority/cancellation fence and waits accepted route work`, async t => {
  const f = fixture(t, 11, bytes - 1), controller = new AbortController(), pending = f.request(controller.signal);
  await turn(); f.release(f.calls[0]!); await turn();
  if (change === 'revoked') f.setActor(undefined); else controller.abort();
  await f.drain(); const response = await pending;
  assert.equal(response.status, change === 'revoked' ? 401 : 503);
  if (change === 'aborted') assert.deepEqual(await response.json(), { error: 'request_aborted' });
  assert.equal(f.calls.length, 4);
  const log = f.rows.find(row => row.phase === 'finished' && row.operation === 'hub-session-state-read'); assert.equal(log.busy, 1);
});

test('logging failure cannot alter budget refusal or fresh readonly recovery', async t => {
  const f = fixture(t, 4, bytes - 1), start = performanceDiagnostics.start.bind(performanceDiagnostics);
  t.mock.method(performanceDiagnostics, 'start', (operation: Parameters<typeof start>[0]) => {
    if (operation === 'hub-session-state-read') throw new Error('private synthetic sink'); return start(operation);
  });
  const pending = f.request(); await f.drain(); assert.equal((await pending).status, 503);
  f.tiny();
  assert.equal((await f.request()).status, 200);
});

test('invalid route budget fails registration instead of weakening admission or waiting forever', t => {
  const f = fixture(t, 0);
  assert.throws(() => registerHubRoutes(new Hono(), { config: loadConfig({ AOD_HUB_DATABASE_FILE: ':memory:' }), hubStore: f.store,
    connectorClient: () => new ConnectorClient('https://fixture.invalid', 'synthetic'), normalizeError: () => 'unavailable',
    sessionStateResponseLimits: { requestBytes: 100, retainedBytes: 99 },
  }), /Invalid response budget/);
});
