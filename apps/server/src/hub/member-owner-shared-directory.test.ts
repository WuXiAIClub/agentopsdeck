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
import { CONNECTOR_PROTOCOL, CONNECTOR_PROTOCOL_HEADER, type SessionDirectoryPage } from '@agentopsdeck/shared';
import { EXPECTED_NODE_HEADER, NODE_ID_HEADER } from '../connector/node-identity.js';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubSharedDirectory } from './async-shared-directory.js';
import { createAsyncConnectorClientResolver, type AsyncConnectorClientResolver } from './async-connector-client.js';
import { ConnectorClient } from './connector-client.js';
import { executeHubMemberCommand, type HubMemberKind } from './member-owner-domain.js';
import { HubMemberRequestError } from './async-member-request.js';
import { validHubSharedDirectoryCommand, validHubSharedDirectoryReply, validHubSharedDirectoryResult } from './member-shared-directory-domain.js';
import { registerHubSharedDirectoryRoutes } from '../routes/hub-shared-directory.js';
import { encodeHubSessionId } from './session-id.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
type Port = Pick<AsyncHubMemberOwner, 'command'>;
const port = (call: (kind: HubMemberKind, input: unknown) => unknown): Port => ({
  command: (async (kind: HubMemberKind, input: unknown) => call(kind, input)) as Port['command'],
});
function seed(store: HubStore, local = false) {
  const db = (store as unknown as { db: DatabaseSync }).db;
  const owner = local ? store.getUser('default')! : store.createUser('Owner'), member = store.createUser('Member');
  store.upsertConnection({ id: 'node', ownerUserId: owner.id, kind: local ? 'local' : 'remote', label: 'Environment', connectorUrl: 'http://private.invalid' });
  store.pinConnectionNode('node', owner.id, store.connectionAuthority('node', owner.id)!, 'node_' + randomUUID());
  const target = { ownerUserId: owner.id, connectionId: 'node', userId: member.id };
  const grant = store.grants.create(target, { runtime: 'codex', actions: ['sessions:read'] });
  const directory = { ownerUserId: owner.id, connectionId: 'node', grantId: grant.id };
  const key = store.identities.issueKey(member.id), token = store.identities.createSession(key.token)!;
  const path = `/api/hub/v1/shared/${owner.id}/connections/node/grants/${grant.id}/sessions`;
  const request = (suffix = '', signal?: AbortSignal) => new Request('http://fixture.invalid' + path + suffix,
    { headers: { cookie: 'agentopsdeck_session=' + token }, ...(signal ? { signal } : {}) });
  const proof = () => ({ evidence: { sessionToken: token }, expectedScope: store.identities.recoveryScope({ userId: member.id, admin: false }) });
  const calls: HubMemberKind[] = [];
  const call = (kind: HubMemberKind, input: unknown) => { calls.push(kind); return executeHubMemberCommand(store, kind, input as never); };
  const original = port(call);
  const page: SessionDirectoryPage = { sessions: [{ sessionKey: 'codex:a', runtime: 'codex' }], nextCursor: null, sourceCursor: 'fixture-source' };
  let remote = 0, beforeRemote: () => unknown = () => {}, afterRemote: () => unknown = () => {};
  const client = new ConnectorClient('http://fixture.invalid', 'fixture', async () => {
    remote++; await beforeRemote(); const response = Response.json(page); await afterRemote(); return response;
  });
  const connector: AsyncConnectorClientResolver = async (_request, connectionId, options) => {
    assert.equal(connectionId, 'node'); assert.equal(options?.expectedUserId, member.id);
    assert.equal(options?.grant?.grantId, grant.id); return client;
  };
  const route = (asyncDirectory?: Pick<AsyncHubSharedDirectory, 'sessions'>) => {
    const app = new Hono(); registerHubSharedDirectoryRoutes(app, asyncDirectory ? { mode: 'async', asyncDirectory } : { hubStore: store,
      principal: c => { if (asyncDirectory) throw Error('sync principal must not run');
        const actor = store.identities.requestPrincipal(c.req.raw, () => false); if (!actor) throw new HTTPException(401); return actor; },
      connectorClient: () => { if (asyncDirectory) throw Error('sync resolver must not run'); return client; } }); return app;
  };
  const effects = () => ['node_grants', 'command_receipts', 'hub_execution_leases', 'hub_session_owners']
    .map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all());
  return { store, db, owner, member, target, grant, directory, key, token, request, proof, calls, call, original, page,
    client, connector, route, effects, remote: () => remote, before: (fn: () => unknown) => { beforeRemote = fn; },
    after: (fn: () => unknown) => { afterRemote = fn; } };
}
async function fixture(work: (f: ReturnType<typeof seed>) => unknown) {
  const root = mkdtempSync(join(tmpdir(), 'hub-shared-directory-')), store = new HubStore(join(root, 'hub.sqlite'), 'fixture');
  try { await work(seed(store)); } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
}
const denied = (status: number) => (error: unknown) => error instanceof HubMemberRequestError && error.status === status;

