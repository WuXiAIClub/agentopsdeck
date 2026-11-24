import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import { HubStore } from './hub-store.js';
import { LEGACY_HUB_PRINCIPAL } from './identity.js';
import { encodeHubSessionId } from './session-id.js';
import { executeHubMemberCommand } from './member-owner-domain.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { validHubSessionCollaboratorResult } from './member-session-collaborators-domain.js';
import { validHubSessionSharingCommand, validHubSessionSharingReply, validHubSessionSharingResult,
  type HubSessionSharingCommand } from './member-session-sharing-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { connectionRecoverySnapshot } from '../storage/connection-recovery.js';

const quiet = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function seed(store: HubStore) {
  const db = (store as unknown as { db: DatabaseSync }).db;
  const owner = store.createUser('Owner'), creator = store.createUser('Creator'), recipient = store.createUser('Recipient');
  store.upsertConnection({ id: 'node', ownerUserId: owner.id, kind: 'remote', label: 'Environment', connectorUrl: 'http://private.invalid' });
  store.pinConnectionNode('node', owner.id, store.connectionAuthority('node', owner.id)!, 'node_' + randomUUID());
  const target = (userId: string) => ({ ownerUserId: owner.id, connectionId: 'node', userId });
  for (const user of [creator, recipient]) {
    const t = target(user.id);
    store.roles.save(LEGACY_HUB_PRINCIPAL, t, { ...store.roles.membership(t), role: 'developer', migrateLegacy: true,
      nodeVersion: store.connectionAuthority('node', owner.id)!, environments: { codex: 'developer', openclaw: 'disabled' } });
  }
  const sessionKey = 'codex:' + randomUUID(), creation = store.grants.authorize(target(creator.id), 'sessions:create', { runtime: 'codex' })!;
  store.grants.acceptCreatedSession(creation, sessionKey, randomUUID(), randomUUID(), () => {});
  const resource = { runtime: 'codex' as const, sessionKey }, share = store.grants.authorize(target(creator.id), 'sessions:share', resource)!;
  const key = store.identities.issueKey(creator.id), token = store.identities.createSession(key.token)!;
  const sessionId = encodeHubSessionId('node', sessionKey);
  const proof = { evidence: { sessionToken: token }, expectedScope: store.identities.recoveryScope({ userId: creator.id, admin: false }) };
  const listed = executeHubMemberCommand(store, 'sessionCollaborators', { ...proof,
    command: { action: 'list', userId: creator.id, ownerUserId: owner.id, sessionId } });
  assert.ok(validHubSessionCollaboratorResult(listed) && listed?.proof);
  const base = { userId: creator.id, ownerUserId: owner.id, sessionId, proof: listed.proof };
  const command: HubSessionSharingCommand = { ...base, action: 'create', recipientId: recipient.id, role: 'collaborator', options: { media: true } };
  const call = (command: HubSessionSharingCommand) => executeHubMemberCommand(store, 'sessionSharing', { ...proof, command });
  const effects = () => ['node_grants','node_grant_dependencies','hub_session_owners','command_receipts','hub_execution_leases']
    .map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all());
  return { db, store, owner, creator, recipient, target, share, sessionKey, sessionId, key, token, proof, base, command, call, effects };
}
async function fixture(work: (f: ReturnType<typeof seed>) => unknown) {
  const root = mkdtempSync(join(tmpdir(), 'hub-sharing-domain-')), store = new HubStore(join(root, 'hub.sqlite'), 'fixture');
  try { await work(seed(store)); } finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
}
test('fixed sharing domain preserves original create/update/delete result and tables', () => fixture(f => {
  const created = f.call(f.command); assert.ok(validHubSessionSharingReply(f.command, created) && created?.grant);
  assert.equal(created.status, 201);
  assert.equal(created.grant.userId, f.recipient.id);
  assert.deepEqual(created.grant, f.store.grants.collaborators(f.share)[0]);
  const update: HubSessionSharingCommand = { ...f.base, action: 'update', id: created.grant.id, version: created.grant.version,
    role: 'observer', options: { live: false, media: false } };
  const updated = f.call(update); assert.ok(validHubSessionSharingReply(update, updated) && updated?.grant);
  assert.equal(updated.grant.version, 2); assert.deepEqual(updated.grant.policy.actions, ['sessions:read','messages:read']);
  const stale = f.call(update); assert.equal(stale?.status, 409);
  const remove: HubSessionSharingCommand = { ...f.base, action: 'delete', id: updated.grant.id, version: updated.grant.version };
  const deleted = f.call(remove); assert.ok(validHubSessionSharingReply(remove, deleted));
  assert.equal(deleted?.ok, true); assert.equal(f.store.grants.collaborators(f.share).length, 0);
  assert.equal(f.call(remove)?.ok, false);
  for (const table of ['command_receipts','hub_execution_leases']) assert.equal(f.db.prepare('SELECT count(*) AS n FROM ' + table).get()!.n, 0);
}));

