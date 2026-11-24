import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { api, ApiResponseError, setRecoveryScope } from '../api.js';
import { setWorkspaceSyncEnabled } from './workspace-sync-preference.js';

function fixture(t: TestContext) {
  const oldWindow = globalThis.window, oldFetch = globalThis.fetch, events: string[] = [];
  Object.assign(globalThis, { window: { setTimeout, clearTimeout, dispatchEvent(event: Event) { events.push(event.type); },
    location: { hostname: 'example.invalid', protocol: 'https:' },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} } } });
  setRecoveryScope('e'.repeat(64)); setWorkspaceSyncEnabled(false);
  t.after(() => { setWorkspaceSyncEnabled(false); setRecoveryScope(undefined); Object.assign(globalThis, { window: oldWindow, fetch: oldFetch }); });
  return { events };
}

for (const capacityError of ['hub_session_reads_busy', 'hub_session_response_busy', 'auth_persistence_failed'] as const) {
test(`Hub ${capacityError} does not reset authentication, replay writes or evict verified messages`, async t => {
  const f = fixture(t), key = 'connector:Y29kZXg6c3ludGhldGlj';
  const history = { messages: [{ id: 'retained', sessionKey: key, role: 'assistant', text: 'retained history', createdAt: 1 }],
    updatedAt: 1, totalCount: 1, hiddenCount: 0 };
  const calls: { path: string; method: string }[] = [];
  let busy = true;
  const snapshot = { groups: [], connections: [], sources: [], sourceStates: [], updatedAt: 2, revision: 'recovered' };
  globalThis.fetch = async (url, init) => {
    const path = String(url); calls.push({ path, method: init?.method ?? 'GET' });
    assert.equal(init?.credentials, 'include');
    assert.equal(new Headers(init?.headers).get('x-agentopsdeck-recovery-scope'), 'e'.repeat(64));
    if (path.includes('/messages?')) return Response.json(history, { headers: { etag: '"verified-history"' } });
    assert.equal(path, '/api/hub/v1/sessions/state');
    return busy ? Response.json({ error: capacityError }, { status: 503, headers: { 'cache-control': 'no-store' } }) : Response.json(snapshot);
  };
  await api.sessionMessages(key);
  await assert.rejects(api.sessionsState(), error => error instanceof ApiResponseError && error.status === 503 && error.message === capacityError);
  assert.deepEqual(api.cachedSessionMessages(key), history);
  assert.deepEqual(f.events, []); assert.equal(calls.length, 2);
  busy = false; assert.deepEqual(await api.sessionsState(), snapshot);
  assert.equal(calls.length, 3); assert.ok(calls.every(call => call.method === 'GET'));
  assert.deepEqual(api.cachedSessionMessages(key), history);
});

test(`shared frontend ${capacityError} retains one original refused GET then allows fresh scoped recovery`, async t => {
  const f = fixture(t); let reads = 0, resolve!: (value: Response) => void;
  const gate = new Promise<Response>(done => { resolve = done; });
  globalThis.fetch = async (_url, init) => {
    assert.equal(init?.method ?? 'GET', 'GET'); reads++;
    return reads === 1 ? gate : Response.json({ groups: [], updatedAt: 3 });
  };
  const a = api.sessionsState(), b = api.sessionsState();
  const outcomes = Promise.allSettled([a, b]);
  resolve(Response.json({ error: capacityError }, { status: 503 }));
  for (const outcome of await outcomes) {
    assert.equal(outcome.status, 'rejected');
    if (outcome.status === 'rejected') assert.equal(outcome.reason.status, 503);
  }
  assert.equal(reads, 1); assert.deepEqual(f.events, []);
  assert.deepEqual(await api.sessionsState(), { groups: [], updatedAt: 3 }); assert.equal(reads, 2);
});
}
