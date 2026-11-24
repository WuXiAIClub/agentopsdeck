import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { COMMAND_KEY_MAX_AGE_MS, createCommandKey } from '@agentopsdeck/shared';
import { CodexExecutions } from '../codex/executions.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { OpenClawExecutions } from '../openclaw/executions.js';
import { MirrorOutbox, type MirrorParams } from '../messages/mirror.js';
import { CommandCapacity, CommandReceipts } from './receipts.js';
import { TurnQueue } from './turn-queue.js';
import { recoverableConnection, connectionRecoverySnapshot, StorageConnectionUnavailable } from '../storage/connection-recovery.js';

const startedAt = 1_789_560_000_000;
const sessionKey = 'synthetic-session';
const scope = JSON.stringify(['alice', sessionKey]);

for (const nested of [false, true]) {
  test(`async native reclamation preserves original receipt and policy (nested=${nested})`, async context => {
    let now = startedAt;
    context.mock.method(Date, 'now', () => now);
    const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw);
    db.exec('CREATE TABLE original_native(value INTEGER); INSERT INTO original_native VALUES(1); CREATE TABLE late_effect(value INTEGER)');
    const insert = db.prepare('INSERT INTO late_effect VALUES(1)');
    let release!: () => void, late: Promise<boolean> | undefined, calls = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    const receipts = new CommandReceipts(db, 1, undefined, (() => {
      calls++; db.exec('DELETE FROM original_native');
      return late = (async () => { await held; insert.run(); return true; })();
    }) as any);
    try {
      const id = randomUUID(), key = createCommandKey(randomUUID());
      receipts.claim(scope, key, {});
      db.exec('BEGIN IMMEDIATE');
      receipts.queueCommit(scope, key, { status: 200, body: { idempotencyKey: id } })(db,
        { runtime: 'openclaw', id, actorId: 'alice', sessionKey, mirror: false });
      receipts.recordExecutionInTransaction(db, 'openclaw', { sessionKey, commandId: id, phase: 'completed', completedAt: now });
      db.exec('COMMIT');
      const rows = raw.prepare('SELECT * FROM command_receipts').all(), usage = raw.prepare('SELECT * FROM command_receipt_usage').all();
      const policy = raw.prepare('SELECT * FROM command_receipt_policy').all();
      now += COMMAND_KEY_MAX_AGE_MS + 1;
      if (nested) db.exec('BEGIN IMMEDIATE');
      assert.throws(() => nested ? receipts.reclaimCompletedInTransaction(db)
        : receipts.claim('next', createCommandKey(randomUUID()), {}), /must be synchronous/);
      assert.equal(calls, 1);
      assert.deepEqual(raw.prepare('SELECT * FROM command_receipts').all(), rows);
      assert.deepEqual(raw.prepare('SELECT * FROM command_receipt_usage').all(), usage);
      assert.deepEqual(raw.prepare('SELECT * FROM command_receipt_policy').all(), policy);
      assert.equal(raw.prepare('SELECT count(*) AS n FROM original_native').get()?.n, 1);
      assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
      assert.throws(() => db.exec('COMMIT'), StorageConnectionUnavailable);
      const rejected = assert.rejects(late!, StorageConnectionUnavailable); release(); await rejected;
      assert.deepEqual(raw.prepare('SELECT * FROM late_effect').all(), []);
    } finally { release(); if (late) await late.catch(() => {}); db.close(); }
  });
}