for (const messages of [false, true]) test('async route preserves frontend projection; independent messages permission=' + messages, () => fixture(async f => {
  if (messages) f.store.grants.create(f.target, { runtime: 'codex', actions: ['messages:read'] });
  const before = f.effects(), legacy = await f.route().request(f.request('?limit=1'));
  const response = await f.route(new AsyncHubSharedDirectory(f.original, f.connector, quiet)).request(f.request('?limit=1'));
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json(); assert.deepEqual(body, await legacy.json());
  assert.deepEqual(body, { ...f.page, sessions: [{ ...f.page.sessions[0], sessionId: messages ? encodeHubSessionId('node', 'codex:a') : null }] });
  assert.deepEqual(f.effects(), before); assert.equal(f.remote(), 2);
  assert.equal(f.calls.filter(k => k === 'sharedDirectory').length, 2);
  assert.doesNotMatch(JSON.stringify(body), /private.invalid|nodeVersion|grantId|ownerUserId/);
}));

for (const condition of ['revoked', 'disabled', 'nodeChanged', 'roleCeiling', 'logout'] as const)
for (const phase of ['before', 'after'] as const) test(`${condition} ${phase} remote completion refuses stale page`, () => fixture(async f => {
  const change = () => {
    if (condition === 'revoked') f.store.grants.revoke(f.target, f.grant.id, f.grant.version);
    if (condition === 'disabled') f.db.prepare("UPDATE env_connections SET status='disabled'").run();
    if (condition === 'nodeChanged') f.store.upsertConnection({ id: 'node', ownerUserId: f.owner.id, kind: 'remote', label: 'Changed', connectorUrl: 'http://changed.invalid' });
    if (condition === 'roleCeiling') f.db.prepare("INSERT INTO connector_memberships VALUES (?,?,?,'none',1,?,?)")
      .run(f.owner.id, 'node', f.member.id, f.store.connectionAuthority('node', f.owner.id)!, JSON.stringify({ codex: 'disabled', openclaw: 'disabled' }));
    if (condition === 'logout') f.store.identities.revokeSession(f.token);
  };
  f[phase](change);
  const response = await f.route(new AsyncHubSharedDirectory(f.original, f.connector, quiet)).request(f.request());
  assert.equal(response.status, condition === 'logout' ? 401 : 403);
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.doesNotMatch(await response.text(), /fixture-source|codex:a|private/);
  assert.equal(f.remote(), 1);
}));

test('scoped runtime/session and agent restrictions cannot broaden directory discovery', () => fixture(async f => {
  const policy = { runtime: 'codex' as const, sessionKey: 'codex:a', actions: ['sessions:read' as const] };
  f.store.grants.replace(f.target, f.grant.id, f.grant.version, policy);
  const port = new AsyncHubSharedDirectory(f.original, f.connector, quiet);
  assert.equal((await port.sessions(f.request(), f.directory)).sessions.length, 1);
  const current = f.store.grants.get(f.target, f.grant.id)!;
  f.store.grants.replace(f.target, f.grant.id, current.version, { runtime: 'codex', agentId: 'private-agent', actions: ['sessions:read'] });
  await assert.rejects(port.sessions(f.request(), f.directory), denied(404)); assert.equal(f.remote(), 1);
}));

