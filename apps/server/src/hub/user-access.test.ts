import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from './async-member-request.js';
import { executeHubMemberCommand, validHubMemberInput, validHubMemberOutput } from './member-owner-domain.js';
import { readHubUserAccess } from './user-access.js';
import { registerHubUserMutations, registerSynchronousHubUserMutations } from '../routes/hub-user-mutations.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
const denied = (status: number) => (error: unknown) => error instanceof HubMemberRequestError && error.status === status;
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function seed(file: string) {
  const store = new HubStore(file, 'synthetic', undefined, 'configured-administrator');
  const db = (store as unknown as { db: DatabaseSync }).db;
  const admin = store.createUser('Administrator'), member = store.createUser('Member'), other = store.createUser('Other');
  db.prepare("INSERT INTO hub_roles VALUES (?, 'admin', 1)").run(admin.id);
  const adminKey = store.identities.issueKey(admin.id), key = store.identities.issueKey(member.id), key2 = store.identities.issueKey(member.id);
  const cookie = store.identities.createSession(key.token)!, cookie2 = store.identities.createSession(key2.token)!;
  store.upsertConnection({ id: 'local', kind: 'local', label: 'Synthetic', connectorUrl: 'http://synthetic.invalid' });
  const target = { ownerUserId: 'default', connectionId: 'local', userId: member.id };
  const root = store.grants.create(target, { runtime: 'codex', sessionKey: 'codex:private', actions: ['messages:read'] });
  const child = store.grants.create({ ...target, userId: other.id }, { runtime: 'codex', sessionKey: 'codex:private', actions: ['messages:read'] });
  db.prepare('INSERT INTO node_grant_dependencies VALUES (?, ?, ?)').run(child.id, root.id, root.version);
  const independent = store.grants.create({ ...target, userId: other.id }, { runtime: 'codex', sessionKey: 'codex:other', actions: ['messages:read'] });
  const evidence = { accessKey: adminKey.token }, expectedScope = store.identities.recoveryScope({ userId: admin.id, admin: true });
  return { store, db, admin, member, other, adminKey, key, key2, cookie, cookie2, root, child, independent, target, evidence, expectedScope };
}
async function fixture(work: (f: ReturnType<typeof seed>, file: string) => unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'user-access-')), file = join(dir, 'hub.sqlite'), f = seed(file);
  try { await work(f, file); } finally { await f.store.close(); rmSync(dir, { recursive: true, force: true }); }
}
const change = (f: ReturnType<typeof seed>, status: 'enabled' | 'disabled', expectedVersion: number, userId = f.member.id) =>
  executeHubMemberCommand(f.store, 'userChange', { evidence: f.evidence, expectedScope: f.expectedScope,
    change: { action: 'accessChange', userId, status, expectedVersion } });
const grant = (f: ReturnType<typeof seed>, id: string) => f.store.grants.get(f.target, id)!;

test('global disable revokes all Keys/Cookies/linked identities and dependent grants, not independent users or Connectors', () => fixture(f => {
  const request = (cookie: string) => new Request('http://synthetic.invalid', { headers: { cookie: 'agentopsdeck_session=' + cookie } });
  const oldScope = f.store.identities.recoveryScope({ userId: f.member.id, admin: false });
  assert.deepEqual(change(f, 'disabled', 0), { access: { userId: f.member.id, status: 'disabled', version: 1 } });
  for (const key of [f.key, f.key2]) {
    assert.equal(f.store.identities.keyPrincipal(key.token), undefined);
    assert.equal(f.store.identities.keyIdentity(key.token), undefined);
    assert.equal(f.store.identities.linkedKeyPrincipal(key.id), undefined);
    assert.equal(f.store.identities.createSession(key.token), undefined);
  }
  for (const cookie of [f.cookie, f.cookie2]) {
    assert.equal(f.store.identities.requestPrincipal(request(cookie), () => true), undefined);
    assert.equal(f.store.identities.requestIdentity(request(cookie)), undefined);
  }
  assert.equal(f.db.prepare('SELECT count(*) n FROM hub_login_sessions').get()?.n, 0);
  assert.equal(f.store.identities.listKeys(f.member.id).length, 0);
  assert.throws(() => f.store.identities.issueKey(f.member.id), /User disabled/);
  assert.throws(() => f.store.grants.create(f.target, { actions: ['messages:read'] }));
  assert.equal(grant(f, f.root.id).revoked, true); assert.equal(grant(f, f.child.id).revoked, true);
  assert.equal(grant(f, f.independent.id).revoked, false);
  assert.equal(f.store.getConnection('local')?.status, 'enabled');
  assert.equal(f.store.identities.keyPrincipal(f.adminKey.token)?.userId, f.admin.id);
  assert.notEqual(oldScope, f.store.identities.recoveryScope({ userId: f.member.id, admin: false }));
  assert.deepEqual(change(f, 'enabled', 1), { access: { userId: f.member.id, status: 'enabled', version: 2 } });
  assert.equal(f.store.identities.keyPrincipal(f.key.token), undefined);
  assert.equal(f.store.identities.requestPrincipal(request(f.cookie), () => true), undefined);
  assert.equal(grant(f, f.root.id).revoked, true); assert.equal(grant(f, f.child.id).revoked, true);
  assert.notEqual(oldScope, f.store.identities.recoveryScope({ userId: f.member.id, admin: false }));
  const fresh = f.store.identities.issueKey(f.member.id);
  assert.equal(f.store.identities.keyPrincipal(fresh.token)?.userId, f.member.id);
  assert.equal(executeHubMemberCommand(f.store, 'connectionSnapshot', { evidence: { accessKey: fresh.token }, expectedScope: oldScope }), null);
  assert.deepEqual(f.store.identities.audit.list().filter(r => r.event === 'user_access_changed').map(r => r.reason).sort(),
    ['disabled:0:1', 'enabled:1:2']);
}));

