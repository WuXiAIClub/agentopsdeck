import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { HubStore } from '../hub/hub-store.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { CompletionConflict, connectionCompletionTarget } from '../hub/completion-unread-store.js';
import { encodeHubSessionId } from '../hub/session-id.js';
import { registerHubCompletionRoutes, registerHubCompletions, type HubCompletionsPort } from './hub-completions.js';
import type { HubCompletionResult } from '../hub/member-completion-domain.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';
const base = '/api/hub/v1/completions/';
const actor = { userId: 'alice', admin: false };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function setup(command: HubCompletionsPort['command'], authority = () => actor) {
  const app = new Hono();
  registerHubCompletionRoutes(app, { principal: () => actor, synchronousStoreAuthority: authority, port: { command } });
  app.onError((error, c) => error instanceof HTTPException ? c.json({ error: error.message }, error.status) : c.json({ error: 'unexpected' }, 500));
  const send = async (action = 'summary', body: unknown = { sessions: [] }, signal?: AbortSignal) => app.request(new Request('http://localhost' + base + action,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {}) }));
  return { app, send };
}
test('async summary preserves original response, scope and no-store', async () => {
  let calls = 0;
  const { send } = setup(async (_request, user, command) => { calls++; assert.equal(user, 'alice'); assert.deepEqual(command, { action: 'summary', sessions: [] }); return { items: [] }; });
  const response = await send(); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { items: [] });
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(calls, 1);
});
for (const status of [401, 403, 409, 499, 503] as const) for (const sync of [true, false])
  test(`trusted ${sync ? 'sync' : 'async'} member refusal ${status} survives read guard`, async () => {
    const fail = () => { throw new HubMemberRequestError(status); };
    const { send } = setup(sync ? fail : async () => fail());
    const response = await send(); assert.equal(response.status, status); assert.equal(response.headers.get('cache-control'), 'no-store');
  });
for (const status of [400, 404] as const) for (const sync of [true, false])
  test(`trusted ${sync ? 'sync' : 'async'} target HTTP refusal ${status} remains compatible`, async () => {
    const fail = () => { throw new HTTPException(status); };
    const response = await setup(sync ? fail : async () => fail()).send(); assert.equal(response.status, status);
  });
