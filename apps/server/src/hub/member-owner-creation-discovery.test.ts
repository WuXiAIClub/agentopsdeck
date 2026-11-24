import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubCreationDiscovery } from './async-creation-discovery.js';
import { executeHubMemberCommand, type HubMemberKind } from './member-owner-domain.js';
import { HubMemberRequestError } from './async-member-request.js';
import { validHubCreationDiscoveryResult, validHubCreationDiscoveryReply } from './member-creation-discovery-domain.js';
import { registerHubSharedCreationRoutes } from '../routes/hub-shared-creation.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const deferred = () => { let resolve!: (v: unknown) => void;
  const promise = new Promise<unknown>(r => { resolve = r; }); return { resolve, promise }; };
type Port = Pick<AsyncHubMemberOwner, 'command'>;
const port = (call: (kind: HubMemberKind, input: unknown) => unknown): Port => ({
  command: (async (kind: HubMemberKind, input: unknown) => call(kind, input)) as Port['command'],
});
function seed(store: HubStore) {
  const db = (store as unknown as { db: DatabaseSync }).db;
  const owner = store.createUser('Owner'), member = store.createUser('Member');
  store.upsertConnection({ id: 'node', ownerUserId: owner.id, kind: 'remote', label: 'Environment', connectorUrl: 'http://private.invalid' });
  store.pinConnectionNode('node', owner.id, store.connectionAuthority('node', owner.id)!, 'node_' + randomUUID());
  const version = store.connectionAuthority('node', owner.id)!;
  const connection = store.getConnection('node', owner.id)!;
  // Metadata only. No configured issuer token, remote call, or live service.
  db.prepare(`INSERT INTO hub_execution_issuers
    (id,owner_id,connection_id,node_id,issuer_id,authority_version,connector_url,kind,retired,creation_allowed)
    VALUES (?,?,?,?,?,?,?,'remote',0,1)`).run(randomUUID(), owner.id, 'node', connection.nodeId!, randomUUID(), version, 'http://private.invalid');
  const target = { ownerUserId: owner.id, connectionId: 'node', userId: member.id };
  const policy = { runtime: 'codex' as const, actions: ['sessions:create' as const, 'messages:read' as const] };
  const grant = store.grants.create(target, policy);
  const key = store.identities.issueKey(member.id), token = store.identities.createSession(key.token)!;
  const request = (suffix = '', signal?: AbortSignal) => new Request('http://fixture.invalid/api/hub/v1/shared/creation-environments' + suffix,
    { headers: { cookie: 'agentopsdeck_session=' + token }, ...(signal ? { signal } : {}) });
  const proof = () => ({ evidence: { sessionToken: token }, expectedScope: store.identities.recoveryScope({
    userId: member.id, admin: store.roles.hubRole(member.id).role === 'admin' }) });
  const command = { userId: member.id, after: '' };
  const calls: HubMemberKind[] = [];
  const call = (kind: HubMemberKind, input: unknown) => { calls.push(kind); return executeHubMemberCommand(store, kind, input as never); };
  const original = port(call);
  const route = (asyncDiscovery?: Pick<AsyncHubCreationDiscovery, 'environments'>) => {
    const app = new Hono(); registerHubSharedCreationRoutes(app, { hubStore: store,
      ...(asyncDiscovery ? { asyncDiscovery } : {}), principal: c => {
        const actor = store.identities.requestPrincipal(c.req.raw, () => false);
        if (!actor) throw new HTTPException(401); return actor;
      } }); return app;
  };
  const effects = () => ['node_grants', 'hub_execution_issuers', 'command_receipts', 'hub_execution_leases', 'hub_session_owners']
    .map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all());
  return { store, db, owner, member, grant, target, policy, key, token, request, proof, command, calls, call, original, route, effects };
}
async function fixture(work: (f: ReturnType<typeof seed>) => unknown) {
  const root = mkdtempSync(join(tmpdir(), 'hub-discovery-')), store = new HubStore(join(root, 'hub.sqlite'), 'fixture');
  try { await work(seed(store)); } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
}
test('awaited creation discovery preserves original frontend projection and has no execution/maintenance effects', () => fixture(async f => {
  f.store.grants.create(f.target, f.policy); // Duplicate grants collapse to one environment.
  const before = f.effects(), original = await f.route().request(f.request('?unused=ignored'));
  const response = await f.route(new AsyncHubCreationDiscovery(f.original, quiet)).request(f.request('?unused=ignored'));
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const page = await response.json(); assert.deepEqual(page, await original.json());
  assert.deepEqual(page, { environments: [{ ownerUserId: f.owner.id, connectionId: 'node', label: 'Environment', kind: 'remote', status: 'enabled' }], nextCursor: null });
  assert.deepEqual(f.effects(), before); assert.equal(JSON.stringify(page).includes('private.invalid'), false);
  assert.equal(f.calls.filter(k => k === 'creationEnvironments').length, 1);
}));
for (const condition of ['disabled', 'revoked', 'nodeChanged', 'issuerRetired', 'issuerDenied', 'issuerNodeChanged', 'roleCeiling'] as const) {
  test('discovery retains original denial for ' + condition + ' without replacing execution authority', () => fixture(async f => {
    if (condition === 'disabled') f.db.prepare("UPDATE env_connections SET status='disabled'").run();
    if (condition === 'revoked') f.store.grants.revoke(f.target, f.grant.id, f.grant.version);
    if (condition === 'nodeChanged') f.store.upsertConnection({ id: 'node', ownerUserId: f.owner.id, kind: 'remote', label: 'Changed', connectorUrl: 'http://changed.invalid' });
    if (condition === 'issuerRetired') f.db.prepare('UPDATE hub_execution_issuers SET retired=1').run();
    if (condition === 'issuerDenied') f.db.prepare('UPDATE hub_execution_issuers SET creation_allowed=0').run();
    if (condition === 'issuerNodeChanged') f.db.prepare('UPDATE hub_execution_issuers SET node_id=?').run('node_' + randomUUID());
    if (condition === 'roleCeiling') f.db.prepare("INSERT INTO connector_memberships VALUES (?,?,?,'none',1,?,?)")
      .run(f.owner.id, 'node', f.member.id, f.store.connectionAuthority('node', f.owner.id)!, JSON.stringify({ codex: 'disabled', openclaw: 'disabled' }));
    const before = f.effects(), response = await f.route().request(f.request());
    if (condition === 'issuerNodeChanged') {
      const unavailable = { error: 'Creation environments are temporarily unavailable. Reload to refresh permissions.' };
      assert.equal(response.status, 503); assert.deepEqual(await response.json(), unavailable);
      const discovery = new AsyncHubCreationDiscovery(f.original, quiet);
      await assert.rejects(discovery.environments(f.request(), ''), (error: unknown) =>
        error instanceof HubMemberRequestError && error.status === 503);
      const awaited = await f.route(discovery).request(f.request());
      assert.equal(awaited.status, 503); assert.deepEqual(await awaited.json(), unavailable);
      assert.deepEqual(f.effects(), before); return;
    }
    assert.equal(response.status, 200);
    const original = await response.json();
    const actual = await new AsyncHubCreationDiscovery(f.original, quiet).environments(f.request(), '');
    assert.deepEqual(actual, original); assert.deepEqual(actual.environments, []); assert.deepEqual(f.effects(), before);
  }));
}
test('administrator discovery does not manufacture grants; original scope and actor must match', () => fixture(async f => {
  f.store.roles.setHubRole({ userId: 'default', admin: true }, f.member.id, 'admin', 0);
  const before = f.effects(); await new AsyncHubCreationDiscovery(f.original, quiet).environments(f.request(), '');
  assert.deepEqual(f.effects(), before);
  assert.equal(f.call('creationEnvironments', { ...f.proof(), command: { ...f.command, userId: f.owner.id } }), null);
  assert.equal(f.call('creationEnvironments', { ...f.proof(), expectedScope: 'a'.repeat(64), command: f.command }), null);
}));
for (const field of ['node_id', 'connector_url', 'kind'] as const) {
  test('discovery binding fault is recoverable JSON in both paths: ' + field, () => fixture(async f => {
    const saved = f.db.prepare('SELECT node_id, connector_url, kind FROM hub_execution_issuers').get()!;
    const discovery = new AsyncHubCreationDiscovery(f.original, quiet);
    const original = f.route(), awaited = f.route(discovery);
    const expected = await (await original.request(f.request())).json();
    const changed = field === 'node_id' ? 'node_' + randomUUID()
      : field === 'connector_url' ? 'http://private-changed.invalid' : 'local';
    f.db.prepare('UPDATE hub_execution_issuers SET ' + field + '=?').run(changed);
    const before = f.effects();
    for (const app of [original, awaited]) {
      const response = await app.request(f.request());
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), {
        error: 'Creation environments are temporarily unavailable. Reload to refresh permissions.',
      });
      assert.deepEqual(f.effects(), before, 'Read failure must not repair bindings or replay creation');
    }
    // Fixture-only restoration models a subsequently healthy store. Ordinary
    // reads recover with the same cookie and route instance, without resend.
    f.db.prepare('UPDATE hub_execution_issuers SET ' + field + '=?').run(saved[field]!);
    for (const app of [original, awaited]) {
      const response = await app.request(f.request());
      assert.equal(response.status, 200); assert.deepEqual(await response.json(), expected);
    }
  }));
}
test('filtered first page retains advancing original cursor and discovers second page', () => fixture(async f => {
  for (let i = 0; i < 51; i++) f.store.grants.create(f.target, f.policy);
  const grants = f.db.prepare('SELECT id FROM node_grants ORDER BY id').all();
  // First-page grants point to an environment without a creation issuer. Grant
  // checks are additive per environment, so changing just their actions would
  // not deny a different grant for the same environment (original semantics).
  f.store.upsertConnection({ id: 'other', ownerUserId: f.owner.id, kind: 'remote', label: 'No issuer', connectorUrl: 'http://other.invalid' });
  f.store.pinConnectionNode('other', f.owner.id, f.store.connectionAuthority('other', f.owner.id)!, 'node_' + randomUUID());
  for (const grant of grants.slice(0, 50)) f.db.prepare('UPDATE node_grants SET connection_id=? WHERE id=?').run('other', grant.id!);
  const caller = new AsyncHubCreationDiscovery(f.original, quiet), first = await caller.environments(f.request(), '');
  assert.deepEqual(first.environments, []); assert.equal(first.nextCursor, grants[49]!.id);
  assert.deepEqual(first, await (await f.route().request(f.request())).json());
  const second = await caller.environments(f.request(), first.nextCursor!); assert.equal(second.environments.length, 1);
  assert.deepEqual(second, await (await f.route().request(f.request('?after=' + first.nextCursor))).json());
}));
test('discovery auth priority and invalid cursor do not dispatch SQL; existing POST remains original', () => fixture(async f => {
  const app = f.route(new AsyncHubCreationDiscovery(f.original, quiet));
  assert.equal((await app.request('/api/hub/v1/shared/creation-environments?after=bad')).status, 401);
  assert.equal((await app.request(f.request('?after=bad'))).status, 400);
  assert.equal(f.calls.includes('creationEnvironments'), false);
  const path = '/api/hub/v1/shared/' + f.owner.id + '/connections/node/agents/other/sessions';
  const response = await app.request(path, { method: 'POST', headers: f.request().headers, body: '{}' });
  assert.equal(response.status, 403); assert.equal(f.calls.includes('creationEnvironments'), false);
}));
for (const field of ['userId', 'after'] as const) test('forged discovery ' + field + ' ACK denies delivery without replay', () => fixture(async f => {
  const caller = new AsyncHubCreationDiscovery(port((kind, input) => {
    const value = f.call(kind, input); return kind === 'creationEnvironments' ? { ...value as object, [field]: randomUUID() } : value;
  }), quiet);
  const before = f.effects(); await assert.rejects(caller.environments(f.request(), ''), e => e instanceof HubMemberRequestError && e.status === 503);
  assert.deepEqual(f.effects(), before); assert.equal(f.calls.filter(k => k === 'creationEnvironments').length, 1);
}));
test('strict bounded projection rejects malformed/duplicate/cursor ACKs without throwing', () => fixture(f => {
  const value = f.call('creationEnvironments', { ...f.proof(), command: f.command });
  assert.ok(value && 'page' in value && value.page && 'environments' in value.page); assert.equal(validHubCreationDiscoveryReply(f.command, value), true);
  const environment = value.page.environments[0]!;
  for (const page of [
    { ...value.page, extra: true }, { environments: [environment, environment], nextCursor: null },
    { environments: [{ ...environment, label: 'x'.repeat(65537) }], nextCursor: null },
    { environments: [{ ...environment, status: 'unknown' }], nextCursor: null },
    { environments: [{ ...environment, credential: 'not-allowed' }], nextCursor: null },
    { environments: new Array(51).fill(environment), nextCursor: null },
    { environments: [], nextCursor: '' }, { environments: [], nextCursor: 'bad' },
  ]) assert.equal(validHubCreationDiscoveryResult({ ...value, page }), false);
  assert.equal(validHubCreationDiscoveryResult({ userId: f.member.id, after: f.grant.id, page: { environments: [], nextCursor: f.grant.id } }), false);
}));
for (const mode of ['timeout', 'cancel', 'lateFailure'] as const) test('discovery ' + mode + ' retains original reservation and privacy-safe phase43 settlement', () => fixture(async f => {
  const gate = deferred(), dispatched = deferred(), logs: string[] = []; let value: unknown;
  const owner = port((kind, input) => { const result = f.call(kind, input); if (kind !== 'creationEnvironments') return result;
    value = result; dispatched.resolve(null); return gate.promise.then(v => { if (mode === 'lateFailure') throw Error('private detail'); return v; }); });
  const caller = new AsyncHubCreationDiscovery(owner, new PerformanceDiagnostics(line => logs.push(line)), 5, 20), abort = new AbortController();
  const work = caller.environments(f.request('', abort.signal), ''); void work.catch(() => {});
  await dispatched.promise; if (mode === 'cancel') abort.abort();
  await assert.rejects(work, e => e instanceof HubMemberRequestError && e.status === (mode === 'cancel' ? 499 : 503));
  assert.equal(caller.pending, 1); assert.equal(f.calls.filter(k => k === 'creationEnvironments').length, 1);
  assert.ok(logs.some(line => { const d = JSON.parse(line); return d.step === 43 && d[mode === 'cancel' ? 'cancelled' : 'timedOut'] === 1; }));
  gate.resolve(value); await tick(); await tick(); assert.equal(caller.pending, 0);
  for (const secret of [f.token, f.key.token, f.member.id, f.owner.id, 'private.invalid', 'private detail']) assert.equal(logs.join('').includes(secret), false);
}));
test('final credential revocation prevents discovery delivery without mutation/replay', () => fixture(async f => {
  const before = f.effects(), caller = new AsyncHubCreationDiscovery(port((kind, input) => {
    const result = f.call(kind, input); if (kind === 'creationEnvironments') f.store.identities.revokeSession(f.token); return result;
  }), quiet);
  await assert.rejects(caller.environments(f.request(), ''), e => e instanceof HubMemberRequestError && e.status === 401);
  assert.deepEqual(f.effects(), before); assert.equal(f.calls.filter(k => k === 'creationEnvironments').length, 1);
}));
for (const column of ['label', 'actions', 'issuer_id'] as const) test('oversized legacy ' + column + ' rejected before discovery materialization', () => fixture(async f => {
  f.db.prepare(column === 'label' ? 'UPDATE env_connections SET label=?' : column === 'actions' ? 'UPDATE node_grants SET actions=?' : 'UPDATE hub_execution_issuers SET issuer_id=?').run('x'.repeat(65537));
  const before = f.effects(), response = await f.route(new AsyncHubCreationDiscovery(f.original, quiet)).request(f.request());
  assert.equal(response.status, 503); assert.deepEqual(f.effects(), before);
}));
test('outer rollback and throwing log sink do not mutate discovery data', () => fixture(async f => {
  const before = f.effects(); f.db.exec('BEGIN');
  const caller = new AsyncHubCreationDiscovery(f.original, new PerformanceDiagnostics(() => { throw Error('sink'); }));
  assert.equal((await caller.environments(f.request(), '')).environments.length, 1);
  f.db.exec('ROLLBACK'); assert.deepEqual(f.effects(), before);
}));
class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = []; stops = 0;
  postMessage(m: { id: number; kind: string; body: string }) { this.messages.push(m); }
  terminate() { this.stops++; return Promise.resolve(1); }
}
test('wrong discovery worker ACK keeps physical owner fenced until exit, never replayed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-discovery-ack-')), file = join(root, 'hub.sqlite'), worker = new FakeWorker();
  const launch = () => worker as unknown as Worker, owner = new AsyncHubMemberOwner({ file }, quiet, launch);
  try {
    const result = owner.command('creationEnvironments', { evidence: {}, expectedScope: 'a'.repeat(64), command: { userId: 'user', after: '' } }); void result.catch(() => {});
    worker.emit('message', { kind: 'ready' }); await tick(); const message = worker.messages[0]!;
    worker.emit('message', { id: message.id, kind: message.kind, ok: true, body: JSON.stringify({ userId: 'other', after: '', page: { environments: [], nextCursor: null } }) });
    await assert.rejects(result); assert.equal(worker.stops, 0); assert.equal(worker.messages.length, 1);
    assert.throws(() => new AsyncHubMemberOwner({ file }, quiet, launch));
    const closing = owner.close(); void closing.catch(() => {}); await tick(); assert.equal(worker.stops, 1);
    assert.throws(() => new AsyncHubMemberOwner({ file }, quiet, launch)); worker.emit('exit', 1); await assert.rejects(closing);
  } finally { worker.emit('exit', 1); rmSync(root, { recursive: true, force: true }); }
});
test('real worker reopen preserves original session, grants, issuer and command/lease state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-discovery-worker-')), file = join(root, 'hub.sqlite'), store = new HubStore(file, 'fixture'), f = seed(store);
  const proof = f.proof(), expected = f.call('creationEnvironments', { ...proof, command: f.command }), before = f.effects(); await store.close();
  const owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture' }, quiet);
  try {
    assert.deepEqual(await owner.command('creationEnvironments', { ...proof, command: f.command }), expected); await owner.close();
    const reopened = new HubStore(file, 'fixture'); try {
      assert.ok(reopened.identities.requestPrincipal(f.request(), () => false));
      assert.deepEqual(executeHubMemberCommand(reopened, 'creationEnvironments', { ...proof, command: f.command }), expected);
      const db = (reopened as unknown as { db: DatabaseSync }).db;
      assert.deepEqual(['node_grants', 'hub_execution_issuers', 'command_receipts', 'hub_execution_leases', 'hub_session_owners'].map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()), before);
    } finally { await reopened.close(); }
  } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
});