function fixture(context: TestContext, runtime: 'openclaw' | 'codex' = 'openclaw', mirror = true,
  limits: { receipts?: number; receiptBytes?: number; mirrors?: number; mirrorBytes?: number; key?: string } = {}) {
  let now = startedAt;
  context.mock.method(Date, 'now', () => now);
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  const turns = new TurnQueue(db);
  const receipts: CommandReceipts = new CommandReceipts(db, limits.receipts ?? 1, limits.receiptBytes, (owner, target) =>
    !turns.hasCommand(target.runtime, target.id) && outbox.reclaimCompletedInTransaction(owner, target));
  const outbox: MirrorOutbox = new MirrorOutbox(db, limits.mirrors, limits.mirrorBytes, receipts);
  const openclaw = new OpenClawExecutions(db, undefined, undefined, () => now, undefined, undefined, outbox, receipts);
  const codex = new CodexExecutions(db, undefined, undefined, () => now, undefined, receipts);
  const id = randomUUID(), key = limits.key ?? createCommandKey(randomUUID());
  const params: MirrorParams = { actorId: 'alice', sessionKey, idempotencyKey: id, after: now, inputText: 'original',
    explicitRoute: { originatingChannel: 'synthetic', originatingTo: 'original', outboundTarget: 'original' } };
  receipts.claim(scope, key, {});
  turns.enqueue(runtime, { id, sessionKey, createdAt: now, payload: { actorId: 'alice', deliveryMode: mirror ? 'mirror' : 'web-only' } },
    (owner, admission) => {
      receipts.queueCommit(scope, key, { status: 200, body: { idempotencyKey: id, status: 'queued' } })(owner, admission);
      if (mirror) outbox.admitInTransaction(owner, params);
    });
  const finish = () => {
    if (runtime === 'openclaw') {
      openclaw.begin(sessionKey, id);
      openclaw.acknowledge(sessionKey, id, 'run', () => turns.complete(runtime, id));
      openclaw.observe(sessionKey, { runId: 'run', phase: 'completed' });
    } else {
      codex.begin(sessionKey, id, 'connection');
      codex.acknowledge(sessionKey, id, 'connection', 'run', () => turns.complete(runtime, id));
      codex.observe(sessionKey, 'connection', 'run', 'completed');
    }
  };
  const reply = (text: string) => {
    db.exec('BEGIN IMMEDIATE');
    outbox.recordCliReplyInTransaction(db, params, text);
    db.exec('COMMIT');
  };
  const noOutput = () => {
    reply('NO_REPLY');
    outbox.saveJob({ ...outbox.get(id)!, deliveryState: 'no_output', lastError: 'Original structured reply has no output' });
  };
  const next = () => receipts.claim('next', createCommandKey(randomUUID()), {});
  return { db, turns, receipts, outbox, id, key, params, finish, reply, noOutput, next, advance: (amount = COMMAND_KEY_MAX_AGE_MS + 1) => { now += amount; } };
}

for (const runtime of ['openclaw', 'codex'] as const) {
  test(`${runtime} receipt pressure reclaims only aged native-completed web-only work`, context => {
    const owner = fixture(context, runtime, false);
    owner.finish(); owner.advance();
    assert.equal(owner.next().fresh, true);
    assert.equal(owner.receipts.get(scope, owner.key), undefined);
    assert.equal(owner.db.prepare('SELECT rows FROM command_receipt_usage').get()?.rows, 1);
    assert.throws(() => owner.receipts.claim(scope, owner.key, {}), /expired/);
  });
}

test('receipt pressure deletes original terminal mirror and receipt in one transaction', context => {
  const owner = fixture(context);
  owner.finish(); owner.noOutput(); owner.advance();
  assert.equal(owner.next().fresh, true);
  assert.equal(owner.receipts.get(scope, owner.key), undefined);
  assert.equal(owner.outbox.get(owner.id), undefined);
  assert.deepEqual({ ...owner.db.prepare('SELECT rows, bytes FROM connector_mirror_usage').get() }, { rows: 0, bytes: 0 });
});

test('mirror row pressure invokes the same coordinated receipt reclamation', context => {
  const owner = fixture(context, 'openclaw', true, { receipts: 10, mirrors: 1 });
  owner.finish(); owner.noOutput(); owner.advance();
  owner.outbox.upsert({ ...owner.params, idempotencyKey: 'next-mirror' });
  assert.equal(owner.receipts.get(scope, owner.key), undefined);
  assert.equal(owner.outbox.get(owner.id), undefined);
  assert.equal(owner.db.prepare('SELECT rows FROM connector_mirror_usage').get()?.rows, 1);
});

test('native completion and mirror completion independently wait their full retention age', context => {
  const owner = fixture(context);
  owner.advance(); owner.finish(); owner.advance(); owner.noOutput();
  assert.throws(owner.next, CommandCapacity);
  owner.advance(COMMAND_KEY_MAX_AGE_MS);
  assert.throws(owner.next, CommandCapacity);
  owner.advance(1);
  assert.equal(owner.next().fresh, true);
});

test('remaining original queue evidence blocks reclamation even with completion stamps', context => {
  const owner = fixture(context);
  owner.finish(); owner.noOutput();
  owner.turns.enqueue('openclaw', { id: owner.id, sessionKey: 'other-session', createdAt: startedAt, payload: { actorId: 'other' } });
  owner.advance();
  assert.throws(owner.next, CommandCapacity);
  assert.ok(owner.receipts.get(scope, owner.key));
  assert.ok(owner.outbox.get(owner.id));
});

