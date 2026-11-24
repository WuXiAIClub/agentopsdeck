import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { HubStore } from '../hub/hub-store.js';
import { AsyncHubMemberOwner } from '../hub/async-member-owner.js';
import { AsyncHubMemberRoles } from '../hub/async-member-roles.js';
import { executeHubMemberCommand } from '../hub/member-owner-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubRoleAccessRoutes } from './hub-role-access.js';

const conflict = { error: 'Role not saved. Self changes are prohibited; refresh the current role.' };
const unavailable = { error: 'Role persistence is unavailable. Reload the current role before retrying.' };
const quiet = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const base = '/api/hub/v1/access/users/';
type Port = Pick<AsyncHubMemberOwner, 'command'>;
const port = (call: (kind: string, input: unknown) => unknown): Port => ({
  command: (async (kind: string, input: unknown) => call(kind, input)) as Port['command'],
});
function appFor(store: HubStore, roles: AsyncHubMemberRoles) {
  const app = new Hono();
  registerHubRoleAccessRoutes(app, { hubStore: store, asyncRoles: roles,
    principal() { throw new Error('Async role HTTP must not invoke synchronous authority'); } });
  return app;
}
function seed(store: HubStore) {
  const admin = store.createUser('Administrator'), member = store.createUser('Member');
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.prepare("INSERT INTO hub_roles VALUES (?, 'admin', 1)").run(admin.id);
  const key = store.identities.issueKey(admin.id), token = store.identities.createSession(key.token)!;
  const headers = { cookie: 'agentopsdeck_session=' + token, 'content-type': 'application/json' };
  return { admin, member, db, headers };
}
async function fixture(work: (f: ReturnType<typeof seed> & { store: HubStore; app: Hono; roles: AsyncHubMemberRoles }) => unknown) {
  const root = mkdtempSync(join(tmpdir(), 'hub-role-http-')), store = new HubStore(join(root, 'hub.sqlite'), 'fixture');
  const roles = new AsyncHubMemberRoles(port((kind, input) => executeHubMemberCommand(store, kind as never, input as never)), quiet);
  try { await work({ ...seed(store), store, roles, app: appFor(store, roles) }); }
  finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
}
async function request(f: { app: Hono; headers: Record<string, string> }, user: string, body?: unknown) {
  return f.app.request(base + encodeURIComponent(user) + '/hub-role', {
    method: body === undefined ? 'GET' : 'PUT', headers: f.headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
test('awaited role HTTP preserves original frontend success, CAS conflicts and no-store contract', () => fixture(async f => {
  const read = await request(f, f.member.id); assert.equal(read.status, 200);
  assert.equal(read.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await read.json(), { role: 'member', version: 0 });
  const saved = await request(f, f.member.id, { role: 'admin', version: 0 });
  assert.equal(saved.status, 200); assert.deepEqual(await saved.json(), { role: 'admin', version: 1 });
  const stale = await request(f, f.member.id, { role: 'member', version: 0 });
  assert.equal(stale.status, 409); assert.deepEqual(await stale.json(), conflict);
  assert.deepEqual({ ...f.store.roles.hubRole(f.member.id) }, { role: 'admin', version: 1 });
  const demoted = await request(f, f.member.id, { role: 'member', version: 1 });
  assert.equal(demoted.status, 200); assert.deepEqual(await demoted.json(), { role: 'member', version: 2 });
}));
test('awaited role HTTP preserves self/missing write conflicts and read missing 404', () => fixture(async f => {
  for (const [id, version] of [[f.admin.id, 1], ['missing', 0]] as const) {
    const res = await request(f, id, { role: 'admin', version });
    assert.equal(res.status, 409); assert.deepEqual(await res.json(), conflict);
  }
  assert.equal((await request(f, 'missing')).status, 404);
}));
test('awaited role HTTP validates old exact body and prevents legacy safe-integer overflow', () => fixture(async f => {
  for (const body of [{ role: 'admin', version: -1 }, { role: 'admin', version: 0, extra: true },
    { role: 'admin', version: 0.5 }, { role: 'admin', version: '0' }, { role: 'other', version: 0 },
    { role: 'admin', version: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal((await request(f, f.member.id, body)).status, 400);
  }
  const res = await request(f, f.member.id, { role: 'admin', version: Number.MAX_SAFE_INTEGER });
  assert.equal(res.status, 409); assert.deepEqual(await res.json(), conflict);
  assert.deepEqual(f.store.roles.hubRole(f.member.id), { role: 'member', version: 0 });
}));
test('awaited role HTTP denies unauthorized requests before reading malformed body', () => fixture(async f => {
  const denied = await f.app.request(base + f.member.id + '/hub-role', { method: 'PUT', body: '{' });
  assert.equal(denied.status, 401);
  const token = f.store.identities.createSession(f.store.identities.issueKey(f.member.id).token)!;
  const res = await f.app.request(base + f.member.id + '/hub-role', { method: 'PUT',
    headers: { cookie: 'agentopsdeck_session=' + token }, body: '{' });
  assert.equal(res.status, 403);
}));
test('awaited role HTTP rechecks original authority after request body yields', () => fixture(async f => {
  let deliver!: () => void;
  const body = new ReadableStream<Uint8Array>({ start(controller) { deliver = () => {
    controller.enqueue(new TextEncoder().encode('{"role":"admin","version":0}')); controller.close();
  }; } });
  const pending = f.app.request(new Request('http://fixture.invalid' + base + f.member.id + '/hub-role', {
    method: 'PUT', headers: f.headers, body, duplex: 'half',
  } as RequestInit));
  await tick(); await tick();
  f.db.prepare("UPDATE hub_roles SET role='member', version=version+1 WHERE user_id=?").run(f.admin.id);
  deliver(); assert.equal((await pending).status, 403);
  assert.deepEqual(f.store.roles.hubRole(f.member.id), { role: 'member', version: 0 });
}));
test('awaited role HTTP SQL failure rolls back, reports 503 and remains readable', () => fixture(async f => {
  f.db.exec("CREATE TRIGGER reject_role BEFORE INSERT ON hub_roles BEGIN SELECT RAISE(ABORT, 'private_sql_text'); END");
  const res = await request(f, f.member.id, { role: 'admin', version: 0 });
  assert.equal(res.status, 503); assert.deepEqual(await res.json(), unavailable);
  assert.deepEqual(f.store.roles.hubRole(f.member.id), { role: 'member', version: 0 });
  assert.equal(f.db.isTransaction, false); f.db.exec('DROP TRIGGER reject_role');
  assert.equal((await request(f, f.member.id)).status, 200);
}));
test('awaited role HTTP lost commit confirmation does not replay or claim domain conflict', () => fixture(async f => {
  let writes = 0;
  const roles = new AsyncHubMemberRoles(port((kind, input) => {
    const value = executeHubMemberCommand(f.store, kind as never, input as never);
    if (kind === 'roleSet') { writes++; throw new Error('private_confirmation_lost'); }
    return value;
  }), quiet);
  const app = appFor(f.store, roles), res = await request({ ...f, app }, f.member.id, { role: 'admin', version: 0 });
  assert.equal(res.status, 503); assert.deepEqual(await res.json(), unavailable); assert.equal(writes, 1);
  assert.deepEqual(await (await request({ ...f, app }, f.member.id)).json(), { role: 'admin', version: 1 });
  assert.equal(writes, 1);
}));
test('awaited role HTTP rejects retargeted success ACK without exposing it', () => fixture(async f => {
  const roles = new AsyncHubMemberRoles(port((kind, input) => kind === 'roleSet'
    ? { userId: 'other-target', role: 'admin', version: 1 }
    : executeHubMemberCommand(f.store, kind as never, input as never)), quiet);
  const res = await request({ ...f, app: appFor(f.store, roles) }, f.member.id, { role: 'admin', version: 0 });
  assert.equal(res.status, 503); assert.deepEqual(await res.json(), unavailable);
  assert.deepEqual(f.store.roles.hubRole(f.member.id), { role: 'member', version: 0 });
}));
test('awaited role HTTP pending write cannot time out, release admission or lose private-safe logs', () => fixture(async f => {
  let settle!: () => void, writes = 0; const logs: string[] = [];
  const roles = new AsyncHubMemberRoles(port((kind, input) => kind === 'roleSet'
    ? new Promise(resolve => { writes++; settle = () => resolve(executeHubMemberCommand(f.store, kind as never, input as never)); })
    : executeHubMemberCommand(f.store, kind as never, input as never)), new PerformanceDiagnostics(line => logs.push(line)), 5, 50);
  let finished = false;
  const pending = request({ ...f, app: appFor(f.store, roles) }, f.member.id, { role: 'admin', version: 0 }).then(res => { finished = true; return res; });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(finished, false); assert.equal(roles.pending, 1); assert.equal(writes, 1);
  assert.ok(logs.some(line => { const r = JSON.parse(line); return r.step === 36 && r.phase === 'pending'; }));
  assert.ok(logs.every(line => !line.includes(f.headers.cookie) && !line.includes(f.member.id)));
  settle(); assert.equal((await pending).status, 200); assert.equal(roles.pending, 0); assert.equal(writes, 1);
}));
test('awaited role HTTP abort before dispatch is 499 without any durable effect', () => fixture(async f => {
  const controller = new AbortController(); controller.abort();
  const res = await f.app.request(new Request('http://fixture.invalid' + base + f.member.id + '/hub-role', {
    method: 'PUT', headers: f.headers, body: '{"role":"admin","version":0}', signal: controller.signal,
  }));
  assert.equal(res.status, 499); assert.deepEqual(f.store.roles.hubRole(f.member.id), { role: 'member', version: 0 });
}));
test('awaited role HTTP real original worker survives close and original frontend reads persisted role', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-role-worker-http-')), file = join(root, 'hub.sqlite');
  let store = new HubStore(file, 'fixture'); const seeded = seed(store); await store.close();
  const owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture' }, quiet);
  try {
    const app = appFor(store, new AsyncHubMemberRoles(owner, quiet));
    const res = await request({ ...seeded, app }, seeded.member.id, { role: 'admin', version: 0 });
    assert.equal(res.status, 200); assert.deepEqual(await res.json(), { role: 'admin', version: 1 });
  } finally { await owner.close(); }
  store = new HubStore(file, 'fixture');
  try {
    const app = new Hono(); registerHubRoleAccessRoutes(app, { hubStore: store, principal: () => ({ userId: seeded.admin.id, admin: true }) });
    const read = await request({ ...seeded, app }, seeded.member.id);
    assert.equal(read.status, 200); assert.deepEqual(await read.json(), { role: 'admin', version: 1 });
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});
