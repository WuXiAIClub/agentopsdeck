import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { TurnQueue, type QueuedTurn } from './turn-queue.js';
import { VolumeAdmission } from '../storage/volume-admission.js';
import { StorageAdmissionDeferred } from '../storage/work-admission.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { recoverableConnection, connectionRecoverySnapshot, StorageConnectionUnavailable } from '../storage/connection-recovery.js';

test('async-only queue rejects sync admission before serialization, authority or receipt effects', async () => {
  const db = new DatabaseSync(':memory:');
  let serialized = 0, authorized = 0, receipts = 0, admissions = 0;
  const queue = new TurnQueue(db, undefined, undefined, () => { authorized++; return true; }, undefined,
    undefined, async (_bytes, write) => { admissions++; return write(); });
  const turn = { id: 'async-only', sessionKey: 's', createdAt: 0,
    payload: { toJSON() { serialized++; return { text: 'original' }; } } };
  try {
    assert.throws(() => queue.enqueue('codex', turn, () => { receipts++; }), /async-admission-required/);
    assert.deepEqual([serialized, authorized, receipts, admissions], [0, 0, 0, 0]);
    assert.equal(queue.maintenanceCount(), 0);
    await queue.enqueueAsync('codex', turn, owner => { assert.equal(owner, db); assert.equal(owner.isTransaction, true); receipts++; });
    assert.equal(serialized, 1); assert.equal(receipts, 1); assert.equal(admissions, 1);
    assert.equal(queue.head('codex', 's')?.id, turn.id);
  } finally { db.close(); }
});

for (const operation of ['enqueue', 'cancel', 'cancel-hook', 'edit', 'edit-payload'] as const)
  test(`queue ${operation} async participant rolls back its original queue and receipt transaction`, async () => {
    const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw), queue = new TurnQueue(db);
    db.exec('CREATE TABLE late_effect(value INTEGER)'); const insert = db.prepare('INSERT INTO late_effect VALUES(1)');
    let release!: () => void, late: Promise<void> | undefined, calls = 0, wakeups = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    const callback = () => { calls++; return late = (async () => { await held; insert.run(); })(); };
    try {
      if (operation !== 'enqueue') queue.enqueue('codex', turn('original'));
      const before = raw.prepare('SELECT * FROM connector_turns').all();
      const usage = raw.prepare('SELECT * FROM connector_turn_usage').all(); queue.onAdmission(() => { wakeups++; });
      assert.throws(() => operation === 'enqueue' ? queue.enqueue('codex', turn('original'), callback)
        : operation.startsWith('cancel') ? queue.cancel('codex', 's', 'original', undefined,
          operation === 'cancel' ? callback : undefined, operation === 'cancel-hook' ? callback : undefined)
          : queue.edit('codex', 's', 'original', operation === 'edit-payload' ? callback as any : () => ({ text: 'new' }),
            undefined, operation === 'edit' ? callback : undefined), /must be synchronous/);
      assert.equal(calls, 1); assert.equal(wakeups, 0); assert.equal(raw.isTransaction, false);
      assert.deepEqual(raw.prepare('SELECT * FROM connector_turns').all(), before);
      assert.deepEqual(raw.prepare('SELECT * FROM connector_turn_usage').all(), usage);
      assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
      const rejected = assert.rejects(late!, StorageConnectionUnavailable); release(); await rejected;
      assert.deepEqual(raw.prepare('SELECT * FROM late_effect').all(), []);
    } finally { release(); if (late) await late.catch(() => {}); db.close(); }
  });

const turn = (id: string, sessionKey = 's'): QueuedTurn<{ text: string }> => ({ id, sessionKey, createdAt: 1, state: 'queued', payload: { text: id } });