test('exact revocation status remains pending until original remote lease ACK, never expiry or another grant', () => fixture(f => {
  const created = f.call(f.command); assert.ok(created?.grant);
  const grant = created.grant;
  const send = f.store.grants.authorize(f.target(f.recipient.id), 'messages:send', { runtime: 'codex', sessionKey: f.sessionKey }, grant.id)!;
  const nodeId = (f.db.prepare('SELECT node_id FROM env_connections WHERE id=? AND owner_user_id=?').get('node', f.owner.id) as { node_id: string }).node_id;
  const lease = f.store.executionLeases.reserve(send, nodeId, 'original-issuer', ['messages:send']);
  const remove: HubSessionSharingCommand = { ...f.base, action: 'delete', id: grant.id, version: grant.version };
  const result = f.call(remove); assert.ok(validHubSessionSharingReply(remove, result));
  assert.deepEqual(result?.revocation, { state: 'pending', pending: 1, confirmed: 0 });
  const status: HubSessionSharingCommand = { ...remove, action: 'revocation' };
  const before = f.effects(); const read = f.call(status);
  assert.ok(validHubSessionSharingReply(status, read)); assert.deepEqual(f.effects(), before);
  assert.equal(f.call({ ...status, version: 2 })?.status, 404);
  assert.equal(f.call({ ...status, id: f.share.grantId })?.status, 404);
  f.db.prepare('UPDATE hub_execution_leases SET expires_at=0 WHERE id=?').run(lease.id);
  assert.equal(f.call(status)?.revocation?.state, 'pending');
  assert.equal(f.store.executionLeases.acknowledgeRevoke(lease.id, lease.version + 1), false);
  assert.equal(f.call(status)?.revocation?.state, 'pending');
  assert.equal(f.store.executionLeases.acknowledgeRevoke(lease.id, lease.version), true);
  assert.deepEqual(f.call(status)?.revocation, { state: 'confirmed', pending: 0, confirmed: 1 });
  assert.equal(validHubSessionSharingReply(status, { ...f.call(status), revocation: { state: 'confirmed', pending: 1, confirmed: 0 } }), false);
}));
for (const options of [{}, { live: false }, { queue: false }, { media: true }, { live: false, queue: false, media: true }]) {
  test('sharing ACK matches exact derived policy for options ' + JSON.stringify(options), () => fixture(f => {
    const command = { ...f.command, options }, result = f.call(command);
    assert.ok(validHubSessionSharingReply(command, result) && result?.grant);
  }));
}
for (const change of ['readVersion','shareVersion','nodeVersion','readId','shareId','creator','credential','recipient'] as const) {
  test('fixed command denies changed original ' + change + ' without grant write', () => fixture(f => {
    let command = structuredClone(f.command);
    if (['readVersion','shareVersion','nodeVersion'].includes(change)) {
      const k = change as 'readVersion' | 'shareVersion' | 'nodeVersion'; command.proof[k]++;
    }
    if (change === 'readId' || change === 'shareId') command.proof[change] = randomUUID();
    if (change === 'creator') f.db.prepare('UPDATE hub_session_owners SET user_id=?').run(f.recipient.id);
    if (change === 'credential') f.store.identities.revokeSession(f.token);
    if (change === 'recipient') command = { ...command, recipientId: randomUUID() };
    const before = f.effects(), result = f.call(command);
    if (change === 'credential') assert.equal(result, null);
    else assert.equal(result?.status, change === 'recipient' ? 400 : 403);
    assert.deepEqual(f.effects(), before);
  }));
}
test('creator original authority revocation refuses mutation without obtaining replacement authority', () => fixture(f => {
  f.store.grants.revoke(f.target(f.creator.id), f.share.grantId, f.share.version);
  f.store.grants.create(f.target(f.creator.id), { runtime: 'codex', sessionKey: f.sessionKey, actions: ['messages:read','sessions:share'] });
  const before = f.effects(); assert.equal(f.call(f.command)?.status, 403); assert.deepEqual(f.effects(), before);
}));
test('outer rollback retains same-owner transaction boundary and no independent commit', () => fixture(f => {
  const before = f.effects(); f.db.exec('BEGIN'); assert.equal(f.call(f.command)?.status, 201);
  f.db.exec('ROLLBACK'); assert.deepEqual(f.effects(), before);
}));
for (const phase of ['beforeRelease','afterRelease'] as const) {
  test('outer identity ' + phase + ' remains unknown and never repeats original sharing write', () => fixture(f => {
    const before = f.effects(), original = f.db.exec.bind(f.db); let releases = 0;
    f.db.exec = sql => {
      if (sql === 'RELEASE hub_identity_check') {
        releases++; if (phase === 'afterRelease') original(sql);
        throw Error('private identity RELEASE fault');
      }
      return original(sql);
    };
    try {
      assert.throws(() => f.call(f.command)); assert.equal(releases, 1); assert.equal(f.db.isTransaction, false);
      if (phase === 'beforeRelease') assert.deepEqual(f.effects(), before);
      else assert.notDeepEqual(f.effects(), before);
    } finally { f.db.exec = original; }
  }));
}
test('rollback failure fences same connection and cannot become definite conflict', () => fixture(f => {
  const original = f.db.exec.bind(f.db); let releases = 0, rollbacks = 0;
  f.db.exec = sql => {
    if (sql === 'RELEASE hub_identity_check') { releases++; throw Error('private release'); }
    if (sql === 'ROLLBACK') { rollbacks++; throw Error('private rollback'); }
    return original(sql);
  };
  try {
    assert.throws(() => f.call(f.command)); assert.equal(releases, 1); assert.equal(rollbacks, 1);
    assert.equal(f.db.isTransaction, true); assert.notEqual(connectionRecoverySnapshot(f.db).state, 'ready');
    // A subsequent request may retry ONLY the original rollback through the
    // existing recovery facade. It must not repeat the sharing transaction.
    assert.throws(() => f.call(f.command)); assert.equal(releases, 1); assert.equal(rollbacks, 2);
  } finally { f.db.exec = original; }
}));
test('SQL trigger failure rolls back sharing and preserves raw uncertainty without mutation replay', () => fixture(f => {
  const before = f.effects();
  f.db.exec("CREATE TRIGGER fixture_fault BEFORE INSERT ON node_grants BEGIN SELECT RAISE(ABORT, 'private SQL fault'); END");
  assert.throws(() => f.call(f.command)); assert.deepEqual(f.effects(), before); assert.equal(f.db.isTransaction, false);
}));
test('missing original write readback rolls back instead of returning successful null ACK', () => fixture(f => {
  const before = f.effects(), original = f.store.grants.get.bind(f.store.grants);
  f.store.grants.get = (target, id) => id === f.share.grantId ? original(target, id) : undefined;
  try { assert.throws(() => f.call(f.command)); assert.deepEqual(f.effects(), before); }
  finally { f.store.grants.get = original; }
}));
test('malformed sharing commands and acknowledgements are rejected', () => fixture(f => {
  for (const command of [{ ...f.command, sql: 'private' }, { ...f.command, options: { secret: 'private' } },
    { ...f.command, options: { media: 1 } }, { ...f.command, role: 'owner' },
    { ...f.command, proof: { ...f.command.proof, authorized: true } }]) assert.equal(validHubSessionSharingCommand(command), false);
  const value = f.call(f.command); assert.ok(value?.grant);
  for (const changed of [{ ...value, userId: randomUUID() }, { ...value, action: 'update' },
    { ...value, proof: { ...value.proof, shareVersion: value.proof.shareVersion + 1 } },
    { ...value, grant: { ...value.grant, userId: randomUUID() } },
    { ...value, grant: { ...value.grant, version: 2 } },
    { ...value, grant: { ...value.grant, policy: { ...value.grant.policy, actions: ['messages:read'] } } }]) {
    assert.equal(validHubSessionSharingReply(f.command, changed), false);
  }
  assert.equal(validHubSessionSharingResult({ ...value, credential: 'private' }), false);
  assert.equal(validHubSessionSharingReply(f.command, { ...value, status: 409, grant: null, ok: null, sessionId: 'other' }), false);
}));
test('successful update permits maximum safe version while original overflow fails closed', () => fixture(f => {
  const created = f.call(f.command); assert.ok(created?.grant);
  f.db.prepare('UPDATE node_grants SET version=? WHERE id=?').run(Number.MAX_SAFE_INTEGER - 1, created.grant.id);
  const command: HubSessionSharingCommand = { ...f.base, action: 'update', id: created.grant.id,
    version: Number.MAX_SAFE_INTEGER - 1, role: 'observer', options: {} };
  const updated = f.call(command); assert.ok(validHubSessionSharingReply(command, updated));
  assert.equal(updated?.grant?.version, Number.MAX_SAFE_INTEGER);
  const before = f.effects(); assert.throws(() => f.call({ ...command, version: Number.MAX_SAFE_INTEGER })); assert.deepEqual(f.effects(), before);
}));
test('negative sharing ACK echoes the complete request, including role, options and recipient', () => fixture(f => {
  const command = { ...f.command, recipientId: randomUUID() };
  const result = f.call(command); assert.ok(result && result.status === 400);
  assert.equal(validHubSessionSharingReply(command, result), true);
  for (const changed of [{ ...result, recipientId: f.recipient.id }, { ...result, role: 'observer' },
    { ...result, options: {} }, { ...result, options: { media: false } }]) {
    assert.equal(validHubSessionSharingResult(changed), true);
    assert.equal(validHubSessionSharingReply(command, changed), false);
  }
  const { status: _status, grant: _grant, ok: _ok, ...echo } = result;
  assert.deepEqual(echo, command);
}));
test('update refusal and delete success ACK require exact original grant id and version', () => fixture(f => {
  const created = f.call(f.command); assert.ok(created?.grant);
  const update: HubSessionSharingCommand = { ...f.base, action: 'update', id: created.grant.id,
    version: created.grant.version + 1, role: 'observer', options: {} };
  const refused = f.call(update); assert.ok(refused?.status === 409);
  assert.equal(validHubSessionSharingReply(update, refused), true);
  for (const changed of [{ ...refused, id: randomUUID() }, { ...refused, version: update.version + 1 }]) {
    assert.equal(validHubSessionSharingResult(changed), true);
    assert.equal(validHubSessionSharingReply(update, changed), false);
  }
  const remove: HubSessionSharingCommand = { ...f.base, action: 'delete', id: created.grant.id, version: created.grant.version };
  const deleted = f.call(remove); assert.ok(deleted?.status === 200 && deleted.ok === true);
  assert.equal(validHubSessionSharingReply(remove, deleted), true);
  for (const changed of [{ ...deleted, id: randomUUID() }, { ...deleted, version: remove.version + 1 }]) {
    assert.equal(validHubSessionSharingResult(changed), true);
    assert.equal(validHubSessionSharingReply(remove, changed), false);
  }
}));
class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = []; stops = 0;
  postMessage(m: { id: number; kind: string; body: string }) { this.messages.push(m); }
  terminate() { this.stops++; return Promise.resolve(1); }
}
test('mis-correlated sharing negative ACK keeps original owner reserved until real exit', () => fixture(async f => {
  const root = mkdtempSync(join(tmpdir(), 'hub-sharing-ack-')), file = join(root, 'hub.sqlite'), worker = new FakeWorker();
  const launch = () => worker as unknown as Worker, owner = new AsyncHubMemberOwner({ file }, quiet, launch);
  try {
    const work = owner.command('sessionSharing', { ...f.proof, command: f.command }); void work.catch(() => {});
    worker.emit('message', { kind: 'ready' }); await tick(); const m = worker.messages[0]!;
    worker.emit('message', { id: m.id, kind: m.kind, ok: true,
      body: JSON.stringify({ ...f.command, userId: randomUUID(), status: 409, grant: null, ok: null }) });
    await assert.rejects(work); assert.equal(worker.messages.length, 1); assert.equal(worker.stops, 0);
    assert.throws(() => new AsyncHubMemberOwner({ file }, quiet, launch));
    const closing = owner.close(); void closing.catch(() => {}); await tick(); assert.equal(worker.stops, 1);
    assert.throws(() => new AsyncHubMemberOwner({ file }, quiet, launch)); worker.emit('exit', 1); await assert.rejects(closing);
  } finally { worker.emit('exit', 1); rmSync(root, { recursive: true, force: true }); }
}));
test('real sharing worker reopen preserves credentials, recorded creator and collaboration data', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-sharing-worker-')), file = join(root, 'hub.sqlite'), store = new HubStore(file, 'fixture'), f = seed(store);
  const unrelated = ['hub_session_owners','command_receipts','hub_execution_leases'].map(table => f.db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all());
  await store.close(); const owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'fixture' }, quiet);
  try {
    const created = await owner.command('sessionSharing', { ...f.proof, command: f.command });
    assert.ok(validHubSessionSharingReply(f.command, created) && created?.grant); await owner.close();
    const reopened = new HubStore(file, 'fixture'); try {
      const request = new Request('http://fixture.invalid', { headers: { cookie: 'agentopsdeck_session=' + f.token } });
      assert.ok(reopened.identities.requestPrincipal(request, () => false));
      assert.equal(reopened.grants.collaborators(f.share)[0]!.id, created.grant.id);
      const db = (reopened as unknown as { db: DatabaseSync }).db;
      assert.deepEqual(['hub_session_owners','command_receipts','hub_execution_leases'].map(table => db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()), unrelated);
    } finally { await reopened.close(); }
  } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
});
