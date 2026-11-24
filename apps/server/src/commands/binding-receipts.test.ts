import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { CommandCapacity, CommandConflict, CommandReceipts } from './receipts.js';

test('pure local binding and final result commit together; duplicates never rerun the report', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const receipts = new CommandReceipts(db);
  let reports = 0;
  const bind = () => { reports++; return { metadata: { report: 'original' }, complete: { status: 200, body: { ok: true } } }; };
  const original = await receipts.claimAsync('local', 'key', { message: '/status' }, false, undefined, undefined, bind);
  assert.equal(original.receipt.state, 'accepted'); assert.equal(reports, 1);
  assert.deepEqual(await receipts.claimAsync('local', 'key', { message: '/status' }, false, undefined, undefined, bind),
    { fresh: false, receipt: original.receipt });
  assert.equal(reports, 1); assert.deepEqual(receipts.binding('local', 'key'), { report: 'original' });
  assert.equal(new CommandReceipts(db).get('local', 'key')?.state, 'accepted');
});

for (const failure of ['5xx', 'redirect', 'oversized', 'sql', 'capacity'] as const)
test(`pure local ${failure} settlement rolls back receipt, binding, usage and participant write`, async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const receipts = new CommandReceipts(db, 10, failure === 'capacity' ? 1100 : undefined);
  db.exec('CREATE TABLE local_reports(id TEXT)');
  if (failure === 'sql') db.exec(`CREATE TRIGGER fail_local_settlement BEFORE UPDATE OF state ON command_receipts
    BEGIN SELECT RAISE(ABORT, 'local settlement failed'); END`);
  const usage = db.prepare('SELECT * FROM command_receipt_usage').get();
  await assert.rejects(receipts.claimAsync('local', 'key', {}, false, undefined, undefined, id => {
    db.prepare('INSERT INTO local_reports VALUES (?)').run(id);
    return { metadata: { report: 'original' }, complete: { status: failure === '5xx' ? 503 : failure === 'redirect' ? 302 : 200,
      body: { report: 'x'.repeat(failure === 'oversized' ? 70_000 : failure === 'capacity' ? 4000 : 1) } } };
  }));
  assert.equal(receipts.get('local', 'key'), undefined);
  assert.equal(receipts.binding('local', 'key'), undefined);
  assert.equal(db.prepare('SELECT count(*) AS n FROM local_reports').get()!.n, 0);
  assert.deepEqual(db.prepare('SELECT * FROM command_receipt_usage').get(), usage);
  assert.equal(db.isTransaction, false);
});

test('internal binding is immutable, actor scoped, never public and never refreshed on duplicates', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const receipts = new CommandReceipts(db);
  const metadata = { nodeId: 'original', origin: 'http://original.invalid', authority: 4 };
  const original = receipts.claim('alice', 'key', { version: 'v1' }, true, undefined, undefined, () => ({ metadata }));
  metadata.nodeId = 'changed';
  assert.equal(receipts.binding('alice', 'key')?.nodeId, 'original');
  assert.equal(receipts.binding('bob', 'key'), undefined);
  assert.doesNotMatch(JSON.stringify(original.receipt), /original|authority|binding/);
  const duplicate = receipts.claim('alice', 'key', { version: 'v1' }, true, undefined, undefined, () => { throw Error('must not run'); });
  assert.equal(duplicate.fresh, false); assert.deepEqual(duplicate.receipt, original.receipt);
  assert.throws(() => receipts.claim('alice', 'key', { version: 'v2' }, true), CommandConflict);
  assert.throws(() => db.prepare('UPDATE command_receipts SET binding_json = NULL').run(), /cannot change/);
  assert.throws(() => db.prepare('UPDATE command_receipts SET retained_bytes = 1').run(), /cannot change/);
  receipts.claim('legacy', 'key', {});
  assert.equal(receipts.claim('legacy', 'key', {}, false, undefined, undefined, () => { throw Error('must not bind legacy'); }).fresh, false);
  assert.equal(receipts.binding('legacy', 'key'), undefined);
});

