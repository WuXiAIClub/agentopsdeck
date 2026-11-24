import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { createCommandKey } from '@agentopsdeck/shared';
import { CodexExecutions } from '../codex/executions.js';
import { CodexAppServer } from '../codex/app-server.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { OpenClawExecutions } from '../openclaw/executions.js';
import { OpenClawTurnQueue } from '../openclaw/turn-queue.js';
import { MirrorOutbox } from '../messages/mirror.js';
import { DeckStore } from '../projection/deck-store.js';
import { CommandReceipts } from './receipts.js';
import { TurnQueue } from './turn-queue.js';

const sessionKey = 'synthetic-session';
const scope = JSON.stringify(['alice', sessionKey]);
const result = { status: 200, body: { idempotencyKey: 'native-command', status: 'queued' } };

function fixture(context: TestContext, runtime: 'openclaw' | 'codex', mirror = false) {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  const receipts = new CommandReceipts(db), turns = new TurnQueue(db);
  const key = createCommandKey(randomUUID());
  const openclaw = new OpenClawExecutions(db, undefined, undefined, () => 1000, undefined, undefined, undefined, receipts);
  const codex = new CodexExecutions(db, undefined, undefined, () => 1000, undefined, receipts);
  receipts.claim(scope, key, {});
  turns.enqueue(runtime, { id: 'native-command', sessionKey, createdAt: 1, payload: { actorId: 'alice', deliveryMode: mirror ? 'mirror' : 'web-only' } }, receipts.queueCommit(scope, key, result));
  const read = () => ({ ...db.prepare('SELECT native_runtime, native_mirror, native_completed_at FROM command_receipts WHERE scope = ? AND command_key = ?').get(scope, key) });
  const begin = () => runtime === 'openclaw' ? openclaw.begin(sessionKey, 'native-command') : codex.begin(sessionKey, 'native-command', 'connection');
  const acknowledge = () => runtime === 'openclaw'
    ? openclaw.acknowledge(sessionKey, 'native-command', 'run', () => turns.complete(runtime, 'native-command'))
    : codex.acknowledge(sessionKey, 'native-command', 'connection', 'run', () => turns.complete(runtime, 'native-command'));
  const finish = () => runtime === 'openclaw'
    ? openclaw.observe(sessionKey, { runId: 'run', phase: 'completed' })
    : codex.observe(sessionKey, 'connection', 'run', 'completed');
  return { db, receipts, turns, key, openclaw, codex, read, begin, acknowledge, finish };
}

for (const runtime of ['openclaw', 'codex'] as const) {
  test(`${runtime} receipt distinguishes admission, queue ACK and native completion`, context => {
    const { receipts, key, turns, read, begin, acknowledge, finish } = fixture(context, runtime);
    const original = receipts.get(scope, key);
    assert.deepEqual(read(), { native_runtime: runtime, native_mirror: 0, native_completed_at: null });
    assert.equal(begin(), true);
    assert.equal(read().native_completed_at, null);
    assert.equal(acknowledge(), true);
    assert.equal(turns.list(runtime).length, 0);
    assert.equal(read().native_completed_at, null);
    assert.equal(finish(), true);
    assert.equal(read().native_completed_at, 1000);
    assert.deepEqual(receipts.get(scope, key), original);
  });

  test(`${runtime} early terminal is recorded only after original ACK binds the run`, context => {
    const { read, begin, acknowledge, finish } = fixture(context, runtime);
    begin();
    finish();
    assert.equal(read().native_completed_at, null);
    acknowledge();
    assert.equal(read().native_completed_at, 1000);
  });

  test(`${runtime} receipt storage failure rolls native completion and ACK removal back`, context => {
    const { db, turns, read, begin, acknowledge, finish, openclaw, codex } = fixture(context, runtime);
    begin();
    finish();
    const owner = runtime === 'openclaw' ? openclaw : codex;
    const original = owner.get(sessionKey);
    db.exec(`CREATE TRIGGER fail_receipt_completion BEFORE UPDATE OF native_completed_at ON command_receipts
      WHEN new.native_completed_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'synthetic receipt write failure'); END`);
    assert.throws(acknowledge, /synthetic receipt write failure/);
    assert.deepEqual(owner.get(sessionKey), original);
    assert.equal(turns.list(runtime).length, 1);
    assert.equal(read().native_completed_at, null);
    db.exec('DROP TRIGGER fail_receipt_completion');
    acknowledge();
    assert.equal(read().native_completed_at, 1000);
    assert.equal(turns.list(runtime).length, 0);
  });

  test(`${runtime} conflicting ACK removes previously recorded terminal proof`, context => {
    const { read, begin, acknowledge, finish, openclaw, codex } = fixture(context, runtime);
    begin(); acknowledge(); finish();
    assert.equal(read().native_completed_at, 1000);
    if (runtime === 'openclaw') openclaw.acknowledge(sessionKey, 'native-command', 'different-run');
    else codex.acknowledge(sessionKey, 'native-command', 'connection', 'different-run', () => {});
    assert.equal(read().native_completed_at, null);
  });

  test(`${runtime} successor replaces current execution without erasing original receipt proof`, context => {
    const { read, begin, acknowledge, finish, openclaw, codex } = fixture(context, runtime);
    begin(); acknowledge(); finish();
    if (runtime === 'openclaw') assert.equal(openclaw.begin(sessionKey, 'successor'), true);
    else {
      codex.settleHistory({ sessionKey, commandId: 'native-command', runId: 'run' }, 'current');
      assert.equal(codex.begin(sessionKey, 'successor', 'connection'), true);
    }
    assert.equal(read().native_completed_at, 1000);
  });

  test(`${runtime} restart does not invent terminal provenance for acknowledged work`, context => {
    const { read, begin, acknowledge, openclaw, codex } = fixture(context, runtime);
    begin(); acknowledge();
    (runtime === 'openclaw' ? openclaw : codex).recoverInterrupted();
    assert.equal(read().native_completed_at, null);
  });
}

