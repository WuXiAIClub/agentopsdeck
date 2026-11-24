import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { TurnQueue, type AsyncTurnStorageAdmission } from './turn-queue.js';
import { CommandReceipts } from './receipts.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { StorageAdmissionDeferred } from '../storage/work-admission.js';

const gate = () => {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
};
const turn = () => ({ id: 'original', sessionKey: 's', createdAt: 1, payload: { actorId: 'actor', text: 'private-content' } });
function fixture(t: test.TestContext, admission: AsyncTurnStorageAdmission, available = () => true) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const logs: any[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(JSON.parse(line)));
  const receipts = new CommandReceipts(db);
  const scope = JSON.stringify(['actor', 's']);
  receipts.claim(scope, 'key', {});
  const queue = new TurnQueue(db, undefined, undefined, available, undefined,
    () => assert.fail('synchronous space admission must not run'), admission, diagnostics);
  let notifications = 0; queue.onAdmission(() => notifications++);
  const commit = receipts.queueCommit(scope, 'key', { status: 200, body: { idempotencyKey: 'original' } });
  return { db, queue, logs, commit, receipt: () => receipts.get(scope, 'key')!, notifications: () => notifications };
}

test('async queue waits without a transaction and commits original receipt/usage on one owner', async t => {
  const wait = gate(); let bytes = 0;
  const f = fixture(t, async (estimate, write) => { bytes = estimate; await wait.promise; await write(); });
  const pending = f.queue.enqueueAsync('codex', turn(), (db, admission) => {
    assert.equal(db, f.db); assert.equal(db.isTransaction, true); f.commit(db, admission);
  });
  assert.equal(f.db.isTransaction, false); assert.equal(f.queue.maintenanceCount(), 0);
  assert.equal(f.receipt().state, 'outcome_unknown'); assert.equal(f.notifications(), 0);
  await new Promise<void>(resolve => setImmediate(resolve));
  wait.release(); await pending;
  assert.ok(bytes > 65536); assert.equal(f.receipt().state, 'accepted');
  assert.equal(f.notifications(), 1); assert.equal(f.db.isTransaction, false);
  assert.equal(f.queue.head<{ text: string }>('codex', 's')?.payload.text, 'private-content');
});

for (const phase of ['before', 'waiting', 'after-commit']) test(`queue authority is checked ${phase}, without uncertain replay`, async t => {
  let valid = phase !== 'before', admissions = 0; const wait = gate();
  const f = fixture(t, async (_bytes, write) => {
    admissions++; await wait.promise; await write();
    if (phase === 'after-commit') valid = false;
  });
  const pending = f.queue.enqueueAsync('codex', turn(), f.commit, () => { if (!valid) throw Error('revoked'); });
  if (phase === 'waiting') valid = false;
  wait.release(); await assert.rejects(pending, /revoked/);
  const committed = phase === 'after-commit';
  assert.equal(f.queue.maintenanceCount(), Number(committed));
  assert.equal(f.notifications(), Number(committed));
  assert.equal(f.receipt().state, committed ? 'accepted' : 'outcome_unknown');
  assert.equal(admissions, phase === 'before' ? 0 : 1); assert.equal(f.db.isTransaction, false);
  if (committed) assert.equal(f.logs.at(-1).unknown, 1);
});

test('lost release reply retains the accepted original and wakes its worker once', async t => {
  let admissions = 0; const original = Error('private-release-error');
  const f = fixture(t, async (_bytes, write) => { admissions++; await write(); throw original; });
  await assert.rejects(f.queue.enqueueAsync('codex', turn(), f.commit), error => error === original);
  assert.equal(f.receipt().state, 'accepted'); assert.equal(f.queue.maintenanceCount(), 1);
  assert.equal(f.notifications(), 1); assert.equal(admissions, 1);
  const log = f.logs.at(-1); assert.equal(log.operation, 'turn-queue-admission');
  assert.equal(log.category, 'failed'); assert.equal(log.unknown, 1); assert.equal(log.changed, 1);
  assert.ok(log.queueMs >= 0); assert.ok(log.bodyMs >= 0); assert.ok(log.releaseMs >= 0);
  assert.doesNotMatch(JSON.stringify(f.logs), /private|original|actor|INSERT|SELECT/);
});

test('a failing admission observer cannot strand later workers or hide its failed trace', async t => {
  const f = fixture(t, async (_bytes, write) => write());
  let wakeups = 0;
  f.queue.onAdmission(() => { throw Error('private-observer-failure'); });
  f.queue.onAdmission(() => { wakeups++; });
  await f.queue.enqueueAsync('codex', turn(), f.commit);
  assert.equal(wakeups, 1); assert.equal(f.receipt().state, 'accepted');
  assert.equal(f.queue.maintenanceCount(), 1);
  assert.equal(f.logs.at(-1).category, 'failed'); assert.equal(f.logs.at(-1).unknown, 1);
  assert.doesNotMatch(JSON.stringify(f.logs), /private-observer/);
});

test('receipt rejection rolls back queue and scalar usage before any notification', async t => {
  const f = fixture(t, async (_bytes, write) => write());
  const usage = () => ({ ...f.db.prepare('SELECT * FROM connector_turn_usage').get() });
  const before = usage();
  await assert.rejects(f.queue.enqueueAsync('codex', turn(), (db, admission) => {
    f.commit(db, admission); throw Error('receipt failed');
  }), /receipt failed/);
  assert.deepEqual(usage(), before); assert.equal(f.receipt().state, 'outcome_unknown');
  assert.equal(f.queue.maintenanceCount(), 0); assert.equal(f.notifications(), 0);
});

test('capacity and deletion are rechecked after asynchronous waiting', async t => {
  let available = true; const wait = gate();
  const f = fixture(t, async (_bytes, write) => { await wait.promise; await write(); }, () => available);
  const pending = f.queue.enqueueAsync('codex', turn(), f.commit);
  available = false; wait.release(); await assert.rejects(pending, /deletion/i);
  assert.equal(f.queue.maintenanceCount(), 0); assert.equal(f.notifications(), 0);
});

test('unavailable admission logs deferred, does not write, and cannot manufacture success without writer', async t => {
  const f = fixture(t, async () => { throw new StorageAdmissionDeferred('private-denial'); });
  await assert.rejects(f.queue.enqueueAsync('codex', turn(), f.commit), StorageAdmissionDeferred);
  assert.equal(f.logs.at(-1).deferred, 1); assert.equal(f.notifications(), 0);
  const absent = fixture(t, async () => {});
  await assert.rejects(absent.queue.enqueueAsync('codex', turn(), absent.commit), /not committed/);
  assert.equal(absent.queue.maintenanceCount(), 0);
});

test('async queue snapshots payload once and rejects repeated writer callbacks without replay', async t => {
  let reads = 0; const f = fixture(t, async (_bytes, write) => { await write(); await write(); });
  await assert.rejects(f.queue.enqueueAsync('codex', { ...turn(), payload: {
    toJSON: () => ({ actorId: 'actor', text: String(++reads) }),
  } }, f.commit), /already attempted/);
  assert.equal(reads, 1); assert.equal(f.queue.maintenanceCount(), 1);
  assert.equal(f.notifications(), 1); assert.equal(f.receipt().state, 'accepted');
});

test('async queue rejects an enclosing owner transaction before admission', async t => {
  const f = fixture(t, async () => assert.fail('must not admit'));
  f.db.exec('BEGIN IMMEDIATE');
  await assert.rejects(f.queue.enqueueAsync('codex', turn(), f.commit), /owning database/);
  assert.equal(f.db.isTransaction, true); f.db.exec('ROLLBACK');
});
