import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { OpenClawTurnQueue } from '../openclaw/turn-queue.js';
import { OpenClawExecutions } from '../openclaw/executions.js';
import { DeckStore } from '../projection/deck-store.js';
import { createMirrorDispatcher, MirrorDeliveryUnknown, MirrorOutbox, type MirrorParams } from './mirror.js';

const params = (id = 'one', sessionKey = 'synthetic'): MirrorParams => ({ actorId: 'original-actor', sessionKey,
  idempotencyKey: id, after: 1, inputText: 'original input', executionGrant: { id: 'grant', actorId: 'original-actor', issuerTokenId: 'issuer' },
  explicitRoute: { originatingChannel: 'synthetic', originatingTo: 'original', outboundTarget: 'original' } });

function fixture(context: TestContext) {
  const db = new DatabaseSync(':memory:'), outbox = new MirrorOutbox(db), store = new DeckStore();
  const calls: unknown[] = [];
  const deps = { store, normalizeError: String, authorizeTarget: () => true,
    sendOutbound: async (route: unknown, text: string) => { calls.push({ route, text }); } };
  const dispatcher = createMirrorDispatcher(outbox, deps);
  context.mock.method(console, 'log', () => {});
  context.mock.method(console, 'warn', () => {});
  context.after(async () => { await dispatcher.close(); db.close(); });
  const admit = (input = params(), text?: string) => {
    outbox.upsert(input);
    if (text !== undefined) {
      db.exec('BEGIN IMMEDIATE');
      try { outbox.recordCliReplyInTransaction(db, input, text); db.exec('COMMIT'); }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    return input;
  };
  return { db, outbox, store, calls, deps, dispatcher, admit };
}

function completedGateway(context: TestContext) {
  context.mock.timers.enable({ apis: ['Date'], now: 10_000 });
  const setup = fixture(context), original = setup.admit();
  const executions = new OpenClawExecutions(setup.db, undefined, undefined, undefined, undefined, undefined, setup.outbox);
  executions.begin(original.sessionKey, original.idempotencyKey);
  executions.bindGatewayConnection(original.sessionKey, original.idempotencyKey, 'original-socket');
  executions.acknowledge(original.sessionKey, original.idempotencyKey, 'original-run');
  const complete = () => executions.observe(original.sessionKey, { phase: 'completed', runId: 'original-run', gatewayConnectionId: 'original-socket' });
  const reply = () => executions.observe(original.sessionKey, { phase: 'completed', runId: 'original-run', gatewayConnectionId: 'original-socket',
    replyOnly: true, reply: { text: 'original answer', sequence: 9 } });
  return { ...setup, original, executions, complete, reply };
}

test('authorization provider failure retires only original recovery demand and does not block the same-session successor', async context => {
  const setup = fixture(context), original = setup.admit(params(), 'original answer');
  setup.admit(params('successor'), 'successor answer');
  const checks: string[] = [];
  const dispatcher = createMirrorDispatcher(setup.outbox, { ...setup.deps, authorizeTarget: input => {
    checks.push(input.idempotencyKey);
    if (input.idempotencyKey === original.idempotencyKey) throw new Error('synthetic provider unavailable');
    return true;
  } });
  context.after(() => dispatcher.close());
  await assert.rejects(dispatcher.reconcileSession('synthetic'), /authorization unavailable/);
  assert.equal(setup.outbox.get('one')?.deliveryState, 'blocked');
  assert.equal(setup.outbox.recoveryJob('synthetic')?.idempotencyKey, 'successor');
  await dispatcher.reconcileSession('synthetic');
  assert.equal(setup.outbox.get('successor')?.deliveryState, 'sent');
  assert.deepEqual(checks, ['one', 'successor']);
  assert.equal(setup.calls.length, 1);
  assert.deepEqual(setup.outbox.recoveryPage('', 16), []);
  assert.equal(setup.outbox.usesExecutionGrant({ runtime: 'openclaw', sessionKey: 'synthetic' }, original.executionGrant!), false);
});

test('completed Gateway missing final has a durable fixed deadline, then settles without sending or renewing', async context => {
  const setup = completedGateway(context);
  assert.equal(setup.outbox.get('one')?.replyDeadlineAt, undefined);
  setup.complete();
  const deadline = setup.outbox.get('one')?.replyDeadlineAt;
  assert.equal(deadline, 490_000);
  assert.deepEqual(setup.outbox.recoveryPage('', 16), ['synthetic']);
  assert.equal(setup.outbox.recoveryJob('synthetic'), undefined);
  context.mock.timers.tick(479_999);
  setup.complete();
  assert.equal(setup.outbox.get('one')?.replyDeadlineAt, deadline);
  await setup.dispatcher.reconcileSession('synthetic');
  assert.equal(setup.outbox.get('one')?.deliveryState, 'pending');
  context.mock.timers.tick(1);
  await assert.rejects(setup.dispatcher.reconcileSession('synthetic'), /persisted deadline/);
  const saved = setup.outbox.get('one'); assert.ok(saved);
  assert.equal(saved.deliveryState, 'blocked');
  assert.equal(saved.replyDeadlineAt, deadline);
  assert.equal(setup.outbox.hasUnresolved('synthetic'), false);
  assert.equal(setup.outbox.usesExecutionGrant({ runtime: 'openclaw', sessionKey: 'synthetic' }, setup.original.executionGrant!), false);
  assert.deepEqual(setup.outbox.recoveryPage('', 16), []);
  setup.reply();
  assert.deepEqual(setup.outbox.get('one'), saved);
  assert.throws(() => setup.outbox.saveJob({ ...saved, deliveryState: 'pending' }), /conflict/);
  assert.deepEqual(setup.calls, []);
});

test('Gateway final arriving before deadline remains sendable after the deadline', async context => {
  const setup = completedGateway(context);
  setup.complete(); context.mock.timers.tick(479_999); setup.reply(); context.mock.timers.tick(20_000);
  await setup.dispatcher.reconcileSession('synthetic');
  assert.equal(setup.outbox.get('one')?.deliveryState, 'sent');
  assert.equal(setup.calls.length, 1);
});

test('delayed Gateway ACK preserves final evidence already stored with original completion', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: 10_000 });
  const setup = fixture(context), original = setup.admit();
  const executions = new OpenClawExecutions(setup.db, undefined, undefined, undefined, undefined, undefined, setup.outbox);
  executions.begin(original.sessionKey, original.idempotencyKey);
  executions.bindGatewayConnection(original.sessionKey, original.idempotencyKey, 'original-socket');
  executions.observe(original.sessionKey, { phase: 'completed', runId: 'original-run', gatewayConnectionId: 'original-socket' });
  executions.observe(original.sessionKey, { phase: 'completed', runId: 'original-run', gatewayConnectionId: 'original-socket',
    replyOnly: true, reply: { text: 'original answer', sequence: 9 } });
  context.mock.timers.tick(500_000);
  executions.acknowledge(original.sessionKey, original.idempotencyKey, 'original-run');
  await setup.dispatcher.reconcileSession('synthetic');
  assert.equal(setup.outbox.get('one')?.deliveryState, 'sent');
  assert.equal(setup.calls.length, 1);
});