test('native admission outside its transaction fails before changing the receipt', context => {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  const receipts = new CommandReceipts(db), key = createCommandKey(randomUUID());
  receipts.claim(scope, key, {});
  const original = receipts.get(scope, key);
  assert.throws(() => receipts.queueCommit(scope, key, result)(db,
    { runtime: 'openclaw', id: 'native-command', sessionKey, actorId: 'alice', mirror: false }), /owning transaction/);
  assert.deepEqual(receipts.get(scope, key), original);
});

test('CLI completion records original receipt provenance, not CLI acceptance', context => {
  const { openclaw, read, begin } = fixture(context, 'openclaw');
  begin();
  openclaw.useCli(sessionKey, 'native-command');
  openclaw.acknowledgeCli(sessionKey, 'native-command');
  assert.equal(read().native_completed_at, null);
  openclaw.finishCli(sessionKey, 'native-command', 'failed');
  assert.equal(read().native_completed_at, 1000);
});

test('wrong session, runtime, command and invalid terminal evidence cannot stamp a receipt', context => {
  const { db, receipts, read } = fixture(context, 'openclaw');
  const valid = { sessionKey, commandId: 'native-command', phase: 'completed', completedAt: 1000 };
  for (const fact of [{ ...valid, sessionKey: 'other' }, { ...valid, commandId: 'other' },
    { ...valid, phase: 'running' }, { ...valid, reason: 'restarted' }, { ...valid, completedAt: -1 },
    { ...valid, completedAt: 1.5 }, { ...valid, completedAt: Number.MAX_SAFE_INTEGER + 1 }]) {
    db.exec('BEGIN IMMEDIATE');
    receipts.recordExecutionInTransaction(db, 'openclaw', fact);
    db.exec('COMMIT');
    assert.equal(read().native_completed_at, null);
  }
  db.exec('BEGIN IMMEDIATE');
  receipts.recordExecutionInTransaction(db, 'codex', valid);
  db.exec('COMMIT');
  assert.equal(read().native_completed_at, null);
  assert.throws(() => receipts.recordExecutionInTransaction(db, 'openclaw', valid), /owning transaction/);
});

test('later ambiguous native binding invalidates previous terminal provenance', context => {
  const { receipts, turns, read, begin, acknowledge, finish } = fixture(context, 'openclaw');
  begin(); acknowledge(); finish();
  assert.equal(read().native_completed_at, 1000);
  const otherScope = JSON.stringify(['bob', 'other-session']), otherKey = createCommandKey(randomUUID());
  receipts.claim(otherScope, otherKey, {});
  turns.enqueue('openclaw', { id: 'native-command', sessionKey: 'other-session', createdAt: 1, payload: { actorId: 'bob' } },
    receipts.queueCommit(otherScope, otherKey, result));
  assert.equal(read().native_completed_at, null);
  finish();
  assert.equal(read().native_completed_at, null);
});

