import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { COMMAND_KEY_MAX_AGE_MS, createCommandKey } from '@agentopsdeck/shared';
import { CommandCapacity, CommandReceipts } from './receipts.js';

const startedAt = Date.UTC(2026, 8, 16, 12);
const reject = { status: 409, body: { error: 'denied' } };

for (const state of ['accepted', 'rejected'] as const) test(`fixed bound controls reclaim expired ${state} facts, preserving original key fence`, context => {
  let now = startedAt; context.mock.method(Date, 'now', () => now);
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db, 1);
  const key = createCommandKey(randomUUID()), control = {operation: 'capabilities'}, epoch = 1;
  const scope = JSON.stringify(['connection-control', JSON.stringify(['alice', 'node'])]);
  try {
    receipts.claim(scope, key, {epoch, control}, false, undefined, undefined,
      receiptId => ({metadata: {domain: 'connection-control', ownerUserId: 'alice', connectionId: 'node', key, receiptId, epoch, control}}));
    receipts.settle(scope, key, {status: state === 'accepted' ? 200 : 403, body: {}});
    now += COMMAND_KEY_MAX_AGE_MS;
    assert.throws(() => receipts.claim('next', createCommandKey(randomUUID()), {}), CommandCapacity);
    now++;
    assert.equal(receipts.claim('next', createCommandKey(randomUUID()), {}).fresh, true);
    assert.equal(receipts.get(scope, key), undefined);
    assert.equal(db.prepare('SELECT rows FROM command_receipt_usage').get()!.rows, 1);
    const reopened = new CommandReceipts(db, 1);
    now = startedAt;
    assert.throws(() => reopened.claim(scope, key, {epoch, control}), /Command key expired/);
  } finally { db.close(); }
});

for (const kind of ['unknown', 'legacy', 'delivery', 'authority', 'retained', 'scope', 'receipt', 'key', 'epoch', 'control', 'fingerprint', 'extra', 'fresh-outcome'] as const) {
  test(`bound control retention preserves ${kind} instead of guessing release authority`, context => {
    let now = startedAt; context.mock.method(Date, 'now', () => now);
    const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db, 1);
    const key = kind === 'legacy' ? 'legacy' : createCommandKey(randomUUID());
    const control = {operation: 'capabilities'}, epoch = 1;
    const scope = kind === 'scope' ? 'alice' : JSON.stringify(['connection-control', JSON.stringify(['alice', 'node'])]);
    try {
      receipts.claim(scope, key, kind === 'fingerprint' ? {} : {epoch, control}, ['authority','delivery'].includes(kind), kind === 'authority' ? 1 : undefined,
        undefined, receiptId => ({retainedBytes: kind === 'retained' ? 1 : 0, metadata: {
          domain: 'connection-control', ownerUserId: 'alice', connectionId: 'node',
          receiptId: kind === 'receipt' ? 'other' : receiptId, key: kind === 'key' ? 'other' : key,
          epoch: kind === 'epoch' ? -1 : epoch, control: kind === 'control' ? {operation: 'arbitrary'} : control,
          ...(kind === 'extra' ? {extra: true} : {}),
        }}));
      if (kind === 'fresh-outcome') now += COMMAND_KEY_MAX_AGE_MS;
      if (kind !== 'unknown') receipts.settle(scope, key, {status: 200, body: {}});
      const original = receipts.get(scope, key);
      now = startedAt + COMMAND_KEY_MAX_AGE_MS + 1;
      assert.throws(() => receipts.claim('next', createCommandKey(randomUUID()), {}), CommandCapacity);
      assert.deepEqual(receipts.get(scope, key), original);
    } finally { db.close(); }
  });
}