test('exact queued-head rejection keeps authority and transition in one transaction and rejects async participants', async () => {
  const raw = new DatabaseSync(':memory:'), db = recoverableConnection(raw), queue = new TurnQueue(db);
  try {
    queue.enqueue('codex', turn('original')); queue.enqueue('codex', turn('successor'));
    const version = queue.version('codex', 's', 'original')!;
    let checks = 0;
    const deny = () => { checks++; assert.equal(db.isTransaction, true); return true; };
    assert.equal(queue.blockQueuedHead('codex', 's', 'successor', queue.version('codex', 's', 'successor')!, deny), false);
    assert.equal(checks, 0);
    assert.equal(queue.blockQueuedHead('codex', 's', 'original', version, () => { assert.equal(db.isTransaction, true); return false; }), false);
    assert.throws(() => queue.blockQueuedHead('codex', 's', 'original', version, () => { throw Error('synthetic authority fault'); }), /synthetic/);
    assert.equal(queue.head('codex', 's')?.state, 'queued');
    assert.equal(queue.blockQueuedHead('codex', 's', 'original', version, deny), true);
    assert.equal(checks, 1); assert.equal(queue.head('codex', 's')?.state, 'blocked');
    assert.equal(queue.blockQueuedHead('codex', 's', 'original', version, deny), false);
    queue.complete('codex', 'original');
    assert.throws(() => queue.blockQueuedHead('codex', 's', 'successor', queue.version('codex', 's', 'successor')!,
      (async () => true) as unknown as () => boolean), /must be synchronous/);
    assert.equal(raw.isTransaction, false);
    assert.equal(raw.prepare("SELECT state FROM connector_turns WHERE id = 'successor'").get()?.state, 'queued');
    assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
  } finally { db.close(); }
});

for (const failure of [Error('private-observer-fault'), undefined]) {
  test(`committed cancellation wakes remaining observers despite ${failure ? 'Error' : 'undefined'} failure`, () => {
    const db = new DatabaseSync(':memory:'), logs: any[] = [];
    const queue = new TurnQueue(db, undefined, undefined, undefined, undefined, undefined, undefined,
      new PerformanceDiagnostics(line => logs.push(JSON.parse(line))));
    let commits = 0, wakeups = 0;
    try {
      queue.enqueue('codex', turn('head')); queue.enqueue('codex', turn('next'));
      queue.onAdmission(() => { throw failure; });
      queue.onAdmission(() => { assert.equal(db.isTransaction, false); wakeups++; });
      let caught = false;
      try { queue.cancel('codex', 's', 'head', undefined, () => { commits++; }); }
      catch (error) { caught = true; assert.equal(error, failure); }
      assert.equal(caught, true); assert.equal(commits, 1); assert.equal(wakeups, 1);
      assert.equal(queue.head('codex', 's')?.id, 'next');
      assert.equal(queue.start('codex', 's', 'next'), true);
      assert.equal(queue.cancel('codex', 's', 'head'), false);
      assert.equal(commits, 1); assert.equal(wakeups, 1);
      const notice = logs.find(row => row.operation === 'turn-queue-notify' && row.category === 'failed');
      assert.equal(notice.unknown, 1); assert.equal(notice.changed, 1);
      assert.doesNotMatch(JSON.stringify(logs), /private-observer|head|codex/);
    } finally { db.close(); }
  });
}

test('failed cancellation receipt rolls back without notifying workers', () => {
  const db = new DatabaseSync(':memory:'), queue = new TurnQueue(db); let wakeups = 0;
  try {
    queue.enqueue('codex', turn('head')); queue.enqueue('codex', turn('next'));
    queue.onAdmission(() => wakeups++);
    assert.throws(() => queue.cancel('codex', 's', 'head', undefined, () => { throw Error('receipt failure'); }), /receipt failure/);
    assert.equal(queue.head('codex', 's')?.id, 'head'); assert.equal(wakeups, 0);
    assert.equal(queue.start('codex', 's', 'next'), false);
  } finally { db.close(); }
});

test('physical-volume pressure rejects new queue work before receipt or notification but allows settlement', () => {
  const db = new DatabaseSync(':memory:'), ledger = new DatabaseSync(':memory:');
  let free = 1024n ** 3n, receipts = 0, notifications = 0;
  const storage = new VolumeAdmission(ledger, tmpdir(), Date.now, () => free);
  const queue = new TurnQueue(db, undefined, undefined, undefined, undefined,
    (bytes, write) => storage.runSync('durable', bytes, write));
  queue.onAdmission(() => notifications++);
  try {
    queue.enqueue('codex', turn('accepted'), () => receipts++);
    free = 0n;
    assert.throws(() => queue.enqueue('codex', turn('rejected'), () => receipts++), StorageAdmissionDeferred);
    assert.equal(receipts, 1); assert.equal(notifications, 1);
    assert.equal(queue.maintenanceCount(), 1);
    assert.equal(queue.start('codex', 's', 'accepted'), true);
    queue.uncertain('codex', 'accepted');
    queue.complete('codex', 'accepted');
    assert.equal(queue.maintenanceCount(), 0);
  } finally { db.close(); ledger.close(); }
});