test('unmatched admission identity and legacy scopes remain unbound', context => {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  const receipts = new CommandReceipts(db), turns = new TurnQueue(db);
  for (const [index, address] of ['legacy', JSON.stringify(['bob', sessionKey]), JSON.stringify(['alice', 'other']), scope].entries()) {
    const key = createCommandKey(randomUUID()), id = `native-${index}`;
    receipts.claim(address, key, {});
    turns.enqueue('openclaw', { id, sessionKey, createdAt: 1, payload: { actorId: 'alice' } },
      receipts.queueCommit(address, key, { status: 200, body: { idempotencyKey: index === 3 ? 'wrong-command' : id } }));
    assert.equal(db.prepare('SELECT native_runtime FROM command_receipts WHERE command_key = ?').get(key)?.native_runtime, null);
    assert.equal(receipts.get(address, key)?.state, 'accepted');
  }
});

test('native binding and queue usage roll back with failed original admission', context => {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  const receipts = new CommandReceipts(db), turns = new TurnQueue(db), key = createCommandKey(randomUUID());
  receipts.claim(scope, key, {});
  const original = receipts.get(scope, key), usage = db.prepare('SELECT * FROM command_receipt_usage').get();
  db.exec(`CREATE TRIGGER fail_binding BEFORE UPDATE OF native_runtime ON command_receipts
    BEGIN SELECT RAISE(ABORT, 'synthetic native binding failure'); END`);
  assert.throws(() => turns.enqueue('openclaw', { id: 'native-command', sessionKey, createdAt: 1, payload: { actorId: 'alice' } },
    receipts.queueCommit(scope, key, result)), /synthetic native binding failure/);
  assert.deepEqual(receipts.get(scope, key), original);
  assert.deepEqual(db.prepare('SELECT * FROM command_receipt_usage').get(), usage);
  assert.equal(turns.list('openclaw').length, 0);
  assert.deepEqual({ ...db.prepare('SELECT rows, bytes FROM connector_turn_usage').get() }, { rows: 0, bytes: 0 });
});

test('OpenClaw enqueue adapter retains mirror admission identity in the original receipt', async context => {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  const receipts = new CommandReceipts(db), turns = new TurnQueue(db);
  const openclaw = new OpenClawExecutions(db, undefined, undefined, undefined, undefined, undefined, undefined, receipts);
  const store = new DeckStore(), outbox = new MirrorOutbox(db), key = createCommandKey(randomUUID());
  store.upsertSession({ sessionKey, agentId: 'synthetic', title: 'Synthetic', status: 'idle' });
  const queue = new OpenClawTurnQueue({ turns, executions: openclaw, store, mirrorOutbox: outbox, authorizeTurn: () => true,
    refreshSessions: async () => {}, refreshMessages: async () => {},
    send: async () => assert.fail('must not invoke native Agent'), mirror: async () => assert.fail('must not invoke channel') });
  try {
    receipts.claim(scope, key, {});
    queue.enqueue({ id: 'mirror-command', sessionKey, createdAt: 1, payload: { actorId: 'alice', message: 'synthetic', media: [],
      deliveryMode: 'mirror', explicitRoute: { originatingChannel: 'synthetic', originatingTo: 'synthetic', outboundTarget: 'synthetic' } } },
      receipts.queueCommit(scope, key, { status: 200, body: { idempotencyKey: 'mirror-command' } }));
    assert.deepEqual({ ...db.prepare('SELECT native_runtime, native_mirror FROM command_receipts WHERE command_key = ?').get(key) },
      { native_runtime: 'openclaw', native_mirror: 1 });
    assert.equal(outbox.get('mirror-command')?.actorId, 'alice');
  } finally { await queue.close(); }
});

test('Codex send adapter binds its generated native ID without starting an Agent', async context => {
  const db = new DatabaseSync(':memory:');
  context.after(() => db.close());
  const receipts = new CommandReceipts(db), turns = new TurnQueue(db);
  const codex = new CodexExecutions(db, undefined, undefined, undefined, undefined, receipts);
  const store = new DeckStore(), address = 'codex:synthetic-thread', actorScope = JSON.stringify(['alice', address]);
  store.upsertSession({ sessionKey: address, agentId: 'codex', title: 'Synthetic', status: 'idle' });
  const app = new CodexAppServer({ enabled: true, command: 'must-not-run-synthetic-agent', defaultCwd: tmpdir(), defaultModel: 'synthetic',
    approvalPolicy: 'never', store, turnQueue: turns, executions: codex, authorizeTurn: () => true });
  try {
    const key = createCommandKey(randomUUID());
    receipts.claim(actorScope, key, {});
    const accepted = await app.send(address, 'synthetic', [], { actorId: 'alice',
      accept: body => receipts.queueCommit(actorScope, key, { status: 200, body }) });
    assert.deepEqual({ ...db.prepare('SELECT native_runtime, native_mirror FROM command_receipts WHERE command_key = ?').get(key) },
      { native_runtime: 'codex', native_mirror: 0 });
    assert.equal(receipts.get(actorScope, key)?.result?.body.idempotencyKey, accepted.idempotencyKey);
    assert.equal(turns.head('codex', address)?.id, accepted.idempotencyKey);
    assert.equal(codex.get(address), undefined);
  } finally { await app.close(); }
});