test('control reclamation SQL failure rolls back the original claim rather than silently releasing capacity', context => {
  let now = startedAt; context.mock.method(Date, 'now', () => now);
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db, 1);
  const key = createCommandKey(randomUUID()), control = {operation: 'capabilities'}, epoch = 1;
  const scope = JSON.stringify(['connection-control', JSON.stringify(['alice', 'node'])]);
  try {
    receipts.claim(scope, key, {epoch, control}, false, undefined, undefined,
      receiptId => ({metadata: {domain: 'connection-control', ownerUserId: 'alice', connectionId: 'node', key, receiptId, epoch, control}}));
    receipts.settle(scope, key, {status: 200, body: {}});
    db.exec("CREATE TRIGGER fail_control_delete BEFORE DELETE ON command_receipts BEGIN SELECT RAISE(ABORT, 'retention failed'); END");
    now += COMMAND_KEY_MAX_AGE_MS + 1;
    assert.throws(() => receipts.claim('next', createCommandKey(randomUUID()), {}), /retention failed/);
    assert.equal(receipts.get(scope, key)?.state, 'accepted');
    assert.equal(db.prepare('SELECT rows FROM command_receipt_usage').get()!.rows, 1);
  } finally { db.close(); }
});

test('capacity reclaims only expired unbound rejected receipts and fences their original keys', context => {
  let now = startedAt;
  context.mock.method(Date, 'now', () => now);
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db, 2);
  try {
    const rejected = createCommandKey(randomUUID()), accepted = createCommandKey(randomUUID());
    receipts.claim('alice', rejected, {});
    receipts.settle('alice', rejected, reject);
    receipts.claim('bob', accepted, {});
    const original = receipts.settle('bob', accepted, { status: 200, body: { idempotencyKey: 'native-command' } });
    now += COMMAND_KEY_MAX_AGE_MS + 1;
    assert.equal(receipts.claim('alice', createCommandKey(randomUUID()), {}).fresh, true);
    assert.equal(receipts.get('alice', rejected), undefined);
    assert.deepEqual(receipts.get('bob', accepted), original);
    assert.throws(() => receipts.claim('alice', rejected, {}, false, undefined,
      () => assert.fail('expired admission')), /Command key expired/);
    assert.equal(db.prepare('SELECT rows FROM command_receipt_usage').get()?.rows, 2);
  } finally { db.close(); }
});

test('retention preserves legacy keys, unknowns, accepted deletion facts and downstream bindings', context => {
  let now = startedAt;
  context.mock.method(Date, 'now', () => now);
  for (const kind of ['legacy', 'unknown', 'accepted-delete', 'delivery', 'authority', 'binding', 'retained']) {
    now = startedAt;
    const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db, 1);
    try {
      const key = kind === 'legacy' ? 'legacy-key' : createCommandKey(randomUUID());
      const scope = kind === 'accepted-delete' ? JSON.stringify(['delete', JSON.stringify(['alice', 'native'])]) : 'alice';
      receipts.claim(scope, key, {}, ['delivery', 'authority'].includes(kind), kind === 'authority' ? 1 : undefined,
        undefined, ['binding', 'retained'].includes(kind) ? () => ({ metadata: {}, retainedBytes: kind === 'retained' ? 8 : 0 }) : undefined);
      if (kind !== 'unknown') receipts.settle(scope, key, kind === 'accepted-delete' ? { status: 200, body: {} } : reject);
      const original = receipts.get(scope, key);
      now += COMMAND_KEY_MAX_AGE_MS + 1;
      assert.throws(() => receipts.claim('next', createCommandKey(randomUUID()), {}), CommandCapacity, kind);
      assert.deepEqual(receipts.get(scope, key), original, kind);
    } finally { db.close(); }
  }
});

test('retention requires both original key age and settled outcome age to expire', context => {
  let now = startedAt;
  context.mock.method(Date, 'now', () => now);
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db, 1);
  try {
    const key = createCommandKey(randomUUID());
    receipts.claim('alice', key, {});
    now += COMMAND_KEY_MAX_AGE_MS;
    receipts.settle('alice', key, reject);
    now += 1;
    assert.throws(() => receipts.claim('next', createCommandKey(randomUUID()), {}), CommandCapacity);
    now += COMMAND_KEY_MAX_AGE_MS - 1;
    assert.throws(() => receipts.claim('next', createCommandKey(randomUUID()), {}), CommandCapacity);
    now += 1;
    assert.equal(receipts.claim('next', createCommandKey(randomUUID()), {}).fresh, true);
  } finally { db.close(); }
});

