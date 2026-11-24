import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { Hono } from 'hono';
import { HubStore } from '../hub/hub-store.js';
import { loadConfig } from '../config.js';
import { ConnectorClientError } from '../hub/connector-client.js';
import { PerformanceDiagnostics, performanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubRoutes } from './hub.js';

function fixture(t: TestContext, count = 11, parallel = false) {
  const rows: any[] = [], diagnostics = new PerformanceDiagnostics(line => rows.push(JSON.parse(line)));
  t.mock.method(performanceDiagnostics, 'start', (...args: Parameters<typeof performanceDiagnostics.start>) => diagnostics.start(...args));
  const store = new HubStore(':memory:', 'fixture-secret');
  store.upsertConnection({ id: 'local', kind: 'remote', label: 'Disabled local', connectorUrl: 'https://fixture.invalid', status: 'disabled' });
  for (let index = 0; index < count; index++) store.upsertConnection({ id: `node-${index}`, kind: 'remote',
    label: `Node ${String(index).padStart(3, '0')}`, connectorUrl: 'https://fixture.invalid', status: 'enabled' });
  const app = new Hono(), calls: string[] = [], waiting = new Map<string, { resolve(value: any): void; reject(error: unknown): void }>();
  let actor: { userId: string; admin: boolean } | undefined = { userId: 'default', admin: true };
  let active = 0, maxActive = 0, immediate = false;
  const body = (id: string) => ({ groups: [{ agentId: 'codex', sessions: [{ sessionKey: `retained-${id}`, label: `PRIVATE ${id}`, agentId: 'codex', updatedAt: 1 }] }], sourceCursor: `cursor-${id}` });
  const hub = registerHubRoutes(app, { config: loadConfig({ AOD_HUB_DATABASE_FILE: ':memory:' }), hubStore: store,
    principal: () => actor, normalizeError: () => 'unavailable', connectorClient: ((id: string) => ({ sessions: async () => {
      calls.push(id); active++; maxActive = Math.max(maxActive, active);
      try { return immediate ? body(id) : await new Promise((resolve, reject) => waiting.set(parallel ? `${id}:${calls.length}` : id, { resolve, reject })); }
      finally { active--; }
    } })) as any });
  const release = (id: string, error?: unknown) => {
    const entry = waiting.get(id); assert.ok(entry); waiting.delete(id);
    if (error) entry.reject(error); else entry.resolve(body(parallel ? id.split(':')[0]! : id));
  };
  const drain = async () => {
    for (let attempt = 0; attempt < count + 4; attempt++) {
      await turn(); for (const id of [...waiting.keys()].reverse()) release(id);
      if (calls.length === count && active === 0) break;
    }
  };
  t.after(async () => { immediate = true; for (const id of [...waiting.keys()]) release(id); await hub?.close(); await store.close(); });
  const signal = new AbortController();
  return { app, store, rows, calls, waiting, release, drain, signal, actor: () => actor,
    setActor: (value: typeof actor) => { actor = value; }, immediate: () => { immediate = true; },
    state: () => ({ active, maxActive }), request: () => Promise.resolve(app.fetch(new Request('http://hub/api/hub/v1/sessions/state', { signal: signal.signal }))) };
}

test('large session directory uses four original reads, preserves order/cursors/wire, and logs recovery without replay', async t => {
  const f = fixture(t), pending = f.request(); await turn();
  assert.equal(f.calls.length, 4); assert.equal(f.state().active, 4);
  await f.drain(); const response = await pending, body = await response.json() as any;
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(f.state().maxActive, 4); assert.equal(f.state().active, 0);
  assert.deepEqual(f.calls, Array.from({ length: 11 }, (_, index) => `node-${index}`));
  assert.deepEqual(body.connections.map((row: any) => row.id), ['local', ...f.calls]);
  assert.deepEqual(body.sources.map((row: any) => row.cursor), f.calls.map(id => `cursor-${id}`));
  assert.equal(body.groups.reduce((count: number, group: any) => count + group.sessions.length, 0), 11);
  assert.equal(typeof body.revision, 'string'); assert.equal(typeof body.viewKey, 'string');
  const logs = f.rows.filter(row => row.operation === 'hub-session-state-read' && row.phase === 'finished');
  assert.equal(logs.length, 1); assert.equal(logs[0].step, 5); assert.equal(logs[0].records, 11);
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE|node-|cursor-|default|fixture/);
});

