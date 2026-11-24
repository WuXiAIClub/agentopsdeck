import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import type { WorkspacePreferences } from '@agentopsdeck/shared';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner, encodeHubMemberJson } from './async-member-owner.js';
import { executeHubMemberCommand, validHubMemberInput, validHubMemberOutput, HubMemberOwnerUnavailable, hubMemberCommandSteps, hubMemberResultBytes } from './member-owner-domain.js';
import { HUB_WORKSPACE_BYTES, HUB_WORKSPACE_NODES } from './member-workspace-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
const initial = (): WorkspacePreferences => ({ revision: 0, groups: [{ id: 'old-group', name: 'Existing group', collapsed: true }],
  sessions: { 'node:session': { groupId: 'old-group', color: '#123456', order: 42, tags: ['existing'] } }, ungroupedCollapsed: false });
async function fixture(work: (f: ReturnType<typeof seed>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'hub-workspace-r44-')), file = join(root, 'hub.sqlite');
  const store = new HubStore(file, 'workspace-fixture');
  try { await work(seed(store, file)); }
  finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
}
function seed(store: HubStore, file: string) {
  const member = store.createUser('Existing member'), second = store.createUser('Other member');
  const key = store.identities.issueKey(member.id), token = store.identities.createSession(key.token)!;
  const proof = { evidence: { sessionToken: token }, expectedScope: store.identities.recoveryScope({ userId: member.id, admin: false }) };
  const db = (store as unknown as { db: DatabaseSync }).db;
  return { store, file, member, second, key, token, proof, db };
}

test('workspace owner preserves original saved preferences, exact CAS conflict and old cookie across reopening', () => fixture(async f => {
  const expected = f.store.workspace.save(f.member.id, initial())!;
  await f.store.close();
  const owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'workspace-fixture' }, quiet);
  try {
    await owner.open();
    assert.deepEqual(await owner.command('workspaceGet', f.proof), { document: expected });
    assert.deepEqual(await owner.command('workspaceSave', { ...f.proof, document: initial() }), { conflict: true });
    const changed = { ...expected, ungroupedCollapsed: true };
    assert.deepEqual(await owner.command('workspaceSave', { ...f.proof, document: changed }), { document: { ...changed, revision: 2 } });
    assert.equal(owner.snapshot().unavailable, false);
  } finally { await owner.close(); }
  const original = new HubStore(f.file, 'workspace-fixture');
  try {
    assert.deepEqual(original.workspace.get(f.member.id), { ...expected, ungroupedCollapsed: true, revision: 2 });
    assert.deepEqual(original.workspace.get(f.second.id), { revision: 0, groups: [], sessions: {} });
    assert.ok(original.identities.requestPrincipal(new Request('http://localhost/', { headers: { cookie: 'agentopsdeck_session=' + f.token } }), () => false));
  } finally { await original.close(); }
}));

test('workspace authority, scope and CAS occur in original savepoint; denial cannot write another user', () => fixture(async f => {
  const command = (proof: typeof f.proof) => executeHubMemberCommand(f.store, 'workspaceSave', { ...proof, document: initial() });
  assert.equal(command({ ...f.proof, expectedScope: '0'.repeat(64) }), null);
  assert.equal(f.store.workspace.get(f.member.id).revision, 0);
  assert.equal(validHubMemberInput('workspaceSave', { ...f.proof, document: initial(), userId: f.second.id }), false);
  f.store.identities.revokeKey(f.member.id, f.key.id);
  assert.equal(command(f.proof), null);
  assert.equal(f.store.workspace.get(f.member.id).revision, 0);
  assert.equal(f.store.workspace.get(f.second.id).revision, 0);
}));

