import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { executeHubMemberCommand, HUB_MEMBER_RESULT_BUDGET, HubMemberOwnerUnavailable, validHubMemberInput } from './member-owner-domain.js';
import { AsyncHubAuditLog } from './async-audit-log.js';
import { HubMemberRequestError } from './async-member-request.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { fingerprintRequest } from '../auth/security.js';

const quiet = new PerformanceDiagnostics(() => {});
async function fixture(work: (f: ReturnType<typeof seed>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'hub-audit-r43-'));
  const store = new HubStore(join(root, 'hub.sqlite'), 'audit-fixture');
  try { await work(seed(store, join(root, 'hub.sqlite'))); }
  finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
}
function seed(store: HubStore, file: string) {
  const admin = store.createUser('Audit administrator');
  store.roles.setHubRole({ userId: 'default', admin: true }, admin.id, 'admin', 0);
  const key = store.identities.issueKey(admin.id);
  const token = store.identities.createSession(key.token)!;
  const proof = { evidence: { sessionToken: token }, expectedScope: store.identities.recoveryScope({ userId: admin.id, admin: true }) };
  // Test-only inspection of the SAME original connection, not another writer.
  const db = (store as unknown as { db: DatabaseSync }).db;
  return { store, db, file, key, token, proof, admin };
}
test('audit list preserves all 10000 original records without 16KiB truncation or changed ordering', () => fixture(async f => {
  f.db.exec('BEGIN');
  const expected = [];
  for (let i = 0; i < 10000; i++) expected.push(f.store.identities.audit.append({ event: 'access_key_login', outcome: 'failure',
    reason: 'fixture-' + i, ...fingerprintRequest(new Request('http://localhost/')) }));
  f.db.exec('COMMIT');
  assert.ok(Buffer.byteLength(JSON.stringify(expected)) > 16384);
  const expectedPage = f.store.identities.audit.page({ limit: 100 });
  await f.store.close();
  const owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'audit-fixture' }, quiet);
  try {
    await owner.open();
    const rows = await owner.command('auditList', { ...f.proof, limit: 10000 });
    assert.ok(rows);
    // Bound failure diagnostics too: a 10000-row deep diff can exhaust the
    // test host and conceal the first actual protocol/ordering mismatch.
    assert.equal(rows.length, expected.length);
    for (let i = 0; i < expected.length; i++) assert.deepEqual(rows[i], expected[i], `audit row ${i}`);
    const page = await owner.command('auditPage', { ...f.proof, options: { limit: 100 } });
    assert.ok(page);
    assert.deepEqual(page.records, expected.slice(-100).reverse());
    assert.equal(page.nextCursor, expectedPage.nextCursor);
    assert.equal(page.persistent, true);
    assert.equal(owner.snapshot().unavailable, false);
  } finally { await owner.close(); }
}));

test('persisted administrator check happens before audit retention mutation, not after prune', () => fixture(async f => {
  const old = f.store.identities.audit.append({ event: 'api_authz', outcome: 'failure' });
  f.db.prepare('UPDATE hub_auth_audit SET ts = 1 WHERE record LIKE ?').run('%' + old.id + '%');
  const execute = (proof: typeof f.proof) => executeHubMemberCommand(f.store, 'auditPage', { ...proof, options: {} });
  assert.equal(execute({ ...f.proof, expectedScope: '0'.repeat(64) }), null);
  assert.ok(f.db.prepare('SELECT 1 FROM hub_auth_audit WHERE ts=1').get());
  f.store.roles.setHubRole({ userId: 'default', admin: true }, f.admin.id, 'member', 1);
  // Role mutation itself appends/prunes. Establish expired evidence AFTER it
  // so this assertion measures the denied query, not the authorized revoke.
  f.db.prepare('UPDATE hub_auth_audit SET ts=1 WHERE sequence=(SELECT MAX(sequence) FROM hub_auth_audit)').run();
  assert.equal(execute(f.proof), null);
  assert.ok(f.db.prepare('SELECT 1 FROM hub_auth_audit WHERE ts=1').get(), 'no pruning under revoked role');
}));