test('revoked administrator evidence cannot apply lifecycle effects despite a previously valid scope', () => fixture(f => {
  f.store.identities.revokeKey(f.admin.id, f.adminKey.id);
  assert.equal(change(f, 'disabled', 0), null);
  assert.deepEqual(readHubUserAccess(f.db, f.member.id), { userId: f.member.id, status: 'enabled', version: 0 });
  assert.equal(grant(f, f.root.id).revoked, false);
  assert.equal(f.store.identities.keyPrincipal(f.key.token)?.userId, f.member.id);
}));

test('failed restoration keeps disabled state, epoch and all tombstones; maximum epoch cannot wrap', () => fixture(f => {
  change(f, 'disabled', 0);
  f.db.exec("CREATE TRIGGER fail_restore BEFORE UPDATE ON hub_user_access BEGIN SELECT RAISE(ABORT, 'restore_fault'); END;");
  assert.throws(() => change(f, 'enabled', 1), /restore_fault/);
  assert.deepEqual(readHubUserAccess(f.db, f.member.id), { userId: f.member.id, status: 'disabled', version: 1 });
  assert.equal(grant(f, f.root.id).revoked, true);
  assert.equal(f.store.identities.listKeys(f.member.id).length, 0);
  f.db.exec('DROP TRIGGER fail_restore');
  f.db.prepare('UPDATE hub_user_access SET version = ? WHERE user_id = ?').run(Number.MAX_SAFE_INTEGER, f.member.id);
  assert.throws(() => change(f, 'enabled', Number.MAX_SAFE_INTEGER));
  assert.equal(readHubUserAccess(f.db, f.member.id)?.version, Number.MAX_SAFE_INTEGER);
}));

test('persisted fences reject older SQL writers trying to give disabled users a Key or active grant', () => fixture(f => {
  change(f, 'disabled', 0);
  assert.throws(() => f.db.prepare('INSERT INTO hub_login_keys VALUES (?, ?, ?, ?)').run('blocked', f.member.id, 'synthetic-hash', 1), /User disabled/);
  assert.throws(() => f.db.prepare('UPDATE node_grants SET revoked = 0 WHERE id = ?').run(f.root.id), /User disabled/);
  const old = grant(f, f.independent.id);
  assert.throws(() => f.db.prepare('UPDATE node_grants SET user_id = ? WHERE id = ?').run(f.member.id, old.id), /User disabled/);
  assert.equal(grant(f, old.id).userId, f.other.id);
}));

