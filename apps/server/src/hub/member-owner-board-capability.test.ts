import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { executeHubMemberCommand, validHubMemberInput, validHubMemberOutput, hubMemberCommandSteps,
  hubMemberFailureSteps, hubMemberResultBytes } from './member-owner-domain.js';
import { validHubBoardCapabilityCommand, validHubBoardCapabilityReply, hubBoardCapabilityReplyExpectation,
  HUB_BOARD_CAPABILITY_RESULT_BYTES, type HubBoardCapabilityCommand } from './member-board-capability-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const quiet = new PerformanceDiagnostics(() => {});
async function fixture(work: (f: ReturnType<typeof seed>) => void | Promise<void>, count = 1) {
  const root = mkdtempSync(join(tmpdir(), 'hub-capability-r254-')), file = join(root, 'hub.sqlite');
  const store = new HubStore(file, 'capability-fixture');
  try { await work(seed(store, file, count)); }
  finally { try { await store.close(); } finally { rmSync(root, { recursive: true, force: true }); } }
}
function seed(store: HubStore, file: string, count: number) {
  const member = store.createUser('Original member'), other = store.createUser('Other member');
  const key = store.identities.issueKey(member.id), token = store.identities.createSession(key.token)!;
  const proof = { evidence: { sessionToken: token }, expectedScope: store.identities.recoveryScope({ userId: member.id, admin: false }) };
  const tasks = Array.from({ length: count }, () => ({ id: randomUUID(), title: 'Task', detail: 'Private detail', status: 'todo' as const }));
  assert.equal(store.boards.save(member.id, 'default', { title: 'Original board', tasks, revision: 0, mutationId: randomUUID() }).status, 'saved');
  const input = { taskIds: tasks.map(t => t.id), fields: ['detail', 'status'] as ('detail' | 'status')[], expiresAt: Date.now() + 60_000 };
  const db = (store as unknown as { db: DatabaseSync }).db;
  const command = (command: HubBoardCapabilityCommand) => executeHubMemberCommand(store, 'boardCapability', { ...proof, command });
  return { store, file, member, other, key, token, proof, input, db, command };
}
test('capability telemetry is append-only and reserves complete original quota responses', () => {
  assert.equal(hubMemberCommandSteps.boardCapability, 47); assert.equal(hubMemberFailureSteps.boardCapability, 67);
  assert.equal(hubMemberCommandSteps.workspaceBoard, 46); assert.equal(hubMemberFailureSteps.workspaceBoard, 66);
  assert.equal(hubMemberResultBytes('boardCapability'), HUB_BOARD_CAPABILITY_RESULT_BYTES);
});
test('old cookie management and old machine token survive worker shutdown/reopening', () => fixture(async f => {
  const issued = f.store.boardCapabilities.issue(f.member.id, 'default', f.input)!;
  await f.store.close();
  const owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'capability-fixture' }, quiet);
  try {
    await owner.open();
    const rows = await owner.command('boardCapability', { ...f.proof, command: { action: 'list', resourceId: 'default' } });
    assert.deepEqual(rows, { action: 'list', capabilities: [issued.capability] });
    const next = await owner.command('boardCapability', { ...f.proof, command: { action: 'issue', resourceId: 'default', input: f.input } });
    assert.ok(next?.action === 'issue' && next.issued);
    assert.equal(validHubMemberOutput('boardCapability', next), true);
  } finally { await owner.close(); }
  const reopened = new HubStore(f.file, 'capability-fixture');
  try {
    assert.equal(reopened.boardCapabilities.authorized(issued.token), true);
    const outcome = reopened.boardCapabilities.update(issued.token, { revision: 1, mutationId: randomUUID(), tasks: [{ id: f.input.taskIds[0]!, status: 'doing' }] });
    assert.equal(outcome.status, 'saved');
  } finally { await reopened.close(); }
}));
test('scope mismatch, revoked cookie, and machine credentials cannot mutate human grants', () => fixture(f => {
  const command = { action: 'issue' as const, resourceId: 'default', input: f.input };
  assert.equal(executeHubMemberCommand(f.store, 'boardCapability', { ...f.proof, expectedScope: '0'.repeat(64), command }), null);
  assert.equal(validHubMemberInput('boardCapability', { ...f.proof, userId: f.other.id, command }), false);
  const issued = f.store.boardCapabilities.issue(f.member.id, 'default', f.input)!;
  assert.equal(executeHubMemberCommand(f.store, 'boardCapability', { evidence: { accessKey: issued.token }, expectedScope: f.proof.expectedScope, command }), null);
  f.store.identities.revokeKey(f.member.id, f.key.id);
  assert.equal(f.command(command), null);
  assert.equal(f.store.boardCapabilities.list(f.member.id, 'default').length, 1);
}));
test('issue and revoke audit failures roll back complete original transactions', () => fixture(f => {
  f.db.exec("CREATE TRIGGER refuse_capability_audit BEFORE INSERT ON hub_board_agent_audit BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  assert.throws(() => f.command({ action: 'issue', resourceId: 'default', input: f.input }));
  assert.deepEqual(f.store.boardCapabilities.list(f.member.id, 'default'), []);
  f.db.exec('DROP TRIGGER refuse_capability_audit');
  const issued = f.command({ action: 'issue', resourceId: 'default', input: f.input });
  assert.ok(issued?.action === 'issue' && issued.issued);
  const grant = issued.issued;
  f.db.exec("CREATE TRIGGER refuse_capability_audit BEFORE INSERT ON hub_board_agent_audit BEGIN SELECT RAISE(ABORT, 'fixture'); END");
  assert.throws(() => f.command({ action: 'revoke', resourceId: 'default', capabilityId: grant.capability.id }));
  assert.equal(f.store.boardCapabilities.authorized(grant.token), true);
  f.db.exec('DROP TRIGGER refuse_capability_audit');
  assert.deepEqual(f.command({ action: 'revoke', resourceId: 'default', capabilityId: grant.capability.id }), { action: 'revoke', revoked: true });
  assert.equal(f.store.boardCapabilities.authorized(grant.token), false);
  assert.equal(f.db.prepare('PRAGMA quick_check').get()?.quick_check, 'ok');
}));
test('wrong owner/board cannot revoke, and explicit repeated revoke retains one audit event', () => fixture(f => {
  const issued = f.store.boardCapabilities.issue(f.member.id, 'default', f.input)!;
  assert.deepEqual(f.command({ action: 'revoke', resourceId: randomUUID(), capabilityId: issued.capability.id }), { action: 'revoke', revoked: false });
  for (let i = 0; i < 2; i++) assert.deepEqual(f.command({ action: 'revoke', resourceId: 'default', capabilityId: issued.capability.id }), { action: 'revoke', revoked: true });
  const rows = f.command({ action: 'events', resourceId: 'default', before: Number.MAX_SAFE_INTEGER });
  assert.ok(rows?.action === 'events'); assert.deepEqual(rows.events.map(e => e.event), ['revoked', 'issued']);
  const earlier = f.command({ action: 'events', resourceId: 'default', before: rows.events[0]!.sequence });
  assert.ok(earlier?.action === 'events'); assert.equal(earlier.events.length, 1);
  assert.ok(rows.events.every(e => !('token' in e) && !('detail' in e)));
}));
test('256 full grants fit actual worker reply; quota refusal does not create a 257th grant', () => fixture(async f => {
  for (let i = 0; i < 256; i++) assert.ok(f.store.boardCapabilities.issue(f.member.id, 'default', f.input));
  await f.store.close();
  const owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'capability-fixture' }, quiet);
  try {
    await owner.open();
    const result = await owner.command('boardCapability', { ...f.proof, command: { action: 'list', resourceId: 'default' } });
    assert.ok(result?.action === 'list'); assert.equal(result.capabilities.length, 256);
    assert.ok(result.capabilities.every(c => c.taskIds.length === 200));
    assert.ok(Buffer.byteLength(JSON.stringify(result)) > 16_384);
    assert.equal(owner.snapshot().unavailable, false);
    assert.deepEqual(await owner.command('boardCapability', { ...f.proof, command: { action: 'issue', resourceId: 'default', input: f.input } }), { action: 'issue', issued: null });
  } finally { await owner.close(); }
}, 200));
test('strict command/result correlation rejects foreign grant, cursor, token, duplicate and extra fields', () => fixture(f => {
  const command = { action: 'issue' as const, resourceId: 'default', input: f.input };
  const result = f.command(command); assert.ok(result?.action === 'issue' && result.issued);
  const expected = hubBoardCapabilityReplyExpectation(command);
  assert.equal(validHubBoardCapabilityReply(expected, result), true);
  assert.equal(validHubBoardCapabilityReply(expected, { ...result, issued: { ...result.issued, capability: { ...result.issued.capability, taskIds: [randomUUID()] } } }), false);
  assert.equal(validHubBoardCapabilityReply(expected, { ...result, issued: { ...result.issued, token: 'invalid' } }), false);
  assert.equal(validHubBoardCapabilityReply(expected, { action: 'revoke', revoked: true }), false);
  assert.equal(validHubMemberOutput('boardCapability', { action: 'list', capabilities: [result.issued.capability, result.issued.capability] }), false);
  assert.equal(validHubBoardCapabilityReply({ action: 'events', resourceId: 'default', before: 1 }, { action: 'events', events: [{ sequence: 1, capabilityId: result.issued.capability.id, event: 'issued', mutationId: null, revision: null, createdAt: 1 }] }), false);
  for (const v of [{ ...command, userId: f.other.id }, { action: 'revoke', resourceId: 'default', capabilityId: '../private' }, { action: 'events', resourceId: 'default', before: 0 }])
    assert.equal(validHubBoardCapabilityCommand(v), false);
}));
class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = [];
  postMessage(v: { id: number; kind: string; body: string }) { this.messages.push(v); }
  terminate() { this.emit('exit', 1); return Promise.resolve(1); }
}
test('wrong worker capability action fences original owner instead of publishing success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-capability-protocol-')), fake = new FakeWorker();
  const owner = new AsyncHubMemberOwner({ file: join(root, 'hub.sqlite') }, quiet, () => fake as unknown as Worker);
  fake.emit('message', { kind: 'ready' });
  try {
    const pending = assert.rejects(owner.command('boardCapability', { evidence: {}, expectedScope: 'a'.repeat(64), command: { action: 'list', resourceId: 'default' } }));
    await new Promise<void>(resolve => setImmediate(resolve));
    const row = fake.messages[0]!;
    fake.emit('message', { id: row.id, kind: row.kind, ok: true, body: JSON.stringify({ action: 'revoke', revoked: true }) });
    await pending; assert.equal(owner.snapshot().unavailable, true);
  } finally { try { await assert.rejects(owner.close()); } finally { rmSync(root, { recursive: true, force: true }); } }
});