test('storage admission estimates and persists one payload snapshot and releases after rollback', () => {
  const db = new DatabaseSync(':memory:');
  let serializations = 0, reservations = 0, releases = 0;
  const queue = new TurnQueue(db, undefined, undefined, undefined, undefined, (bytes, write) => {
    assert.ok(bytes > 65536); assert.equal(db.isTransaction, false); reservations++;
    try { write(); } finally { releases++; }
  });
  try {
    const payload = { toJSON: () => ({ actorId: `actor-${++serializations}`, text: '测试' }) };
    queue.enqueue('codex', { ...turn('snapshot'), payload }, (_db, admission) => assert.equal(admission?.actorId, 'actor-1'));
    assert.equal(serializations, 1);
    assert.deepEqual(queue.head('codex', 's')?.payload, { actorId: 'actor-1', text: '测试' });
    assert.throws(() => queue.enqueue('codex', turn('rollback'), () => { throw new Error('receipt rejected'); }), /receipt rejected/);
    assert.equal(reservations, 2); assert.equal(releases, 2); assert.equal(queue.maintenanceCount(), 1);
    assert.throws(() => queue.enqueue('codex', { ...turn('oversized'), payload: 'x'.repeat(1024 * 1024) }), /payload exceeds/);
    assert.equal(reservations, 2);
  } finally { db.close(); }
});

test('maintenance counts every queue state without decoding prompt or attachment bodies', () => {
  const db = new DatabaseSync(':memory:'), queue = new TurnQueue(db);
  try {
    for (const [i, state] of ['queued', 'dispatching', 'blocked', 'outcome_unknown'].entries()) {
      queue.enqueue('codex', turn(String(i)));
      db.prepare('UPDATE connector_turns SET state = ? WHERE id = ?').run(state, String(i));
    }
    queue.enqueue('hermes', turn('other'));
    assert.equal(queue.maintenanceCount('codex'), 4); assert.equal(queue.maintenanceCount('hermes'), 1);
    assert.equal(queue.maintenanceCount(), 5); assert.equal(queue.maintenanceCount('openclaw'), 0);
  } finally { db.close(); }
});

test('batch claim participates in the owning journal transaction and rolls back with it', () => {
  const db = new DatabaseSync(':memory:'), queue = new TurnQueue(db);
  try {
    queue.enqueue('hermes', turn('1')); queue.enqueue('hermes', turn('2'));
    db.exec('BEGIN IMMEDIATE');
    assert.equal(queue.startBatch('hermes', 's', ['1', '2']), true);
    assert.ok(queue.list('hermes').every(row => row.state === 'dispatching'));
    db.exec('ROLLBACK');
    assert.ok(queue.list('hermes').every(row => row.state === 'queued'));
    db.exec(`CREATE TRIGGER fail_nested BEFORE UPDATE ON connector_turns WHEN NEW.id = '2'
      BEGIN SELECT RAISE(ABORT, 'nested failure'); END`);
    db.exec('BEGIN IMMEDIATE');
    assert.throws(() => queue.startBatch('hermes', 's', ['1', '2']), /nested failure/);
    assert.ok(queue.list('hermes').every(row => row.state === 'queued'));
    assert.equal(db.isTransaction, true);
    db.exec('COMMIT');
  } finally { db.close(); }
});

test('batch claim is an atomic FIFO boundary for cancel, edit, later arrivals and other runtimes', () => {
  const db = new DatabaseSync(':memory:'), queue = new TurnQueue(db);
  try {
    for (const id of ['1', '2', '3']) queue.enqueue('codex', turn(id));
    queue.enqueue('openclaw', turn('2'));
    assert.equal(queue.startBatch('codex', 's', ['2', '3']), false);
    assert.equal(queue.startBatch('codex', 's', ['1', 'missing']), false);
    assert.ok(queue.list('codex').every(row => row.state === 'queued'));
    assert.equal(queue.cancel('codex', 's', '1'), true);
    assert.equal(queue.edit<{text:string}>('codex', 's', '3', () => ({text:'edited'})), true);
    assert.equal(queue.startBatch('codex', 's', ['2', '3']), true);
    assert.equal(queue.cancel('codex', 's', '2'), false);
    assert.equal(queue.edit('codex', 's', '3', () => ({text:'too late'})), false);
    queue.enqueue('codex', turn('4'));
    assert.deepEqual(queue.list('codex').map(row => row.state), ['dispatching', 'dispatching', 'queued']);
    assert.equal(queue.head('openclaw', 's')?.state, 'queued');
    assert.equal(queue.startBatch('codex', 's', ['4']), false);
  } finally { db.close(); }
});