for (const fault of ['state', 'keys', 'grants', 'audit'] as const) test(`disable ${fault} failure rolls back state, credentials, grants, descendants and audit together`, () => fixture(f => {
  const statements = {
    state: 'BEFORE INSERT ON hub_user_access', keys: 'BEFORE DELETE ON hub_login_keys',
    grants: 'BEFORE UPDATE ON node_grants', audit: 'BEFORE INSERT ON hub_auth_audit',
  };
  const beforeAudit = f.store.identities.audit.list();
  f.db.exec(`CREATE TRIGGER fail_access ${statements[fault]} BEGIN SELECT RAISE(ABORT, 'synthetic_failure'); END`);
  assert.throws(() => change(f, 'disabled', 0));
  assert.deepEqual(readHubUserAccess(f.db, f.member.id), { userId: f.member.id, status: 'enabled', version: 0 });
  assert.equal(f.store.identities.keyPrincipal(f.key.token)?.userId, f.member.id);
  assert.equal(f.store.identities.requestIdentity(new Request('http://synthetic.invalid', { headers: { cookie: 'agentopsdeck_session=' + f.cookie } }))?.userId, f.member.id);
  assert.equal(grant(f, f.root.id).revoked, false); assert.equal(grant(f, f.child.id).revoked, false);
  assert.deepEqual(f.store.identities.audit.list(), beforeAudit);
  f.db.exec('DROP TRIGGER fail_access'); assert.ok(change(f, 'disabled', 0));
}));

test('CAS/no-op and protected default/self/last keyed admin refuse without collateral mutations', () => fixture(f => {
  assert.deepEqual(change(f, 'disabled', 0, 'default'), { error: 'protected' });
  assert.deepEqual(change(f, 'disabled', 0, f.admin.id), { error: 'protected' });
  assert.deepEqual(change(f, 'disabled', 0, 'missing'), { error: 'missing' });
  assert.deepEqual(change(f, 'enabled', 0), { access: { userId: f.member.id, status: 'enabled', version: 0 } });
  change(f, 'disabled', 0);
  assert.deepEqual(change(f, 'enabled', 0), { error: 'conflict' });
  assert.deepEqual(change(f, 'disabled', 1), { access: { userId: f.member.id, status: 'disabled', version: 1 } });
  const before = f.store.identities.audit.list().length;
  const legacy = new HubStore(':memory:', 'synthetic', undefined, 'configured-administrator', () => true);
  try {
    const target = legacy.createUser('Only keyed administrator'), db = (legacy as unknown as { db: DatabaseSync }).db;
    db.prepare("INSERT INTO hub_roles VALUES (?, 'admin', 1)").run(target.id); legacy.identities.issueKey(target.id);
    const result = legacy.identities.administratorUserCommand(new Request('http://synthetic.invalid'),
      legacy.identities.recoveryScope({ userId: 'default', admin: true }), legacy,
      { action: 'accessChange', userId: target.id, status: 'disabled', expectedVersion: 0 });
    assert.deepEqual(result, { error: 'protected' });
  } finally { legacy.close(); }
  assert.equal(f.store.identities.audit.list().length, before);
}));

test('access command/output allowlist refuses forged roles, coercion, negative/overflow epochs and malformed access ACKs', () => fixture(f => {
  const input = { evidence: f.evidence, expectedScope: f.expectedScope,
    change: { action: 'accessChange', userId: f.member.id, status: 'disabled', expectedVersion: 0 } };
  assert.equal(validHubMemberInput('userChange', input), true);
  for (const change of [{ ...input.change, admin: true }, { ...input.change, expectedVersion: -1 },
    { ...input.change, expectedVersion: Number.MAX_SAFE_INTEGER }, { ...input.change, status: 'none' },
    { ...input.change, userId: '\0' }, { ...input.change, expectedVersion: '0' }]) {
    assert.equal(validHubMemberInput('userChange', { ...input, change }), false);
  }
  assert.equal(validHubMemberOutput('userChange', { access: { userId: f.member.id, status: 'disabled', version: 1 } }), true);
  assert.equal(validHubMemberOutput('userChange', { access: { userId: f.member.id, status: 'disabled', version: 1, admin: true } }), false);
}));

