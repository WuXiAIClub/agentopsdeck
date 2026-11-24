import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Hono } from 'hono';
import { CommandConflict, CommandReceipts } from './receipts.js';
import { registerMessageReceipts } from './http.js';

const windowMs = 30 * 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 8, 16, 12);
const keyAt = (timestamp: number) => `cp1:${timestamp}:${randomUUID()}`;

test('expired versioned commands never reach admission or binding and create no receipt', context => {
  context.mock.method(Date, 'now', () => now);
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db);
  try {
    const key = keyAt(now - windowMs - 1);
    assert.throws(() => receipts.claim('actor', key, {}, true, 1,
      () => assert.fail('must not admit'), () => assert.fail('must not bind')), /Command key expired/);
    assert.equal(receipts.get('actor', key), undefined);
    assert.equal(db.prepare('SELECT count(*) AS count FROM command_receipts').get()?.count, 0);
  } finally { db.close(); }
});

test('expiry refusal survives restart and wall clock rollback, across scopes', context => {
  let clock = now;
  context.mock.method(Date, 'now', () => clock);
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-key-floor-'));
  const file = join(directory, 'commands.sqlite');
  let db = new DatabaseSync(file), receipts = new CommandReceipts(db);
  try {
    const key = keyAt(now - windowMs - 1);
    assert.throws(() => receipts.claim('alice', key, {}), /Command key expired/);
    db.close();
    clock -= windowMs;
    db = new DatabaseSync(file); receipts = new CommandReceipts(db);
    assert.throws(() => receipts.claim('alice', key, {}), /Command key expired/);
    assert.throws(() => receipts.claim('bob', key, {}), /Command key expired/);
    assert.equal(receipts.get('alice', key), undefined);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('retained original outcomes and authority win over expiry without repeating callbacks', context => {
  let clock = now;
  context.mock.method(Date, 'now', () => clock);
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db);
  try {
    const keys = [keyAt(now), keyAt(now), keyAt(now)];
    for (const key of keys) receipts.claim('actor', key, { text: 'original' }, true, 7);
    receipts.settle('actor', keys[0]!, { status: 200, body: { ok: true } });
    receipts.settle('actor', keys[1]!, { status: 409, body: { error: 'denied' } });
    const before = keys.map(key => receipts.get('actor', key));
    clock += windowMs + 1;
    receipts.claim('other', keyAt(clock), {});
    for (const [index, key] of keys.entries()) {
      assert.deepEqual(receipts.claim('actor', key, { text: 'original' }, true, 7,
        () => assert.fail('duplicate admission'), () => assert.fail('duplicate binding')),
      { fresh: false, receipt: before[index] });
      assert.deepEqual(receipts.get('actor', key), before[index]);
      assert.throws(() => receipts.claim('actor', key, { text: 'changed' }, true, 7), /different content/);
      assert.throws(() => receipts.claim('actor', key, { text: 'original' }, true, 8), /authority cannot change/);
    }
  } finally { db.close(); }
});

test('versioned downstream keys preserve original age and isolated identity', context => {
  context.mock.method(Date, 'now', () => now);
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db);
  try {
    const issuedAt = now - 1000, key = keyAt(issuedAt);
    receipts.claim('alice', key, {}, true, 1);
    receipts.claim('bob', key, {}, true, 1);
    const first = receipts.deliveryKey('alice', key), second = receipts.deliveryKey('bob', key);
    assert.match(first, new RegExp(`^cp1:${issuedAt}:`));
    assert.match(second, new RegExp(`^cp1:${issuedAt}:`));
    assert.notEqual(first, second);
    assert.notEqual(first, key);
    assert.equal(receipts.claim('alice', key, {}, true, 1).fresh, false);
    assert.equal(receipts.deliveryKey('alice', key), first);
    receipts.claim('legacy', 'old-key', {}, true);
    assert.match(receipts.deliveryKey('legacy', 'old-key'), /^cmd_/);
  } finally { db.close(); }
});

test('canonical versioned keys reject malformed or far-future timestamps, but preserve legacy keys', context => {
  context.mock.method(Date, 'now', () => now);
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db);
  try {
    for (const key of ['cp1:bad:nonce', `cp1:0${now}:${randomUUID()}`, `cp1:${now}:short`,
      `cp1:9007199254740992:${randomUUID()}`, keyAt(now + 5 * 60 * 1000 + 1)]) {
      assert.throws(() => receipts.claim('actor', key, {}), CommandConflict);
      assert.equal(receipts.get('actor', key), undefined);
    }
    assert.equal(receipts.claim('actor', keyAt(now - windowMs), {}).fresh, true);
    assert.equal(receipts.claim('actor', keyAt(now + 5 * 60 * 1000), {}).fresh, true);
    for (const key of ['legacy-key', randomUUID(), 'cmd_legacy']) {
      assert.equal(receipts.claim('actor', key, {}).fresh, true);
      assert.equal(receipts.claim('actor', key, {}).fresh, false);
    }
  } finally { db.close(); }
});

