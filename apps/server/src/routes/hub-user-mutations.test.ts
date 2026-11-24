import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { HubStore } from '../hub/hub-store.js';
import type { HubPrincipal } from '../hub/identity.js';
import { AsyncHubMemberOwner } from '../hub/async-member-owner.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from '../hub/async-member-request.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubUserMutations, registerSynchronousHubUserMutations, type HubUserMutationAuthority } from './hub-user-mutations.js';

const quiet = new PerformanceDiagnostics(() => {});
const admin = Object.freeze({ userId: 'admin', admin: true });
const user = { id: 'user_existing', label: 'Existing', createdAt: 1, updatedAt: 1 };
const request = (app: Hono, label: unknown, id?: string) => app.request('/api/hub/v1/users'+(id ? '/'+id : ''), {
  method: id ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label, frontendExtra: true }),
});
function appFor(authority: HubUserMutationAuthority, diagnostics = quiet, warningMs = 30_000) {
  const app = new Hono(); registerHubUserMutations(app, { begin: () => authority, normalizeError: () => 'normalized error', diagnostics, warningMs }); return app;
}
for(const fault of ['start','add','add-getter','pending','pending-getter','finish','finish-getter'] as const)
test('user '+fault+' observation cannot replace a once-only write ACK',async t=>{
  const diagnostics=new PerformanceDiagnostics(()=>{});let writes=0;
  t.mock.method(diagnostics,'start',()=>{
    if(fault==='start')throw Error('PRIVATE log start');
    return {
      get add(){if(fault==='add-getter')throw Error('PRIVATE getter');return ()=>{if(fault==='add')throw Error('PRIVATE add');};},
      get reportPending(){if(fault==='pending-getter')throw Error('PRIVATE getter');return ()=>{if(fault==='pending')throw Error('PRIVATE pending');};},
      get finish(){if(fault==='finish-getter')throw Error('PRIVATE getter');return ()=>{if(fault==='finish')throw Error('PRIVATE finish');};},
    };
  });
  const app=appFor({principal:admin,check(){},async createUser(){writes++;await new Promise(resolve=>setTimeout(resolve,10));return user;},updateUser:()=>user},diagnostics,1);
  const response=await request(app,'Valid');assert.equal(response.status,201);assert.equal(writes,1);
  assert.deepEqual((await response.json()).user,user);
});
test('synchronous original facade preserves frontend user JSON, validation and missing-user errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-users-http-')), store = new HubStore(join(root, 'hub.sqlite'), 'fixture');
  const app = new Hono(); registerSynchronousHubUserMutations(app, store, () => admin, () => 'normalized error');
  try {
    const created = await request(app, '  Existing\n user  '); assert.equal(created.status, 201);
    const body = await created.json() as { user: typeof user; updatedAt: number };
    assert.deepEqual(Object.keys(body).sort(), ['updatedAt', 'user']);
    assert.deepEqual(Object.keys(body.user).sort(), ['createdAt', 'id', 'label', 'updatedAt']);
    assert.equal(body.user.label, 'Existing user'); assert.equal(created.headers.get('set-cookie'), null);
    const updated = await request(app, 'x'.repeat(119)+' z', body.user.id); assert.equal(updated.status, 200);
    assert.equal((await updated.json() as {user: typeof user}).user.label, 'x'.repeat(119)+' ');
    for (const label of ['', '   ', 0, null, { toString: 'not executable' }]) {
      const invalid = await request(app, label); assert.equal(invalid.status, 400); assert.deepEqual(await invalid.json(), { error: 'label is required' });
    }
    const invalid = await app.request('/api/hub/v1/users', { method: 'POST', body: 'null' }); assert.equal(invalid.status, 400);
    const missing = await request(app, 'New', 'missing'); assert.equal(missing.status, 404); assert.deepEqual(await missing.json(), { error: 'user not found' });
    assert.equal(store.listUsers().length, 2); assert.equal(created.headers.get('cache-control'), 'no-store');
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('original synchronous effects are checked in the same task and final denial never replays a write', async () => {
  let actor: HubPrincipal = admin, writes = 0;
  const app = new Hono(); registerSynchronousHubUserMutations(app, {
    createUser: () => { writes++; actor = { userId: 'other', admin: true }; return user; }, updateUser: () => user,
  }, () => actor, () => 'normalized error');
  assert.equal((await request(app, 'New')).status, 401); assert.equal(writes, 1);
});

test('synchronous facade rechecks account changes in the await gap immediately before its original effect', async () => {
  let actor: HubPrincipal = admin, proofs = 0, writes = 0;
  const app = new Hono(); registerSynchronousHubUserMutations(app, {
    createUser() { writes++; return user; }, updateUser() { writes++; return user; },
  }, () => {
    if (++proofs === 2) queueMicrotask(() => { actor = { userId: 'other', admin: true }; });
    return actor;
  }, () => 'normalized error');
  const response = await request(app, 'New');
  assert.equal(response.status, 401); assert.equal(proofs, 3); assert.equal(writes, 0);
});

test('there is no await between the final synchronous pre-effect proof and original write', async () => {
  let actor: HubPrincipal = admin, proofs = 0, writes = 0;
  const app = new Hono(); registerSynchronousHubUserMutations(app, {
    createUser() { assert.equal(actor.userId, admin.userId); writes++; return user; }, updateUser: () => user,
  }, () => {
    if (++proofs === 3) queueMicrotask(() => { actor = { userId: 'other', admin: true }; });
    return actor;
  }, () => 'normalized error');
  const response = await request(app, 'New');
  assert.equal(response.status, 401); assert.equal(proofs, 4); assert.equal(writes, 1);
});

test('delivery denial after returned user mutation logs settlement without claiming rollback or replay', async () => {
  const logs: string[] = []; let checks = 0, writes = 0;
  const app = appFor({ principal: admin,
    check() { if (++checks === 2) throw new HubMemberRequestError(401); },
    createUser() { writes++; return user; }, updateUser: () => user,
  }, new PerformanceDiagnostics(line => logs.push(line)));
  const response = await request(app, 'PRIVATE committed label');
  assert.equal(response.status, 401); assert.equal(writes, 1);
  const rows = logs.map(line => JSON.parse(line)).filter(row => row.operation === 'hub-user-change');
  assert.equal(rows.length, 1); assert.equal(rows[0].phase, 'finished');
  assert.equal(rows[0].step, 5); assert.equal(rows[0].settled, 1);
  assert.equal(rows[0].unknown, undefined); assert.equal(rows[0].category, 'failed');
  assert.doesNotMatch(logs.join(''), /PRIVATE committed label/);
});

test('member authority cannot dispatch a user mutation', async () => {
  let writes = 0; const app = appFor({ principal: { userId: 'member', admin: false }, check() {}, createUser() { writes++; return user; }, updateUser() { writes++; return user; } });
  const r = await request(app, 'New'); assert.equal(r.status, 403); assert.deepEqual(await r.json(), { error: 'forbidden' }); assert.equal(writes, 0);
});

test('revocation during streamed body reading refuses the original mutation before effect', async () => {
  let finish!: () => void, allowed = true, writes = 0;
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"label":'));
    finish = () => { allowed = false; c.enqueue(new TextEncoder().encode('"New"}')); c.close(); }; } });
  const app = appFor({ principal: admin, check() { if (!allowed) throw new HubMemberRequestError(401); }, createUser() { writes++; return user; }, updateUser: () => user });
  const pending = app.fetch(new Request('http://fixture.invalid/api/hub/v1/users', { method: 'POST', body, duplex: 'half' } as RequestInit));
  await new Promise(resolve => setImmediate(resolve)); finish(); assert.equal((await pending).status, 401); assert.equal(writes, 0);
});