for (const mode of ['original', 'worker', 'synchronous'] as const) test(`${mode}: real HTTP disable, CAS, member refusal and reopen never resurrect old credentials/shares`, () => fixture(async (f, file) => {
  let owner: Pick<AsyncHubMemberOwner, 'command' | 'close'> | undefined, service: AsyncHubMemberRequests | undefined;
  const app = new Hono();
  if (mode === 'synchronous') registerSynchronousHubUserMutations(app, f.store,
    c => f.store.identities.requestPrincipal(c.req.raw, () => false) ?? (() => { throw new HubMemberRequestError(401); })(), () => 'normalized');
  else {
    if (mode === 'worker') { await f.store.close(); owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'synthetic', administratorKey: 'configured-administrator' }, quiet); await (owner as AsyncHubMemberOwner).open(); }
    else owner = new OriginalHubAdministrativeCommands(f.store, quiet);
    service = new AsyncHubMemberRequests(owner, quiet);
    registerHubUserMutations(app, { begin: c => service!.begin(c.req.raw), normalizeError: () => 'normalized', diagnostics: quiet });
  }
  const request = (method = 'GET', body?: unknown, key = f.adminKey.token, userId = f.member.id) => app.request(`/api/hub/v1/users/${userId}/access`, {
    method, headers: { authorization: 'Bearer ' + key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    assert.equal((await request('GET', undefined, f.key.token)).status, 403);
    assert.equal((await request('GET', undefined, f.adminKey.token, 'missing')).status, 404);
    assert.deepEqual((await (await request()).json()).access, { userId: f.member.id, status: 'enabled', version: 0 });
    assert.equal((await request('PATCH', { status: 'disabled', expectedVersion: 0, admin: true })).status, 400);
    const held = service ? await service.begin(new Request('http://synthetic.invalid', { headers: { cookie: 'agentopsdeck_session=' + f.cookie } })) : undefined;
    const response = await request('PATCH', { status: 'disabled', expectedVersion: 0 });
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('set-cookie'), null);
    assert.equal((await request('PATCH', { status: 'enabled', expectedVersion: 0 })).status, 409);
    assert.equal((await request('GET', undefined, f.key.token)).status, 401);
    if (held) await assert.rejects(held.check(), denied(401));
    assert.equal((await request('PATCH', { status: 'enabled', expectedVersion: 1 })).status, 200);
    if (held) await assert.rejects(held.check(), denied(401));
  } finally { await service?.close(); await owner?.close(); await f.store.close(); }
  const reopened = new HubStore(file, 'synthetic');
  try {
    assert.deepEqual(readHubUserAccess((reopened as unknown as { db: DatabaseSync }).db, f.member.id), { userId: f.member.id, status: 'enabled', version: 2 });
    assert.equal(reopened.identities.keyPrincipal(f.key.token), undefined);
    assert.equal(reopened.grants.get(f.target, f.root.id)?.revoked, true);
    assert.equal(reopened.grants.get(f.target, f.child.id)?.revoked, true);
    assert.equal(reopened.grants.get(f.target, f.independent.id)?.revoked, false);
    assert.equal(reopened.identities.keyPrincipal(reopened.identities.issueKey(f.member.id).token)?.userId, f.member.id);
  } finally { await reopened.close(); }
}));

for (const mode of ['original', 'worker'] as const) test(`${mode}: a lost disable ACK commits once and stale CAS reconciles without retry`, () => fixture(async (f, file) => {
  let owner: Pick<AsyncHubMemberOwner, 'command' | 'close'>;
  if (mode === 'worker') { await f.store.close(); const worker = new AsyncHubMemberOwner({ file, encryptionSecret: 'synthetic' }, quiet); await worker.open(); owner = worker; }
  else owner = new OriginalHubAdministrativeCommands(f.store, quiet);
  let writes = 0;
  const port: Pick<AsyncHubMemberOwner, 'command'> = { async command(kind, input) {
    const result = await owner.command(kind, input);
    if (kind === 'userChange' && (input as any).change.action === 'accessChange') { writes++; throw Error('synthetic_lost_ack'); }
    return result;
  } };
  const service = new AsyncHubMemberRequests(port, quiet), reconcile = new AsyncHubMemberRequests(owner, quiet);
  const request = new Request('http://synthetic.invalid', { headers: { authorization: 'Bearer ' + f.adminKey.token } });
  try {
    const caller = await service.begin(request);
    await assert.rejects(caller.setUserAccess(f.member.id, 'disabled', 0), denied(503));
    await assert.rejects(caller.setUserAccess(f.member.id, 'disabled', 0), denied(503)); assert.equal(writes, 1);
    const fresh = await reconcile.begin(request);
    assert.deepEqual(await fresh.getUserAccess(f.member.id), { userId: f.member.id, status: 'disabled', version: 1 });
    await assert.rejects(fresh.setUserAccess(f.member.id, 'disabled', 0), denied(409));
  } finally { await service.close(); await reconcile.close(); await owner.close(); }
}));