function mirrorFixture(context: TestContext, mirror = true) {
  const base = fixture(context, 'openclaw', mirror);
  const outbox = new MirrorOutbox(base.db, undefined, undefined, base.receipts);
  const params = { sessionKey, idempotencyKey: 'native-command', actorId: 'alice', after: 1, inputText: 'synthetic',
    explicitRoute: { originatingChannel: 'synthetic', originatingTo: 'synthetic', outboundTarget: 'synthetic' } };
  outbox.upsert(params);
  const reply = (text: string) => {
    base.db.exec('BEGIN IMMEDIATE');
    outbox.recordCliReplyInTransaction(base.db, params, text);
    base.db.exec('COMMIT');
  };
  const readMirror = () => base.db.prepare('SELECT mirror_completed_at FROM command_receipts WHERE command_key = ?').get(base.key)?.mirror_completed_at;
  const noOutput = () => outbox.saveJob({ ...outbox.get(params.idempotencyKey)!, deliveryState: 'no_output', lastError: 'Original structured reply has no output' });
  return { ...base, outbox, params, reply, readMirror, noOutput };
}

test('no-output terminal stamps the original receipt using owner time, not native reply or admission time', context => {
  const { receipts, key, outbox, reply, readMirror, noOutput } = mirrorFixture(context);
  const original = receipts.get(scope, key);
  context.mock.method(Date, 'now', () => 5000);
  assert.equal(readMirror(), null);
  reply('NO_REPLY');
  assert.equal(readMirror(), null);
  noOutput();
  assert.equal(readMirror(), 5000);
  assert.equal(outbox.get('native-command')?.deliveryState, 'no_output');
  assert.deepEqual(receipts.get(scope, key), original);
  assert.throws(noOutput, /delivery conflict/);
  assert.equal(readMirror(), 5000);
});

test('sent terminal uses owner time and duplicates cannot backdate or extend retained proof', context => {
  const { outbox, reply, readMirror } = mirrorFixture(context);
  let now = 5000;
  context.mock.method(Date, 'now', () => now);
  reply('synthetic reply');
  const selected = { ...outbox.get('native-command')!, deliveryState: 'outcome_unknown' as const,
    selectedMessageId: 'original-reply', outputSha256: 'a'.repeat(64), attemptedAt: 1000 };
  outbox.saveJob(selected);
  assert.equal(readMirror(), null);
  const sent = { ...selected, deliveryState: 'sent' as const, mirroredMessageIds: ['original-reply'], lastMirroredAt: 1001 };
  outbox.saveJob(sent);
  assert.equal(readMirror(), 5000);
  now = 9000;
  outbox.saveJob(sent);
  assert.equal(readMirror(), 5000);
});

test('terminal receipt failure rolls back mirror fact and both usage counters', context => {
  const { db, outbox, reply, readMirror, noOutput } = mirrorFixture(context);
  reply('NO_REPLY');
  const original = outbox.get('native-command');
  const mirrorUsage = db.prepare('SELECT * FROM connector_mirror_usage').get();
  const receiptUsage = db.prepare('SELECT * FROM command_receipt_usage').get();
  db.exec(`CREATE TRIGGER fail_mirror_receipt BEFORE UPDATE OF mirror_completed_at ON command_receipts
    WHEN new.mirror_completed_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'synthetic mirror receipt failure'); END`);
  assert.throws(noOutput, /synthetic mirror receipt failure/);
  assert.deepEqual(outbox.get('native-command'), original);
  assert.deepEqual(db.prepare('SELECT * FROM connector_mirror_usage').get(), mirrorUsage);
  assert.deepEqual(db.prepare('SELECT * FROM command_receipt_usage').get(), receiptUsage);
  assert.equal(readMirror(), null);
});

test('unexpected mirror cannot stamp a web-only admission', context => {
  const { reply, readMirror, noOutput } = mirrorFixture(context, false);
  reply('NO_REPLY'); noOutput();
  assert.equal(readMirror(), null);
});