for (const status of [400, 401, 403, 404, 499, 503] as const) test('async user error '+status+' retains status without plaintext owner errors or retry', async () => {
  const logs: string[] = []; let writes = 0;
  const app = appFor({ principal: admin, check() {}, createUser() { writes++; throw new HubMemberRequestError(status); }, updateUser: () => user }, new PerformanceDiagnostics(line => logs.push(line)));
  const r = await request(app, 'PRIVATE user label'); assert.equal(r.status, status); assert.equal(writes, 1);
  assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal(r.headers.get('set-cookie'), null);
  assert.ok(logs.some(line => line.includes('"operation":"hub-user-change"') && line.includes('"step":4')));
  assert.ok(!logs.join('').includes('PRIVATE user label')); assert.ok(!JSON.stringify(await r.json()).includes('hub_member_request_unavailable'));
});

test('pending mutation produces bounded warning logs and cannot be released, cancelled or retried by HTTP', async () => {
  const logs: string[] = []; let settle!: () => void, writes = 0;
  const wait = new Promise<void>(resolve => { settle = resolve; });
  const app = appFor({ principal: admin, check() {}, async createUser() { writes++; await wait; return user; }, updateUser: () => user }, new PerformanceDiagnostics(line => logs.push(line)), 5);
  let returned = false; const pending = Promise.resolve(request(app, 'PRIVATE pending label')).then(r => { returned = true; return r; });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(returned, false); assert.equal(writes, 1);
  assert.ok(logs.some(line => line.includes('"phase":"pending"') && line.includes('"step":4')));
  settle(); assert.equal((await pending).status, 201); assert.equal(writes, 1);
  assert.ok(!logs.join('').includes('PRIVATE pending label'));
});