for (const access of [null, { userId: 'wrong-target', status: 'disabled', version: 1 },
  { status: 'disabled', version: 1 }, { userId: 'target', status: 'enabled', version: 1 },
  { userId: 'target', status: 'disabled', version: 9 }]) test(`malformed or mismatched lifecycle ACK ${JSON.stringify(access)} fails closed without replay`, () => fixture(async f => {
  const owner = new OriginalHubAdministrativeCommands(f.store, quiet); let writes = 0;
  const port: Pick<AsyncHubMemberOwner, 'command'> = { command: (async (kind, input) => {
    if (kind === 'userChange') {
      writes++;
      return { access: access && { ...access, userId: access.userId === 'target' ? f.member.id : access.userId } };
    }
    return owner.command(kind, input);
  }) as AsyncHubMemberOwner['command'] };
  const service = new AsyncHubMemberRequests(port, quiet);
  try {
    const caller = await service.begin(new Request('http://synthetic.invalid', { headers: { authorization: 'Bearer ' + f.adminKey.token } }));
    await assert.rejects(caller.setUserAccess(f.member.id, 'disabled', 0), denied(503));
    await assert.rejects(caller.setUserAccess(f.member.id, 'disabled', 0), denied(503));
    assert.equal(writes, 1);
    assert.equal(readHubUserAccess(f.db, f.member.id)?.status, 'enabled');
  } finally { await service.close(); await owner.close(); }
}));

test('administrator revocation after disable commit hides the late ACK but neither undoes nor repeats the effect', () => fixture(async f => {
  const owner = new OriginalHubAdministrativeCommands(f.store, quiet); let writes = 0;
  const port: Pick<AsyncHubMemberOwner, 'command'> = { command: (async (kind, input) => {
    const result = await owner.command(kind, input);
    if (kind === 'userChange') { writes++; f.store.identities.revokeKey(f.admin.id, f.adminKey.id); }
    return result;
  }) as AsyncHubMemberOwner['command'] };
  const service = new AsyncHubMemberRequests(port, quiet);
  try {
    const caller = await service.begin(new Request('http://synthetic.invalid', { headers: { authorization: 'Bearer ' + f.adminKey.token } }));
    await assert.rejects(caller.setUserAccess(f.member.id, 'disabled', 0), denied(401));
    await assert.rejects(caller.setUserAccess(f.member.id, 'disabled', 0), denied(401));
    assert.equal(writes, 1); assert.equal(readHubUserAccess(f.db, f.member.id)?.status, 'disabled');
  } finally { await service.close(); await owner.close(); }
}));

for (const boundary of ['revoke', 'close'] as const) test(`pending lifecycle HTTP body followed by ${boundary} cannot dispatch a mutation`, { timeout: 5000 }, () => fixture(async f => {
  const owner = new OriginalHubAdministrativeCommands(f.store, quiet), service = new AsyncHubMemberRequests(owner, quiet), app = new Hono();
  registerHubUserMutations(app, { begin: c => service.begin(c.req.raw), normalizeError: () => 'normalized', diagnostics: quiet });
  const entered = gate(), finish = gate();
  const body = new ReadableStream<Uint8Array>({ async pull(controller) {
    entered.resolve(); await finish.promise;
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ status: 'disabled', expectedVersion: 0 }))); controller.close();
  } }, { highWaterMark: 0 });
  const request = new Request(`http://synthetic.invalid/api/hub/v1/users/${f.member.id}/access`, {
    method: 'PATCH', headers: { authorization: 'Bearer ' + f.adminKey.token }, body, duplex: 'half',
  } as RequestInit);
  const flight = app.fetch(request);
  try {
    await entered.promise;
    if (boundary === 'close') await service.close(); else f.store.identities.revokeKey(f.admin.id, f.adminKey.id);
    finish.resolve();
    const response = await flight; assert.equal(response.status, boundary === 'close' ? 503 : 401);
    assert.equal(readHubUserAccess(f.db, f.member.id)?.status, 'enabled');
    assert.equal(grant(f, f.root.id).revoked, false);
  } finally { finish.resolve(); await flight; await service.close(); await owner.close(); }
}));

test('HTTP lifecycle body uses actual byte limit and leaves access unchanged on malformed or oversized JSON', () => fixture(async f => {
  const owner = new OriginalHubAdministrativeCommands(f.store, quiet), service = new AsyncHubMemberRequests(owner, quiet), app = new Hono();
  registerHubUserMutations(app, { begin: c => service.begin(c.req.raw), normalizeError: () => 'normalized', diagnostics: quiet });
  try {
    for (const [body, status] of [['{', 400], ['x'.repeat(1025), 413]] as const) {
      const response = await app.request(`/api/hub/v1/users/${f.member.id}/access`, {
        method: 'PATCH', headers: { authorization: 'Bearer ' + f.adminKey.token, 'content-length': '1' }, body,
      });
      assert.equal(response.status, status); assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    assert.equal(readHubUserAccess(f.db, f.member.id)?.status, 'enabled');
  } finally { await service.close(); await owner.close(); }
}));