test('mirror proof rejects wrong original actor, session, native command and foreign transaction', context => {
  const { db, receipts, params, readMirror } = mirrorFixture(context);
  for (const change of [{ actorId: 'bob' }, { sessionKey: 'other' }, { idempotencyKey: 'other' }]) {
    db.exec('BEGIN IMMEDIATE');
    receipts.recordMirrorInTransaction(db, { ...params, ...change, deliveryState: 'sent' });
    db.exec('COMMIT');
    assert.equal(readMirror(), null);
  }
  assert.throws(() => receipts.recordMirrorInTransaction(db, { ...params, deliveryState: 'sent' }), /owning transaction/);
  const foreign = new DatabaseSync(':memory:');
  try {
    foreign.exec('BEGIN IMMEDIATE');
    assert.throws(() => receipts.recordMirrorInTransaction(foreign, { ...params, deliveryState: 'sent' }), /owning transaction/);
  } finally { foreign.close(); }
});

test('ConnectorUserStore persists original mirror completion without rewriting mirror job format', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-original-mirror-proof-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'connector.sqlite'), key = createCommandKey(randomUUID());
  const store = new ConnectorUserStore(file);
  const params = { sessionKey, idempotencyKey: 'native-command', actorId: 'alice', after: 1, inputText: 'synthetic',
    explicitRoute: { originatingChannel: 'synthetic', originatingTo: 'synthetic', outboundTarget: 'synthetic' } };
  try {
    (await store.commands.claimAsync(scope, key, {}));
    const commit = store.commands.queueCommit(scope, key, result);
    await store.turns.enqueueAsync('openclaw', { id: 'native-command', sessionKey, createdAt: 1, payload: { actorId: 'alice', deliveryMode: 'mirror' } },
      (db, admission) => {
        store.mirrorOutbox.admitInTransaction(db, params);
        commit(db, admission);
      });
    store.openClawExecutions.begin(sessionKey, 'native-command');
    store.openClawExecutions.useCli(sessionKey, 'native-command');
    store.openClawExecutions.finishCli(sessionKey, 'native-command', 'completed', db => {
      store.mirrorOutbox.recordCliReplyInTransaction(db, params, 'NO_REPLY');
    });
    store.mirrorOutbox.saveJob({ ...store.mirrorOutbox.get(params.idempotencyKey)!, deliveryState: 'no_output', lastError: 'No external output' });
    assert.equal('completedAt' in store.mirrorOutbox.get(params.idempotencyKey)!, false);
  } finally { store.close(); }
  const reopened = new ConnectorUserStore(file);
  try {
    assert.deepEqual(reopened.commands.get(scope, key)?.result, result);
    assert.equal(reopened.mirrorOutbox.get(params.idempotencyKey)?.deliveryState, 'no_output');
  } finally { reopened.close(); }
  const db = new DatabaseSync(file);
  try {
    const row = db.prepare('SELECT native_completed_at, mirror_completed_at FROM command_receipts WHERE command_key = ?').get(key);
    assert.equal(typeof row?.native_completed_at, 'number');
    assert.equal(typeof row?.mirror_completed_at, 'number');
  } finally { db.close(); }
});

for (const runtime of ['openclaw', 'codex'] as const) {
  test(`ConnectorUserStore wires and reopens ${runtime} terminal evidence in the original database`, async context => {
    const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-receipt-execution-'));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, 'connector.sqlite'), key = createCommandKey(randomUUID());
    const store = new ConnectorUserStore(file);
    try {
      (await store.commands.claimAsync(scope, key, {}));
      await store.turns.enqueueAsync(runtime, { id: 'native-command', sessionKey, createdAt: 1, payload: { actorId: 'alice' } },
        store.commands.queueCommit(scope, key, result));
      if (runtime === 'openclaw') {
        store.openClawExecutions.begin(sessionKey, 'native-command');
        store.openClawExecutions.useCli(sessionKey, 'native-command');
        store.openClawExecutions.finishCli(sessionKey, 'native-command', 'completed');
      } else {
        store.codexExecutions.begin(sessionKey, 'native-command', 'connection');
        store.codexExecutions.acknowledge(sessionKey, 'native-command', 'connection', 'run', () => {});
        store.codexExecutions.observe(sessionKey, 'connection', 'run', 'interrupted');
      }
    } finally { store.close(); }
    const reopened = new ConnectorUserStore(file);
    try { assert.deepEqual(reopened.commands.get(scope, key)?.result, result); } finally { reopened.close(); }
    const db = new DatabaseSync(file);
    try {
      const row = db.prepare('SELECT native_runtime, native_completed_at FROM command_receipts WHERE command_key = ?').get(key);
      assert.equal(row?.native_runtime, runtime);
      assert.equal(typeof row?.native_completed_at, 'number');
    } finally { db.close(); }
  });
}