test('duplicate recovery precedes retention and spare capacity does not delete evidence', context => {
  let now = startedAt;
  context.mock.method(Date, 'now', () => now);
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db, 2);
  try {
    const key = createCommandKey(randomUUID());
    receipts.claim('alice', key, { original: true });
    const original = receipts.settle('alice', key, reject);
    now += COMMAND_KEY_MAX_AGE_MS + 1;
    assert.deepEqual(receipts.claim('alice', key, { original: true }), { fresh: false, receipt: original });
    assert.throws(() => receipts.claim('alice', key, { original: false }), /different content/);
    receipts.claim('next', createCommandKey(randomUUID()), {});
    assert.deepEqual(receipts.get('alice', key), original);
  } finally { db.close(); }
});

test('reclamation and admission roll back together on a storage failure', context => {
  let now = startedAt;
  context.mock.method(Date, 'now', () => now);
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db, 1);
  try {
    const key = createCommandKey(randomUUID());
    receipts.claim('alice', key, {});
    const original = receipts.settle('alice', key, reject);
    const usage = db.prepare('SELECT * FROM command_receipt_usage').get();
    db.exec("CREATE TRIGGER fail_retention BEFORE DELETE ON command_receipts BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END");
    now += COMMAND_KEY_MAX_AGE_MS + 1;
    assert.throws(() => receipts.claim('next', createCommandKey(randomUUID()), {}, false, undefined,
      () => assert.fail('must not admit')), /synthetic storage failure/);
    assert.deepEqual(receipts.get('alice', key), original);
    assert.deepEqual(db.prepare('SELECT * FROM command_receipt_usage').get(), usage);
    assert.equal(db.prepare('SELECT reject_before FROM command_receipt_policy').get()?.reject_before, startedAt - COMMAND_KEY_MAX_AGE_MS);
  } finally { db.close(); }
});