test('Gateway late final cannot beat expiry by arriving before the recovery worker', async context => {
  const setup = completedGateway(context);
  setup.complete(); context.mock.timers.tick(480_000); setup.reply();
  assert.equal(setup.outbox.get('one')?.deliveryState, 'blocked');
  assert.equal(setup.outbox.get('one')?.nativeReply?.text, 'original answer');
  await setup.dispatcher.reconcileSession('synthetic');
  assert.deepEqual(setup.calls, []);
});

test('Gateway completion deadline and execution terminal fact roll back together', context => {
  const setup = completedGateway(context), original = setup.executions.get('synthetic');
  setup.db.exec(`CREATE TRIGGER synthetic_deadline_failure BEFORE UPDATE OF job ON connector_mirror_outbox
    WHEN json_extract(new.job, '$.replyDeadlineAt') IS NOT NULL BEGIN SELECT RAISE(ABORT, 'synthetic deadline failure'); END;`);
  assert.throws(() => setup.complete(), /synthetic deadline failure/);
  assert.deepEqual(setup.executions.get('synthetic'), original);
  assert.equal(setup.outbox.get('one')?.replyDeadlineAt, undefined);
  setup.db.exec('DROP TRIGGER synthetic_deadline_failure');
  setup.complete();
  assert.equal(setup.executions.get('synthetic')?.phase, 'completed');
  assert.equal(setup.outbox.get('one')?.replyDeadlineAt, 490_000);
});

