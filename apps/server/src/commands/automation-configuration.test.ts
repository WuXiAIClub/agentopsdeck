import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutomationConfigurationStore, type AutomationConfiguration } from './automation-configuration.js';
import { AutomationStore } from './automation-store.js';
import type { AutomationRule } from './automation-policy.js';
const target = { ownerId: 'alice', connectionId: 'conn', runtime: 'codex', sessionId: 'codex:session' };
const rule: AutomationRule = { id: 'rule', revision: 1, authorityEpoch: 1, target, enabled: false,
  startsAt: 1000, expiresAt: 1000000, maxSends: 2, maxPerHour: 2, minIntervalMs: 60000,
  mode: { kind: 'interval', intervalMs: 60000 } };
const save = (overrides: Partial<AutomationRule> = {}, expectedRevision = 0): AutomationConfiguration => ({
  kind: 'save', rule: { ...rule, ...overrides }, template: 'test', expectedRevision, confirmEnable: false });
test('configuration preserves original authority failure when rollback reporting fails', () => {
  const db = new DatabaseSync(':memory:'), original = Error('original-authority'), exec = db.exec.bind(db);
  const config = new AutomationConfigurationStore(db, () => { throw original; });
  db.exec = sql => { exec(sql); if (sql === 'ROLLBACK') throw Error('cleanup'); };
  try {
    assert.throws(() => config.configure('alice', 'request', save()), error => error === original);
    assert.equal(db.isTransaction, false);
  } finally { db.close(); }
});
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'automation-config-')), path = join(dir, 'data.sqlite');
  let db = new DatabaseSync(path), allowed = true;
  const authorize = (owner: string, value: typeof target) => allowed && owner === 'alice' && value.ownerId === owner;
  let config = new AutomationConfigurationStore(db, authorize), store = new AutomationStore(db);
  t.after(() => { db.close(); rmSync(dir, { force: true, recursive: true }); });
  return { get db() { return db; }, get config() { return config; }, get store() { return store; },
    revoke: () => { allowed = false; }, reopen: () => { db.close(); db = new DatabaseSync(path);
      config = new AutomationConfigurationStore(db, authorize); store = new AutomationStore(db); } };
}
test('read-only missing original creates no schema; default disabled saves persist immutable original', t => {
  const f = fixture(t); assert.equal(f.config.original('alice', 'req'), undefined);
  assert.equal(f.db.prepare('SELECT count(*) n FROM sqlite_master').get()!.n, 0);
  const receipt = f.config.configure('alice', 'req', save());
  assert.equal(receipt.result.rule.enabled, false);
  f.reopen(); assert.deepEqual(f.config.original('alice', 'req'), receipt);
  assert.deepEqual(f.config.configure('alice', 'req', save()), receipt);
});
test('enabled save requires explicit confirmation; no rules or receipt on invalid input', t => {
  const f = fixture(t); const input = save({ enabled: true });
  assert.throws(() => f.config.configure('alice', 'req', input), /confirmation/);
  assert.deepEqual(f.store.list('alice'), []);
  assert.equal(f.config.original('alice', 'req'), undefined);
  assert.equal(f.config.configure('alice', 'req', { ...input, confirmEnable: true } as AutomationConfiguration).result.rule.enabled, true);
});
test('lost ACK after later edit returns original snapshot without restoring old rule', t => {
  const f = fixture(t), original = f.config.configure('alice', 'r1', save());
  f.config.configure('alice', 'r2', { ...save({ revision: 2, authorityEpoch: 2 }, 1), template: 'changed' } as AutomationConfiguration);
  f.reopen(); assert.deepEqual(f.config.configure('alice', 'r1', save()), original);
  assert.equal(f.store.read('alice', 'rule')!.template, 'changed');
  assert.throws(() => f.config.configure('alice', 'r1', { ...save(), template: 'different' } as AutomationConfiguration), /request-reused/);
});
test('configuration receipt failure rolls back rule and epoch', t => {
  const f = fixture(t); f.config.configure('alice', 'r1', save());
  f.db.exec("CREATE TRIGGER fixture_failure BEFORE INSERT ON automation_configuration_receipts BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  assert.throws(() => f.config.configure('alice', 'r2', save({ revision: 2, authorityEpoch: 2 }, 1)), /fixture/);
  assert.equal(f.store.read('alice', 'rule')!.rule.revision, 1);
  assert.equal(f.config.original('alice', 'r2'), undefined);
});
test('revocation is durable, repeated original does not resurrect rule, permission checked on reads', t => {
  const f = fixture(t); f.config.configure('alice', 'r1', save());
  const input: AutomationConfiguration = { kind: 'revoke', ruleId: 'rule', expectedRevision: 1 };
  const revoked = f.config.configure('alice', 'r2', input); assert.equal(revoked.result.revoked, true);
  f.reopen(); assert.deepEqual(f.config.configure('alice', 'r2', input), revoked);
  f.config.configure('alice', 'r1', save()); assert.equal(f.store.read('alice', 'rule')!.revoked, true);
  f.revoke(); assert.throws(() => f.config.original('alice', 'r1'), /forbidden/);
  assert.throws(() => f.config.configure('alice', 'r1', save()), /forbidden/);
});
test('cross-owner access, malformed keys, stale CAS and nested transaction fail closed', t => {
  const f = fixture(t); f.config.configure('alice', 'r1', save());
  assert.equal(f.config.original('bob', 'r1'), undefined);
  assert.throws(() => f.config.configure('bob', 'r1', save()), /configuration/);
  assert.throws(() => f.config.configure('alice', 'r2', { ...save(), unexpected: true } as unknown as AutomationConfiguration), /configuration/);
  assert.throws(() => f.config.configure('alice', 'r2', save({ revision: 3, authorityEpoch: 3 }, 2)), /revision/);
  f.db.exec('BEGIN'); assert.throws(() => f.config.configure('alice', 'r2', save()), /top-level/); f.db.exec('ROLLBACK');
  assert.equal(f.store.read('alice', 'rule')!.rule.revision, 1);
});
test('immutable receipts resist update, delete and INSERT OR REPLACE', t => {
  const f = fixture(t); f.config.configure('alice', 'r1', save());
  for (const sql of ["DELETE FROM automation_configuration_receipts", "UPDATE automation_configuration_receipts SET payload='{}'",
    "INSERT OR REPLACE INTO automation_configuration_receipts SELECT * FROM automation_configuration_receipts"]) {
    assert.throws(() => f.db.exec(sql), /immutable/);
  }
});
test('full receipt byte budget refuses new configuration atomically, original lookup still works', t => {
  const f = fixture(t); const original = f.config.configure('alice', 'r1', save());
  f.db.prepare('INSERT INTO automation_configuration_receipts VALUES(?,?,?)').run('other', 'padding', ' '.repeat(8 * 1024 * 1024));
  assert.throws(() => f.config.configure('alice', 'r2', save({ revision: 2, authorityEpoch: 2 }, 1)), /capacity/);
  assert.equal(f.store.read('alice', 'rule')!.rule.revision, 1);
  assert.deepEqual(f.config.original('alice', 'r1'), original);
});