test('real complete async owner preserves existing Cookie, user save and reopen without a second writer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-users-http-owner-')), file = join(root, 'hub.sqlite');
  const original = new HubStore(file, 'fixture'); let owner: AsyncHubMemberOwner | undefined, newId = '';
  const actor = original.createUser('Original administrator'), db = (original as unknown as { db: DatabaseSync }).db;
  db.prepare("INSERT INTO hub_roles VALUES (?, 'admin', 1)").run(actor.id);
  const key = original.identities.issueKey(actor.id), cookie = original.identities.createSession(key.token)!;
  try {
    await original.close(); owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture' }, quiet); await owner.open();
    const service = new AsyncHubMemberRequests(owner, quiet), app = new Hono();
    registerHubUserMutations(app, { begin: c => service.begin(c.req.raw), normalizeError: () => 'normalized error', diagnostics: quiet });
    const send = (path: string, label: string, token = cookie) => app.request('/api/hub/v1/users'+path, {
      method: path ? 'PATCH' : 'POST', headers: { cookie: 'agentopsdeck_session='+token, 'Content-Type': 'application/json' }, body: JSON.stringify({ label }),
    });
    const created = await send('', 'x'.repeat(119)+' z'); assert.equal(created.status, 201);
    const body = await created.json() as { user: typeof user }; newId = body.user.id; assert.equal(body.user.label, 'x'.repeat(119)+' ');
    assert.equal(created.headers.get('set-cookie'), null); assert.equal((await send('/'+newId, 'Renamed')).status, 200);
    assert.equal((await send('/missing', 'New')).status, 404); assert.equal((await send('', 'Rejected', 'hub_session_'+'z'.repeat(43))).status, 401);
    assert.equal(service.pendingReads, 0); assert.equal(owner.snapshot().unavailable, false); await owner.close(); owner = undefined;
    const reopened = new HubStore(file, 'fixture');
    try { assert.equal(reopened.getUser(newId)!.label, 'Renamed'); assert.equal(reopened.listUsers().length, 3);
      assert.deepEqual(reopened.identities.requestPrincipal(new Request('http://fixture.invalid', { headers: { cookie: 'agentopsdeck_session='+cookie } }), () => false), { userId: actor.id, admin: true });
    } finally { await reopened.close(); }
  } finally { await owner?.close(); await original.close(); rmSync(root, { recursive: true, force: true }); }
});