test('deadline settlement persistence failure retains demand and retries without sending', async context => {
  const setup = completedGateway(context);
  setup.complete(); context.mock.timers.tick(480_000);
  setup.db.exec(`CREATE TRIGGER synthetic_deadline_failure BEFORE UPDATE OF job ON connector_mirror_outbox
    WHEN json_extract(new.job, '$.deliveryState') = 'blocked' BEGIN SELECT RAISE(ABORT, 'synthetic deadline failure'); END;`);
  await assert.rejects(setup.dispatcher.reconcileSession('synthetic'), /synthetic deadline failure/);
  assert.equal(setup.outbox.get('one')?.deliveryState, 'pending');
  assert.equal(setup.outbox.usesExecutionGrant({ runtime: 'openclaw', sessionKey: 'synthetic' }, setup.original.executionGrant!), true);
  setup.db.exec('DROP TRIGGER synthetic_deadline_failure');
  await assert.rejects(setup.dispatcher.reconcileSession('synthetic'), /persisted deadline/);
  assert.equal(setup.outbox.get('one')?.deliveryState, 'blocked');
  assert.deepEqual(setup.calls, []);
});

test('persisted deadline cannot be extended by ordinary save or injected on admission', context => {
  const setup = completedGateway(context);
  setup.complete();
  const saved = setup.outbox.get('one'); assert.ok(saved?.replyDeadlineAt);
  const deadline = saved.replyDeadlineAt;
  assert.throws(() => setup.outbox.saveJob({ ...saved, replyDeadlineAt: deadline + 1 }), /deadline conflict/);
  assert.throws(() => setup.outbox.saveJob({ ...saved, replyDeadlineAt: undefined } as any), /deadline conflict/);
  assert.throws(() => setup.outbox.upsert({ ...params('injected'), replyDeadlineAt: saved.replyDeadlineAt,
    gatewayRun: saved.gatewayRun } as any), /separate native evidence/);
  assert.equal(setup.outbox.get('injected'), undefined);
});

test('ready successor in the same session is not starved by an earlier future deadline', async context => {
  const setup = completedGateway(context);
  setup.complete(); setup.admit(params('two'), 'successor reply');
  await setup.dispatcher.reconcileSession('synthetic');
  assert.equal(setup.outbox.get('two')?.deliveryState, 'sent');
  assert.equal(setup.outbox.get('one')?.deliveryState, 'pending');
  assert.equal(setup.calls.length, 1);
});

test('deadline survives reopening SQLite and startup never revives incomplete Gateway evidence', context => {
  context.mock.timers.enable({ apis: ['Date'], now: 10_000 });
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-mirror-deadline-')), file = join(directory, 'connector.sqlite');
  const original = params();
  let database = new ConnectorUserStore(file);
  context.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  database.mirrorOutbox.upsert(original);
  database.openClawExecutions.begin('synthetic', 'one');
  database.openClawExecutions.bindGatewayConnection('synthetic', 'one', 'socket');
  database.openClawExecutions.acknowledge('synthetic', 'one', 'run');
  database.openClawExecutions.observe('synthetic', { phase: 'completed', runId: 'run', gatewayConnectionId: 'socket' });
  database.close(); context.mock.timers.tick(1_000); database = new ConnectorUserStore(file);
  assert.equal(database.mirrorOutbox.get('one')?.replyDeadlineAt, 490_000);
  database.openClawExecutions.recoverInterrupted();
  assert.equal(database.mirrorOutbox.get('one')?.gatewayRun?.state, 'blocked');
  assert.equal(database.mirrorOutbox.get('one')?.replyDeadlineAt, 490_000);
});