test('mirror absence is not delivery proof for an original mirror admission', context => {
  const owner = fixture(context);
  owner.finish(); owner.noOutput(); owner.advance();
  owner.db.prepare('DELETE FROM connector_mirror_outbox WHERE id = ?').run(owner.id);
  assert.throws(owner.next, CommandCapacity);
  assert.ok(owner.receipts.get(scope, owner.key));
});

test('late receipt deletion failure rolls mirror, usage and rejection boundary back', context => {
  const owner = fixture(context);
  owner.finish(); owner.noOutput(); owner.advance();
  const original = owner.receipts.get(scope, owner.key), mirror = owner.outbox.get(owner.id);
  const usage = owner.db.prepare('SELECT * FROM connector_mirror_usage').get();
  const policy = owner.db.prepare('SELECT * FROM command_receipt_policy').get();
  owner.db.exec("CREATE TRIGGER fail_receipt_reclaim BEFORE DELETE ON command_receipts BEGIN SELECT RAISE(ABORT, 'synthetic deletion failure'); END");
  assert.throws(owner.next, /synthetic deletion failure/);
  assert.deepEqual(owner.receipts.get(scope, owner.key), original);
  assert.deepEqual(owner.outbox.get(owner.id), mirror);
  assert.deepEqual(owner.db.prepare('SELECT * FROM connector_mirror_usage').get(), usage);
  assert.deepEqual(owner.db.prepare('SELECT * FROM command_receipt_policy').get(), policy);
});

test('receipt byte pressure reclaims coordinated evidence without reaching the row limit', context => {
  const owner = fixture(context, 'openclaw', true, { receipts: 10, receiptBytes: 1100 });
  owner.finish(); owner.noOutput(); owner.advance();
  assert.equal(owner.next().fresh, true);
  assert.equal(owner.outbox.get(owner.id), undefined);
});

test('mirror byte pressure reclaims coordinated evidence without reaching the row limit', context => {
  const owner = fixture(context, 'openclaw', true, { receipts: 10, mirrors: 10, mirrorBytes: 1600 });
  owner.finish(); owner.noOutput(); owner.advance();
  owner.outbox.upsert({ ...owner.params, idempotencyKey: 'next-mirror' });
  assert.equal(owner.receipts.get(scope, owner.key), undefined);
  assert.equal(owner.outbox.get(owner.id), undefined);
});

test('the mirror currently growing cannot reclaim its own completed receipt or job', context => {
  const owner = fixture(context, 'openclaw', true, { receipts: 10, mirrorBytes: 1600 });
  owner.finish(); owner.reply('Original structured output');
  const pending = owner.outbox.get(owner.id)!;
  owner.outbox.saveJob({ ...pending, deliveryState: 'outcome_unknown', selectedMessageId: 'original', outputSha256: 'a'.repeat(64), attemptedAt: startedAt });
  owner.outbox.saveJob({ ...owner.outbox.get(owner.id)!, deliveryState: 'sent', lastMirroredAt: startedAt, mirroredMessageIds: ['original'] });
  owner.advance();
  const original = owner.outbox.get(owner.id);
  assert.throws(() => owner.outbox.saveJob({ ...original!, lastError: 'oversized'.repeat(300) }), /capacity/);
  assert.deepEqual(owner.outbox.get(owner.id), original);
  assert.ok(owner.receipts.get(scope, owner.key));
});

test('successful delivery ages from original owner completion rather than caller lastMirroredAt', context => {
  const owner = fixture(context);
  owner.finish(); owner.reply('Original structured output'); owner.advance();
  owner.outbox.saveJob({ ...owner.outbox.get(owner.id)!, deliveryState: 'outcome_unknown', selectedMessageId: 'original', outputSha256: 'a'.repeat(64), attemptedAt: 1 });
  owner.outbox.saveJob({ ...owner.outbox.get(owner.id)!, deliveryState: 'sent', lastMirroredAt: 1, mirroredMessageIds: ['original'] });
  assert.throws(owner.next, CommandCapacity);
  owner.advance();
  assert.equal(owner.next().fresh, true);
});