test('batch claim rolls back every member when a later update fails', () => {
  const db = new DatabaseSync(':memory:'), queue = new TurnQueue(db);
  try {
    queue.enqueue('codex', turn('1')); queue.enqueue('codex', turn('2'));
    db.exec(`CREATE TRIGGER fail_batch BEFORE UPDATE ON connector_turns WHEN NEW.id = '2'
      BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`);
    assert.throws(() => queue.startBatch('codex', 's', ['1', '2']), /synthetic failure/);
    assert.ok(queue.list('codex').every(row => row.state === 'queued'));
  } finally { db.close(); }
});

test('lease usage uses an index and matches complete actor/issuer/ref/runtime/session provenance', () => {
  const db = new DatabaseSync(':memory:'), queue = new TurnQueue(db);
  const target = { runtime: 'codex' as const, sessionKey: 's' }, grant = { id: 'grant', actorId: 'actor', issuerTokenId: 'issuer' };
  try {
    for (const payload of [{}, { actorId: 'other', executionGrant: grant }, { actorId: grant.actorId, executionGrant: { ...grant, actorId: 'other' } },
      { actorId: grant.actorId, executionGrant: { ...grant, issuerTokenId: 'other' } },
      { actorId: grant.actorId, executionGrant: { ...grant, id: 'other' } }]) {
      queue.enqueue('codex', { id: 'wrong', sessionKey: 's', createdAt: 1, payload });
      assert.equal(queue.usesExecutionGrant(target, grant), false); queue.complete('codex', 'wrong');
    }
    for (const [runtime, sessionKey] of [['openclaw', 's'], ['codex', 'other']]) {
      queue.enqueue(runtime!, { id: 'wrong', sessionKey: sessionKey!, createdAt: 1, payload: { actorId: grant.actorId, executionGrant: grant } });
      assert.equal(queue.usesExecutionGrant(target, grant), false);
    }
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM connector_turns
      WHERE json_extract(payload, '$.executionGrant.id') = ? AND state IN ('queued', 'dispatching')
      AND runtime = ? AND session_key = ? LIMIT 1`).all(grant.id, target.runtime, target.sessionKey);
    assert.match(JSON.stringify(plan), /USING (?:COVERING )?INDEX connector_turn_execution_usage/);
  } finally { db.close(); }
});

test('management pages filter identity/runtime/session in SQL and never return payloads', () => {
  const db = new DatabaseSync(':memory:'), queue = new TurnQueue(db);
  try {
    for (let i = 0; i < 66; i++) queue.enqueue('codex', { ...turn(String(i)), payload: { actorId: 'a', text: 'private', path: '/private' } });
    queue.enqueue('codex', { ...turn('other'), payload: { actorId: 'b' } });
    queue.enqueue('codex', turn('legacy'));
    queue.enqueue('openclaw', { ...turn('wrong-runtime'), payload: { actorId: 'a' } });
    queue.enqueue('codex', { ...turn('wrong-session', 'other'), payload: { actorId: 'a' } });
    const first = queue.summaryPage('codex', 's', 'a');
    assert.equal(first.items.length, 64); assert.ok(first.nextCursor);
    assert.deepEqual(Object.keys(first.items[0]!), ['id', 'state', 'createdAt', 'version']);
    assert.equal(JSON.stringify(first).includes('private'), false);
    const next = queue.summaryPage('codex', 's', 'a', false, Number(first.nextCursor));
    assert.deepEqual(next.items.map((item) => item.id), ['64', '65']); assert.equal(next.nextCursor, null);
    assert.deepEqual(queue.summaryPage('codex', 's', 'b').items.map((item) => item.id), ['other']);
    assert.equal(queue.ownedEntry('codex', 's', '0', 'b'), undefined);
    assert.equal(queue.ownedEntry('codex', 's', 'legacy', 'a'), undefined);
    assert.equal(queue.ownedEntry('codex', 's', 'legacy', 'manager', true)?.state, 'queued');
    assert.equal(queue.summaryPage('codex', 's', 'manager', true, Number(first.nextCursor)).items.length, 4);
    const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT sequence, revision, id, state, created_at FROM connector_turns
      WHERE runtime = ? AND session_key = ? AND sequence > ? AND json_extract(payload, '$.actorId') = ? ORDER BY sequence LIMIT 65`)
      .all('codex', 's', 0, 'a');
    assert.match(JSON.stringify(plan), /SEARCH.*connector_turn_actor_order/);
    assert.doesNotMatch(JSON.stringify(plan), /SCAN|TEMP B-TREE/);
  } finally { db.close(); }
});