for (const suffix of ['?runtime=codex', '?sessionKey=codex:a', '?limit=0', '?limit=1&limit=2', '?after=x&after=y'])
test('rejects browser resource filters/invalid pagination without remote IO: ' + suffix, () => fixture(async f => {
  const port = new AsyncHubSharedDirectory(f.original, f.connector, quiet);
  await assert.rejects(port.sessions(f.request(suffix), f.directory), denied(400)); assert.equal(f.remote(), 0);
  const anonymous = new Request(f.request(suffix).url);
  await assert.rejects(port.sessions(anonymous, f.directory), denied(401));
}));

test('post-remote projection hides session entry when only messages permission was revoked', () => fixture(async f => {
  const read = f.store.grants.create(f.target, { runtime: 'codex', actions: ['messages:read'] });
  f.after(() => f.store.grants.revoke(f.target, read.id, read.version));
  const page = await new AsyncHubSharedDirectory(f.original, f.connector, quiet).sessions(f.request(), f.directory);
  assert.equal(page.sessions[0]!.sessionId, null); assert.equal(f.remote(), 1);
}));

test('original scope and current recipient are checked inside each owner savepoint', () => fixture(async f => {
  const command = { action: 'open', target: f.directory };
  assert.equal(f.call('sharedDirectory', { ...f.proof(), expectedScope: 'a'.repeat(64), command }), null);
  assert.equal(f.call('sharedDirectory', { evidence: {}, expectedScope: f.proof().expectedScope, command }), null);
  const other = f.store.createUser('Other'), key = f.store.identities.issueKey(other.id), token = f.store.identities.createSession(key.token)!;
  const value = f.call('sharedDirectory', { evidence: { sessionToken: token },
    expectedScope: f.store.identities.recoveryScope({ userId: other.id, admin: false }), command });
  assert.deepEqual(value, { error: 'missing' }); assert.equal(f.remote(), 0);
}));

test('preexisting revoked grant refuses before remote dispatch, even with invalid query', () => fixture(async f => {
  f.store.grants.revoke(f.target, f.grant.id, f.grant.version);
  await assert.rejects(new AsyncHubSharedDirectory(f.original, f.connector, quiet).sessions(f.request('?runtime=codex'), f.directory), denied(404));
  assert.equal(f.remote(), 0);
}));

for (const failure of ['runtime', 'duplicate', 'cursor', 'order', 'after'] as const)
test('malformed remote page refuses without projection or replay: ' + failure, () => fixture(async f => {
  if (failure === 'runtime') f.page.sessions[0]!.runtime = 'openclaw';
  if (failure === 'duplicate') f.page.sessions.push({ ...f.page.sessions[0]! });
  if (failure === 'cursor') f.page.nextCursor = 'forged';
  if (failure === 'order') f.page.sessions.unshift({ sessionKey: 'codex:z', runtime: 'codex' });
  const response = await f.route(new AsyncHubSharedDirectory(f.original, f.connector, quiet)).request(f.request(failure === 'after' ? '?after=codex:z' : ''));
  assert.equal(response.status, 502); assert.equal(f.remote(), 1);
  assert.equal(f.calls.filter(k => k === 'sharedDirectory').length, 1);
  assert.doesNotMatch(await response.text(), /fixture-source|forged|codex:/);
}));

test('same policy with replaced grant version still invalidates in-flight directory proof', () => fixture(async f => {
  f.after(() => f.store.grants.replace(f.target, f.grant.id, f.grant.version, { runtime: 'codex', actions: ['sessions:read'] }));
  await assert.rejects(new AsyncHubSharedDirectory(f.original, f.connector, quiet).sessions(f.request(), f.directory), denied(403));
  assert.equal(f.remote(), 1);
}));