test('spare capacities and duplicate recovery preserve expired completed evidence', context => {
  const owner = fixture(context, 'openclaw', true, { receipts: 10, mirrors: 10 });
  owner.finish(); owner.noOutput(); owner.advance();
  const original = owner.receipts.get(scope, owner.key), mirror = owner.outbox.get(owner.id);
  assert.deepEqual(owner.receipts.claim(scope, owner.key, {}), { fresh: false, receipt: original });
  owner.next(); owner.outbox.upsert({ ...owner.params, idempotencyKey: 'next-mirror' });
  assert.deepEqual(owner.receipts.get(scope, owner.key), original);
  assert.deepEqual(owner.outbox.get(owner.id), mirror);
});

test('unknown delivery and ACK without native completion never qualify by age alone', context => {
  const owner = fixture(context);
  owner.advance();
  assert.throws(owner.next, CommandCapacity);
  owner.finish();
  owner.outbox.saveJob({ ...owner.outbox.get(owner.id)!, deliveryState: 'outcome_unknown', selectedMessageId: 'original', outputSha256: 'a'.repeat(64), attemptedAt: startedAt });
  owner.advance();
  assert.throws(owner.next, CommandCapacity);
  assert.equal(owner.outbox.get(owner.id)?.deliveryState, 'outcome_unknown');
});

test('a later legacy mapping blocks reclamation despite historical native and mirror stamps', context => {
  const owner = fixture(context, 'openclaw', true, { receipts: 10, mirrors: 1 });
  owner.finish(); owner.noOutput(); owner.advance();
  owner.receipts.claim('legacy-scope', 'legacy-key', {});
  owner.receipts.settle('legacy-scope', 'legacy-key', { status: 200, body: { idempotencyKey: owner.id } });
  assert.throws(() => owner.outbox.upsert({ ...owner.params, idempotencyKey: 'next' }), /capacity/);
  assert.ok(owner.receipts.get(scope, owner.key));
  assert.ok(owner.outbox.get(owner.id));
});

test('original web-only mode refuses unexpected mirror evidence', context => {
  const owner = fixture(context, 'openclaw', false);
  owner.finish(); owner.outbox.upsert(owner.params); owner.advance();
  assert.throws(owner.next, CommandCapacity);
  assert.ok(owner.outbox.get(owner.id));
});

for (const change of ['actor', 'session', 'legacy', 'blocked', 'pending', 'unknown'] as const) {
  test(`reclamation independently rechecks original mirror ${change} instead of trusting its timestamp`, context => {
    const owner = fixture(context);
    owner.finish(); owner.noOutput(); owner.advance();
    const job = owner.outbox.get(owner.id)!;
    if (change === 'actor') job.actorId = 'other';
    if (change === 'session') job.sessionKey = 'other';
    if (change === 'legacy') {
      job.legacy = true; delete job.actorId; delete job.nativeReply;
      Object.assign(job, { deliveryState: 'sent', selectedMessageId: 'original', outputSha256: 'a'.repeat(64),
        attemptedAt: startedAt, lastMirroredAt: startedAt, mirroredMessageIds: ['original'] });
    }
    if (change === 'blocked' || change === 'pending') job.deliveryState = change;
    if (change === 'unknown') Object.assign(job, { deliveryState: 'outcome_unknown', selectedMessageId: 'original', outputSha256: 'a'.repeat(64), attemptedAt: startedAt });
    owner.db.prepare('UPDATE connector_mirror_outbox SET job = ?, session_key = ? WHERE id = ?').run(JSON.stringify(job), job.sessionKey, owner.id);
    assert.throws(owner.next, CommandCapacity);
    assert.ok(owner.receipts.get(scope, owner.key));
    assert.ok(owner.outbox.get(owner.id));
  });
}

test('legacy native admission remains protected after both completions age', context => {
  const owner = fixture(context, 'openclaw', true, { key: 'legacy-original-key' });
  owner.finish(); owner.noOutput(); owner.advance();
  assert.throws(owner.next, CommandCapacity);
  assert.ok(owner.receipts.get(scope, owner.key));
});

test('original key age remains independent of earlier native and mirror completion times', context => {
  const owner = fixture(context, 'openclaw', true, { key: createCommandKey(randomUUID(), startedAt + 300_000) });
  owner.finish(); owner.noOutput(); owner.advance();
  assert.throws(owner.next, CommandCapacity);
  owner.advance(300_000);
  assert.equal(owner.next().fresh, true);
});