for (const change of ['revoked', 'member', 'other', 'mutated-object', 'aborted'] as const)
test(`session fan-in ${change} stops new dispatch but retains original lanes until all settle`, async t => {
  const f = fixture(t), pending = f.request(); let returned = false; void pending.then(() => { returned = true; }); await turn();
  assert.equal(f.calls.length, 4);
  if (change === 'revoked') f.setActor(undefined);
  if (change === 'member') f.setActor({ userId: 'default', admin: false });
  if (change === 'other') f.setActor({ userId: 'other', admin: true });
  if (change === 'mutated-object') f.actor()!.admin = false;
  if (change === 'aborted') f.signal.abort();
  f.release('node-0'); await turn();
  assert.equal(f.calls.length, 4); assert.equal(returned, false); assert.equal(f.state().active, 3);
  for (const id of [...f.waiting.keys()]) f.release(id); const response = await pending;
  assert.equal(response.status, change === 'aborted' ? 503 : 401); assert.equal(f.state().active, 0);
  assert.doesNotMatch(await response.text(), /PRIVATE|cursor-|retained-/); assert.equal(f.calls.length, 4);
  const logs = f.rows.filter(row => row.operation === 'hub-session-state-read' && row.phase === 'finished');
  assert.equal(logs.length, 1); assert.equal(logs[0].step, 2); assert.equal(logs[0].deferred, 1);
  assert.equal(logs[0].settled, undefined); assert.equal(logs[0].unknown, undefined);
  f.setActor({ userId: 'default', admin: true }); f.immediate();
  assert.equal((await f.app.request('/api/hub/v1/sessions/state')).status, 200);
});

for (const code of [401, 403, 404, 500])
test(`one original Connector ${code} failure does not poison healthy sources or replay`, async t => {
  const f = fixture(t, 7), pending = f.request(); await turn();
  f.release('node-0', new ConnectorClientError(code, `Connector request failed: HTTP ${code}`));
  await f.drain(); const response = await pending, body = await response.json() as any;
  assert.equal(response.status, 200); assert.equal(f.state().maxActive, 4); assert.equal(f.calls.length, 7);
  assert.equal(new Set(f.calls).size, 7); assert.equal(body.sourceStates.find((row: any) => row.connectionId === 'node-0').state,
    code === 500 ? 'unavailable' : 'denied');
  assert.equal(body.sources.length, 6);
});

test('no enabled source dispatches no request and retains empty successful wire', async t => {
  const f = fixture(t, 0), response = await f.request(), body = await response.json() as any;
  assert.equal(response.status, 200); assert.equal(f.calls.length, 0); assert.deepEqual(body.groups, []);
  assert.deepEqual(body.sources, []); assert.equal(body.sourceStates[0].state, 'disabled');
});

function heldDirectory(t: TestContext) {
  const f = fixture(t, 0);
  const original = f.store.listUsersAsync.bind(f.store);
  let unblock!: () => void, fail!: (error: Error) => void, blocked = true, reads = 0;
  const gate = new Promise<void>((resolve, reject) => { unblock = resolve; fail = reject; });
  void gate.catch(() => {});
  const release = () => { blocked = false; unblock(); };
  t.mock.method(f.store, 'listUsersAsync', async (...args: Parameters<typeof original>) => {
    reads++; if (blocked) await gate;
    return original(...args);
  });
  t.after(release);
  return { ...f, releaseDirectory: release, failDirectory: () => { blocked = false; fail(Error('PRIVATE SQL failure')); },
    reads: () => reads };
}

test('eight aggregate requests bound Hub-wide readonly work before SQL and recover after real settlement', async t => {
  const f = heldDirectory(t), accepted = Array.from({ length: 8 }, () => f.request());
  await turn();
  assert.equal(f.reads(), 8); assert.equal(f.calls.length, 0);
  const refusalRequest = f.request(); await turn();
  assert.equal(f.reads(), 8);
  const refusal = await refusalRequest;
  assert.equal(refusal.status, 503); assert.equal(refusal.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await refusal.json(), { error: 'hub_session_reads_busy' });
  assert.equal(f.reads(), 8);
  const refusalLog = f.rows.find(row => row.operation === 'hub-session-state-read' && row.admitted === 0);
  assert.ok(refusalLog); assert.equal(refusalLog.pending, 8); assert.equal(refusalLog.step, 1);
  assert.equal(refusalLog.deferred, 1);
  assert.doesNotMatch(JSON.stringify(refusalLog), /PRIVATE|default|fixture/);
  f.releaseDirectory();
  for (const response of await Promise.all(accepted)) assert.equal(response.status, 200);
  assert.equal((await f.app.request('/api/hub/v1/sessions/state')).status, 200);
  assert.equal(f.reads(), 9); assert.equal(f.calls.length, 0);
});