test('queue versions reject stale edits/cancels, state round trips and reused IDs without changing usage', () => {
  const db = new DatabaseSync(':memory:'), queue = new TurnQueue(db);
  try {
    const version = () => queue.version('codex', 's', 'a')!;
    const usage = () => ({ ...db.prepare('SELECT rows, bytes FROM connector_turn_usage').get() });
    queue.enqueue('codex', { ...turn('a'), payload: { text: 'original', actorId: 'actor' } });
    const first = version();
    assert.match(first, /^[1-9]\d*:[1-9]\d*$/);
    assert.equal(queue.summaryPage('codex', 's', 'actor').items[0]?.version, first);
    assert.equal((queue.commandState('codex', 's', 'a', 'actor') as any).version, first);
    assert.equal(queue.version('openclaw', 's', 'a'), undefined);
    assert.equal(queue.version('codex', 'other', 'a'), undefined);
    assert.equal(queue.edit('codex', 's', 'a', () => ({ text: 'first edit', actorId: 'actor' }), first), true);
    const second = version(), after = usage();
    assert.notEqual(second, first);
    assert.equal(queue.edit('codex', 's', 'a', () => { throw new Error('stale callback must not execute'); }, first), false);
    assert.equal(queue.cancel('codex', 's', 'a', first), false);
    assert.deepEqual(usage(), after);
    assert.equal(queue.start('codex', 's', 'a'), true);
    const dispatching = version(); queue.defer('codex', 'a');
    assert.notEqual(version(), dispatching);
    assert.equal(queue.cancel('codex', 's', 'a', second), false, 'back to queued is not the old observed state');
    const queued = version(); queue.block('codex', 'a');
    assert.equal(queue.cancel('codex', 's', 'a', queued), false);
    const blocked = version();
    assert.equal(queue.edit('codex', 's', 'a', () => ({}), blocked), false);
    assert.equal(queue.cancel('codex', 's', 'a', blocked), true);
    queue.enqueue('codex', turn('a'));
    assert.notEqual(version(), first);
    assert.equal(queue.cancel('codex', 's', 'a', first), false, 'a reinserted ID cannot satisfy an old precondition');
    assert.equal(queue.cancel('codex', 's', 'a', version()), true);
    assert.deepEqual(usage(), { rows: 0, bytes: 0 });
  } finally { db.close(); }
});

test('queue version migration and restart retain pending data, FIFO identity and stale-write protection', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'agentopsdeck-queue-version-')), 'db.sqlite');
  let db = new DatabaseSync(file);
  db.exec(`CREATE TABLE connector_turns (sequence INTEGER PRIMARY KEY AUTOINCREMENT, runtime TEXT NOT NULL,
    id TEXT NOT NULL, session_key TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL,
    UNIQUE(runtime, id));
    INSERT INTO connector_turns(runtime, id, session_key, created_at, state, payload)
      VALUES ('codex', 'a', 's', 1, 'queued', '{"text":"old"}');`);
  let queue = new TurnQueue(db);
  const original = queue.version('codex', 's', 'a')!;
  queue.start('codex', 's', 'a');
  const started = queue.version('codex', 's', 'a')!;
  db.close(); db = new DatabaseSync(file); queue = new TurnQueue(db);
  try {
    assert.equal(queue.version('codex', 's', 'a'), started);
    queue.recoverInterrupted('codex');
    assert.notEqual(queue.version('codex', 's', 'a'), started);
    assert.deepEqual(queue.head('codex', 's')?.payload, { text: 'old' });
    assert.equal(queue.head('codex', 's')?.state, 'outcome_unknown');
    assert.equal(queue.edit('codex', 's', 'a', () => ({}), original), false);
    assert.equal(queue.cancel('codex', 's', 'a', queue.version('codex', 's', 'a')), false);
    const unknown = queue.version('codex', 's', 'a');
    queue.recoverInterrupted('codex');
    assert.equal(queue.version('codex', 's', 'a'), unknown, 'no transition means no new version');
  } finally { db.close(); }
});