test('a terminal sent mirror without original native reply provenance remains protected', context => {
  const owner = fixture(context);
  owner.finish();
  owner.outbox.saveJob({ ...owner.outbox.get(owner.id)!, deliveryState: 'outcome_unknown', selectedMessageId: 'original', outputSha256: 'a'.repeat(64), attemptedAt: startedAt });
  owner.outbox.saveJob({ ...owner.outbox.get(owner.id)!, deliveryState: 'sent', lastMirroredAt: startedAt, mirroredMessageIds: ['original'] });
  owner.advance();
  assert.throws(owner.next, CommandCapacity);
  assert.ok(owner.receipts.get(scope, owner.key));
  assert.ok(owner.outbox.get(owner.id));
});

test('accepted retention is bounded to 64 candidates in its original transaction', context => {
  const owner = fixture(context, 'openclaw', false, { receipts: 100 });
  owner.finish();
  for (let index = 0; index < 69; index++) {
    const key = createCommandKey(randomUUID()), id = 'bounded-' + index;
    owner.receipts.claim(scope, key, {});
    owner.turns.enqueue('openclaw', { id, sessionKey, createdAt: startedAt, payload: { actorId: 'alice' } }, (db, admission) => {
      owner.receipts.queueCommit(scope, key, { status: 200, body: { idempotencyKey: id } })(db, admission);
      owner.turns.complete('openclaw', id);
      owner.receipts.recordExecutionInTransaction(db, 'openclaw', { sessionKey, commandId: id, phase: 'completed', completedAt: startedAt });
    });
  }
  owner.advance();
  owner.db.exec('BEGIN IMMEDIATE');
  owner.receipts.reclaimCompletedInTransaction(owner.db);
  assert.equal(owner.db.prepare('SELECT rows FROM command_receipt_usage').get()?.rows, 6);
  owner.db.exec('COMMIT');
});

test('mirror capacity does not spend its bounded candidate page on web-only receipts', context => {
  const owner = fixture(context, 'openclaw', false, { receipts: 100, mirrors: 1 });
  owner.finish();
  for (let index = 0; index < 64; index++) {
    const key = createCommandKey(randomUUID()), id = 'web-' + index;
    owner.receipts.claim(scope, key, {});
    owner.turns.enqueue('openclaw', { id, sessionKey, createdAt: startedAt, payload: { actorId: 'alice' } }, (db, admission) => {
      owner.receipts.queueCommit(scope, key, { status: 200, body: { idempotencyKey: id } })(db, admission);
      owner.turns.complete('openclaw', id);
      owner.receipts.recordExecutionInTransaction(db, 'openclaw', { sessionKey, commandId: id, phase: 'completed', completedAt: startedAt });
    });
  }
  const key = createCommandKey(randomUUID()), id = 'mirror-original';
  owner.receipts.claim(scope, key, {});
  owner.turns.enqueue('openclaw', { id, sessionKey, createdAt: startedAt, payload: { actorId: 'alice', deliveryMode: 'mirror' } }, (db, admission) => {
    owner.receipts.queueCommit(scope, key, { status: 200, body: { idempotencyKey: id } })(db, admission);
    owner.outbox.admitInTransaction(db, { ...owner.params, idempotencyKey: id });
    owner.outbox.recordCliReplyInTransaction(db, { ...owner.params, idempotencyKey: id }, 'NO_REPLY');
    owner.turns.complete('openclaw', id);
    owner.receipts.recordExecutionInTransaction(db, 'openclaw', { sessionKey, commandId: id, phase: 'completed', completedAt: startedAt });
  });
  owner.outbox.saveJob({ ...owner.outbox.get(id)!, deliveryState: 'no_output', lastError: 'No output' });
  owner.advance();
  owner.outbox.upsert({ ...owner.params, idempotencyKey: 'next-mirror' });
  assert.equal(owner.receipts.get(scope, key), undefined);
  assert.equal(owner.db.prepare('SELECT rows FROM command_receipt_usage').get()?.rows, 65);
});

test('coordinated reclamation rejects another database and calls outside the owner transaction', context => {
  const owner = fixture(context), other = new DatabaseSync(':memory:');
  context.after(() => other.close());
  assert.throws(() => owner.receipts.reclaimCompletedInTransaction(owner.db), /owning transaction/);
  other.exec('BEGIN IMMEDIATE');
  assert.throws(() => owner.receipts.reclaimCompletedInTransaction(other), /owning transaction/);
  other.exec('ROLLBACK');
});