test('client abort cannot free an accepted aggregate slot while its original directory read is unresolved', async t => {
  const f = heldDirectory(t), accepted = Array.from({ length: 8 }, () => f.request());
  await turn(); f.signal.abort(); await turn();
  // A fresh, non-aborted request must still see all original slots retained.
  const refusalRequest = f.app.request('/api/hub/v1/sessions/state'); await turn();
  assert.equal(f.reads(), 8);
  const refusal = await refusalRequest;
  assert.equal(refusal.status, 503); assert.deepEqual(await refusal.json(), { error: 'hub_session_reads_busy' });
  assert.equal(f.reads(), 8);
  f.releaseDirectory();
  for (const response of await Promise.all(accepted)) assert.equal(response.status, 503);
  assert.equal((await f.app.request('/api/hub/v1/sessions/state')).status, 200);
  assert.equal(f.reads(), 9); assert.equal(f.calls.length, 0);
});

test('revocation outranks aggregate capacity and rejected original reads return their slot only after settlement', async t => {
  const f = heldDirectory(t), accepted = Array.from({ length: 8 }, () => f.request());
  await turn(); f.setActor(undefined);
  assert.equal((await f.app.request('/api/hub/v1/sessions/state')).status, 401);
  assert.equal(f.reads(), 8);
  f.failDirectory();
  for (const response of await Promise.all(accepted)) assert.equal(response.status, 401);
  f.setActor({ userId: 'default', admin: true });
  assert.equal((await f.app.request('/api/hub/v1/sessions/state')).status, 200);
  assert.equal(f.reads(), 9);
});

test('original SQL rejection settles aggregate slots without exposing exceptions or replaying reads', async t => {
  const f = heldDirectory(t), accepted = Array.from({ length: 8 }, () => f.request());
  await turn(); f.failDirectory();
  for (const response of await Promise.all(accepted)) {
    assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /PRIVATE|SQL/);
  }
  assert.equal(f.reads(), 8);
  assert.equal((await f.app.request('/api/hub/v1/sessions/state')).status, 200);
  assert.equal(f.reads(), 9); assert.equal(f.calls.length, 0);
});

test('diagnostic failures cannot leak aggregate slots or grant a ninth dispatch', async t => {
  const f = heldDirectory(t);
  const broken = t.mock.method(performanceDiagnostics, 'start', () => { throw Error('diagnostic failure'); });
  try {
    const accepted = Array.from({ length: 8 }, () => f.request()); await turn();
    const refusal = f.request(); await turn(); assert.equal(f.reads(), 8);
    assert.equal((await refusal).status, 503);
    f.releaseDirectory();
    for (const response of await Promise.all(accepted)) assert.equal(response.status, 200);
    assert.equal((await f.app.request('/api/hub/v1/sessions/state')).status, 200);
  } finally { broken.mock.restore(); }
});

test('eight simultaneous requests retain at most 32 Connector reads and preserve each original source ordering', async t => {
  const f = fixture(t, 11, true), accepted = Array.from({ length: 8 }, () => f.request());
  await turn();
  assert.equal(f.calls.length, 32); assert.equal(f.state().active, 32);
  const refusalRequest = f.request(); await turn(); assert.equal(f.calls.length, 32);
  assert.equal((await refusalRequest).status, 503);
  await f.drain();
  for (const response of await Promise.all(accepted)) {
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.deepEqual(body.sources.map((row: any) => row.connectionId), Array.from({ length: 11 }, (_, index) => `node-${index}`));
    assert.equal(body.groups.reduce((count: number, group: any) => count + group.sessions.length, 0), 11);
  }
  assert.equal(f.calls.length, 88); assert.equal(f.state().maxActive, 32); assert.equal(f.state().active, 0);
  f.immediate(); assert.equal((await f.app.request('/api/hub/v1/sessions/state')).status, 200);
});

test('aborted aggregate requests retain all 32 original Connector reads until settlement and do not replay', async t => {
  const f = fixture(t, 11, true), accepted = Array.from({ length: 8 }, () => f.request());
  await turn(); assert.equal(f.calls.length, 32);
  f.signal.abort();
  const refusalRequest = f.app.request('/api/hub/v1/sessions/state'); await turn();
  assert.equal(f.calls.length, 32); assert.equal((await refusalRequest).status, 503);
  const first = f.waiting.keys().next().value!;
  f.release(first); await turn(); assert.equal(f.calls.length, 32); assert.equal(f.state().active, 31);
  const stillBusy = f.app.request('/api/hub/v1/sessions/state'); await turn();
  assert.equal((await stillBusy).status, 503); assert.equal(f.calls.length, 32);
  await f.drain();
  for (const response of await Promise.all(accepted)) assert.equal(response.status, 503);
  assert.equal(f.calls.length, 32); assert.equal(f.state().active, 0);
  f.immediate(); assert.equal((await f.app.request('/api/hub/v1/sessions/state')).status, 200);
});