test('workspace trigger failure rolls back original savepoint and preserves older document for recovery', () => fixture(async f => {
  const original = f.store.workspace.save(f.member.id, initial())!;
  f.db.exec(`CREATE TRIGGER reject_workspace BEFORE UPDATE ON hub_workspace_preferences BEGIN SELECT RAISE(ABORT, 'fixture_failure'); END`);
  assert.throws(() => executeHubMemberCommand(f.store, 'workspaceSave', { ...f.proof, document: { ...original, ungroupedCollapsed: true } }));
  assert.deepEqual(f.store.workspace.get(f.member.id), original);
  f.db.exec('DROP TRIGGER reject_workspace');
  assert.deepEqual(executeHubMemberCommand(f.store, 'workspaceSave', { ...f.proof, document: original }), { document: { ...original, revision: 2 } });
  assert.equal(f.db.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
}));

test('workspace final MAX_SAFE_INTEGER revision remains readable, never reset or silently overwritten', () => fixture(async f => {
  const doc = f.store.workspace.save(f.member.id, initial())!;
  f.db.prepare('UPDATE hub_workspace_preferences SET revision=? WHERE user_id=?').run(Number.MAX_SAFE_INTEGER - 1, f.member.id);
  const last = { ...doc, revision: Number.MAX_SAFE_INTEGER - 1 };
  assert.equal(validHubMemberInput('workspaceSave', { ...f.proof, document: last }), true);
  const result = executeHubMemberCommand(f.store, 'workspaceSave', { ...f.proof, document: last });
  assert.deepEqual(result, { document: { ...last, revision: Number.MAX_SAFE_INTEGER } });
  assert.equal(validHubMemberOutput('workspaceGet', result), true);
  assert.equal(validHubMemberInput('workspaceSave', { ...f.proof, document: (result as { document: WorkspacePreferences }).document }), false);
  assert.deepEqual(executeHubMemberCommand(f.store, 'workspaceGet', f.proof), result);
}));

test('workspace worker transports the full original 5000-session schema including escaped keys, tags and styles', () => fixture(async f => {
  const document: WorkspacePreferences = { revision: 0, groups: Array.from({ length: 100 }, (_, i) => ({
    id: 'g' + i, name: '组'.repeat(80), collapsed: true })), sessions: {}, ungroupedCollapsed: true };
  for (let i = 0; i < 5000; i++) document.sessions[String(i).padStart(4, '0') + '\u0001'.repeat(1020)] = {
    color: '#aAbBcC', groupId: 'g99', order: 1000000,
    tags: Array.from({ length: 8 }, (_, tag) => String(tag) + '标'.repeat(31)),
  };
  assert.ok(validHubMemberInput('workspaceSave', { ...f.proof, document }));
  const encoded = encodeHubMemberJson({ ...f.proof, document }, HUB_WORKSPACE_BYTES, HUB_WORKSPACE_NODES);
  assert.ok(Buffer.byteLength(encoded) > 30 * 1024 * 1024);
  assert.ok(Buffer.byteLength(encoded) < HUB_WORKSPACE_BYTES);
  // Old store accepts this directly, although the current HTTP input limit is
  // 8MiB. GET must continue to read such already persisted schema-valid data.
  const expected = f.store.workspace.save(f.member.id, document)!;
  await f.store.close();
  const owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'workspace-fixture' }, quiet);
  try {
    await owner.open();
    const result = await owner.command('workspaceGet', f.proof);
    assert.ok(result && 'document' in result);
    assert.equal(result.document.revision, 1);
    assert.equal(Object.keys(result.document.sessions).length, 5000);
    assert.deepEqual(result.document.groups, expected.groups);
    for (const key of Object.keys(expected.sessions)) assert.deepEqual(result.document.sessions[key], expected.sessions[key], 'workspace row');
    const saved = await owner.command('workspaceSave', { ...f.proof, document: result.document });
    assert.ok(saved && 'document' in saved); assert.equal(saved.document.revision, 2);
    assert.equal(Object.keys(saved.document.sessions).length, 5000);
    assert.equal(owner.snapshot().unavailable, false);
  } finally { await owner.close(); }
}));

for (const kind of ['workspaceGet', 'workspaceSave'] as const) {
  test(`${kind} typed result rejects malformed document/conflict without accepting a permission claim`, () => {
    for (const value of [true, {}, { document: initial(), granted: true }, { document: { ...initial(), revision: -1 } },
      { conflict: false }, { document: initial(), conflict: true }, { document: { ...initial(), sessions: { constructor: {} } } }]) {
      assert.equal(validHubMemberOutput(kind, value), false);
    }
    assert.equal(validHubMemberOutput(kind, null), true);
    assert.equal(validHubMemberOutput(kind, { document: initial() }), true);
    assert.equal(validHubMemberOutput(kind, { conflict: true }), kind === 'workspaceSave');
  });
}