test('trusted unauthenticated failure audit uses original fingerprints, persists once and is not an authorization grant', () => fixture(async f => {
  await f.store.close();
  const owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'audit-fixture' }, quiet);
  try {
    await owner.open();
    const record = { event: 'access_key_login' as const, outcome: 'throttled' as const, failureCount: 3, retryAfterSeconds: 30,
      reason: 'untrusted / detail', ...fingerprintRequest(new Request('http://localhost/')) };
    const appended = await owner.command('auditAppend', { record });
    assert.equal(appended.reason, 'untrusted___detail');
    assert.equal(appended.ipHash!.length, 24);
    const rows = await owner.command('auditList', { ...f.proof, limit: 100 });
    assert.ok(rows);
    assert.equal(rows.filter(row => row.id === appended.id).length, 1);
  } finally { await owner.close(); }
}));

test('audit pruning remains nested in the original parent transaction and rollback restores its exact rows', () => fixture(async f => {
  const old = f.store.identities.audit.append({ event: 'api_authz', outcome: 'failure' });
  f.db.prepare('UPDATE hub_auth_audit SET ts=1 WHERE record LIKE ?').run('%' + old.id + '%');
  f.db.exec('BEGIN');
  assert.ok(executeHubMemberCommand(f.store, 'auditPage', { ...f.proof, options: {} }));
  assert.equal(f.db.prepare('SELECT 1 FROM hub_auth_audit WHERE ts=1').get(), undefined);
  assert.equal(f.db.isTransaction, true);
  f.db.exec('ROLLBACK');
  assert.ok(f.db.prepare('SELECT 1 FROM hub_auth_audit WHERE ts=1').get());
  f.db.exec("CREATE TRIGGER fail_audit_prune BEFORE DELETE ON hub_auth_audit BEGIN SELECT RAISE(ABORT, 'private-audit-prune'); END");
  assert.throws(() => executeHubMemberCommand(f.store, 'auditPage', { ...f.proof, options: {} }));
  assert.ok(f.db.prepare('SELECT 1 FROM hub_auth_audit WHERE ts=1').get());
  assert.equal(f.db.isTransaction, false);
  f.db.exec('DROP TRIGGER fail_audit_prune');
  assert.ok(executeHubMemberCommand(f.store, 'memberSnapshot', f.proof.evidence));
}));

test('audit INSERT failure preserves rows, reports only bounded phases and keeps the original worker usable', () => fixture(async f => {
  const before = f.store.identities.audit.list(10000);
  f.db.exec("CREATE TRIGGER fail_audit_insert BEFORE INSERT ON hub_auth_audit BEGIN SELECT RAISE(ABORT, 'private-audit-insert'); END");
  await f.store.close();
  const logs: string[] = [];
  const owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'audit-fixture' }, new PerformanceDiagnostics(line => logs.push(line)));
  try {
    await owner.open();
    await assert.rejects(owner.command('auditAppend', { record: { event: 'api_authz', outcome: 'failure' } }), HubMemberOwnerUnavailable);
    assert.deepEqual(await owner.command('auditList', { ...f.proof, limit: 10000 }), before);
    assert.ok(await owner.command('memberSnapshot', f.proof.evidence));
    assert.equal(owner.snapshot().unavailable, false);
    assert.ok(logs.some(line => { const row = JSON.parse(line); return row.operation === 'hub-member-sqlite-command' && row.unknown === 1; }));
    assert.equal(logs.join('').includes('private-audit-insert'), false);
    assert.equal(logs.join('').includes(f.token), false);
  } finally { await owner.close(); }
}));

