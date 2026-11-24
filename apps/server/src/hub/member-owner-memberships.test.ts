import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { executeHubMemberCommand, hubMemberCommandSteps, validHubMemberInput, validHubMemberOutput } from './member-owner-domain.js';
import { validHubMembershipReply, type HubMembershipCommand } from './member-membership-domain.js';
import { connectionRecoverySnapshot } from '../storage/connection-recovery.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
const quiet = new PerformanceDiagnostics(() => {});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function seed(store: HubStore) {
  const db = (store as unknown as { db: DatabaseSync }).db;
  const owner = store.createUser('Owner'), member = store.createUser('Member'), other = store.createUser('Other');
  store.upsertConnection({ id: 'node', ownerUserId: owner.id, kind: 'remote', label: 'Node', connectorUrl: 'http://private.invalid' });
  store.pinConnectionNode('node', owner.id, store.connectionAuthority('node', owner.id)!, 'node_' + randomUUID());
  const target = { ownerUserId: owner.id, connectionId: 'node', userId: member.id };
  const actor = { userId: owner.id, admin: false };
  const key = store.identities.issueKey(owner.id), token = store.identities.createSession(key.token)!;
  const proof = { evidence: { sessionToken: token }, expectedScope: store.identities.recoveryScope(actor) };
  const command = (command: HubMembershipCommand) => executeHubMemberCommand(store,
    command.action === 'set' ? 'membershipSet' : 'membershipRead', { ...proof, command } as never);
  const set = (overrides: Partial<Extract<HubMembershipCommand, { action: 'set' }>['membership']> = {}): Extract<HubMembershipCommand, { action: 'set' }> => ({
    action: 'set', target, membership: { role: 'developer', version: store.roles.membership(target).version,
      nodeVersion: store.connectionAuthority('node', owner.id)!, environments: { codex: 'developer', openclaw: 'observer' }, migrateLegacy: true,
      grantSetDigest: store.roles.snapshot(actor, target).grantSetDigest, ...overrides },
  });
  return { db, store, owner, member, other, target, actor, key, token, proof, command, set };
}
async function fixture(work: (f: ReturnType<typeof seed>) => unknown) {
  const root = mkdtempSync(join(tmpdir(), 'hub-membership-')), file = join(root, 'hub.sqlite'), store = new HubStore(file, 'membership-fixture');
  try { await work(seed(store)); }
  finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
}
test('membership read matches original legacy snapshot without granting execution', () => fixture(f => {
  const before = f.db.prepare('SELECT total_changes() AS n').get()!.n;
  const result = f.command({ action: 'read', target: f.target });
  assert.deepEqual(result, { target: f.target, snapshot: f.store.roles.snapshot(f.actor, f.target) });
  assert.equal(f.store.roles.membership(f.target).version, 0);
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get()!.n, before);
  assert.equal(f.store.grants.authorize(f.target, 'messages:send', { runtime: 'codex', sessionKey: 'codex:other' }), undefined);
}));
test('membership authorize preserves PUT pre-body management without requiring recipient', () => fixture(f => {
  const target = { ...f.target, userId: 'missing' };
  assert.deepEqual(f.command({ action: 'authorize', target }), { target, authorized: true });
  assert.deepEqual(f.command({ action: 'read', target }), { error: 'missing' });
  assert.deepEqual(f.command({ ...f.set(), target }), { error: 'conflict' });
  assert.deepEqual(f.command({ action: 'read', target: { ...target, connectionId: 'missing' } }), { error: 'denied' });
}));
test('membership save retains exact-session grants and original audit in one original transaction', () => fixture(f => {
  const original = f.store.grants.create(f.target, { runtime: 'codex', sessionKey: 'codex:owned', actions: ['messages:read', 'messages:send'] });
  const result = f.command(f.set());
  assert.deepEqual(result, { target: f.target, snapshot: f.store.roles.snapshot(f.actor, f.target) });
  assert.equal(f.store.roles.membership(f.target).version, 1);
  assert.ok(f.store.grants.authorize(f.target, 'messages:send', { runtime: 'codex', sessionKey: 'codex:owned' }));
  assert.ok(f.db.prepare('SELECT 1 FROM node_grants WHERE id=? AND revoked=0').get(original.id));
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM hub_auth_audit WHERE record LIKE '%role_changed%'").get()!.n, 1);
  assert.equal(f.store.grants.authorize(f.target, 'messages:send', { runtime: 'codex', sessionKey: 'codex:other' }), undefined);
}));
test('membership demotion revokes parent and dependent sharing without reviving on promotion', () => fixture(f => {
  f.command(f.set());
  const creation = f.store.grants.authorize(f.target, 'sessions:create', { runtime: 'codex' })!;
  f.store.grants.acceptCreatedSession(creation, 'codex:owned', randomUUID(), randomUUID(), () => {});
  const root = f.store.grants.authorize(f.target, 'sessions:share', { runtime: 'codex', sessionKey: 'codex:owned' })!;
  const childTarget = { ...f.target, userId: f.other.id };
  f.store.roles.save(f.actor, childTarget, { ...f.set().membership, role: 'observer', version: 0,
    grantSetDigest: f.store.roles.snapshot(f.actor, childTarget).grantSetDigest,
    environments: { codex: 'observer', openclaw: 'disabled' } });
  const child = f.store.grants.shareSession(root, f.other.id, 'observer');
  assert.deepEqual(f.command(f.set({ role: 'none' })), { target: f.target, snapshot: f.store.roles.snapshot(f.actor, f.target) });
  for (const id of [root.grantId, child.id]) assert.equal(f.db.prepare('SELECT revoked FROM node_grants WHERE id=?').get(id)!.revoked, 1);
  f.command(f.set());
  assert.equal(f.db.prepare('SELECT revoked FROM node_grants WHERE id=?').get(child.id)!.revoked, 1);
}));
test('membership policy conflicts preserve original snapshots and never become unknown success', () => fixture(f => {
  const before = f.store.roles.snapshot(f.actor, f.target);
  for (const command of [f.set({ version: 1 }), f.set({ nodeVersion: 0 }), f.set({ role: 'admin' }),
    f.set({ role: 'observer', environments: { codex: 'developer', openclaw: 'observer' } }),
    { ...f.set(), target: { ...f.target, userId: f.owner.id } }]) {
    assert.deepEqual(f.command(command), { error: 'conflict' });
    assert.deepEqual(f.store.roles.snapshot(f.actor, f.target), before);
  }
}));
test('membership legacy conversion still requires explicit confirmation and legacy broad grant is revoked', () => fixture(f => {
  const legacy = f.store.grants.create(f.target, { runtime: 'codex', actions: ['messages:read'] });
  assert.deepEqual(f.command(f.set({ migrateLegacy: false })), { error: 'conflict' });
  assert.equal(f.store.roles.membership(f.target).version, 0);
  f.command(f.set());
  assert.equal(f.db.prepare('SELECT revoked FROM node_grants WHERE id=?').get(legacy.id)!.revoked, 1);
}));
for (const change of ['add', 'replace', 'revoke'] as const) {
  test(`membership confirmation rejects ${change} of legacy grants despite unchanged membership CAS`, () => fixture(f => {
    const legacy = f.store.grants.create(f.target, { runtime: 'codex', actions: ['messages:read'] });
    const stale = f.set();
    if (change === 'add') f.store.grants.create(f.target, { runtime: 'openclaw', actions: ['messages:read'] });
    else if (change === 'replace') assert.equal(f.store.grants.replace(f.target, legacy.id, legacy.version,
      { runtime: 'codex', actions: ['messages:read', 'messages:send'] }), true);
    else assert.equal(f.store.grants.revoke(f.target, legacy.id, legacy.version), true);
    const grants = f.db.prepare('SELECT * FROM node_grants ORDER BY id').all();
    const current = f.store.roles.snapshot(f.actor, f.target);
    assert.equal(current.version, stale.membership.version);
    assert.notEqual(current.grantSetDigest, stale.membership.grantSetDigest);
    assert.deepEqual(f.command(stale), { error: 'conflict' });
    assert.deepEqual(f.store.roles.snapshot(f.actor, f.target), current);
    assert.deepEqual(f.db.prepare('SELECT * FROM node_grants ORDER BY id').all(), grants);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM hub_auth_audit WHERE record LIKE '%role_changed%'").get()!.n, 0);
    // Refresh is read-only; a separately confirmed save may now commit.
    assert.deepEqual(f.command({ action: 'read', target: f.target }), { target: f.target, snapshot: current });
    assert.deepEqual(f.command(f.set()), { target: f.target, snapshot: f.store.roles.snapshot(f.actor, f.target) });
  }));
}
test('legacy conversion requires the reviewed digest; old clients remain compatible for nonlegacy changes', () => fixture(f => {
  const legacy = f.store.grants.create(f.target, { runtime: 'codex', actions: ['messages:read'] });
  const reviewed = f.set(), { grantSetDigest: _digest, ...oldMembership } = reviewed.membership;
  const oldCommand = { ...reviewed, membership: oldMembership };
  assert.equal(validHubMemberInput('membershipSet', { ...f.proof, command: oldCommand }), true);
  assert.deepEqual(f.command(oldCommand), { error: 'conflict' });
  assert.equal(f.db.prepare('SELECT revoked FROM node_grants WHERE id=?').get(legacy.id)!.revoked, 0);
  f.command(reviewed);
  const { grantSetDigest: _nextDigest, ...next } = f.set().membership;
  assert.ok('snapshot' in f.command({ ...reviewed, membership: next })!);
}));
test('membership digest binds recipient and connection, but unrelated grants do not invalidate review', () => fixture(f => {
  const reviewed = f.set(), otherTarget = { ...f.target, userId: f.other.id };
  assert.notEqual(f.store.roles.snapshot(f.actor, otherTarget).grantSetDigest, reviewed.membership.grantSetDigest);
  assert.deepEqual(f.command({ ...reviewed, target: otherTarget }), { error: 'conflict' });
  f.store.upsertConnection({ id: 'other-node', ownerUserId: f.owner.id, kind: 'remote', label: 'Other', connectorUrl: 'http://private.invalid' });
  f.store.pinConnectionNode('other-node', f.owner.id, f.store.connectionAuthority('other-node', f.owner.id)!, 'node_' + randomUUID());
  const otherConnection = { ...f.target, connectionId: 'other-node' };
  assert.notEqual(f.store.roles.snapshot(f.actor, otherConnection).grantSetDigest, reviewed.membership.grantSetDigest);
  f.store.grants.create(otherTarget, { runtime: 'codex', actions: ['messages:read'] });
  f.store.grants.create(otherConnection, { runtime: 'codex', actions: ['messages:read'] });
  assert.equal(f.store.roles.snapshot(f.actor, f.target).grantSetDigest, reviewed.membership.grantSetDigest);
  assert.ok('snapshot' in f.command(reviewed)!);
}));
test('dependent collaborator change invalidates creator review without changing creator membership version', () => fixture(f => {
  f.command(f.set());
  const childTarget = { ...f.target, userId: f.other.id };
  f.store.roles.save(f.actor, childTarget, { ...f.set().membership, version: 0,
    grantSetDigest: f.store.roles.snapshot(f.actor, childTarget).grantSetDigest });
  const creation = f.store.grants.authorize(f.target, 'sessions:create', { runtime: 'codex' })!;
  f.store.grants.acceptCreatedSession(creation, 'codex:owned', randomUUID(), randomUUID(), () => {});
  const root = f.store.grants.authorize(f.target, 'sessions:share', { runtime: 'codex', sessionKey: 'codex:owned' })!;
  const child = f.store.grants.shareSession(root, f.other.id, 'collaborator');
  const reviewed = f.set({ role: 'none' });
  assert.equal(f.store.grants.updateCollaborator(root, child.id, child.version, 'observer', {}).version, child.version + 1);
  assert.equal(f.store.roles.membership(f.target).version, reviewed.membership.version);
  assert.deepEqual(f.command(reviewed), { error: 'conflict' });
  assert.ok(f.store.grants.authorize(f.target, 'messages:send', { runtime: 'codex', sessionKey: 'codex:owned' }));
  const current = f.set({ role: 'none' });
  assert.notEqual(current.membership.grantSetDigest, reviewed.membership.grantSetDigest);
  assert.ok('snapshot' in f.command(current)!);
  assert.equal(f.db.prepare('SELECT revoked FROM node_grants WHERE id=?').get(child.id)!.revoked, 1);
  f.command(f.set());
  assert.equal(f.store.grants.authorize(childTarget, 'messages:read', { runtime: 'codex', sessionKey: 'codex:owned' }), undefined);
}));
test('membership command rejects transported principal, wrong action and malformed snapshots', () => fixture(f => {
  const good = f.command(f.set());
  assert.equal(validHubMemberInput('membershipSet', { ...f.proof, command: f.set(), admin: true }), false);
  assert.equal(validHubMemberInput('membershipRead', { ...f.proof, command: f.set() }), false);
  assert.equal(validHubMemberInput('membershipSet', { ...f.proof, command: f.set({ version: Number.MAX_SAFE_INTEGER }) }), false);
  assert.equal(validHubMembershipReply({ ...f.set(), membership: { ...f.set().membership, version: 0 } }, good), true);
  assert.equal(validHubMembershipReply({ ...f.set(), target: { ...f.target, userId: f.other.id } }, good), false);
  assert.equal(validHubMemberOutput('membershipRead', { target: f.target, snapshot: { ...f.store.roles.snapshot(f.actor, f.target), inherited: 'administrator' } }), false);
}));
test('membership revoked credentials and wrong scopes cannot dispatch original effects', () => fixture(f => {
  assert.equal(executeHubMemberCommand(f.store, 'membershipSet', { ...f.proof, expectedScope: '0'.repeat(64), command: f.set() }), null);
  f.store.identities.revokeKey(f.owner.id, f.key.id);
  assert.equal(f.command(f.set()), null);
  assert.equal(f.store.roles.membership(f.target).version, 0);
}));
test('membership oversized legacy text refuses before original grant decoding', () => fixture(f => {
  const grant = f.store.grants.create(f.target, { runtime: 'codex', actions: ['messages:read'] });
  f.db.prepare('UPDATE node_grants SET actions=? WHERE id=?').run(' '.repeat(16_385), grant.id);
  assert.throws(() => f.command(f.set()), /hub_membership_unavailable/);
  assert.equal(f.store.roles.membership(f.target).version, 0);
}));
test('membership SQL failure after original membership update rolls back audit and grants', () => fixture(f => {
  const append = f.store.identities.audit.append;
  f.store.identities.audit.append = () => { throw new Error('SQL private fault'); };
  assert.throws(() => f.command(f.set()), /SQL private fault/);
  assert.equal(f.store.roles.membership(f.target).version, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM node_grants').get()!.n, 0);
  f.store.identities.audit.append = append;
  assert.ok(f.command(f.set()));
}));
test('membership typed rejection with failed rollback is unknown until original outer cleanup', () => fixture(f => {
  const exec = f.db.exec;
  f.db.exec = sql => { if (sql === 'ROLLBACK TO role_access; RELEASE role_access') throw new Error('private cleanup fault'); return exec(sql); };
  assert.throws(() => f.command(f.set({ version: 1 })), /Connection or member version changed/);
  assert.equal(connectionRecoverySnapshot(f.db).state, 'ready');
  assert.equal(f.db.isTransaction, false);
  f.db.exec = exec;
  assert.ok(f.command(f.set()));
}));
class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = []; stops = 0;
  postMessage(message: { id: number; kind: string; body: string }) { this.messages.push(message); }
  terminate() { this.stops++; return Promise.resolve(1); }
}
test('membership negative ACKs are correlated to original command semantics', () => {
  const target = { ownerUserId: 'owner', connectionId: 'node', userId: 'user' };
  const commands: HubMembershipCommand[] = [{ action: 'authorize', target }, { action: 'read', target },
    { action: 'set', target, membership: { role: 'none', version: 0, nodeVersion: 1,
      environments: { codex: 'disabled', openclaw: 'disabled' }, migrateLegacy: true } }];
  for (const command of commands) {
    assert.equal(validHubMembershipReply(command, null), true);
    assert.equal(validHubMembershipReply(command, { error: 'denied' }), true);
    assert.equal(validHubMembershipReply(command, { error: 'missing' }), command.action === 'read');
    assert.equal(validHubMembershipReply(command, { error: 'conflict' }), command.action === 'set');
    assert.equal(validHubMembershipReply(command, { error: 'missing', target }), false);
  }
});
for (const action of ['authorize', 'read', 'set'] as const) {
  test(`membership impossible negative ${action} ACK preserves original physical owner fence`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'hub-membership-negative-ack-'));
    const file = join(root, 'hub.sqlite'), worker = new FakeWorker();
    const launch = () => worker as unknown as Worker, owner = new AsyncHubMemberOwner({ file }, quiet, launch);
    try {
      const target = { ownerUserId: 'owner', connectionId: 'node', userId: 'user' };
      const command: HubMembershipCommand = action === 'set' ? { action, target, membership: {
        role: 'none', version: 0, nodeVersion: 1, environments: { codex: 'disabled', openclaw: 'disabled' }, migrateLegacy: true,
      } } : { action, target };
      const result = owner.command(action === 'set' ? 'membershipSet' : 'membershipRead',
        { evidence: {}, expectedScope: 'a'.repeat(64), command } as never);
      void result.catch(() => {});
      worker.emit('message', { kind: 'ready' }); await tick();
      const message = worker.messages[0]!;
      worker.emit('message', { id: message.id, kind: message.kind, ok: true,
        body: JSON.stringify({ error: action === 'read' ? 'conflict' : 'missing' }) });
      await assert.rejects(result); assert.equal(worker.stops, 0);
      assert.equal(worker.messages.length, 1, 'unknown result cannot replay the original command');
      assert.throws(() => new AsyncHubMemberOwner({ file }, quiet, launch));
      const closing = owner.close(); await tick(); assert.equal(worker.stops, 1);
      assert.throws(() => new AsyncHubMemberOwner({ file }, quiet, launch));
      worker.emit('exit', 1); await assert.rejects(closing);
    } finally { worker.emit('exit', 1); rmSync(root, { recursive: true, force: true }); }
  });
}
test('membership mismatched success ACK retains sole owner until physical exit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-membership-ack-')), file = join(root, 'hub.sqlite'), worker = new FakeWorker();
  const createWorker = () => worker as unknown as Worker, owner = new AsyncHubMemberOwner({ file }, quiet, createWorker);
  try {
    const command: HubMembershipCommand = { action: 'read', target: { ownerUserId: 'owner', connectionId: 'node', userId: 'user' } };
    const result = owner.command('membershipRead', { evidence: {}, expectedScope: 'a'.repeat(64), command }); void result.catch(() => {});
    worker.emit('message', { kind: 'ready' }); await tick();
    const message = worker.messages[0]!;
    worker.emit('message', { id: message.id, kind: message.kind, ok: true, body: JSON.stringify({ target: { ...command.target, userId: 'other' }, authorized: true }) });
    await assert.rejects(result); assert.equal(worker.stops, 0);
    assert.throws(() => new AsyncHubMemberOwner({ file }, quiet, createWorker));
    const closing = owner.close(); await tick(); assert.equal(worker.stops, 1);
    assert.throws(() => new AsyncHubMemberOwner({ file }, quiet, createWorker));
    worker.emit('exit', 1); await assert.rejects(closing);
  } finally { worker.emit('exit', 1); rmSync(root, { recursive: true, force: true }); }
});
test('real membership worker closes before original synchronous same-database reopening', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-membership-real-')), file = join(root, 'hub.sqlite'), store = new HubStore(file, 'membership-fixture');
  const f = seed(store), command = f.set(), proof = f.proof;
  await store.close();
  const logs: string[] = [], owner = new AsyncHubMemberOwner({ file, encryptionSecret: 'membership-fixture' }, new PerformanceDiagnostics(line => logs.push(line)));
  try {
    const saved = await owner.command('membershipSet', { ...proof, command });
    assert.equal(validHubMembershipReply(command, saved), true);
    await owner.close();
    const reopened = new HubStore(file, 'membership-fixture');
    try { assert.deepEqual(saved, { target: command.target, snapshot: reopened.roles.snapshot(f.actor, f.target) }); }
    finally { await reopened.close(); }
    // Parent command numbers and SQL failure phases are separate stable
    // namespaces: successful ACKs use the command index, not failure phase39.
    assert.ok(logs.some(line => {
      const event = JSON.parse(line);
      return event.operation === 'hub-member-sqlite-command'
        && event.step === hubMemberCommandSteps.membershipSet
        && event.phase === 'finished' && event.admitted === 1 && event.settled === 1;
    }));
    for (const secret of [f.token, f.key.token, f.owner.id, 'private.invalid']) assert.equal(logs.some(line => line.includes(secret)), false);
  } finally { await owner.close(); rmSync(root, { recursive: true, force: true }); }
});
