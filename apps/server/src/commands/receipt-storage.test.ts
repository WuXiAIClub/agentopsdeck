import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { CommandReceipts } from './receipts.js';

test('physical pressure rejects new SQL admission before callbacks, preserves originals and settlement', () => {
  const db = new DatabaseSync(':memory:'); let pressure = false, admissions = 0, callbacks = 0;
  const receipts = new CommandReceipts(db, undefined, undefined, undefined, (bytes, write) => {
    admissions++; assert.ok(bytes >= 16 * 1024 ** 2);
    if (pressure) throw Error('storage-pressure'); return write();
  });
  try {
    const first = receipts.claim('owner', 'first', { a: 1 }); pressure = true;
    assert.throws(() => receipts.claim('owner', 'second', {}, false, undefined, () => { callbacks++; return true; }), /storage-pressure/);
    assert.equal(callbacks, 0); assert.equal(receipts.get('owner', 'second'), undefined);
    const count = admissions;
    assert.deepEqual(receipts.claim('owner', 'first', { a: 1 }), { fresh: false, receipt: first.receipt });
    assert.throws(() => receipts.claim('owner', 'first', { a: 2 }), /different content/);
    assert.equal(receipts.settle('owner', 'first', { status: 200, body: { ok: true } }).state, 'accepted');
    assert.equal(admissions, count); assert.equal(db.isTransaction, false);
    pressure = false; assert.equal(receipts.claim('owner', 'second', {}).fresh, true);
  } finally { db.close(); }
});

test('SQL rollback inside a reserved write releases admission without a stranded transaction', () => {
  const db = new DatabaseSync(':memory:'); let active = 0;
  const receipts = new CommandReceipts(db, undefined, undefined, undefined, (_bytes, write) => {
    active++; try { return write(); } finally { active--; }
  });
  try {
    assert.throws(() => receipts.claim('owner', 'failed', {}, false, undefined, () => { throw Error('fixture'); }), /fixture/);
    assert.equal(active, 0); assert.equal(db.isTransaction, false); assert.equal(receipts.get('owner', 'failed'), undefined);
    assert.equal(receipts.claim('owner', 'failed', {}).fresh, true);
  } finally { db.close(); }
});