test('HTTP expired refusal is not a terminal receipt and GET never claims no original execution', async context => {
  context.mock.method(Date, 'now', () => now);
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db), app = new Hono();
  registerMessageReceipts(app, '/sessions/:sessionKey', { receipts, scope: () => 'actor' });
  app.post('/sessions/:sessionKey/messages', () => assert.fail('must not dispatch'));
  try {
    const key = keyAt(now - windowMs - 1);
    const result = await app.request('/sessions/session/messages', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idempotencyKey: key, message: 'original' }) });
    assert.equal(result.status, 409);
    const body = await result.json();
    assert.match(body.error, /original outcome is not established/);
    assert.equal(body.command, undefined);
    const recovery = await app.request(`/sessions/session/commands/${encodeURIComponent(key)}`);
    assert.equal(recovery.status, 404);
    assert.equal((await recovery.json()).command, undefined);
  } finally { db.close(); }
});

test('downstream expiry cannot settle an admitted upstream command as rejected or generate a new key', context => {
  let clock = now;
  context.mock.method(Date, 'now', () => clock);
  const hubDb = new DatabaseSync(':memory:'), connectorDb = new DatabaseSync(':memory:');
  const hub = new CommandReceipts(hubDb), connector = new CommandReceipts(connectorDb);
  try {
    const key = keyAt(now);
    hub.claim('actor', key, {}, true, 1);
    const original = hub.get('actor', key), delivery = hub.deliveryKey('actor', key);
    clock += windowMs + 1;
    assert.throws(() => connector.claim('connector-actor', delivery, {}), /Command key expired/);
    assert.deepEqual(hub.settleFromReceipt('actor', key, connector.get('connector-actor', delivery)), original);
    assert.deepEqual(hub.claim('actor', key, {}, true, 1), { fresh: false, receipt: original });
    assert.equal(hub.deliveryKey('actor', key), delivery);
  } finally { hubDb.close(); connectorDb.close(); }
});

test('policy write failure prevents receipt, admission and binding, without damaging the existing transaction', context => {
  context.mock.method(Date, 'now', () => now);
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db);
  try {
    db.exec("CREATE TRIGGER policy_failure BEFORE UPDATE ON command_receipt_policy BEGIN SELECT RAISE(ABORT, 'synthetic policy failure'); END");
    const key = keyAt(now);
    assert.throws(() => receipts.claim('actor', key, {}, true, 1,
      () => assert.fail('must not admit'), () => assert.fail('must not bind')), /synthetic policy failure/);
    assert.equal(receipts.get('actor', key), undefined);
    db.exec('DROP TRIGGER policy_failure');
    assert.equal(receipts.claim('actor', key, {}, true, 1).fresh, true);
  } finally { db.close(); }
});