test('reclaimed keys remain refused after reopen and clock rollback, including direct old-style inserts', context => {
  let now = startedAt;
  context.mock.method(Date, 'now', () => now);
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-receipt-retention-'));
  const file = join(directory, 'commands.sqlite');
  let db = new DatabaseSync(file), receipts = new CommandReceipts(db, 1);
  try {
    const key = createCommandKey(randomUUID());
    receipts.claim('alice', key, {});
    receipts.settle('alice', key, reject);
    now += COMMAND_KEY_MAX_AGE_MS + 1;
    receipts.claim('next', createCommandKey(randomUUID()), {});
    db.close();
    now = startedAt;
    db = new DatabaseSync(file); receipts = new CommandReceipts(db, 1);
    assert.equal(receipts.get('alice', key), undefined);
    assert.throws(() => receipts.claim('alice', key, {}), /Command key expired/);
    assert.throws(() => db.prepare(`INSERT INTO command_receipts
      (scope, command_key, id, fingerprint, state, created_at, updated_at)
      VALUES ('alice', ?, 'old-module-id', 'old-fingerprint', 'outcome_unknown', ?, ?)`).run(key, now, now), /Command key expired/);
    assert.equal(db.prepare('SELECT rows FROM command_receipt_usage').get()?.rows, 1);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('each capacity pass is bounded to 64 rejected receipts', context => {
  let now = startedAt;
  context.mock.method(Date, 'now', () => now);
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db, 70);
  try {
    for (let index = 0; index < 70; index += 1) {
      const key = createCommandKey(randomUUID());
      receipts.claim('alice', key, {});
      receipts.settle('alice', key, reject);
    }
    now += COMMAND_KEY_MAX_AGE_MS + 1;
    receipts.claim('next', createCommandKey(randomUUID()), {});
    assert.equal(db.prepare('SELECT rows FROM command_receipt_usage').get()?.rows, 7);
    assert.equal(db.prepare('SELECT count(*) AS count FROM command_receipts').get()?.count, 7);
  } finally { db.close(); }
});

test('byte pressure and a new legacy command use the same durable rejection boundary', context => {
  let now = startedAt;
  context.mock.method(Date, 'now', () => now);
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db, 100, 700);
  try {
    const key = createCommandKey(randomUUID());
    receipts.claim('alice', key, {});
    receipts.settle('alice', key, reject);
    now += COMMAND_KEY_MAX_AGE_MS + 1;
    assert.equal(receipts.claim('bob', 'new-legacy-command', {}).fresh, true);
    assert.equal(receipts.get('alice', key), undefined);
    assert.equal(db.prepare('SELECT bytes FROM command_receipt_usage').get()?.bytes, 643);
    now = startedAt;
    assert.throws(() => receipts.claim('alice', key, {}), /Command key expired/);
  } finally { db.close(); }
});

test('binding failure after reclamation restores the deleted receipt, budget and boundary', context => {
  let now = startedAt;
  context.mock.method(Date, 'now', () => now);
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db, 1);
  try {
    const key = createCommandKey(randomUUID());
    receipts.claim('alice', key, {});
    const original = receipts.settle('alice', key, reject);
    const usage = db.prepare('SELECT * FROM command_receipt_usage').get();
    const policy = db.prepare('SELECT * FROM command_receipt_policy').get();
    now += COMMAND_KEY_MAX_AGE_MS + 1;
    assert.throws(() => receipts.claim('bob', createCommandKey(randomUUID()), {}, false, undefined, undefined,
      () => { throw new Error('synthetic binding failure'); }), /synthetic binding failure/);
    assert.deepEqual(receipts.get('alice', key), original);
    assert.deepEqual(db.prepare('SELECT * FROM command_receipt_usage').get(), usage);
    assert.deepEqual(db.prepare('SELECT * FROM command_receipt_policy').get(), policy);
  } finally { db.close(); }
});

test('future-skewed and malformed reserved keys are not reclaimed by outcome age alone', context => {
  let now = startedAt;
  context.mock.method(Date, 'now', () => now);
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db, 2);
  try {
    const future = createCommandKey(randomUUID(), now + 5 * 60 * 1000);
    receipts.claim('alice', future, {});
    const original = receipts.settle('alice', future, reject);
    db.prepare(`INSERT INTO command_receipts
      (scope, command_key, id, fingerprint, state, created_at, updated_at, result)
      VALUES ('alice', ?, 'malformed', 'fingerprint', 'rejected', ?, ?, ?)`).run(`cp1:${now}:malformed`, now, now, JSON.stringify(reject));
    now += COMMAND_KEY_MAX_AGE_MS + 1;
    assert.throws(() => receipts.claim('bob', createCommandKey(randomUUID()), {}), CommandCapacity);
    assert.deepEqual(receipts.get('alice', future), original);
    assert.equal(db.prepare('SELECT rows FROM command_receipt_usage').get()?.rows, 2);
  } finally { db.close(); }
});

test('retention candidates use the partial age index rather than scanning all command receipts', () => {
  const db = new DatabaseSync(':memory:');
  try {
    new CommandReceipts(db);
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT scope, command_key FROM command_receipts
      WHERE state = 'rejected' AND delivery_key IS NULL AND authority_id IS NULL
        AND binding_json IS NULL AND retained_bytes = 0 AND substr(command_key, 1, 4) = 'cp1:'
        AND updated_at < ? ORDER BY updated_at LIMIT 64`).all(startedAt) as Array<{ detail: string }>;
    assert.ok(plan.some(row => row.detail.includes('USING INDEX command_receipt_rejected_retention')));
    assert.ok(plan.every(row => !row.detail.includes('TEMP B-TREE')));
  } finally { db.close(); }
});