for (const failure of ['mirror-delete', 'receipt-insert', 'binding', 'mirror-insert'] as const) {
  test(`${failure} failure rolls coordinated reclamation and usage accounting back`, context => {
    const owner = fixture(context, 'openclaw', true, { mirrors: 1 });
    owner.finish(); owner.noOutput(); owner.advance();
    const original = owner.receipts.get(scope, owner.key), mirror = owner.outbox.get(owner.id);
    const receipts = owner.db.prepare('SELECT * FROM command_receipt_usage').get();
    const mirrors = owner.db.prepare('SELECT * FROM connector_mirror_usage').get();
    const policy = owner.db.prepare('SELECT * FROM command_receipt_policy').get();
    if (failure !== 'binding') {
      const table = failure === 'receipt-insert' ? 'command_receipts' : 'connector_mirror_outbox';
      const operation = failure === 'mirror-delete' ? 'DELETE' : 'INSERT';
      owner.db.exec(`CREATE TRIGGER fail_retention BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`);
    }
    const attempt = failure === 'mirror-insert' ? () => owner.outbox.upsert({ ...owner.params, idempotencyKey: 'next' })
      : failure === 'binding' ? () => owner.receipts.claim('next', createCommandKey(randomUUID()), {}, false, undefined,
        undefined, () => { throw new Error('synthetic failure'); }) : owner.next;
    assert.throws(attempt, /synthetic failure/);
    assert.deepEqual(owner.receipts.get(scope, owner.key), original);
    assert.deepEqual(owner.outbox.get(owner.id), mirror);
    assert.deepEqual(owner.db.prepare('SELECT * FROM command_receipt_usage').get(), receipts);
    assert.deepEqual(owner.db.prepare('SELECT * FROM connector_mirror_usage').get(), mirrors);
    assert.deepEqual(owner.db.prepare('SELECT * FROM command_receipt_policy').get(), policy);
  });
}

test('real ConnectorUserStore coordinates original owners and preserves rejection across reopen and clock rollback', async context => {
  let now = startedAt;
  context.mock.method(Date, 'now', () => now);
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-coordinated-reopen-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'connector.sqlite');
  const store = new ConnectorUserStore(file), key = createCommandKey(randomUUID()), id = randomUUID();
  const params: MirrorParams = { actorId: 'alice', sessionKey, idempotencyKey: id, after: now, inputText: 'original',
    explicitRoute: { originatingChannel: 'synthetic', originatingTo: 'original', outboundTarget: 'original' } };
  try {
    (await store.commands.claimAsync(scope, key, {}));
    await store.turns.enqueueAsync('openclaw', { id, sessionKey, createdAt: now, payload: { actorId: 'alice', deliveryMode: 'mirror' } }, (db, admission) => {
      store.commands.queueCommit(scope, key, { status: 200, body: { idempotencyKey: id } })(db, admission);
      store.mirrorOutbox.admitInTransaction(db, params);
      store.mirrorOutbox.recordCliReplyInTransaction(db, params, 'NO_REPLY');
    });
    store.openClawExecutions.begin(sessionKey, id);
    store.openClawExecutions.acknowledge(sessionKey, id, 'run', () => store.turns.complete('openclaw', id));
    store.openClawExecutions.observe(sessionKey, { runId: 'run', phase: 'completed' });
    store.mirrorOutbox.saveJob({ ...store.mirrorOutbox.get(id)!, deliveryState: 'no_output', lastError: 'No output' });
    now += COMMAND_KEY_MAX_AGE_MS + 1;
    await store.turns.enqueueAsync('openclaw', { id: 'next', sessionKey, createdAt: now, payload: {} }, db => {
      store.commands.reclaimCompletedInTransaction(db);
      assert.equal(db.prepare('SELECT rows FROM command_receipt_usage').get()?.rows, 0);
      assert.equal(db.prepare('SELECT bytes FROM connector_mirror_usage').get()?.bytes, 0);
    });
    assert.equal(store.commands.get(scope, key), undefined);
    assert.equal(store.mirrorOutbox.get(id), undefined);
  } finally { store.close(); }
  now = startedAt;
  const reopened = new ConnectorUserStore(file);
  try {
    assert.equal(reopened.commands.get(scope, key), undefined);
    assert.equal(reopened.mirrorOutbox.get(id), undefined);
    await assert.rejects(reopened.commands.claimAsync(scope, key, {}), /expired/);
    assert.equal(reopened.turns.hasCommand('openclaw', 'next'), true);
  } finally { reopened.close(); }
});