test('age boundary never removes legacy receipts, deletion facts, retained bindings or unknown results', context => {
  let clock = now;
  context.mock.method(Date, 'now', () => clock);
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db);
  try {
    const scope = JSON.stringify(['delete', JSON.stringify(['actor', 'session'])]);
    const deletion = keyAt(now), bound = keyAt(now);
    receipts.claim(scope, deletion, {});
    receipts.settle(scope, deletion, { status: 200, body: { ok: true } });
    receipts.claim('maintenance', bound, {}, true, 1, undefined,
      () => ({ metadata: { originalTarget: 'node-a' }, retainedBytes: 100 }));
    receipts.claim('legacy', 'old', {});
    const before = db.prepare('SELECT * FROM command_receipts ORDER BY scope, command_key').all();
    const usage = db.prepare('SELECT * FROM command_receipt_usage').get();
    clock += windowMs * 2;
    assert.throws(() => receipts.claim('missing', keyAt(now), {}), /Command key expired/);
    assert.deepEqual(db.prepare('SELECT * FROM command_receipts ORDER BY scope, command_key').all(), before);
    assert.deepEqual(db.prepare('SELECT * FROM command_receipt_usage').get(), usage);
    assert.equal(receipts.sessionDeletion('session'), 'accepted');
    assert.deepEqual(receipts.binding('maintenance', bound), { originalTarget: 'node-a' });
    assert.equal(receipts.get('maintenance', bound)?.state, 'outcome_unknown');
  } finally { db.close(); }
});

test('legacy SQL writers cannot reinsert a retired versioned key after simulated reclamation', context => {
  let clock = now;
  context.mock.method(Date, 'now', () => clock);
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db);
  try {
    const key = keyAt(now), original = receipts.claim('actor', key, {}).receipt;
    receipts.settle('actor', key, { status: 200, body: { ok: true } });
    clock += windowMs + 1;
    assert.throws(() => receipts.claim('missing', key, {}), /Command key expired/);
    db.prepare('DELETE FROM command_receipts WHERE scope = ? AND command_key = ?').run('actor', key);
    const insert = db.prepare(`INSERT INTO command_receipts
      (scope, command_key, id, fingerprint, state, created_at, updated_at, result)
      VALUES (?, ?, ?, 'synthetic', 'outcome_unknown', ?, ?, NULL)`);
    assert.throws(() => insert.run('actor', key, original.id, now, now), /Command key expired/);
    assert.throws(() => insert.run('other', key, original.id, now, now), /Command key expired/);
    assert.equal(receipts.get('actor', key), undefined);
    insert.run('legacy', 'old-uuid-style', 'legacy-id', now, now);
    const usage = db.prepare('SELECT rows FROM command_receipt_usage').get();
    assert.equal(usage?.rows, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM command_receipts').get()?.count, 1);
  } finally { db.close(); }
});

test('durable rejection policy cannot be lowered or removed by a legacy storage operation', context => {
  context.mock.method(Date, 'now', () => now);
  const db = new DatabaseSync(':memory:'), receipts = new CommandReceipts(db);
  try {
    assert.throws(() => receipts.claim('actor', keyAt(now - windowMs - 1), {}), /Command key expired/);
    const before = db.prepare('SELECT * FROM command_receipt_policy').get();
    assert.throws(() => db.exec('UPDATE command_receipt_policy SET reject_before = 0'), /cannot decrease/);
    assert.throws(() => db.exec('DELETE FROM command_receipt_policy'), /cannot be removed/);
    assert.throws(() => db.exec('INSERT OR REPLACE INTO command_receipt_policy VALUES(1, 0)'), /cannot decrease/);
    assert.deepEqual(db.prepare('SELECT * FROM command_receipt_policy').get(), before);
    new CommandReceipts(db);
    assert.deepEqual(db.prepare('SELECT * FROM command_receipt_policy').get(), before);
  } finally { db.close(); }
});