class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = [];
  stops = 0;
  postMessage(value: { id: number; kind: string; body: string }) { this.messages.push(value); }
  terminate() { this.stops++; return Promise.resolve(1); }
  reply(index: number, value: unknown) { const row = this.messages[index]!;
    this.emit('message', { id: row.id, kind: row.kind, ok: true, body: JSON.stringify(value) }); }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
test('workspace worst-case capacity remains bounded through waiting and graceful original close', { timeout: 5000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-workspace-capacity-r44-')), fake = new FakeWorker(), logs: string[] = [];
  const owner = new AsyncHubMemberOwner({ file: join(root, 'hub.sqlite') }, new PerformanceDiagnostics(line => logs.push(line)),
    () => fake as unknown as Worker, 5);
  fake.emit('message', { kind: 'ready' });
  const proof = { evidence: {}, expectedScope: 'a'.repeat(64) };
  try {
    const pending = owner.command('workspaceGet', proof);
    assert.equal(owner.snapshot().acceptedResultBytes, HUB_WORKSPACE_BYTES);
    const waiting = owner.command('workspaceGet', proof);
    // Ordinary replies use their own bounded pool, even while the full
    // workspace reservation is held. Keep BOTH original replies through close.
    const member = owner.command('memberSnapshot', {});
    const memberBytes = hubMemberResultBytes('memberSnapshot');
    assert.equal(owner.snapshot().acceptedResultBytes, HUB_WORKSPACE_BYTES + memberBytes);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(fake.messages.length, 2); assert.equal(fake.stops, 0);
    const close = owner.close(); await tick(); assert.equal(fake.messages.length, 2);
    await assert.rejects(owner.command('memberSnapshot', {}), HubMemberOwnerUnavailable);
    fake.reply(0, { document: initial() }); await pending; await tick();
    assert.equal(owner.snapshot().acceptedResultBytes, HUB_WORKSPACE_BYTES + memberBytes);
    assert.equal(fake.messages[2]!.kind, 'workspaceGet');
    fake.reply(1, null); await member; await tick();
    assert.equal(fake.messages.length, 3, 'close must also await the queued workspace reply');
    fake.reply(2, { document: initial() }); await waiting; await tick();
    assert.equal(owner.snapshot().acceptedResultBytes, 0);
    assert.equal(fake.messages[3]!.kind, 'close'); fake.reply(3, null); fake.emit('exit', 0); await close;
    assert.ok(logs.some(line => line.includes('"phase":"pending"')));
    assert.ok(logs.some(line => line.includes('"operation":"hub-member-sqlite-command"') && line.includes('"deferred":1')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('workspace worker reports SQL failure without leaking body/credentials, stays usable and keeps prior revision', () => fixture(async f => {
  const saved = f.store.workspace.save(f.member.id, initial())!;
  f.db.exec(`CREATE TRIGGER reject_workspace BEFORE UPDATE ON hub_workspace_preferences BEGIN SELECT RAISE(ABORT, 'private_workspace_sql'); END`);
  await f.store.close(); const logs: string[] = [];
  const owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'workspace-fixture' }, new PerformanceDiagnostics(line => logs.push(line)));
  try {
    await owner.open();
    await assert.rejects(owner.command('workspaceSave', { ...f.proof, document: saved }), HubMemberOwnerUnavailable);
    assert.deepEqual(await owner.command('workspaceGet', f.proof), { document: saved });
    assert.ok(await owner.command('memberSnapshot', f.proof.evidence));
    assert.equal(owner.snapshot().unavailable, false);
    assert.ok(logs.some(line => { const row = JSON.parse(line); return row.operation === 'hub-member-sqlite-command'
      && row.step === hubMemberCommandSteps.workspaceSave && row.unknown === 1; }));
    for (const secret of [f.token, f.key.token, 'private_workspace_sql', 'Existing group']) assert.equal(logs.join('').includes(secret), false);
  } finally { await owner.close(); }
}));