test('audit request adapter accepts original undefined option fields and refuses proof-free queries', () => fixture(async f => {
  await f.store.close();
  const owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'audit-fixture' }, quiet);
  try {
    await owner.open(); const audit = new AsyncHubAuditLog(owner, quiet);
    const appended = await audit.append({ event: 'access_key_login', outcome: 'failure', keyIdentityHash: undefined });
    await assert.rejects(audit.page());
    await assert.rejects(audit.list());
    const request = new Request('http://localhost/', { headers: { cookie: 'agentopsdeck_session=' + f.token } });
    const page = await audit.page({ limit: 100, userId: undefined, before: undefined }, request);
    assert.ok(page.records.some(row => row.id === appended.id));
    assert.deepEqual(await audit.list(0, request), []);
    assert.equal(audit.pending, 0);
  } finally { await owner.close(); }
}));

class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; body: string }[] = [];
  stops = 0;
  postMessage(value: { id: number; kind: string; body: string }) { this.messages.push(value); }
  terminate() { this.stops++; return Promise.resolve(1); }
  reply(index: number, body: unknown) { const row = this.messages[index]!; this.emit('message', { id: row.id, kind: row.kind, ok: true, body: JSON.stringify(body) }); }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
test('worst-case audit result capacity queues bounded reads until real ACK, including warning and close wait', async () => {
  const fake = new FakeWorker(), logs: string[] = [];
  const root = mkdtempSync(join(tmpdir(), 'hub-audit-capacity-'));
  const owner = new AsyncHubMemberOwner({ file: join(root, 'hub.sqlite') }, new PerformanceDiagnostics(line => logs.push(line)), () => fake as unknown as Worker, 5);
  fake.emit('message', { kind: 'ready' });
  const proof = { evidence: {}, expectedScope: 'a'.repeat(64), limit: 10000 };
  const first = owner.command('auditList', proof), second = owner.command('auditList', proof);
  assert.equal(owner.snapshot().acceptedResultBytes, HUB_MEMBER_RESULT_BUDGET);
  // The owner queues bounded accepted commands behind its result budget.
  // Awaiting a refusal here deadlocks the fixture before it sends any ACK.
  const third = owner.command('auditList', proof);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(owner.snapshot().accepted, 3); assert.equal(fake.messages.length, 2); assert.equal(fake.stops, 0);
  const close = owner.close(); await tick(); assert.equal(fake.messages.length, 2);
  await assert.rejects(owner.command('auditList', proof), HubMemberOwnerUnavailable);
  fake.reply(0, []); await first; await tick();
  assert.equal(fake.messages.length, 3, 'queued original request dispatches only after real result capacity is released');
  assert.equal(fake.messages[2]!.kind, 'auditList');
  assert.equal(owner.snapshot().acceptedResultBytes, HUB_MEMBER_RESULT_BUDGET);
  fake.reply(1, []); await second; await tick();
  assert.equal(owner.snapshot().acceptedResultBytes, HUB_MEMBER_RESULT_BUDGET / 2);
  assert.equal(fake.messages.length, 3, 'shutdown must retain the queued request until its original ACK');
  fake.reply(2, []); await third; await tick();
  assert.equal(owner.snapshot().acceptedResultBytes, 0);
  assert.equal(fake.messages[3]!.kind, 'close'); fake.reply(3, null); fake.emit('exit', 0); await close;
  assert.ok(logs.some(line => line.includes('"phase":"pending"')));
  rmSync(root, { recursive: true, force: true });
});

test('audit RPC rejects raw credentials, callbacks, forged grant fields and invalid cursors before dispatch', () => {
  const proof = { evidence: {}, expectedScope: 'a'.repeat(64) };
  assert.equal(validHubMemberInput('auditPage', { ...proof, options: { before: 0 } }), false);
  assert.equal(validHubMemberInput('auditList', { ...proof, limit: 100, authorized: true }), false);
  assert.equal(validHubMemberInput('auditAppend', { record: { event: 'api_authz', outcome: 'failure', accessKey: 'private' } }), false);
  assert.equal(validHubMemberInput('auditAppend', { record: { event: 'api_authz', outcome: 'failure', ipHash: 'a'.repeat(64) } }), false);
});
