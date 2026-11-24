import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { HubStore } from './hub-store.js';
import { AsyncHubMemberOwner } from './async-member-owner.js';
import { executeHubMemberCommand, validHubMemberInput, validHubMemberOutput } from './member-owner-domain.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
const quiet = new PerformanceDiagnostics(() => {});
async function fixture(work: (f: ReturnType<typeof seed>) => Promise<void> | void) {
  const root = mkdtempSync(join(tmpdir(), 'hub-activity-owner-r56-')), file = join(root, 'hub.sqlite');
  const store = new HubStore(file, 'activity-fixture');
  try { await work(seed(store, file)); }
  finally { await store.close(); rmSync(root, { recursive: true, force: true }); }
}
function seed(store: HubStore, file: string) {
  const member = store.createUser('Existing member'), other = store.createUser('Other member');
  const key = store.identities.issueKey(member.id), token = store.identities.createSession(key.token)!;
  const proof = { evidence: { sessionToken: token }, expectedScope: store.identities.recoveryScope({ userId: member.id, admin: false }) };
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.exec('DELETE FROM hub_key_usage; DELETE FROM hub_user_usage');
  const request = new Request('http://fixture.invalid/', { headers: { cookie: 'agentopsdeck_session=' + token } });
  const rows = () => ({ keys: db.prepare('SELECT * FROM hub_key_usage').all(), users: db.prepare('SELECT * FROM hub_user_usage').all() });
  return { store, file, member, other, key, token, proof, db, request, rows };
}
test('activity domain preserves paired timestamps, cookie semantics and 60-second throttle', () => fixture(f => {
  assert.deepEqual(executeHubMemberCommand(f.store, 'memberActivity', f.proof), { ok: true });
  const before = f.rows();
  assert.equal(before.keys.length, 1); assert.equal(before.users.length, 1);
  assert.equal(before.keys[0]!.last_used_at, null);
  assert.equal(before.keys[0]!.last_active_at, before.users[0]!.last_active_at);
  assert.deepEqual(executeHubMemberCommand(f.store, 'memberActivity', f.proof), { ok: true });
  assert.deepEqual(f.rows(), before, 'a throttled ACK is not a second usage update');
  const keyProof = { ...f.proof, evidence: { accessKey: f.key.token } };
  assert.deepEqual(executeHubMemberCommand(f.store, 'memberActivity', keyProof), { ok: true });
  const keyRow = f.rows().keys[0]!;
  assert.equal(typeof keyRow.last_used_at, 'number');
  assert.equal(keyRow.last_used_at, keyRow.last_active_at);
  assert.deepEqual(f.rows().users, before.users, 'key-first direct-use change retains the separate original user throttle');
}));
test('activity refuses caller authority, revoked credentials, expired sessions and changed role', () => fixture(f => {
  for (const extra of [{ userId: f.other.id }, { authorized: true }, { now: 1 }, { sql: 'INSERT' }])
    assert.equal(validHubMemberInput('memberActivity', { ...f.proof, ...extra }), false);
  assert.equal(validHubMemberOutput('memberActivity', { ok: false }), false);
  assert.equal(validHubMemberOutput('memberActivity', { ok: true, userId: f.member.id }), false);
  assert.equal(executeHubMemberCommand(f.store, 'memberActivity', { ...f.proof, expectedScope: '0'.repeat(64) }), null);
  f.db.prepare("INSERT INTO hub_roles VALUES (?, 'admin', 1)").run(f.member.id);
  assert.equal(executeHubMemberCommand(f.store, 'memberActivity', f.proof), null);
  f.db.prepare('DELETE FROM hub_roles WHERE user_id = ?').run(f.member.id);
  f.db.exec('UPDATE hub_login_sessions SET expires_at = 0');
  assert.equal(executeHubMemberCommand(f.store, 'memberActivity', f.proof), null);
  f.store.identities.revokeKey(f.member.id, f.key.id);
  assert.equal(executeHubMemberCommand(f.store, 'memberActivity', { ...f.proof, evidence: { accessKey: f.key.token } }), null);
  assert.deepEqual(f.rows(), { keys: [], users: [] });
}));
for (const original of [false, true]) {
  test(`second activity SQL failure rolls back both usage rows on ${original ? 'original facade' : 'fixed command'}`, () => fixture(f => {
    f.db.exec("CREATE TRIGGER fail_activity BEFORE INSERT ON hub_user_usage BEGIN SELECT RAISE(ABORT,'synthetic second usage failure'); END");
    assert.throws(() => original ? f.store.identities.recordActivity(f.request)
      : executeHubMemberCommand(f.store, 'memberActivity', f.proof), /synthetic second usage failure/);
    assert.equal(f.db.isTransaction, false); assert.deepEqual(f.rows(), { keys: [], users: [] });
  }));
}
test('nested activity savepoint never commits or rolls back the outer transaction', () => fixture(f => {
  f.db.exec('BEGIN');
  f.db.prepare("INSERT INTO hub_user_usage (user_id, last_active_at) VALUES (?, 7)").run(f.other.id);
  f.db.exec("CREATE TRIGGER fail_activity BEFORE INSERT ON hub_user_usage WHEN NEW.user_id <> 'never' BEGIN SELECT RAISE(ABORT,'nested activity failure'); END");
  assert.throws(() => f.store.identities.recordActivity(f.request), /nested activity failure/);
  assert.equal(f.db.isTransaction, true); assert.equal(f.rows().keys.length, 0);
  assert.equal(f.rows().users.length, 1); assert.equal(f.rows().users[0]!.user_id, f.other.id);
  f.db.exec('ROLLBACK'); assert.deepEqual(f.rows(), { keys: [], users: [] });
}));
test('activity owner real worker writes original WAL and original facade can reopen it', () => fixture(async f => {
  const logs: string[] = [];
  await f.store.close();
  const owner = new AsyncHubMemberOwner({ file: f.file, encryptionSecret: 'activity-fixture' }, new PerformanceDiagnostics(line => logs.push(line)));
  try {
    await owner.open();
    assert.deepEqual(await owner.command('memberActivity', f.proof), { ok: true });
  } finally { await owner.close(); }
  const original = new HubStore(f.file, 'activity-fixture');
  try {
    const db = (original as unknown as { db: DatabaseSync }).db;
    assert.equal(db.prepare('SELECT count(*) AS n FROM hub_key_usage').get()!.n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM hub_user_usage').get()!.n, 1);
    assert.equal(original.identities.requestIdentity(f.request)?.userId, f.member.id);
    assert.equal(db.prepare('PRAGMA quick_check').get()!.quick_check, 'ok');
  } finally { await original.close(); }
  assert.equal(logs.join('').includes(f.token), false);
  assert.equal(logs.join('').includes(f.file), false);
}));
test('anonymous activity remains an original-facade no-op', () => fixture(f => {
  assert.equal(f.store.identities.recordActivity(new Request('http://fixture.invalid/')), undefined);
  assert.deepEqual(f.rows(), { keys: [], users: [] });
}));