test('known completion conflict is 409, unknown storage failures are sanitized 503', async () => {
  const conflict = await setup(async () => { throw new CompletionConflict('target-limit'); }).send();
  assert.equal(conflict.status, 409); assert.deepEqual(await conflict.json(), { error: 'target-limit' });
  for (const sync of [true, false]) {
    const fail = () => { throw Error('PRIVATE-path-cookie-session'); };
    const response = await setup(sync ? fail : async () => fail()).send(); assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /PRIVATE/);
  }
});
test('post-await authority change refuses buffered summary', async () => {
  let valid = true, resolve!: (result: HubCompletionResult) => void;
  const { send } = setup(() => new Promise(done => { resolve = done; }), () => valid ? actor : { ...actor, userId: 'bob' });
  const response = send(); await turn(); valid = false; resolve({ items: [] }); assert.equal((await response).status, 401);
});
test('cancel ends only HTTP wait, never the original summary or a write', async () => {
  let resolve!: (result: HubCompletionResult) => void, calls = 0, settled = false;
  const { send } = setup(async () => { calls++; const value = await new Promise<HubCompletionResult>(done => { resolve = done; }); settled = true; return value; });
  const controller = new AbortController(), response = send('summary', { sessions: [] }, controller.signal);
  await turn(); controller.abort(); assert.equal((await response).status, 499);
  assert.equal(settled, false); assert.equal(calls, 1); resolve({ items: [] }); await turn(); assert.equal(settled, true); assert.equal(calls, 1);
});
test('pre-cancelled body preserves existing 408 and never dispatches summary', async () => {
  let calls = 0; const { send } = setup(() => { calls++; return { items: [] }; });
  const controller = new AbortController(); controller.abort(); assert.equal((await send('summary', { sessions: [] }, controller.signal)).status, 408);
  assert.equal(calls, 0);
});
test('observe/read still await original effect after abort, without summary timeout or replay', async () => {
  for (const action of ['observe', 'read'] as const) {
    let resolve!: (value: HubCompletionResult) => void, calls = 0, ended = false;
    const { send } = setup(() => { calls++; return new Promise(done => { resolve = done; }); });
    const controller = new AbortController(), body = action === 'observe' ? { sessionKey: 'node:YQ' }
      : { sessionKey: 'node:YQ', requestId: 'receipt', token: 'token', throughSequence: 1 };
    const response = send(action, body, controller.signal).then(r => { ended = true; return r; });
    await turn(); controller.abort(); await turn(); assert.equal(ended, false); assert.equal(calls, 1);
    resolve(action === 'observe' ? { observation: { token: 'token', generation: 'generation', throughSequence: 1, expiresAt: 1 } } : { throughSequence: 1 });
    assert.equal((await response).status, 200); assert.equal(calls, 1);
  }
});
function actual(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'summary-http-')), store = new HubStore(join(root, 'hub.sqlite'), 'synthetic'), app = new Hono();
  t.after(async () => { await store.close(); rmSync(root, { recursive: true, force: true }); });
  store.upsertConnection({ id: 'node', ownerUserId: 'alice', label: 'Original', connectorUrl: 'http://fixture.invalid', credentialToken: 'synthetic', capabilities: ['events'] });
  store.pinConnectionNode('node', 'alice', store.connectionAuthority('node', 'alice')!, 'node_00000000-0000-4000-8000-000000000001');
  const key = encodeHubSessionId('node', 'codex:original-long-session');
  const target = connectionCompletionTarget(store.getConnection('node', 'alice')!.nodeId!, 'node', store.connectionAuthority('node', 'alice')!, 'codex:original-long-session');
  store.completions.baseline('alice', target, 'epoch', 10);
  store.completions.record({ owner: 'alice', target, epoch: 'epoch', turnId: 'original-turn', sourceCursor: 11, provenance: 'live-successful-message' });
  registerHubCompletions(app, store, () => actor);
  app.onError((error, c) => error instanceof HTTPException ? c.json({ error: error.message }, error.status) : c.json({ error: 'unexpected' }, 500));
  const send = (sessions: string[]) => app.request(base + 'summary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessions }) });
  return { store, target, key, send, db: (store as unknown as { db: DatabaseSync }).db };
}
test('actual HTTP summary uses only readonly content SQL; legacy response, missing targets and invalid target statuses preserved', async t => {
  const { store, key, send, db } = actual(t);
  t.mock.method(db, 'prepare', function(this: DatabaseSync, sql: string) { assert.doesNotMatch(sql, /FROM completion_targets/i); return DatabaseSync.prototype.prepare.call(this, sql); });
  t.mock.method(store.completions, 'summary', () => { throw Error('sync summary forbidden'); });
  const response = await send([key, key, encodeHubSessionId('missing', 'codex:missing')]); assert.equal(response.status, 200);
  const body = await response.json() as { items: Array<Record<string, unknown>> }; assert.equal(body.items.length, 1);
  assert.equal(body.items[0]!.sessionKey, key); assert.equal(body.items[0]!.unread, true);
  assert.deepEqual(Object.keys(body.items[0]!).sort(), ['coverage','displayTarget','generation','latestSequence','readThrough','sessionKey','unread']);
  assert.equal((await send(['invalid'])).status, 400);
});
test('actual credential authority changes even with unchanged display version refuse old summary; retry has no replay', async t => {
  const { store, key, send, db } = actual(t), version = store.connectionDirectoryVersion('alice'), original = store.completionSummaryAsync.bind(store);
  let resolve!: () => void, calls = 0, ready!: () => void;
  const admitted = new Promise<void>(done => { ready = done; });
  const lastSequence = performanceDiagnostics.snapshot().events.at(-1)?.sequence ?? 0;
  const mock = t.mock.method(store, 'completionSummaryAsync', async (owner: string, targets: string[]) => {
    calls++; const rows = await original(owner, targets); await new Promise<void>(done => { resolve = done; ready(); }); return rows;
  });
  const response = send([key]);
  await admitted; store.updateMaintenanceCredential('node', 'synthetic-replacement', 'alice');
  assert.equal(store.connectionDirectoryVersion('alice'), version);
  resolve(); assert.equal((await response).status, 503); assert.equal(calls, 1); mock.mock.restore();
  const events = performanceDiagnostics.snapshot().events.filter(event => event.sequence > lastSequence
    && event.operation === 'hub-completion-summary-read' && event.step === 3);
  assert.equal(events.length, 1); assert.equal(events[0]!.changed, 1);
  assert.equal(events[0]!.settled, 1); assert.equal(events[0]!.deferred, 1);
  assert.doesNotMatch(JSON.stringify(events), /alice|codex:original|synthetic-replacement/);
  assert.deepEqual(await (await send([key])).json(), { items: [] });
  assert.equal(db.prepare('SELECT count(*) n FROM completion_events').get()!.n, 1);
});
test('actual corrupt summary is not empty unread; writer repair restores original state without new observations', async t => {
  const { store, key, send, db } = actual(t);
  const generation = db.prepare('SELECT generation FROM completion_targets').get()!.generation!;
  db.exec("UPDATE completion_targets SET generation='broken'"); const failed = await send([key]); assert.equal(failed.status, 503);
  assert.doesNotMatch(await failed.text(), /broken|sqlite|generation/);
  db.prepare('UPDATE completion_targets SET generation=?').run(generation);
  const response = await send([key]); assert.equal(response.status, 200);
  assert.equal((await response.json() as { items: Array<{ unread: boolean }> }).items[0]!.unread, true);
  assert.equal(db.prepare('SELECT count(*) n FROM completion_observations').get()!.n, 0);
  assert.equal(store.completions.summary('alice', [connectionCompletionTarget(store.getConnection('node','alice')!.nodeId!, 'node', store.connectionAuthority('node','alice')!, 'codex:original-long-session')])[0]!.latestSequence, 1);
});