test('receipt, internal metadata and retained vault write commit or roll back together', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const receipts = new CommandReceipts(db, 10, 3000);
  db.exec('CREATE TABLE synthetic_vault(id TEXT PRIMARY KEY, encrypted TEXT)');
  const bind = (retainedBytes: number, metadata: Record<string, unknown> = { nodeId: 'node' }) => (id: string) => {
    db.prepare('INSERT INTO synthetic_vault VALUES (?, ?)').run(id, 'synthetic-ciphertext');
    return { metadata, retainedBytes };
  };
  assert.throws(() => receipts.claim('s', 'capacity', {}, true, undefined, undefined, bind(3000)), CommandCapacity);
  for (const bytes of [-1, 0.5, Infinity, NaN]) {
    assert.throws(() => receipts.claim('s', 'invalid', {}, true, undefined, undefined, bind(bytes)), CommandConflict);
  }
  assert.throws(() => receipts.claim('s', 'large', {}, true, undefined, undefined, bind(0, { text: '中'.repeat(3000) })), CommandConflict);
  assert.equal(db.prepare('SELECT count(*) AS n FROM synthetic_vault').get()!.n, 0);
  assert.equal(db.prepare('SELECT rows FROM command_receipt_usage').get()!.rows, 0);
  const result = receipts.claim('s', 'accepted', {}, true, undefined, undefined, bind(256));
  assert.equal(db.prepare('SELECT id FROM synthetic_vault').get()!.id, result.receipt.id);
  assert.equal(receipts.claim('s', 'denied', {}, true, undefined, () => false, () => { throw Error('no retention on denial'); }).receipt.state, 'rejected');
  db.exec(`CREATE TRIGGER synthetic_failure BEFORE INSERT ON command_receipts BEGIN SELECT RAISE(ABORT, 'insert failed'); END`);
  assert.throws(() => receipts.claim('s', 'fails', {}, true, undefined, undefined, bind(0)), /insert failed/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM synthetic_vault').get()!.n, 1);
});

test('retained metadata and encrypted vault allowance consume capacity across settlement, reopen and delete', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const metadata = { target: '节点' }, retainedBytes = 180;
  const expected = 1 + 512 + 128 + Buffer.byteLength(JSON.stringify(metadata)) + retainedBytes;
  const receipts = new CommandReceipts(db, 10, expected);
  const usage = () => Number(db.prepare('SELECT bytes FROM command_receipt_usage').get()!.bytes);
  receipts.claim('s', 'key', {}, true, undefined, undefined, () => ({ metadata, retainedBytes }));
  assert.equal(usage(), expected);
  assert.throws(() => receipts.claim('s', 'another', {}), CommandCapacity);
  receipts.settle('s', 'key', { status: 200, body: {} });
  assert.equal(usage(), expected);
  const reopened = new CommandReceipts(db, 10, expected);
  assert.deepEqual(reopened.binding('s', 'key'), metadata); assert.equal(usage(), expected);
  db.exec('DELETE FROM command_receipts'); assert.equal(usage(), 0);
});

test('binding schema and accounting migration roll back together on failure', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  new CommandReceipts(db).claim('legacy', 'key', {});
  for (const operation of ['insert', 'update', 'delete']) db.exec(`DROP TRIGGER command_receipt_${operation}_v6`);
  db.exec(`DROP TRIGGER command_receipt_binding_immutable;
    DROP INDEX command_receipt_rejected_retention;
    DROP INDEX command_receipt_completed_retention;
    DROP INDEX command_receipt_connection_control_retention;
    ALTER TABLE command_receipts DROP COLUMN binding_json;
    ALTER TABLE command_receipts DROP COLUMN retained_bytes;
    CREATE TRIGGER fail_upgrade BEFORE UPDATE ON command_receipt_usage BEGIN SELECT RAISE(ABORT, 'upgrade failed'); END`);
  const before = db.prepare('SELECT * FROM command_receipt_usage').get();
  assert.throws(() => new CommandReceipts(db), /upgrade failed/);
  assert.equal(db.prepare('PRAGMA table_info(command_receipts)').all().some(row => row.name === 'binding_json'), false);
  assert.deepEqual(db.prepare('SELECT * FROM command_receipt_usage').get(), before);
  db.exec('DROP TRIGGER fail_upgrade');
  const upgraded = new CommandReceipts(db);
  assert.equal(upgraded.binding('legacy', 'key'), undefined);
  assert.equal(upgraded.get('legacy', 'key')?.state, 'outcome_unknown');
  assert.deepEqual(db.prepare('SELECT * FROM command_receipt_usage').get(), before);
});