test('account role change after original projection denies final delivery', () => fixture(async f => {
  const original = port((kind, input) => { const value = f.call(kind, input);
    if (kind === 'sharedDirectory' && (input as { command: { action: string } }).command.action === 'project')
      f.store.roles.setHubRole({ userId: 'default', admin: true }, f.member.id, 'admin', 0);
    return value;
  });
  await assert.rejects(new AsyncHubSharedDirectory(original, f.connector, quiet).sessions(f.request(), f.directory), denied(401));
  assert.equal(f.remote(), 1);
}));

test('uncertain original command is not replayed; diagnostic failures do not expose credentials', () => fixture(async f => {
  const rows: string[] = [], diagnostics = new PerformanceDiagnostics(line => { rows.push(line); throw Error('log sink unavailable'); });
  let dispatched = 0;
  const original = port((kind, input) => { if (kind === 'sharedDirectory') { dispatched++; throw Error('PRIVATE SELECT credential'); } return f.call(kind, input); });
  const client = new AsyncHubSharedDirectory(original, f.connector, diagnostics);
  await assert.rejects(client.sessions(f.request(), f.directory), denied(503));
  assert.equal(client.pending, 0); assert.equal(dispatched, 1); assert.equal(f.remote(), 0);
  assert.ok(rows.some(line => line.includes('"step":74')));
  assert.doesNotMatch(rows.join(''), new RegExp(f.token + '|PRIVATE|SELECT|credential|private.invalid'));
}));

test('real original Connector resolver rechecks shared directory on local response delivery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-directory-resolver-')), store = new HubStore(join(root, 'hub.sqlite'), 'fixture'), f = seed(store, true);
  let remote = 0, revoke = false, wrongNode = false;
  const nodeId = store.getConnection('node', f.owner.id)!.nodeId!;
  const connector = createAsyncConnectorClientResolver(f.original, { connectionId: 'node', token: 'fixture-local', dispatch: request => {
    remote++; assert.equal(new URL(request.url).pathname, '/api/connector/v1/sessions/directory');
    assert.equal(request.headers.get(EXPECTED_NODE_HEADER), nodeId);
    if (revoke) f.store.grants.revoke(f.target, f.grant.id, f.grant.version);
    return Response.json(f.page, { headers: {
      [NODE_ID_HEADER]: wrongNode ? 'node_' + randomUUID() : nodeId,
      [CONNECTOR_PROTOCOL_HEADER]: String(CONNECTOR_PROTOCOL.max),
    } });
  } }, quiet);
  const client = new AsyncHubSharedDirectory(f.original, connector, quiet);
  try {
    assert.equal((await client.sessions(f.request(), f.directory)).sessions.length, 1);
    wrongNode = true;
    await assert.rejects(client.sessions(f.request(), f.directory), /Connector identity mismatch/);
    wrongNode = false;
    revoke = true;
    const response = await f.route(client).request(f.request()); assert.equal(response.status, 403);
    assert.equal(remote, 3); assert.ok(f.calls.includes('connectorAccess'));
  } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('caller parameters are copied before permission await; accessor/proxy inputs never run', () => fixture(async f => {
  const blocked = gate(), entered = gate(); let first = true;
  const original = port(async (kind, input) => { if (first) { first = false; entered.resolve(); await blocked.promise; } return f.call(kind, input); });
  const target = { ...f.directory }, pending = new AsyncHubSharedDirectory(original, f.connector, quiet).sessions(f.request(), target);
  await entered.promise; target.connectionId = 'other'; blocked.resolve(); await pending;
  let traps = 0; const bad = new Proxy(f.directory, { ownKeys() { traps++; throw Error('trap'); } });
  await assert.rejects(new AsyncHubSharedDirectory(f.original, f.connector, quiet).sessions(f.request(), bad), denied(400));
  assert.equal(traps, 0); assert.equal(f.remote(), 1);
}));