test('queue version stays unchanged when an edit transaction rolls back', () => {
  const db = new DatabaseSync(':memory:'), queue = new TurnQueue(db);
  try {
    queue.enqueue('codex', turn('a'));
    const version = queue.version('codex', 's', 'a');
    assert.throws(() => queue.edit('codex', 's', 'a', () => ({ text: 'x'.repeat(1024 * 1024) }), version), /capacity/);
    assert.equal(queue.version('codex', 's', 'a'), version);
    assert.throws(() => queue.edit('codex', 's', 'a', () => { throw new Error('synthetic update failure'); }, version), /synthetic/);
    assert.equal(queue.version('codex', 's', 'a'), version);
    assert.equal(queue.edit('codex', 's', 'a', () => ({ text: 'valid' }), version), true);
  } finally { db.close(); }
});

test('authorization-blocked heads survive reopen, stop scheduling and require explicit scoped cancellation', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'agentopsdeck-blocked-turn-')), 'queue.sqlite');
  let db = new DatabaseSync(file), queue = new TurnQueue(db);
  queue.enqueue('test', turn('denied')); queue.enqueue('test', turn('tail')); queue.enqueue('test', turn('other', 'other'));
  assert.equal(queue.block('test', 'denied'), true);
  db.close(); db = new DatabaseSync(file); queue = new TurnQueue(db);
  let wakes = 0; queue.onAdmission(() => { wakes++; });
  try {
    assert.equal(queue.head('test', 's')?.state, 'blocked');
    assert.deepEqual(queue.sessionPage('test'), ['other']);
    assert.equal(queue.start('test', 's', 'tail'), false);
    assert.equal(queue.edit('test', 's', 'denied', () => ({ text: 'cannot reauthorize by edit' })), false);
    assert.equal(queue.cancel('test', 'wrong', 'denied'), false);
    assert.equal(queue.cancel('test', 's', 'denied'), true);
    assert.equal(wakes, 1);
    assert.deepEqual(queue.sessionPage('test'), ['other', 's']);
    queue.start('test', 's', 'tail'); queue.uncertain('test', 'tail');
    assert.equal(queue.block('test', 'tail'), false, 'unknown is not proof of no execution');
    assert.equal(queue.cancel('test', 's', 'tail'), false);
  } finally { db.close(); }
});

test('edits account for UTF-8 capacity atomically and cancel is session/state scoped', () => {
  const db = new DatabaseSync(':memory:'), queue = new TurnQueue(db, 10, 2048);
  const usage = () => db.prepare('SELECT rows, bytes FROM connector_turn_usage').get();
  try {
    queue.enqueue('openclaw', turn('a')); queue.enqueue('openclaw', turn('b'));
    const before = usage();
    assert.equal(queue.edit('openclaw', 'wrong', 'a', () => ({})), false);
    assert.equal(queue.cancel('codex', 's', 'a'), false);
    assert.equal(queue.cancel('openclaw', 'wrong', 'a'), false);
    assert.throws(() => queue.edit('openclaw', 's', 'a', () => ({ text: '中'.repeat(500) })), /capacity/);
    assert.deepEqual(usage(), before);
    assert.equal(queue.edit('openclaw', 's', 'a', () => ({ text: '中'.repeat(100) })), true);
    assert.equal(Number(usage()!.bytes) - Number(before!.bytes), 299);
    assert.deepEqual(queue.list('openclaw').map(({ id }) => id), ['a', 'b']);
    queue.start('openclaw', 's', 'a');
    assert.equal(queue.cancel('openclaw', 's', 'a'), false);
    assert.equal(queue.edit('openclaw', 's', 'a', () => ({})), false);
    queue.uncertain('openclaw', 'a');
    assert.equal(queue.cancel('openclaw', 's', 'a'), false);
    assert.equal(queue.cancel('openclaw', 's', 'b'), true);
    queue.complete('openclaw', 'a');
    assert.deepEqual({ ...usage() }, { rows: 0, bytes: 0 });
  } finally { db.close(); }
});

