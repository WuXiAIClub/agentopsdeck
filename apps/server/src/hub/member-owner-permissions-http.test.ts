import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { HubStore } from './hub-store.js';
import { LEGACY_HUB_PRINCIPAL } from './identity.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { OriginalHubAdministrativeCommands } from './original-administrative-commands.js';
import { createHubAdministrativeServices } from './administrative-route-services.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerAsyncHubPermissions, isAsyncHubPermissionRequest } from '../routes/hub-permissions-async.js';
import { registerHubRoutes } from '../routes/hub.js';
import { loadConfig } from '../config.js';
import { encodeHubSessionId } from './session-id.js';
import { pinOriginalRequestScope } from './original-request-scope.js';
import type { HubMemberKind } from './member-owner-domain.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
type Mode = 'original' | 'worker';

async function fixture(t: TestContext, mode: Mode, parent = false) {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-permissions-http-')), file = join(root, 'hub.sqlite');
  const seed = new HubStore(file, 'permissions-fixture');
  const admin = seed.createUser('Administrator'), creator = seed.createUser('Creator'), recipient = seed.createUser('Recipient'), member = seed.createUser('Member'), stranger = seed.createUser('Direct recipient');
  (seed as unknown as { db: DatabaseSync }).db.prepare("INSERT INTO hub_roles VALUES (?, 'admin', 1)").run(admin.id);
  seed.upsertConnection({ id: 'node', ownerUserId: admin.id, kind: 'remote', label: 'Node', connectorUrl: 'http://private.invalid' });
  seed.pinConnectionNode('node', admin.id, seed.connectionAuthority('node', admin.id)!, 'node_' + randomUUID());
  const nodeVersion = seed.connectionAuthority('node', admin.id)!;
  const target = (userId: string) => ({ ownerUserId: admin.id, connectionId: 'node', userId });
  for (const user of [creator, recipient]) seed.roles.save(LEGACY_HUB_PRINCIPAL, target(user.id), {
    ...seed.roles.membership(target(user.id)), role: 'developer', migrateLegacy: true, nodeVersion,
    environments: { codex: 'developer', openclaw: 'disabled' },
  });
  const sessionKey = 'codex:' + randomUUID(), creation = seed.grants.authorize(target(creator.id), 'sessions:create', { runtime: 'codex' })!;
  seed.grants.acceptCreatedSession(creation, sessionKey, randomUUID(), randomUUID(), () => {});
  const keys = { admin: seed.identities.issueKey(admin.id), creator: seed.identities.issueKey(creator.id), recipient: seed.identities.issueKey(recipient.id) };
  const tokens = Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, seed.identities.createSession(key.token)!])) as Record<keyof typeof keys, string>;
  const scope = seed.identities.recoveryScope({ userId: admin.id, admin: true });
  await seed.close();
  // The scaffold is a different database, never a peer writer beside the worker.
  const metadata = new HubStore(mode === 'original' ? file : join(root, 'scaffold.sqlite'), 'permissions-fixture');
  const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => { logs.push(line); });
  const owner = mode === 'original' ? new OriginalHubAdministrativeCommands(metadata, diagnostics)
    : new AsyncHubMemberOwner({ file, encryptionSecret: 'permissions-fixture' }, diagnostics);
  const calls: HubMemberKind[] = [];
  const behavior: { after?: (kind: HubMemberKind, input: unknown) => Promise<void> } = {};
  const command: Pick<AsyncHubMemberOwner, 'command'>['command'] = async (kind, input) => {
    calls.push(kind); const result = await owner.command(kind, input); await behavior.after?.(kind, input); return result;
  };
  const services = createHubAdministrativeServices({ command,
    contentBackground: () => owner.contentBackground(), nativeFileBackground: () => owner.nativeFileBackground(),
    connectionControlSettlement: () => owner.connectionControlSettlement(),
    weixinBindingEffect: () => owner.weixinBindingEffect(), weixinBackground: () => owner.weixinBackground(),
  }, diagnostics), app = new Hono();
  let sync = 0;
  const routes = parent ? registerHubRoutes(app, { config: loadConfig({ HOME: root, AOD_SERVER_ROLE: 'hub' }),
    hubStore: metadata, administrative: services, principal: () => { sync++; throw Error('SYNC_PERMISSION_PRINCIPAL'); },
    connectorClient: () => { sync++; throw Error('SYNC_PERMISSION_CONNECTOR'); }, normalizeError: () => 'unavailable',
  }) : registerAsyncHubPermissions(app, { mode: 'async', access: services.createPermissionAccess(), services, diagnostics });
  assert.ok(routes);
  t.after(async () => {
    await routes.close(); await services.close(); await owner.close(); await metadata.close();
    assert.equal(sync, 0);
    for (const secret of [...Object.values(keys).map(k => k.token), ...Object.values(tokens), 'private.invalid', 'PRIVATE_ACK']) assert.equal(logs.join('').includes(secret), false);
    rmSync(root, { recursive: true, force: true });
  });
  const sessionId = encodeHubSessionId('node', sessionKey), base = '/api/hub/v1';
  const paths = { directory: `${base}/access/directory`, role: `${base}/access/users/${member.id}/hub-role`,
    membership: `${base}/access/${admin.id}/connections/node/members/${member.id}`,
    grants: `${base}/connections/node/grants`, received: `${base}/shared/grants`,
    sharing: `${base}/shared/${admin.id}/sessions/${encodeURIComponent(sessionId)}/collaborators`,
    owned: `${base}/sessions/${encodeURIComponent(encodeHubSessionId('node', 'codex:owner'))}/collaborators` };
  const headers = (actor: keyof typeof keys = 'admin', key = false) => key ? { 'x-agentopsdeck-key': keys[actor].token } : { cookie: `agentopsdeck_session=${tokens[actor]}` };
  const http = (path: string, method = 'GET', body?: unknown, actor: keyof typeof keys = 'admin', key = false) => app.request(path, {
    method, headers: { ...headers(actor, key), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const revoke = async (actor: keyof typeof keys) => {
    const evidence = { accessKey: keys.admin.token }, snapshot = await owner.command('memberSnapshot', evidence); assert.ok(snapshot);
    assert.deepEqual(await owner.command('memberKeyRevoke', { evidence, expectedScope: snapshot.recoveryScope,
      userId: actor === 'creator' ? creator.id : actor === 'recipient' ? recipient.id : admin.id, keyId: keys[actor].id }), { ok: true });
  };
  const membership = { role: 'developer', version: 0, nodeVersion, migrateLegacy: true, environments: { codex: 'developer', openclaw: 'disabled' } };
  return { app, routes, services, owner, paths, http, headers, calls, behavior, revoke, membership, member, admin, stranger, sessionId, creator, recipient, keys, scope, nodeVersion, logs };
}

for (const mode of ['original', 'worker'] as const) for (const parent of [false, true]) {
  const label = `${mode}/${parent ? 'parent' : 'standalone'}`;
  test(`permission no-store composition keeps all eight domains and frontend CAS ${label}`, async t => {
    const f = await fixture(t, mode, parent);
    for (const [path, actor] of [[f.paths.directory, 'admin'], [f.paths.role, 'admin'], [f.paths.membership, 'admin'],
      [f.paths.grants, 'admin'], [f.paths.received, 'recipient'], [f.paths.sharing, 'creator'], [f.paths.owned, 'admin']] as const) {
      for (const key of [false, true]) { const r = await f.http(path, 'GET', undefined, actor, key); assert.equal(r.status, 200, path + ':' + await r.text()); assert.equal(r.headers.get('cache-control'), 'no-store'); }
    }
    const role = await (await f.http(f.paths.role)).json() as { role: string; version: number };
    const savedRole = await f.http(f.paths.role, 'PUT', { role: 'admin', version: role.version }); assert.equal(savedRole.status, 200);
    assert.equal((await f.http(f.paths.role, 'PUT', { role: 'member', version: role.version })).status, 409);
    const savedMember = await f.http(f.paths.membership, 'PUT', f.membership); assert.equal(savedMember.status, 200, await savedMember.text());
    assert.equal((await f.http(f.paths.membership, 'PUT', f.membership)).status, 409);
    // Managed membership is intentionally not used for the direct-grant CRUD recipient.
    const policy = { runtime: 'codex', sessionKey: 'codex:owner', actions: ['messages:read'] };
    const created = await f.http(f.paths.grants, 'POST', { userId: f.stranger.id, nodeVersion: f.nodeVersion, policy });
    assert.equal(created.status, 201, await created.clone().text());
    const grant = (await created.json() as { grant: { id: string; version: number } }).grant;
    const updated = await f.http(`${f.paths.grants}/${grant.id}`, 'PUT', { version: grant.version, nodeVersion: f.nodeVersion, policy });
    assert.equal(updated.status, 200); const next = (await updated.json() as { grant: { version: number } }).grant;
    assert.equal((await f.http(`${f.paths.grants}/${grant.id}`, 'DELETE', { version: next.version })).status, 200);
    for (const [path, actor] of [[f.paths.sharing, 'creator'], [f.paths.owned, 'admin']] as const) {
      const r = await f.http(path, 'POST', { userId: f.recipient.id, role: 'collaborator', media: true }, actor);
      assert.equal(r.status, 201, await r.clone().text()); const share = (await r.json() as { grant: { id: string; version: number } }).grant;
      const u = await f.http(`${path}/${share.id}`, 'PUT', { version: share.version, role: 'observer', live: false }, actor);
      assert.equal(u.status, 200, await u.clone().text()); const current = (await u.json() as { grant: { version: number } }).grant;
      assert.equal((await f.http(`${path}/${share.id}`, 'DELETE', { version: current.version }, actor)).status, 200);
      assert.equal((await f.http(`${path}/${share.id}`, 'PUT', { version: share.version, role: 'observer' }, actor)).status, 409);
    }
  });
  test(`permission credentials, exact selection and private/public scope fences ${label}`, async t => {
    const f = await fixture(t, mode, parent);
    for (const path of [f.paths.directory, f.paths.role, f.paths.membership, f.paths.grants, f.paths.received, f.paths.sharing, f.paths.owned]) {
      const request = new Request('http://fixture.invalid' + path, { headers: f.headers() }); pinOriginalRequestScope(request, 'stale-private-scope');
      assert.equal((await f.app.request(request)).status, 401);
      assert.equal((await f.app.request(path, { headers: { ...f.headers(), 'x-agentopsdeck-recovery-scope': 'stale-public-scope' } })).status, 409);
      // Preserve the existing member-key namespace: unrelated legacy keys do
      // not override a member Cookie; a supplied member Key does.
      assert.equal((await f.app.request(path, { headers: { ...f.headers(), 'x-agentopsdeck-key': 'hub_key_invalid' } })).status, 401);
      assert.equal((await f.app.request(path, { headers: { ...f.headers(), authorization: 'Bearer aod_board_synthetic' } })).status, 401);
    }
    assert.equal(f.calls.some(kind => ['roleSet', 'membershipSet', 'grantChange', 'sessionSharing', 'ownedSessionSharing'].includes(kind)), false);
    assert.equal(isAsyncHubPermissionRequest('POST', f.paths.directory), false);
    assert.equal(isAsyncHubPermissionRequest('GET', f.paths.grants + '/unknown/suffix'), false);
    assert.equal(isAsyncHubPermissionRequest('GET', f.paths.grants + '/grant'), false);
    assert.equal(isAsyncHubPermissionRequest('HEAD', f.paths.directory), true);
  });
}

for (const mode of ['original', 'worker'] as const) {
  test(`permission registration refuses partial ports before publishing routes ${mode}`, async t => {
    const f = await fixture(t, mode);
    for (const key of ['roles', 'memberships', 'directory', 'grants', 'received', 'collaborators', 'sharing', 'ownedSharing'] as const) {
      const app = new Hono(), access = f.services.createPermissionAccess();
      try {
        assert.throws(() => registerAsyncHubPermissions(app, { mode: 'async', access,
          services: { ...f.services, [key]: undefined } as unknown as Parameters<typeof registerAsyncHubPermissions>[1]['services'] }), /hub_permission_ports_required/);
        assert.equal(app.routes.length, 0);
      } finally { await access.close(); }
    }
  });
  for (const invalid of [false, true]) test(`permission body rechecks original revocation before ${invalid ? 'invalid' : 'valid'} delivery ${mode}`, async t => {
    const f = await fixture(t, mode), admitted = deferred(), release = deferred(); let once = true;
    f.behavior.after = async (kind, input) => {
      if (kind === 'membershipRead' && (input as { command: { action: string } }).command.action === 'authorize' && once) { once = false; admitted.resolve(); }
    };
    const body = new ReadableStream<Uint8Array>({ async start(controller) { await release.promise;
      controller.enqueue(new TextEncoder().encode(invalid ? '{invalid' : JSON.stringify(f.membership))); controller.close(); } });
    const response = f.app.request(new Request('http://fixture.invalid' + f.paths.membership,
      { method: 'PUT', headers: f.headers(), body, duplex: 'half' } as RequestInit));
    try { await admitted.promise; await f.revoke('admin'); release.resolve(); assert.equal((await response).status, 401); assert.equal(f.calls.includes('membershipSet'), false); }
    finally { release.resolve(); await response; }
  });
  test(`permission close owns held HTTP body and rejects late mutation ${mode}`, async t => {
    const f = await fixture(t, mode), admitted = deferred(), release = deferred();
    // Signal actual body consumption, not an SQL authorize ACK: close before
    // the final authority check may correctly prevent reaching the body at all.
    const body = new ReadableStream<Uint8Array>({ async pull(controller) { admitted.resolve(); await release.promise;
      controller.enqueue(new TextEncoder().encode(JSON.stringify(f.membership))); controller.close(); } }, { highWaterMark: 0 });
    const response = f.app.request(new Request('http://fixture.invalid' + f.paths.membership,
      { method: 'PUT', headers: f.headers(), body, duplex: 'half' } as RequestInit));
    let closed = false;
    try { await admitted.promise; const closing = f.routes.close().then(() => { closed = true; }); await tick(); assert.equal(closed, false);
      assert.equal((await f.http(f.paths.directory)).status, 503); release.resolve(); assert.equal((await response).status, 503); await closing;
      assert.equal(f.calls.includes('membershipSet'), false);
    } finally { release.resolve(); await response; }
  });
  test(`permission unknown mutation ACK is never replayed and durable state is readable ${mode}`, async t => {
    const f = await fixture(t, mode); let once = true;
    f.behavior.after = async kind => { if (kind === 'membershipSet' && once) { once = false; throw Error('PRIVATE_ACK'); } };
    assert.equal((await f.http(f.paths.membership, 'PUT', f.membership)).status, 503);
    assert.equal(f.calls.filter(k => k === 'membershipSet').length, 1);
    const read = await f.http(f.paths.membership); assert.equal(read.status, 200);
    const snapshot = await read.json() as { version: number }; assert.equal(snapshot.version, 1);
    assert.equal(f.calls.filter(k => k === 'membershipSet').length, 1);
  });
  test(`permission shutdown waits actual post-commit SQL acknowledgement ${mode}`, async t => {
    const f = await fixture(t, mode), admitted = deferred(), release = deferred();
    f.behavior.after = async kind => { if (kind === 'membershipSet') { admitted.resolve(); await release.promise; } };
    const response = f.http(f.paths.membership, 'PUT', f.membership); let closed = false;
    try { await admitted.promise; const closing = f.routes.close().then(() => { closed = true; }); await tick(); assert.equal(closed, false);
      release.resolve(); assert.equal((await response).status, 503); await closing; assert.equal(f.calls.filter(k => k === 'membershipSet').length, 1);
    } finally { release.resolve(); await response; }
  });
  test(`all permission domains preserve inherited private scope without outer middleware ${mode}`, async t => {
    const f = await fixture(t, mode), request = () => { const r = new Request('http://fixture.invalid', { headers: f.headers() }); pinOriginalRequestScope(r, 'private-stale'); return r; };
    const calls = [() => f.services.roles.read(request(), f.member.id), () => f.services.memberships.read(request(), { ownerUserId: f.admin.id, connectionId: 'node', userId: f.member.id }),
      () => f.services.directory.read(request()), () => f.services.grants.begin(request(), 'node'), () => f.services.received.received(request(), '', 50),
      () => f.services.collaborators.collaborators(request(), f.admin.id, f.sessionId), () => f.services.sharing.begin(request(), f.admin.id, f.sessionId), () => f.services.ownedSharing.begin(request(), f.sessionId)];
    for (const call of calls) await assert.rejects(call(), (error: unknown) => (error as { status: number }).status === 401);
  });
}