test('abort retains pending original grant maintenance, never replays; later fresh request recovers', () => fixture(async f => {
  const blocked = gate(), entered = gate(); let pendingCommand = true;
  const original = port(async (kind, input) => { if (kind === 'sharedDirectory' && pendingCommand) {
    pendingCommand = false; entered.resolve(); await blocked.promise; } return f.call(kind, input); });
  const controller = new AbortController(), client = new AsyncHubSharedDirectory(original, f.connector, quiet, 5, 30_000);
  let settled = false; const pending = client.sessions(f.request('', controller.signal), f.directory).finally(() => { settled = true; });
  const rejection = assert.rejects(pending, denied(499)); await entered.promise; controller.abort(); await tick();
  assert.equal(client.pending, 1); assert.equal(settled, false); assert.equal(f.remote(), 0);
  blocked.resolve(); await rejection; assert.equal(client.pending, 0);
  await client.sessions(f.request(), f.directory); assert.equal(f.remote(), 1);
  assert.equal(f.calls.filter(k => k === 'sharedDirectory').length, 3);
}));

test('command/reply validators pin action, grant, exact page order, canonical IDs and resource filters', () => fixture(async f => {
  const command = { action: 'open' as const, target: f.directory }, opened = f.call('sharedDirectory', { ...f.proof(), command });
  assert.ok(validHubSharedDirectoryResult(opened)); assert.ok(opened && !('error' in opened) && opened.action === 'open');
  const project = { action: 'project' as const, target: f.directory, proof: opened.proof, query: { runtime: 'codex' as const, limit: 50 }, page: f.page };
  const value = f.call('sharedDirectory', { ...f.proof(), command: project });
  assert.ok(validHubSharedDirectoryCommand(project)); assert.ok(validHubSharedDirectoryReply(project, value));
  assert.equal(validHubSharedDirectoryCommand({ ...project, query: { limit: 50 } }), false);
  assert.equal(validHubSharedDirectoryCommand({ ...project, proof: { ...opened.proof, grantId: 'other' } }), false);
  assert.equal(validHubSharedDirectoryCommand({ ...project, page: { ...f.page, sessions: [{ sessionKey: 'openclaw:a', runtime: 'openclaw' }] } }), false);
  assert.equal(validHubSharedDirectoryCommand({ ...project, page: { ...f.page, private: true } }), false);
  assert.ok(value && !('error' in value) && value.action === 'project');
  assert.equal(validHubSharedDirectoryReply(project, { ...value, target: { ...f.directory, connectionId: 'other' } }), false);
  assert.equal(validHubSharedDirectoryReply(project, { ...value, page: { ...value.page, sourceCursor: 'other' } }), false);
  assert.equal(validHubSharedDirectoryReply(project, { ...value, page: { ...value.page, sessions: [{ ...value.page.sessions[0], sessionId: 'forged' }] } }), false);
}));

class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = []; stops = 0;
  postMessage(message: { id: number; kind: string; body: string }) { this.messages.push(message); }
  terminate() { this.stops++; return new Promise<number>(() => {}); }
}
test('cross-target worker ACK fences original physical owner until exit with no resend', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-directory-ack-')), file = join(root, 'hub.sqlite'), worker = new FakeWorker();
  const launch = () => worker as unknown as Worker, owner = new AsyncHubMemberOwner({ file }, quiet, launch);
  try {
    const result = owner.command('sharedDirectory', { evidence: {}, expectedScope: 'a'.repeat(64), command: {
      action: 'open', target: { ownerUserId: 'owner', connectionId: 'node', grantId: 'grant' } } }); void result.catch(() => {});
    worker.emit('message', { kind: 'ready' }); await tick(); const sent = worker.messages[0]!;
    worker.emit('message', { id: sent.id, kind: sent.kind, ok: true, body: JSON.stringify({ action: 'project' }) });
    await assert.rejects(result); assert.equal(worker.messages.length, 1); assert.equal(worker.stops, 0);
    assert.throws(() => new AsyncHubMemberOwner({ file }, quiet, launch));
    const closing = owner.close(); void closing.catch(() => {}); await tick(); assert.equal(worker.stops, 1);
    worker.emit('exit', 1); await assert.rejects(closing);
  } finally { worker.emit('exit', 1); rmSync(root, { recursive: true, force: true }); }
});

