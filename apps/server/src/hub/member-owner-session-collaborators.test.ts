import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { HubStore } from './hub-store.js';
import { LEGACY_HUB_PRINCIPAL } from './identity.js';
import { encodeHubSessionId } from './session-id.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { AsyncHubSessionCollaborators } from './async-session-collaborators.js';
import { HubMemberRequestError } from './async-member-request.js';
import { executeHubMemberCommand, type HubMemberKind } from './member-owner-domain.js';
import { validHubSessionCollaboratorResult, validHubSessionCollaboratorReply, type HubSessionCollaboratorCommand } from './member-session-collaborators-domain.js';
import { registerHubSessionSharingRoutes } from '../routes/hub-session-sharing.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
type Port = Pick<AsyncHubMemberOwner, 'command'>;
const port = (call: (kind: HubMemberKind, input: unknown) => unknown): Port => ({
  command: (async (kind: HubMemberKind, input: unknown) => call(kind, input)) as Port['command'],
});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const deferred = () => { let resolve!: (v: unknown) => void;
  const promise = new Promise<unknown>(r => { resolve = r; }); return { promise, resolve }; };
function seed(store: HubStore) {
  const db = (store as unknown as { db: DatabaseSync }).db;
  const owner = store.createUser('Owner'), creator = store.createUser('Creator'), recipient = store.createUser('Recipient');
  store.upsertConnection({ id: 'node', ownerUserId: owner.id, kind: 'remote', label: 'Environment', connectorUrl: 'http://private.invalid' });
  store.pinConnectionNode('node', owner.id, store.connectionAuthority('node', owner.id)!, 'node_' + randomUUID());
  const target = (userId: string) => ({ ownerUserId: owner.id, connectionId: 'node', userId });
  const save = (userId: string, role: 'developer' | 'observer' | 'none') => {
    const t = target(userId), previous = store.roles.membership(t);
    return store.roles.save(LEGACY_HUB_PRINCIPAL, t, { ...previous, role, migrateLegacy: true,
      nodeVersion: store.connectionAuthority('node', owner.id)!,
      environments: { codex: role === 'developer' ? 'developer' : role === 'observer' ? 'observer' : 'disabled', openclaw: 'disabled' } });
  };
  save(creator.id, 'developer'); save(recipient.id, 'developer');
  const sessionKey = 'codex:' + randomUUID(), creation = store.grants.authorize(target(creator.id), 'sessions:create', { runtime: 'codex' })!;
  store.grants.acceptCreatedSession(creation, sessionKey, randomUUID(), randomUUID(), () => {});
  const resource = { runtime: 'codex' as const, sessionKey }, share = store.grants.authorize(target(creator.id), 'sessions:share', resource)!;
  const collaborator = store.grants.shareSession(share, recipient.id, 'collaborator', { media: true });
  const key = store.identities.issueKey(creator.id), token = store.identities.createSession(key.token)!;
  const sessionId = encodeHubSessionId('node', sessionKey);
  const command: HubSessionCollaboratorCommand = { action: 'list', userId: creator.id, ownerUserId: owner.id, sessionId };
  const request = (signal?: AbortSignal) => new Request('http://fixture.invalid/api/hub/v1/shared/' + owner.id + '/sessions/' + sessionId + '/collaborators',
    { headers: { cookie: 'agentopsdeck_session=' + token }, ...(signal ? { signal } : {}) });
  const proof = () => ({ evidence: { sessionToken: token }, expectedScope: store.identities.recoveryScope({ userId: creator.id, admin: false }) });
  const calls: HubMemberKind[] = [];
  const call = (kind: HubMemberKind, input: unknown) => { calls.push(kind); return executeHubMemberCommand(store, kind, input as never); };
  const original = port(call);
  const route = (asyncCollaborators?: Pick<AsyncHubSessionCollaborators, 'collaborators'>) => {
    const app = new Hono(); registerHubSessionSharingRoutes(app, { hubStore: store,
      ...(asyncCollaborators ? { asyncCollaborators } : {}), principal: c => {
        const actor = store.identities.requestPrincipal(c.req.raw, () => false); if (!actor) throw new HTTPException(401); return actor;
      } }); return app;
  };
  const effects = () => ['node_grants', 'node_grant_dependencies', 'connector_memberships', 'hub_session_owners', 'command_receipts', 'hub_execution_leases']
    .map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all());
  return { store, db, owner, creator, recipient, target, save, share, collaborator, sessionKey, sessionId, resource, key, token, command, request, proof, calls, call, original, route, effects };
}
async function fixture(work: (f: ReturnType<typeof seed>) => unknown) {
  const root = mkdtempSync(join(tmpdir(), 'hub-collaborators-')), store = new HubStore(join(root, 'hub.sqlite'), 'fixture');
  try { await work(seed(store)); } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
}
test('awaited collaborator list preserves old frontend shape without sharing/session/receipt effects', () => fixture(async f => {
  const before = f.effects(), old = await f.route().request(f.request());
  const response = await f.route(new AsyncHubSessionCollaborators(f.original, quiet)).request(f.request());
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const page = await response.json(); assert.deepEqual(page, await old.json());
  assert.equal(page.collaborators[0].id, f.collaborator.id); assert.equal(page.candidates[0].id, f.recipient.id);
  assert.deepEqual(f.effects(), before); assert.equal(f.calls.filter(k => k === 'sessionCollaborators').length, 2);
  for (const secret of [f.token, f.key.token, 'private.invalid']) assert.equal(JSON.stringify(page).includes(secret), false);
}));
for (const asynchronous of [false, true]) for (const role of ['observer', 'developer'] as const) {
  test(`${asynchronous ? 'awaited' : 'legacy'} collaborator HTTP candidates exclude disabled ${role} without reviving shares`, () => fixture(async f => {
    f.save(f.recipient.id, role);
    f.store.roles.setHubRole(LEGACY_HUB_PRINCIPAL, f.owner.id, 'admin', 0);
    const key = f.store.identities.issueKey(f.owner.id);
    const lifecycle = (status: 'disabled' | 'enabled', expectedVersion: number) => f.call('userChange', {
      evidence: { accessKey: key.token },
      expectedScope: f.store.identities.recoveryScope({ userId: f.owner.id, admin: true }),
      change: { action: 'accessChange', userId: f.recipient.id, status, expectedVersion },
    });
    const app = f.route(asynchronous ? new AsyncHubSessionCollaborators(f.original, quiet) : undefined);
    const read = async () => {
      const response = await app.request(f.request());
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      return response.json();
    };
    const expected = { id: f.recipient.id, label: f.recipient.label, canChat: role === 'developer' };
    assert.deepEqual((await read()).candidates, [expected]);
    assert.deepEqual(lifecycle('disabled', 0), { access: { userId: f.recipient.id, status: 'disabled', version: 1 } });
    assert.deepEqual((await read()).candidates, []);
    assert.throws(() => f.store.grants.shareSession(f.share, f.recipient.id, 'observer'));
    assert.deepEqual(lifecycle('enabled', 1), { access: { userId: f.recipient.id, status: 'enabled', version: 2 } });
    const restored = await read();
    assert.deepEqual(restored.candidates, [expected]); assert.deepEqual(restored.collaborators, []);
    assert.equal(f.store.grants.authorize(f.target(f.recipient.id), 'messages:read', f.resource), undefined);
    const fresh = f.store.grants.shareSession(f.share, f.recipient.id, 'observer');
    assert.deepEqual((await read()).collaborators.map((item: { id: string }) => item.id), [fresh.id]);
  }));
}
for (const fault of ['disabled','nodeChanged','revoked','creatorChanged','memberCeiling','invalidSession'] as const) {
  test('original collaborator denial retained for ' + fault, () => fixture(async f => {
    if (fault === 'disabled') f.db.prepare("UPDATE env_connections SET status='disabled'").run();
    if (fault === 'nodeChanged') f.store.upsertConnection({ id: 'node', ownerUserId: f.owner.id, kind: 'remote', label: 'Changed', connectorUrl: 'http://changed.invalid' });
    if (fault === 'revoked') f.store.grants.revoke(f.target(f.creator.id), f.share.grantId, f.share.version);
    if (fault === 'creatorChanged') f.db.prepare('UPDATE hub_session_owners SET user_id=?').run(f.recipient.id);
    if (fault === 'memberCeiling') f.save(f.creator.id, 'none');
    const request = fault === 'invalidSession' ? new Request(f.request().url.replace(f.sessionId, 'bad'), { headers: f.request().headers }) : f.request();
    const old = await f.route().request(request), response = await f.route(new AsyncHubSessionCollaborators(f.original, quiet)).request(request);
    assert.equal(response.status, old.status); assert.ok([403,404].includes(response.status));
  }));
}
for (const fault of ['revoke','replace','nodeChanged','ownershipChanged','credentialRevoked'] as const) {
  test('post-await original-version check blocks ' + fault + ' without new authority/replay', () => fixture(async f => {
    const caller = new AsyncHubSessionCollaborators(port((kind, input) => {
      const value = f.call(kind, input);
      if (kind === 'sessionCollaborators' && (input as { command: { action: string } }).command.action === 'list') {
        if (fault === 'revoke' || fault === 'replace') {
          f.store.grants.revoke(f.target(f.creator.id), f.share.grantId, f.share.version);
          if (fault === 'replace') f.store.grants.create(f.target(f.creator.id), { runtime: 'codex', sessionKey: f.sessionKey, actions: ['messages:read','sessions:share'] });
        }
        if (fault === 'nodeChanged') f.store.upsertConnection({ id: 'node', ownerUserId: f.owner.id, kind: 'remote', label: 'Changed', connectorUrl: 'http://changed.invalid' });
        if (fault === 'ownershipChanged') f.db.prepare('UPDATE hub_session_owners SET user_id=?').run(f.recipient.id);
        if (fault === 'credentialRevoked') f.store.identities.revokeSession(f.token);
      }
      return value;
    }), quiet);
    await assert.rejects(caller.collaborators(f.request(), f.owner.id, f.sessionId), e => e instanceof HubMemberRequestError && e.status === (fault === 'credentialRevoked' ? 401 : 403));
    assert.ok(f.calls.filter(k => k === 'sessionCollaborators').length <= 2);
  }));
}
for (const field of ['userId','ownerUserId','sessionId','action'] as const) {
  test('forged collaborator ' + field + ' ACK refused without replay', () => fixture(async f => {
    const caller = new AsyncHubSessionCollaborators(port((kind, input) => {
      const value = f.call(kind, input); return kind === 'sessionCollaborators' ? { ...value as object, [field]: field === 'action' ? 'check' : randomUUID() } : value;
    }), quiet);
    const before = f.effects(); await assert.rejects(caller.collaborators(f.request(), f.owner.id, f.sessionId), e => e instanceof HubMemberRequestError && e.status === 503);
    assert.deepEqual(f.effects(), before); assert.equal(f.calls.filter(k => k === 'sessionCollaborators').length, 1);
  }));
}
test('private proof/scope/user correlation is validated by original SQL identity', () => fixture(f => {
  assert.equal(f.call('sessionCollaborators', { ...f.proof(), expectedScope: 'a'.repeat(64), command: f.command }), null);
  assert.throws(() => f.call('sessionCollaborators', { ...f.proof(), command: { ...f.command, userId: f.recipient.id } }));
  const value = f.call('sessionCollaborators', { ...f.proof(), command: f.command });
  assert.ok(validHubSessionCollaboratorResult(value) && value && value.status === 200 && value.proof);
  const check = { ...f.command, action: 'check' as const, proof: { ...value.proof, shareVersion: value.proof.shareVersion + 1 } };
  const denied = f.call('sessionCollaborators', { ...f.proof(), command: check }); assert.ok(denied && 'status' in denied && denied.status === 403);
}));
test('strict collaborator page/proof limits reject credentials, duplicate and malformed ACKs', () => fixture(f => {
  const value = f.call('sessionCollaborators', { ...f.proof(), command: f.command }); assert.ok(validHubSessionCollaboratorResult(value) && value && value.page);
  assert.equal(validHubSessionCollaboratorReply(f.command, value), true);
  for (const page of [{ ...value.page, extra: true }, { ...value.page, candidates: [...value.page.candidates, ...value.page.candidates] },
    { ...value.page, collaborators: [...value.page.collaborators, ...value.page.collaborators] },
    { ...value.page, candidates: [{ ...value.page.candidates[0], label: 'x'.repeat(65537) }] },
    { ...value.page, candidates: [{ ...value.page.candidates[0], credential: 'private' }] },
    { ...value.page, candidates: new Array(501).fill(value.page.candidates[0]) }]) assert.equal(validHubSessionCollaboratorResult({ ...value, page }), false);
  assert.equal(validHubSessionCollaboratorResult({ ...value, proof: { ...value.proof, shareVersion: -1 } }), false);
  const collaborator = value.page.collaborators[0]!;
  for (const changed of [{ ...collaborator, nodeVersion: collaborator.nodeVersion + 1 },
    { ...collaborator, policy: { ...collaborator.policy, runtime: 'openclaw' } },
    { ...collaborator, policy: { ...collaborator.policy, sessionKey: 'codex:another-session' } },
    { ...collaborator, policy: { ...collaborator.policy, agentId: 'another-agent' } }]) {
    assert.equal(validHubSessionCollaboratorResult({ ...value, page: { ...value.page, collaborators: [changed] } }), false);
  }
}));
test('list warnings/cancellation never release original maintenance command before settlement', () => fixture(async f => {
  const gate = deferred(), entered = deferred(), logs: string[] = [], abort = new AbortController(); let value: unknown, settled = false;
  const caller = new AsyncHubSessionCollaborators(port((kind, input) => {
    const result = f.call(kind, input); if (kind !== 'sessionCollaborators') return result;
    value = result; entered.resolve(null); return gate.promise;
  }), new PerformanceDiagnostics(line => logs.push(line)), 5, 20);
  const work = caller.collaborators(f.request(abort.signal), f.owner.id, f.sessionId); void work.then(() => { settled = true; }, () => { settled = true; });
  await entered.promise; abort.abort(); await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(settled, false); assert.equal(caller.pending, 1); assert.equal(f.calls.filter(k => k === 'sessionCollaborators').length, 1);
  assert.ok(logs.some(line => { const d = JSON.parse(line); return d.step === 44 && d.phase === 'pending'; }));
  gate.resolve(value); await assert.rejects(work, e => e instanceof HubMemberRequestError && e.status === 499); await tick(); assert.equal(caller.pending, 0);
  for (const secret of [f.token, f.key.token, f.creator.id, f.owner.id, f.sessionId, 'private.invalid']) assert.equal(logs.join('').includes(secret), false);
}));
test('unknown maintenance failure stays503, never becomes permission conflict/replay', () => fixture(async f => {
  const before = f.effects(), caller = new AsyncHubSessionCollaborators(port((kind, input) => {
    const result = f.call(kind, input); if (kind === 'sessionCollaborators') throw Error('private SQL detail'); return result;
  }), quiet);
  const response = await f.route(caller).request(f.request()); assert.equal(response.status, 503);
  assert.equal(JSON.stringify(await response.json()).includes('private SQL'), false); assert.deepEqual(f.effects(), before);
  assert.equal(f.calls.filter(k => k === 'sessionCollaborators').length, 1);
}));
test('candidate labels bounded before original ordered SQL materialization', () => fixture(async f => {
  f.db.prepare('UPDATE users SET label=? WHERE id=?').run('x'.repeat(65537), f.recipient.id);
  const before = f.effects(), response = await f.route(new AsyncHubSessionCollaborators(f.original, quiet)).request(f.request());
  assert.equal(response.status, 503); assert.deepEqual(f.effects(), before);
}));
test('outer rollback/log-sink failure preserve original sharing transaction', () => fixture(async f => {
  const before = f.effects(); f.db.exec('BEGIN');
  const caller = new AsyncHubSessionCollaborators(f.original, new PerformanceDiagnostics(() => { throw Error('sink'); }));
  assert.equal((await caller.collaborators(f.request(), f.owner.id, f.sessionId)).collaborators.length, 1);
  f.db.exec('ROLLBACK'); assert.deepEqual(f.effects(), before);
}));
test('authentication precedes invalid session; original mutations remain unchanged', () => fixture(async f => {
  const app = f.route(new AsyncHubSessionCollaborators(f.original, quiet));
  assert.equal((await app.request('/api/hub/v1/shared/owner/sessions/bad/collaborators')).status, 401);
  const old = await f.route().request(f.request().url, { method: 'POST', headers: f.request().headers, body: '{}' });
  const response = await app.request(f.request().url, { method: 'POST', headers: f.request().headers, body: '{}' });
  assert.equal(response.status, old.status); assert.deepEqual(await response.json(), await old.json());
  assert.equal(f.calls.includes('sessionCollaborators'), false);
}));
class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = []; stops = 0;
  postMessage(m: { id: number; kind: string; body: string }) { this.messages.push(m); }
  terminate() { this.stops++; return Promise.resolve(1); }
}
test('mis-correlated worker ACK keeps physical owner fenced through exit without replay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-collaborator-ack-')), file = join(root, 'hub.sqlite'), worker = new FakeWorker();
  const launch = () => worker as unknown as Worker, owner = new AsyncHubMemberOwner({ file }, quiet, launch);
  try {
    const command: HubSessionCollaboratorCommand = { action: 'list', userId: 'user', ownerUserId: 'owner', sessionId: 'bad' };
    const work = owner.command('sessionCollaborators', { evidence: {}, expectedScope: 'a'.repeat(64), command }); void work.catch(() => {});
    worker.emit('message', { kind: 'ready' }); await tick(); const m = worker.messages[0]!;
    worker.emit('message', { id: m.id, kind: m.kind, ok: true, body: JSON.stringify({ ...command, userId: 'other', status: 404, proof: null, page: null }) });
    await assert.rejects(work); assert.equal(worker.messages.length, 1); assert.equal(worker.stops, 0);
    assert.throws(() => new AsyncHubMemberOwner({ file }, quiet, launch));
    const closing = owner.close(); void closing.catch(() => {}); await tick(); assert.equal(worker.stops, 1);
    assert.throws(() => new AsyncHubMemberOwner({ file }, quiet, launch)); worker.emit('exit', 1); await assert.rejects(closing);
  } finally { worker.emit('exit', 1); rmSync(root, { recursive: true, force: true }); }
});
test('real worker original-data reopen preserves existing session and collaboration records', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-collaborator-worker-')), file = join(root, 'hub.sqlite'), store = new HubStore(file, 'fixture'), f = seed(store);
  const proof = f.proof(), expected = f.call('sessionCollaborators', { ...proof, command: f.command }), before = f.effects(); await store.close();
  const owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture' }, quiet);
  try {
    const caller = new AsyncHubSessionCollaborators(owner, quiet), page = await caller.collaborators(f.request(), f.owner.id, f.sessionId);
    assert.ok(expected && 'page' in expected); assert.deepEqual(page, expected.page); await owner.close();
    const reopened = new HubStore(file, 'fixture'); try {
      assert.ok(reopened.identities.requestPrincipal(f.request(), () => false));
      const db = (reopened as unknown as { db: DatabaseSync }).db;
      assert.deepEqual(['node_grants','node_grant_dependencies','connector_memberships','hub_session_owners','command_receipts','hub_execution_leases'].map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()), before);
    } finally { await reopened.close(); }
  } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
});