test('original queue worker wakes and settles an expired final wait without native replay', async context => {
  context.mock.timers.enable({ apis: ['Date'], now: 10_000 });
  const database = new ConnectorUserStore(':memory:'), store = new DeckStore(), original = params();
  const dispatcher = createMirrorDispatcher(database.mirrorOutbox, { store, normalizeError: String, authorizeTarget: () => true,
    sendOutbound: async () => assert.fail('no reply means no external send') });
  const queue = new OpenClawTurnQueue({ turns: database.turns, executions: database.openClawExecutions, mirrorOutbox: database.mirrorOutbox,
    store, authorizeTurn: () => true, refreshSessions: async () => {}, refreshMessages: async () => {},
    send: async () => assert.fail('no native replay'), mirror: async () => assert.fail('no polling delivery'), reconcileMirror: dispatcher.reconcileSession });
  context.after(async () => { await queue.close(); await dispatcher.close(); database.close(); });
  context.mock.method(console, 'warn', () => {});
  database.mirrorOutbox.upsert(original);
  database.openClawExecutions.begin('synthetic', 'one');
  database.openClawExecutions.bindGatewayConnection('synthetic', 'one', 'socket');
  database.openClawExecutions.acknowledge('synthetic', 'one', 'run');
  database.openClawExecutions.observe('synthetic', { phase: 'completed', runId: 'run', gatewayConnectionId: 'socket' });
  queue.start(); await delay(10);
  assert.equal(database.mirrorOutbox.get('one')?.deliveryState, 'pending');
  context.mock.timers.tick(480_000); queue.wake();
  for (let attempt = 0; attempt < 100 && database.mirrorOutbox.get('one')?.deliveryState !== 'blocked'; attempt++) await delay(5);
  assert.equal(database.mirrorOutbox.get('one')?.deliveryState, 'blocked');
});

test('mirror recovery pages are bounded, BINARY ordered, indexed and omit waiting or uncertain work', context => {
  const setup = fixture(context);
  for (let index = 0; index < 80; index++) setup.admit(params(`waiting-${index}`, `waiting-${index}`));
  const keys = Array.from({ length: 70 }, (_, index) => `ready-${index}`).concat(['\uE000', '😀']);
  for (const key of keys) setup.admit(params(key, key), 'reply');
  const sorted = [...keys].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  assert.deepEqual(setup.outbox.recoveryPage('', 1000), sorted.slice(0, 64));
  assert.deepEqual(setup.outbox.recoveryPage(sorted[63]!, 64), sorted.slice(64));
  assert.throws(() => setup.outbox.recoveryPage('', NaN), /page size/);
  assert.throws(() => setup.outbox.recoveryPage('', 0), /page size/);
  const index = setup.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'connector_mirror_recovery_v2'").get() as { sql: string };
  const predicate = index.sql.split(' WHERE ')[1];
  for (const query of [`SELECT DISTINCT session_key FROM connector_mirror_outbox WHERE ${predicate} AND session_key > '' ORDER BY session_key LIMIT 16`,
    `SELECT job FROM connector_mirror_outbox WHERE ${predicate} AND session_key = 'ready-1' ORDER BY id LIMIT 1`]) {
    const plan = setup.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all();
    assert.match(JSON.stringify(plan), /connector_mirror_recovery_v2/);
    assert.doesNotMatch(JSON.stringify(plan), /TEMP B-TREE/);
  }
  context.mock.method(setup.outbox, 'list', () => assert.fail('recovery cannot materialize the whole outbox'));
  context.mock.method(setup.store, 'getMessages', () => assert.fail('recovery cannot select transcript replies'));
  assert.equal(setup.outbox.recoveryJob('waiting-1'), undefined);
  assert.equal(setup.outbox.recoveryJob('ready-1')?.nativeReply?.text, 'reply');
});