test('real worker handoff/reopen preserves original cookie, grants, session ownership and execution state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-directory-worker-')), file = join(root, 'hub.sqlite'), store = new HubStore(file, 'fixture'), f = seed(store);
  const before = f.effects(), expected = await new AsyncHubSharedDirectory(f.original, f.connector, quiet).sessions(f.request(), f.directory);
  await store.close(); // No overlapping synchronous writer and worker owner.
  const owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture' }, quiet);
  try {
    assert.deepEqual(await new AsyncHubSharedDirectory(owner, f.connector, quiet).sessions(f.request(), f.directory), expected);
    await owner.close(); const reopened = new HubStore(file, 'fixture');
    try { assert.ok(reopened.identities.requestPrincipal(f.request(), () => false));
      const db = (reopened as unknown as { db: DatabaseSync }).db;
      assert.deepEqual(['node_grants', 'command_receipts', 'hub_execution_leases', 'hub_session_owners']
        .map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()), before);
    } finally { await reopened.close(); }
  } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const phase of ['resolver', 'directory'] as const) for (const failure of [false, true])
test(`directory close retains original ${phase}; late failure=${failure}`, () => fixture(async f => {
  const entered = gate(), release = gate();
  const wait = async () => { entered.resolve(); await release.promise; if (failure) throw Error('PRIVATE upstream detail'); };
  if (phase === 'directory') {
    f.before(wait);
  }
  const connector: AsyncConnectorClientResolver = async (...args) => {
    if (phase === 'resolver') await wait();
    return f.connector(...args);
  };
  const directory = new AsyncHubSharedDirectory(f.original, connector, quiet);
  const response = assert.rejects(directory.sessions(f.request(), f.directory), denied(503));
  await entered.promise;
  assert.equal(directory.pendingRequests, 1); assert.equal(directory.pending, 0);
  const commands = f.calls.length; let closed = false;
  const closing = directory.close(); assert.equal(directory.close(), closing);
  void closing.then(() => { closed = true; });
  try {
    await assert.rejects(directory.sessions(f.request(), f.directory), denied(503));
    await tick(); assert.equal(closed, false); assert.equal(f.calls.length, commands);
    assert.equal(directory.pendingRequests, 1); assert.equal(f.remote(), phase === 'directory' ? 1 : 0);
  } finally { release.resolve(); await response; await closing; }
  assert.equal(directory.pendingRequests, 0); assert.equal(directory.pending, 0);
  assert.equal(f.calls.length, commands, 'late page cannot dispatch a projection or fresh lookup');
}));

test('directory shutdown waits a committed grant-maintenance ACK and does not start remote IO', () => fixture(async f => {
  const entered = gate(), release = gate(); let changes = 0;
  const owner = port(async (kind, input) => {
    const value = f.call(kind, input);
    if (kind === 'sharedDirectory') { changes++; entered.resolve(); await release.promise; }
    return value;
  });
  const directory = new AsyncHubSharedDirectory(owner, f.connector, quiet);
  const response = assert.rejects(directory.sessions(f.request(), f.directory), denied(503));
  await entered.promise; let closed = false;
  const closing = directory.close().then(() => { closed = true; });
  try {
    await tick(); assert.equal(closed, false); assert.equal(directory.pending, 1);
    assert.equal(directory.pendingRequests, 1); assert.equal(f.remote(), 0);
  } finally { release.resolve(); await response; await closing; }
  assert.equal(changes, 1); assert.equal(f.remote(), 0);
}));