test('editing cannot bypass the single-payload admission bound', () => {
  const db = new DatabaseSync(':memory:'), queue = new TurnQueue(db);
  try {
    queue.enqueue('openclaw', turn('a'));
    assert.throws(() => queue.edit('openclaw', 's', 'a', () => ({ text: 'x'.repeat(1024 * 1024) })), /capacity/);
    assert.deepEqual(queue.head('openclaw', 's')?.payload, { text: 'a' });
  } finally { db.close(); }
});

test('single FIFO claim retains identities and a crashed dispatch blocks only its session', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'agentopsdeck-turns-')), 'db.sqlite');
  let db = new DatabaseSync(file), queue = new TurnQueue(db);
  queue.enqueue('codex', turn('a')); queue.enqueue('codex', turn('b')); queue.enqueue('codex', turn('c', 'other'));
  assert.equal(queue.start('codex', 's', 'b'), false);
  assert.equal(queue.start('codex', 's', 'a'), true);
  assert.equal(queue.start('codex', 's', 'a'), false);
  db.close(); db = new DatabaseSync(file); queue = new TurnQueue(db); queue.recoverInterrupted('codex');
  try {
    assert.deepEqual(queue.list('codex', 's').map(({ id, state }) => [id, state]), [['a', 'outcome_unknown'], ['b', 'queued']]);
    assert.equal(queue.start('codex', 's', 'b'), false);
    assert.equal(queue.start('codex', 'other', 'c'), true);
    queue.defer('codex', 'c'); assert.equal(queue.start('codex', 'other', 'c'), true);
    queue.complete('codex', 'a'); assert.equal(queue.start('codex', 's', 'b'), true);
    queue.complete('codex', 'b'); queue.complete('codex', 'c');
    assert.deepEqual(queue.sessions('codex'), []);
  } finally { db.close(); }
});

test('runtime namespaces cannot claim each other and capacity has no eviction', () => {
  const db = new DatabaseSync(':memory:');
  const queue = new TurnQueue(db, 2, 2048);
  try {
    queue.enqueue('codex', turn('same')); queue.enqueue('openclaw', turn('same'));
    assert.throws(() => queue.enqueue('codex', turn('full')), /capacity/);
    assert.equal(queue.start('other', 's', 'same'), false);
    queue.complete('codex', 'same'); assert.equal(queue.list('openclaw').length, 1);
    assert.throws(() => queue.enqueue('codex', { ...turn('large'), payload: { text: 'x'.repeat(2048) } }), /capacity/);
    queue.enqueue('codex', turn('new'));
    assert.equal(queue.list('codex').length, 1);
  } finally { db.close(); }
});

test('legacy migration commits once, preserves source and rolls back all malformed imports', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'agentopsdeck-turn-import-')), 'legacy.json');
  const db = new DatabaseSync(':memory:'), queue = new TurnQueue(db);
  const decode = (sessionKey: string, entry: unknown) => {
    if (typeof entry !== 'string') throw new Error('invalid entry');
    return turn(entry, sessionKey);
  };
  try {
    writeFileSync(file, '{broken');
    assert.throws(() => queue.importLegacy('codex', file, decode), /valid JSON/);
    writeFileSync(file, JSON.stringify({ queues: { s: ['first', 2] } }));
    assert.throws(() => queue.importLegacy('codex', file, decode), /invalid entry/);
    assert.equal(queue.list('codex').length, 0);
    writeFileSync(file, JSON.stringify({ queues: { s: ['same', 'same'] } }));
    assert.throws(() => queue.importLegacy('codex', file, decode), /UNIQUE/);
    assert.equal(queue.list('codex').length, 0, 'failed insert transaction cannot partially import');
    writeFileSync(file, JSON.stringify({ queues: { s: ['one', 'two'] } }));
    const source = readFileSync(file, 'utf8');
    queue.importLegacy('codex', file, decode);
    assert.equal(readFileSync(file, 'utf8'), source);
    queue.complete('codex', 'one');
    queue.importLegacy('codex', file, decode);
    assert.deepEqual(queue.list('codex').map(({ id }) => id), ['two']);
  } finally { db.close(); }
});