test('original worker restarts an ACK-deleted mirror intent without browser or native replay', async context => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-mirror-worker-'));
  const file = join(directory, 'connector.sqlite');
  const seed = new DatabaseSync(file), seedOutbox = new MirrorOutbox(seed), original = params();
  seedOutbox.upsert(original);
  seed.exec('BEGIN IMMEDIATE'); seedOutbox.recordCliReplyInTransaction(seed, original, 'persisted original reply'); seed.exec('COMMIT'); seed.close();
  const database = new ConnectorUserStore(file), store = new DeckStore(), calls: string[] = [];
  const dispatcher = createMirrorDispatcher(database.mirrorOutbox, { store, normalizeError: String, authorizeTarget: () => true,
    sendOutbound: async (_route, text) => { calls.push(text); } });
  const queue = new OpenClawTurnQueue({ turns: database.turns, executions: database.openClawExecutions, mirrorOutbox: database.mirrorOutbox,
    store, authorizeTurn: () => true, refreshSessions: async () => assert.fail('no session refresh needed'),
    refreshMessages: async () => assert.fail('no history refresh needed'), send: async () => assert.fail('no native replay'),
    mirror: async () => assert.fail('no second polling scheduler'), reconcileMirror: dispatcher.reconcileSession });
  context.after(async () => { await queue.close(); await dispatcher.close(); database.close(); rmSync(directory, { recursive: true, force: true }); });
  context.mock.method(database.mirrorOutbox, 'list', () => assert.fail('no full recovery scan'));
  assert.equal(database.turns.list('openclaw').length, 0);
  queue.start();
  const deadline = Date.now() + 2000;
  while (database.mirrorOutbox.get('one')?.deliveryState !== 'sent' && Date.now() < deadline) await delay(5);
  assert.equal(database.mirrorOutbox.get('one')?.deliveryState, 'sent');
  assert.deepEqual(calls, ['Input:\noriginal input\n\nOutput:\npersisted original reply']);
  queue.wake(); await delay(10);
  assert.equal(calls.length, 1);
});

for (const text of ['', 'NO_REPLY', '[tool output]']) test(`mirror recovery durably settles no-output ${JSON.stringify(text)}`, async context => {
  const setup = fixture(context), original = setup.admit(params(), text);
  assert.equal(setup.outbox.usesExecutionGrant({ runtime: 'openclaw', sessionKey: original.sessionKey }, original.executionGrant!), true);
  await assert.rejects(setup.dispatcher.reconcileSession(original.sessionKey), /no forwardable text/);
  const saved = setup.outbox.get('one'); assert.ok(saved);
  assert.equal(saved.deliveryState, 'no_output');
  assert.equal(saved.nativeReply?.text, text);
  assert.deepEqual(setup.outbox.recoveryPage('', 16), []);
  assert.equal(setup.outbox.hasUnresolved(original.sessionKey), false);
  assert.equal(setup.outbox.usesExecutionGrant({ runtime: 'openclaw', sessionKey: original.sessionKey }, original.executionGrant!), false);
  assert.throws(() => setup.outbox.saveJob({ ...saved, deliveryState: 'pending' }), /conflict/);
  await setup.dispatcher.reconcileSession(original.sessionKey);
  assert.deepEqual(setup.calls, []);
});

test('mirror recovery settles original target revocation and does not revive on regrant', async context => {
  const setup = fixture(context), original = setup.admit(params(), 'private reply');
  let allowed = false;
  const dispatcher = createMirrorDispatcher(setup.outbox, { ...setup.deps, authorizeTarget: () => allowed });
  context.after(() => dispatcher.close());
  await assert.rejects(dispatcher.reconcileSession(original.sessionKey), /not authorized/);
  assert.equal(setup.outbox.get('one')?.deliveryState, 'blocked');
  allowed = true;
  await dispatcher.reconcileSession(original.sessionKey);
  await assert.rejects(dispatcher.mirrorAssistantReplyToChannel(original), /not authorized/);
  assert.deepEqual(setup.calls, []);
  assert.equal(setup.outbox.hasUnresolved(original.sessionKey), false);
});

