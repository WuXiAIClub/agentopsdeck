import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { HubStore } from './hub-store.js';
import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubMemberMemberships } from './async-member-memberships.js';
import { HubMemberRequestError } from './async-member-request.js';
import { executeHubMemberCommand, type HubMemberKind } from './member-owner-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubRoleAccessRoutes } from '../routes/hub-role-access.js';
const quiet = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
type Port = Pick<AsyncHubMemberOwner, 'command'>;
const port = (call: (kind: HubMemberKind, input: unknown) => unknown): Port => ({
  command: (async (kind: HubMemberKind, input: unknown) => call(kind, input)) as Port['command'],
});
const deferred = () => { let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>(r => { resolve = r; }); return { resolve, promise }; };
async function fixture(work: (f: ReturnType<typeof seed>) => unknown) {
  const root = mkdtempSync(join(tmpdir(), 'hub-membership-http-')), store = new HubStore(join(root, 'hub.sqlite'), 'fixture');
  try { await work(seed(store)); }
  finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
}
function seed(store: HubStore) {
  const db = (store as unknown as { db: DatabaseSync }).db;
  const owner = store.createUser('Owner'), member = store.createUser('Member');
  store.upsertConnection({ id: 'node', ownerUserId: owner.id, kind: 'remote', label: 'Node', connectorUrl: 'http://private.invalid' });
  store.pinConnectionNode('node', owner.id, store.connectionAuthority('node', owner.id)!, 'node_' + randomUUID());
  const actor = { userId: owner.id, admin: false }, target = { ownerUserId: owner.id, connectionId: 'node', userId: member.id };
  const key = store.identities.issueKey(owner.id), token = store.identities.createSession(key.token)!;
  const request = () => new Request('http://fixture.invalid', { headers: { cookie: 'agentopsdeck_session=' + token } });
  const input = () => ({ role: 'developer' as const, version: store.roles.membership(target).version,
    nodeVersion: store.connectionAuthority('node', owner.id)!, environments: { codex: 'developer' as const, openclaw: 'disabled' as const }, migrateLegacy: true,
    grantSetDigest: store.roles.snapshot(actor, target).grantSetDigest });
  const calls: HubMemberKind[] = [];
  const call = (kind: HubMemberKind, value: unknown) => { calls.push(kind); return executeHubMemberCommand(store, kind, value as never); };
  const original = port(call);
  const route = (asyncMemberships: Pick<AsyncHubMemberMemberships, 'authorize' | 'read' | 'set'> = new AsyncHubMemberMemberships(original, quiet)) => {
    const app = new Hono(); registerHubRoleAccessRoutes(app, { hubStore: store,
      principal: () => { throw new Error('async route must not use synchronous principal'); }, asyncMemberships });
    const path = `/api/hub/v1/access/${owner.id}/connections/node/members/${member.id}`;
    const http = (method = 'GET', body?: unknown, pathname = path) => app.request(pathname, { method,
      headers: request().headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { app, path, http };
  };
  return { db, store, owner, member, actor, target, key, token, request, input, calls, call, original, route };
}
test('awaited membership GET/PUT retains exact original frontend shape, audit and CAS', () => fixture(async f => {
  const { http } = f.route();
  const read = await http(); assert.equal(read.status, 200); assert.equal(read.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await read.json(), f.store.roles.snapshot(f.actor, f.target));
  const body = f.input(), saved = await http('PUT', body); assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), f.store.roles.snapshot(f.actor, f.target));
  assert.equal(f.calls.filter(k => k === 'membershipSet').length, 1);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM hub_auth_audit WHERE record LIKE '%role_changed%'").get()!.n, 1);
  const stale = await http('PUT', body); assert.equal(stale.status, 409);
  assert.match(String((await stale.json() as {error: string}).error), /Refresh permissions/);
  assert.equal(f.store.roles.membership(f.target).version, 1);
}));
test('HTTP pre-body membership authorization precedes invalid JSON and missing recipient handling', () => fixture(async f => {
  const { app, path, http } = f.route();
  const denied = await app.request(path.replace('/connections/node/', '/connections/missing/'), {
    method: 'PUT', headers: f.request().headers, body: '{invalid',
  }); assert.equal(denied.status, 403); assert.equal(f.calls.includes('membershipSet'), false);
  assert.equal((await http('GET', undefined, path.replace(f.member.id, 'missing'))).status, 404);
  assert.equal((await http('PUT', f.input(), path.replace(f.member.id, 'missing'))).status, 409);
}));
test('HTTP strict body/overflow rejection preserves 400/409 and never dispatches mutation', () => fixture(async f => {
  const { http } = f.route();
  assert.equal((await http('PUT', { ...f.input(), environments: { codex: 'developer', openclaw: 'disabled', hermes: 'developer' } })).status, 400);
  assert.equal((await http('PUT', { ...f.input(), version: Number.MAX_SAFE_INTEGER })).status, 409);
  assert.equal(f.calls.includes('membershipSet'), false);
}));
test('HTTP stale grant confirmation conflicts without mutation; GET cannot silently retry PUT', () => fixture(async f => {
  const { http } = f.route(), reviewed = f.input();
  const grant = f.store.grants.create(f.target, { runtime: 'codex', actions: ['messages:read'] });
  assert.equal((await http('PUT', reviewed)).status, 409);
  assert.equal(f.store.roles.membership(f.target).version, 0);
  assert.equal(f.db.prepare('SELECT revoked FROM node_grants WHERE id=?').get(grant.id)!.revoked, 0);
  const read = await http(); assert.equal(read.status, 200);
  assert.notEqual((await read.json()).grantSetDigest, reviewed.grantSetDigest);
  assert.equal(f.calls.filter(k => k === 'membershipSet').length, 1);
  const { grantSetDigest: _digest, ...oldClient } = f.input();
  assert.equal((await http('PUT', oldClient)).status, 409);
  assert.equal((await http('PUT', f.input())).status, 200);
  assert.equal(f.db.prepare('SELECT revoked FROM node_grants WHERE id=?').get(grant.id)!.revoked, 1);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM hub_auth_audit WHERE record LIKE '%role_changed%'").get()!.n, 1);
}));
test('HTTP malformed confirmation digest is refused before membership dispatch', () => fixture(async f => {
  const { http } = f.route();
  for (const grantSetDigest of ['', 'A'.repeat(64), '0'.repeat(63), null, 7]) {
    assert.equal((await http('PUT', { ...f.input(), grantSetDigest })).status, 400);
  }
  assert.equal(f.calls.includes('membershipSet'), false);
  assert.equal(f.store.roles.membership(f.target).version, 0);
}));
test('HTTP rechecks revoked credentials after body read before any membership mutation', () => fixture(async f => {
  const bodyGate = deferred(), members = new AsyncHubMemberMemberships(f.original, quiet); let prechecks = 0;
  const { app, path } = f.route({
    read: members.read.bind(members), set: members.set.bind(members),
    authorize: async (request, target) => { await members.authorize(request, target);
      if (++prechecks === 1) setImmediate(() => bodyGate.resolve(null)); },
  }); let pulled = false;
  const body = new ReadableStream<Uint8Array>({ async pull(controller) {
    await bodyGate.promise;
    if (!pulled) { pulled = true; f.store.identities.revokeSession(f.token);
      controller.enqueue(new TextEncoder().encode(JSON.stringify(f.input()))); controller.close(); }
  } });
  const response = await app.request(new Request('http://fixture.invalid' + path,
    { method: 'PUT', headers: f.request().headers, body, duplex: 'half' } as RequestInit));
  assert.equal(response.status, 401); assert.equal(f.calls.includes('membershipSet'), false);
  assert.equal(prechecks, 1); // First check succeeded; post-body fresh identity failed.
  assert.equal(f.store.roles.membership(f.target).version, 0);
}));
test('SQL failure remains 503, original savepoint restores grants/audit, refresh does not replay', () => fixture(async f => {
  f.db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON hub_auth_audit WHEN NEW.record LIKE '%role_changed%' BEGIN SELECT RAISE(ABORT, 'private-sql-fault'); END");
  const { http } = f.route(), saved = await http('PUT', f.input());
  assert.equal(saved.status, 503); assert.match(JSON.stringify(await saved.json()), /Reload permissions/);
  assert.equal(f.store.roles.membership(f.target).version, 0); assert.equal(f.db.isTransaction, false);
  assert.equal(f.calls.filter(k => k === 'membershipSet').length, 1);
  assert.equal((await http()).status, 200); assert.equal(f.calls.filter(k => k === 'membershipSet').length, 1);
  f.db.exec('DROP TRIGGER fail_audit'); assert.equal((await http('PUT', f.input())).status, 200);
}));
for (const committed of [false, true]) test('outer membership commit uncertainty produces 503 without replay; committed=' + committed, () => fixture(async f => {
  const exec = f.db.exec.bind(f.db); let releases = 0;
  f.db.exec = sql => { if (sql === 'RELEASE hub_identity_check' && f.calls.at(-1) === 'membershipSet') {
    releases++; if (committed) exec(sql); throw new Error('private-commit-ack'); } exec(sql); };
  try { const response = await f.route().http('PUT', f.input()); assert.equal(response.status, 503);
    assert.equal(releases, 1); assert.equal(f.calls.filter(k => k === 'membershipSet').length, 1);
    assert.equal(f.store.roles.membership(f.target).version, committed ? 1 : 0); assert.equal(f.db.isTransaction, false);
  } finally { f.db.exec = exec; }
}));
test('membership read deadline preserves original admission and emits phase38 until actual settlement', () => fixture(async f => {
  const gate = deferred(), logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(line));
  let reply: unknown;
  const owner = port((kind, input) => { const result = f.call(kind, input);
    if (kind === 'membershipRead' && (input as {command: {action: string}}).command.action === 'read') { reply = result; return gate.promise; } return result; });
  const members = new AsyncHubMemberMemberships(owner, diagnostics, 5, 15);
  await assert.rejects(members.read(f.request(), f.target), e => e instanceof HubMemberRequestError && e.status === 503);
  assert.equal(members.pending, 1); assert.equal(f.calls.includes('membershipSet'), false);
  assert.ok(logs.some(line => { const e = JSON.parse(line); return e.step === 38 && e.timedOut === 1; }));
  gate.resolve(reply); await tick(); assert.equal(members.pending, 0);
  for (const secret of [f.token, f.key.token, f.owner.id, 'private.invalid']) assert.equal(logs.join('').includes(secret), false);
}));
test('read abort returns 499 but cannot free the original membership read slot', () => fixture(async f => {
  const gate = deferred(); let reply: unknown;
  const owner = port((kind, input) => { const result = f.call(kind, input);
    if (kind === 'membershipRead') { reply = result; return gate.promise; } return result; });
  const members = new AsyncHubMemberMemberships(owner, quiet, 30_000, 30_000), abort = new AbortController();
  const work = members.read(new Request('http://fixture.invalid', { headers: f.request().headers, signal: abort.signal }), f.target);
  void work.catch(() => {}); await tick(); abort.abort();
  await assert.rejects(work, e => e instanceof HubMemberRequestError && e.status === 499);
  assert.equal(members.pending, 1); gate.resolve(reply); await tick(); assert.equal(members.pending, 0);
}));
test('membership input target, environments and request headers remain owned across identity await', () => fixture(async f => {
  const gate = deferred(); let first = true;
  const owner = port(async (kind, input) => { if (first) { first = false; await gate.promise; } return f.call(kind, input); });
  const members = new AsyncHubMemberMemberships(owner, quiet), request = f.request(), target = { ...f.target }, body = f.input();
  const work = members.set(request, target, body);
  target.userId = f.owner.id; body.environments.codex = 'observer' as 'developer'; request.headers.set('cookie', 'agentopsdeck_session=invalid');
  gate.resolve(null); const saved = await work;
  assert.equal(saved.role, 'developer'); assert.equal(saved.environments.codex, 'developer');
  assert.equal(f.store.roles.membership(f.target).version, 1);
}));
test('malformed or different-target membership ACK cannot become frontend save success', () => fixture(async f => {
  const owner = port((kind, input) => { const result = f.call(kind, input);
    return kind === 'membershipSet' ? { target: { ...f.target, userId: f.owner.id }, snapshot: f.store.roles.snapshot(f.actor, f.target) } : result; });
  const response = await f.route(new AsyncHubMemberMemberships(owner, quiet)).http('PUT', f.input());
  assert.equal(response.status, 503); assert.equal(f.store.roles.membership(f.target).version, 1);
  assert.equal(f.calls.filter(k => k === 'membershipSet').length, 1);
}));
test('lost final credentials suppress response without replaying or undoing a committed membership', () => fixture(async f => {
  const owner = port((kind, input) => { const result = f.call(kind, input);
    if (kind === 'membershipSet') f.store.identities.revokeSession(f.token); return result; });
  const response = await f.route(new AsyncHubMemberMemberships(owner, quiet)).http('PUT', f.input());
  assert.equal(response.status, 401); assert.equal(f.store.roles.membership(f.target).version, 1);
  assert.equal(f.calls.filter(k => k === 'membershipSet').length, 1);
}));
test('membership transaction cannot settle an enclosing original transaction', () => fixture(async f => {
  f.db.exec('BEGIN');
  try {
    assert.equal((await f.route().http('PUT', f.input())).status, 200);
    assert.equal(f.db.isTransaction, true); assert.equal(f.store.roles.membership(f.target).version, 1);
  } finally { f.db.exec('ROLLBACK'); }
  assert.equal(f.store.roles.membership(f.target).version, 0);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM hub_auth_audit WHERE record LIKE '%role_changed%'").get()!.n, 0);
}));
test('inherited Hub administrator membership read does not create execution or membership grants', () => fixture(async f => {
  f.db.prepare("INSERT INTO hub_roles VALUES (?, 'admin', 1)").run(f.owner.id);
  const before = f.db.prepare('SELECT total_changes() AS n').get()!.n;
  const saved = await new AsyncHubMemberMemberships(f.original, quiet).read(f.request(), f.target);
  assert.deepEqual(saved, f.store.roles.snapshot({ userId: f.owner.id, admin: true }, f.target));
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get()!.n, before);
  assert.equal(f.store.grants.authorize(f.target, 'messages:send', { runtime: 'codex', sessionKey: 'codex:existing' }), undefined);
}));
test('original worker transaction rechecks deleted connection after HTTP authorization, no mutation replay', () => fixture(async f => {
  const owner = port((kind, input) => {
    if (kind === 'membershipSet') f.store.deleteConnection('node', f.owner.id);
    return f.call(kind, input);
  });
  const response = await f.route(new AsyncHubMemberMemberships(owner, quiet)).http('PUT', f.input());
  assert.equal(response.status, 403); assert.equal(f.store.roles.membership(f.target).version, 0);
  assert.equal(f.calls.filter(k => k === 'membershipSet').length, 1);
}));