test('mirror grant usage binds every original identity and releases uncertain send without renewal', async context => {
  const setup = fixture(context), original = setup.admit(params(), 'reply');
  const target = { runtime: 'openclaw' as const, sessionKey: original.sessionKey }, grant = original.executionGrant!;
  assert.equal(setup.outbox.usesExecutionGrant(target, grant), true);
  for (const changed of [{ ...grant, id: 'other' }, { ...grant, actorId: 'other' }, { ...grant, issuerTokenId: 'other' }]) {
    assert.equal(setup.outbox.usesExecutionGrant(target, changed), false);
  }
  assert.equal(setup.outbox.usesExecutionGrant({ ...target, runtime: 'codex' }, grant), false);
  assert.equal(setup.outbox.usesExecutionGrant({ ...target, sessionKey: 'other' }, grant), false);
  const dispatcher = createMirrorDispatcher(setup.outbox, { ...setup.deps, sendOutbound: async () => { throw new Error('synthetic lost acknowledgement'); } });
  context.after(() => dispatcher.close());
  await assert.rejects(dispatcher.reconcileSession(original.sessionKey), MirrorDeliveryUnknown);
  assert.equal(setup.outbox.get('one')?.deliveryState, 'outcome_unknown');
  assert.equal(setup.outbox.usesExecutionGrant(target, grant), false);
  assert.equal(setup.outbox.hasUnresolved(original.sessionKey), true);
  assert.deepEqual(setup.outbox.recoveryPage('', 16), []);
});

test('one recovery invocation selects one original job, never waits for absent evidence', async context => {
  const setup = fixture(context);
  setup.admit(params('waiting'));
  setup.admit(params('ready-one'), 'one'); setup.admit(params('ready-two'), 'two');
  await setup.dispatcher.reconcileSession('synthetic');
  assert.equal(setup.calls.length, 1);
  assert.equal(setup.outbox.get('waiting')?.deliveryState, 'pending');
  assert.equal(setup.outbox.get('ready-one')?.deliveryState, 'sent');
  assert.equal(setup.outbox.get('ready-two')?.deliveryState, 'pending');
  await setup.dispatcher.reconcileSession('synthetic');
  await setup.dispatcher.reconcileSession('synthetic');
  assert.equal(setup.calls.length, 2);
});

test('bounded compatibility resume never scans or starts waiting jobs', async context => {
  const setup = fixture(context);
  for (let index = 0; index < 30; index++) setup.admit(params(`job-${index}`, `session-${index}`), 'reply');
  context.mock.method(setup.outbox, 'list', () => assert.fail('no full outbox scan'));
  await setup.dispatcher.resume();
  assert.equal(setup.calls.length, 16);
  assert.equal(setup.outbox.recoveryPage('', 64).length, 14);
});

for (const phase of ['reply-only', 'completed', 'no-reply'] as const) test(`Gateway ${phase} restart recovery sends only separately completed original evidence`, async context => {
  const setup = fixture(context), original = setup.admit();
  const executions = new OpenClawExecutions(setup.db, undefined, undefined, undefined, undefined, undefined, setup.outbox);
  executions.begin(original.sessionKey, original.idempotencyKey);
  executions.bindGatewayConnection(original.sessionKey, original.idempotencyKey, 'original-socket');
  executions.acknowledge(original.sessionKey, original.idempotencyKey, 'original-run');
  if (phase !== 'no-reply') executions.observe(original.sessionKey, { phase: 'completed', runId: 'original-run', gatewayConnectionId: 'original-socket',
    replyOnly: true, reply: { text: 'original answer', sequence: 9 } });
  if (phase !== 'reply-only') executions.observe(original.sessionKey, { phase: 'completed', runId: 'original-run', gatewayConnectionId: 'original-socket' });
  executions.recoverInterrupted();
  if (phase === 'completed') {
    await setup.dispatcher.reconcileSession(original.sessionKey);
    assert.equal(setup.outbox.get('one')?.deliveryState, 'sent');
    assert.equal(setup.calls.length, 1);
  } else {
    await assert.rejects(setup.dispatcher.reconcileSession(original.sessionKey), /not settled/);
    assert.equal(setup.outbox.get('one')?.deliveryState, 'blocked');
    assert.equal(setup.calls.length, 0);
  }
  assert.deepEqual(setup.outbox.recoveryPage('', 16), []);
});

test('original worker limits mirror concurrency to two and shutdown drains only already-started sends', async context => {
  const database = new ConnectorUserStore(':memory:'), store = new DeckStore();
  const releases: Array<() => void> = [];
  let active = 0, maximum = 0, calls = 0;
  for (let index = 0; index < 7; index++) {
    const original = params(`job-${index}`, `session-${index}`);
    database.turns.enqueue('openclaw', { id: original.idempotencyKey, sessionKey: original.sessionKey, createdAt: 1, payload: {} }, db => {
      database.mirrorOutbox.admitInTransaction(db, original);
      database.mirrorOutbox.recordCliReplyInTransaction(db, original, 'reply');
    });
    database.turns.complete('openclaw', original.idempotencyKey);
  }
  const dispatcher = createMirrorDispatcher(database.mirrorOutbox, { store, normalizeError: String, authorizeTarget: () => true,
    sendOutbound: async () => {
      calls++; active++; maximum = Math.max(maximum, active);
      await new Promise<void>(resolve => releases.push(resolve)); active--;
    } });
  const queue = new OpenClawTurnQueue({ turns: database.turns, executions: database.openClawExecutions, mirrorOutbox: database.mirrorOutbox,
    store, authorizeTurn: () => true, refreshSessions: async () => {}, refreshMessages: async () => {},
    send: async () => assert.fail('no Agent dispatch'), mirror: async () => assert.fail('no per-admission polling'),
    reconcileMirror: dispatcher.reconcileSession });
  context.after(async () => { for (const release of releases) release(); await queue.close(); await dispatcher.close(); database.close(); });
  queue.start();
  const deadline = Date.now() + 2000;
  while (calls < 2 && Date.now() < deadline) await delay(5);
  assert.equal(calls, 2); assert.equal(maximum, 2);
  dispatcher.stopAdmissions();
  let closed = false;
  const closing = Promise.all([queue.close(), dispatcher.close()]).then(() => { closed = true; });
  await delay(10); assert.equal(closed, false);
  for (const release of releases) release();
  await closing;
  assert.equal(calls, 2); assert.equal(active, 0);
  assert.equal(database.mirrorOutbox.recoveryPage('', 64).length, 5);
  assert.equal(database.mirrorOutbox.get('job-0')?.deliveryState, 'sent');
  assert.equal(database.mirrorOutbox.get('job-1')?.deliveryState, 'sent');
});

test('terminal settlement storage failure keeps original evidence and capacity accounting intact', async context => {
  const setup = fixture(context), original = setup.admit(params(), '');
  const before = setup.outbox.get('one'), usage = setup.db.prepare('SELECT * FROM connector_mirror_usage').get();
  const save = context.mock.method(setup.outbox, 'saveJob', () => { throw new Error('synthetic settlement storage failure'); });
  await assert.rejects(setup.dispatcher.reconcileSession(original.sessionKey), /storage failure/);
  assert.deepEqual(setup.outbox.get('one'), before);
  assert.deepEqual(setup.db.prepare('SELECT * FROM connector_mirror_usage').get(), usage);
  assert.deepEqual(setup.calls, []);
  save.mock.restore();
  await assert.rejects(setup.dispatcher.reconcileSession(original.sessionKey), /no forwardable text/);
  assert.equal(setup.outbox.get('one')?.deliveryState, 'no_output');
});
