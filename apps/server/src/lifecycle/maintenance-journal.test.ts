import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { advanceMaintenance, newMaintenanceJob, recoverInterruptedMaintenance, validMaintenanceJob, type MaintenanceAdapter } from './connector-maintenance.js';
import { MaintenanceConflict, SqliteMaintenanceJournal } from './maintenance-journal.js';
import { MaintenanceObservationUnavailable } from './maintenance-observation-error.js';
import { cancelUnstartedPreparation, type UnstartedPreparationProof, type SupersededPreFenceProof } from './maintenance-reconciliation.js';
import { recoverableConnection, connectionRecoverySnapshot, StorageConnectionUnavailable } from '../storage/connection-recovery.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { MaintenanceReconciliationPolicy } from './maintenance-journal.js';

const create = (id = 'request:1', nodeId = 'node:1') => newMaintenanceJob({ id, nodeId, actorId: 'owner:1', operation: 'upgrade', createdAt: 1000, deadline: 60_000 });

for (const phase of ['now-before', 'authorize', 'now-after'] as const) for (const check of [1, 2]) {
  test(`maintenance ${phase} check ${check} cannot escape cancellation owner or mutate receipts later`, async t => {
    const f = fixture(t), initial = create(); f.journal.enqueue(initial);
    const failed = (await advanceMaintenance(initial, f.journal, { authorize: async () => true,
      prepare: async () => { throw new Error('not started'); } } as unknown as MaintenanceAdapter, () => 2000))!;
    const proof: UnstartedPreparationProof = { nodeId: initial.nodeId, observedAt: 3000,
      workerStopped: true, serviceRunning: true, serviceStartedAt: 500, serviceInvocationId: 'a'.repeat(32),
      originalRelease: { revision: 'b'.repeat(40), manifestSha256: 'c'.repeat(64) }, originalReleaseVerified: true,
      preparationDirectoryAbsent: true, admissionReleased: true, failedInvocationFenceAbsent: true };
    const db = recoverableConnection(f.db), reader = f.open();
    db.exec('CREATE TABLE authority_effects(value INTEGER)'); const statement = db.prepare('INSERT INTO authority_effects VALUES(?)');
    let release!: () => void, late!: Promise<number | boolean>, clockCalls = 0, authorityCalls = 0, escaped = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    const escape = (value: number | boolean) => {
      escaped++; statement.run(1);
      return late = (async () => { await held; statement.run(2); return value; })();
    };
    const policy = {
      now: () => {
        clockCalls++;
        const target = phase === 'now-before' ? 2 * check - 1 : phase === 'now-after' ? 2 * check : -1;
        return clockCalls === target ? escape(3000) : 3000;
      },
      authorize: () => ++authorityCalls === check && phase === 'authorize' ? escape(false) : true,
    } as unknown as MaintenanceReconciliationPolicy;
    const lines: string[] = [], journal = new SqliteMaintenanceJournal(db, new PerformanceDiagnostics(line => lines.push(line)), policy);
    try {
      assert.throws(() => journal.cancelUnstartedPreparation(failed, proof, 3000), /must be synchronous/);
      assert.equal(escaped, 1); assert.equal(f.db.isTransaction, false);
      assert.deepEqual(reader.journal.get(initial.id), failed);
      assert.equal(reader.db.prepare('SELECT count(*) n FROM connector_maintenance_reconciliations').get()!.n, 0);
      assert.equal(reader.db.prepare('SELECT count(*) n FROM connector_maintenance_reconciliation_evidence').get()!.n, 0);
      assert.deepEqual(reader.db.prepare('SELECT * FROM authority_effects').all(), []);
      assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
      const event = lines.map(line => JSON.parse(line)).find(event => event.unknown === 1);
      assert.ok(event); assert.equal(event.operation, 'maintenance-journal-change'); assert.equal(event.step, 2);
      assert.ok(lines.every(line => !line.includes('authority_effects') && !line.includes(initial.id)));
      const rejected = assert.rejects(late, StorageConnectionUnavailable); release(); await rejected;
      assert.deepEqual(reader.journal.get(initial.id), failed);
      assert.deepEqual(reader.db.prepare('SELECT * FROM authority_effects').all(), []); assert.equal(escaped, 1);
    } finally { release(); if (late) await late.catch(() => {}); db.close(); }
  });
}
test('unstarted prepare cancellation is exact, atomic, durable, authorized and never replayed', async t => {
  const f = fixture(t), initial = create(); f.journal.enqueue(initial);
  const failed = (await advanceMaintenance(initial, f.journal, { authorize: async () => true,
    prepare: async () => { throw new Error('not started'); } } as unknown as MaintenanceAdapter, () => 2000))!;
  assert.equal(failed.failedStage, 'prepare'); assert.equal(failed.revision, 2);
  const proof: UnstartedPreparationProof = { nodeId: initial.nodeId, observedAt: 3000,
    workerStopped: true, serviceRunning: true, serviceStartedAt: 500, serviceInvocationId: 'a'.repeat(32),
    originalRelease: { revision: 'b'.repeat(40), manifestSha256: 'c'.repeat(64) }, originalReleaseVerified: true,
    preparationDirectoryAbsent: true, admissionReleased: true, failedInvocationFenceAbsent: true };
  const deps = { journal: f.journal, authorize: async () => true, inspect: async () => proof, now: () => 3000 };
  for (const patch of [{ stage: 'drain' }, { failedStage: 'drain' }, { failedStage: undefined }, { executing: true },
    { revision: 4 }, { reason: 'interrupted' }, { operation: 'recover' }, { release: proof.originalRelease },
    { fenceId: 'fence:1' }, { backupId: 'backup:1' }]) {
    await assert.rejects(cancelUnstartedPreparation({ ...failed, ...patch } as typeof failed, deps));
  }
  for (const patch of [{ workerStopped: false }, { serviceStartedAt: 1001 }, { serviceInvocationId: '' },
    { preparationDirectoryAbsent: false }, { admissionReleased: false }, { failedInvocationFenceAbsent: false },
    { originalReleaseVerified: false }, { nodeId: 'other' }, { observedAt: 3001 }, { observedAt: -3000 }]) {
    await assert.rejects(cancelUnstartedPreparation(failed, { ...deps,
      inspect: async () => ({ ...proof, ...patch }) as UnstartedPreparationProof }));
  }
  let checks = 0;
  await assert.rejects(cancelUnstartedPreparation(failed, { ...deps, authorize: async () => ++checks < 2 }));
  let clock = 0;
  await assert.rejects(cancelUnstartedPreparation(failed, { ...deps, now: () => ++clock === 1 ? 3000 : 8001 }));
  assert.deepEqual(f.journal.get(initial.id), failed);
  const result = await cancelUnstartedPreparation(failed, deps);
  assert.equal(result?.stage, 'cancelled'); assert.equal(result?.revision, 3);
  assert.equal(await cancelUnstartedPreparation(failed, deps), undefined);
  const reopened = f.open(); assert.deepEqual(reopened.journal.get(initial.id), result);
  const row = reopened.db.prepare('SELECT previous_record, next_record FROM connector_maintenance_reconciliations WHERE job_id = ?').get(initial.id)!;
  assert.deepEqual(JSON.parse(row.previous_record as string), failed);
  assert.deepEqual(JSON.parse(row.next_record as string), result);
  const evidence = reopened.db.prepare('SELECT * FROM connector_maintenance_reconciliation_evidence WHERE job_id = ?').get(initial.id);
  assert.ok(evidence);
  assert.ok(f.journal.enqueue(create('new-request')));
});
test('archive authorization is immutable, durably retained and single-use across job identities', async t => {
  const f = fixture(t);
  const candidate = { revision: 'a'.repeat(40), manifestSha256: 'b'.repeat(64) };
  const job = { ...create(), archiveBootstrap: { authorizationId: 'one-window', serviceInvocationId: 'c'.repeat(32),
    previous: { revision: 'd'.repeat(40), manifestSha256: 'e'.repeat(64) }, candidate,
    sessions: ['codex:01a0adde-49f0-7382-8068-c87f9b68d3fa'] } };
  f.journal.enqueue(job);
  assert.deepEqual(f.open().journal.get(job.id), job);
  const { archiveBootstrap: omittedGrant, ...withoutGrant } = job;
  assert.ok(omittedGrant);
  await assert.rejects(f.journal.compareAndSwap(job, { ...withoutGrant, revision: 1, executing: true }));
  await assert.rejects(f.journal.compareAndSwap(job, { ...job, revision: 1, executing: true,
    archiveBootstrap: { ...job.archiveBootstrap, authorizationId: 'another' } }));
  const draining = (await advanceMaintenance(job, f.journal, { authorize: async () => true,
    prepare: async () => candidate } as unknown as MaintenanceAdapter, () => 2000))!;
  assert.ok(f.journal.cancelObservation(draining, 2100));
  assert.throws(() => f.journal.enqueue({ ...job, id: 'new-id' }), MaintenanceConflict);
  assert.equal(f.journal.get(job.id)?.stage, 'cancelled');
});
function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-maintenance-journal-'));
  const file = join(directory, 'journal.sqlite');
  const handles: DatabaseSync[] = [];
  const open = () => {
    const db = new DatabaseSync(file); handles.push(db);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    return { db, journal: new SqliteMaintenanceJournal(db) };
  };
  t.after(() => { for (const db of handles) { try { db.close(); } catch {} } rmSync(directory, { recursive: true, force: true }); });
  return { ...open(), open };
}

for (const replaced of [false, true]) test(`superseded cancellation archives failure and OS proof atomically, survives reopen and never replays (replacement=${replaced})`, async t => {
  const f = fixture(t), job = create(); f.journal.enqueue(job);
  const draining = (await advanceMaintenance(job, f.journal, { authorize: async () => true,
    prepare: async () => ({ revision: 'a'.repeat(40), manifestSha256: 'b'.repeat(64) }),
  } as unknown as MaintenanceAdapter, () => 2000))!;
  const failed = (await advanceMaintenance(draining, f.journal, { authorize: async () => true,
    inspect: async () => { throw new Error('fixture observation failure'); },
  } as unknown as MaintenanceAdapter, () => 3000))!;
  assert.equal(failed.stage, 'attention'); assert.equal(failed.failedStage, 'drain');
  const proof: SupersededPreFenceProof = { nodeId: job.nodeId, observedAt: 100_000, workerStopped: true,
    serviceStartedAt: 5000, serviceInvocationId: 'c'.repeat(32), serviceRunning: true,
    previousReleaseVerified: true, currentRelease: failed.release!, candidate: failed.release!,
    admissionReleased: true, failedInvocationFenceAbsent: true };
  if (replaced) {
    proof.currentRelease = { revision: 'd'.repeat(40), manifestSha256: 'e'.repeat(64) };
    proof.replacementAcceptance = { release: proof.currentRelease, deploymentSha256: 'f'.repeat(64), acceptanceSha256: 'a'.repeat(64) };
  }
  f.db.exec(`CREATE TRIGGER deny_superseded_proof BEFORE INSERT ON connector_maintenance_reconciliation_evidence
    BEGIN SELECT RAISE(ABORT, 'synthetic proof failure'); END`);
  assert.throws(() => f.journal.cancelSupersededObservation(failed, proof, 100_000), /synthetic proof failure/);
  assert.deepEqual(f.journal.get(job.id), failed);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM connector_maintenance_reconciliations').get()!.n, 0);
  f.db.exec('DROP TRIGGER deny_superseded_proof');
  const cancelled = f.journal.cancelSupersededObservation(failed, proof, 100_000)!;
  assert.equal(cancelled.stage, 'cancelled'); assert.equal(cancelled.failedStage, undefined); assert.equal(cancelled.reason, undefined);
  const reopened = f.open().journal;
  assert.deepEqual(reopened.get(job.id), cancelled);
  assert.equal(reopened.cancelSupersededObservation(failed, proof, 100_000), undefined);
  assert.deepEqual(reopened.enqueue(job), cancelled);
  const audit = f.db.prepare('SELECT previous_record FROM connector_maintenance_reconciliations').get()!;
  assert.deepEqual(JSON.parse(audit.previous_record as string), failed);
  const savedProof = f.db.prepare('SELECT evidence FROM connector_maintenance_reconciliation_evidence').get()!;
  assert.equal(JSON.parse(savedProof.evidence as string).serviceInvocationId, proof.serviceInvocationId);
  if (replaced) assert.equal(JSON.parse(savedProof.evidence as string).replacementAcceptance.deploymentSha256, 'f'.repeat(64));
  assert.equal(reopened.unresolved(job.nodeId), undefined);
  assert.deepEqual(await advanceMaintenance(cancelled, reopened, {} as MaintenanceAdapter), cancelled);
});

test('pre-fence cancellation durably preserves both receipts and permits only a new request', async t => {
  const f = fixture(t), job = create();
  f.journal.enqueue(job);
  const adapter = { authorize: async () => true,
    prepare: async () => ({ revision: 'a'.repeat(40), manifestSha256: 'b'.repeat(64) }),
  } as unknown as MaintenanceAdapter;
  const draining = (await advanceMaintenance(job, f.journal, adapter, () => 2000))!;
  const cancelled = f.journal.cancelObservation(draining, 100_000)!;
  assert.equal(cancelled.stage, 'cancelled'); assert.deepEqual(cancelled.release, draining.release);
  assert.equal(f.journal.active(job.nodeId), undefined); assert.equal(f.journal.unresolved(job.nodeId), undefined);
  const reopened = f.open().journal;
  assert.deepEqual(reopened.get(job.id), cancelled);
  assert.equal(reopened.cancelObservation(draining, 100_000), undefined, 'stale cancellation is query-only');
  assert.deepEqual(reopened.enqueue(job), cancelled, 'original identity can never redeploy');
  const row = f.db.prepare('SELECT previous_record, next_record FROM connector_maintenance_reconciliations').get() as { previous_record: string; next_record: string };
  assert.deepEqual(JSON.parse(row.previous_record), draining); assert.deepEqual(JSON.parse(row.next_record), cancelled);
  const second = create('request:2'); reopened.enqueue(second);
  assert.equal(reopened.active(job.nodeId)?.id, second.id);
  assert.throws(() => reopened.enqueue(create('request:3')), MaintenanceConflict);
  assert.deepEqual(await advanceMaintenance(cancelled, reopened, {} as MaintenanceAdapter), cancelled, 'terminal receipt has no effects');
  await assert.rejects(reopened.compareAndSwap(cancelled, { ...cancelled, stage: 'drain', revision: cancelled.revision + 1 }));
});

test('cancellation refuses executing intent, cannot bypass ordinary CAS and rolls back if audit persistence fails', async t => {
  const f = fixture(t), job = create(); f.journal.enqueue(job);
  const draining = (await advanceMaintenance(job, f.journal, { authorize: async () => true,
    prepare: async () => ({ revision: 'a'.repeat(40), manifestSha256: 'b'.repeat(64) }),
  } as unknown as MaintenanceAdapter, () => 2000))!;
  await assert.rejects(f.journal.compareAndSwap(draining, { ...draining, revision: draining.revision + 1, stage: 'cancelled' }));
  assert.throws(() => f.journal.cancelObservation({ ...draining, executing: true }, 2000));
  assert.throws(() => f.journal.cancelObservation(draining, 999));
  for (const patch of [{ fenceId: 'fence' }, { backupId: 'backup' }, { executing: true }, { operation: 'recover' as const },
    { reason: 'deadline' as const }, { failedStage: 'drain' as const }]) {
    assert.equal(validMaintenanceJob({ ...draining, stage: 'cancelled', ...patch }), false);
  }
  f.db.exec(`CREATE TRIGGER deny_cancel_audit BEFORE INSERT ON connector_maintenance_reconciliations
    BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END`);
  assert.throws(() => f.journal.cancelObservation(draining, 2000), /synthetic audit failure/);
  assert.deepEqual(f.journal.get(job.id), draining);
});

test('legacy active-node index upgrades atomically without losing old receipts', async t => {
  const f = fixture(t), job = create(); f.journal.enqueue(job);
  f.db.exec(`DROP INDEX connector_maintenance_one_active_node;
    CREATE UNIQUE INDEX connector_maintenance_one_active_node ON connector_maintenance_jobs(node_id)
    WHERE stage NOT IN ('succeeded', 'attention')`);
  const reopened = f.open();
  assert.deepEqual(reopened.journal.get(job.id), job);
  const row = reopened.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'connector_maintenance_one_active_node'").get() as { sql: string };
  assert.match(row.sql, /'cancelled'/);
  assert.throws(() => reopened.journal.enqueue(create('another')), MaintenanceConflict);
});

test('observation retry and its backoff survive a real journal reopen', async t => {
  const f = fixture(t), job = create();
  f.journal.enqueue(job);
  const adapter = { authorize: async () => true,
    prepare: async () => ({ revision: 'a'.repeat(40), manifestSha256: 'b'.repeat(64) }),
    inspect: async () => { throw new MaintenanceObservationUnavailable('observation_unavailable'); },
  } as unknown as MaintenanceAdapter;
  await advanceMaintenance(job, f.journal, adapter, () => 2000);
  const result = await advanceMaintenance(f.journal.get(job.id)!, f.journal, adapter, () => 2000);
  const reopened = f.open().journal;
  assert.deepEqual(reopened.get(job.id), result);
  assert.equal(result?.observationRetry?.nextAttemptAt, 3000);
  await advanceMaintenance(reopened.get(job.id)!, reopened, adapter, () => 2999);
  assert.deepEqual(reopened.get(job.id), result);
  for (const at of [3000, 5000, 9000, 17000]) await advanceMaintenance(reopened.get(job.id)!, reopened, adapter, () => at);
  assert.equal(f.journal.get(job.id)?.failedStage, 'drain');
  assert.equal(f.journal.get(job.id)?.failureCode, 'observation_unavailable');
});

test('operator reconciliation atomically archives the original failure and CAS prevents duplicate rearming', async t => {
  const f = fixture(t), job = create();
  f.journal.enqueue(job);
  const adapter = { authorize: async () => true,
    prepare: async () => ({ revision: 'a'.repeat(40), manifestSha256: 'b'.repeat(64) }),
    inspect: async () => { throw new Error('unavailable'); },
  } as unknown as MaintenanceAdapter;
  await advanceMaintenance(job, f.journal, adapter, () => 2000);
  const failed = (await advanceMaintenance(f.journal.get(job.id)!, f.journal, adapter, () => 2000))!;
  const next = f.journal.resumeObservation(failed, 1_900_000, 100_000)!;
  assert.equal(next.stage, 'drain'); assert.equal(next.id, job.id); assert.equal(next.failedStage, undefined);
  assert.equal(next.reason, undefined); assert.deepEqual(next.release, failed.release);
  assert.equal(f.open().journal.resumeObservation(failed, 1_900_000, 100_000), undefined);
  const rows = f.db.prepare('SELECT previous_record, next_record FROM connector_maintenance_reconciliations').all() as { previous_record: string; next_record: string }[];
  assert.equal(rows.length, 1); assert.deepEqual(JSON.parse(rows[0]!.previous_record), failed);
  assert.deepEqual(JSON.parse(rows[0]!.next_record), next);
  assert.throws(() => f.journal.resumeObservation({ ...failed, fenceId: 'unknown' }, 1_900_000, 100_000));
  assert.throws(() => f.journal.resumeObservation(failed, 1_900_001, 100_000));
  assert.deepEqual(f.journal.get(job.id), next);
});

test('real SQLite journal persists intent across reopen; interrupted invocation is not reset', async t => {
  const f = fixture(t), job = create();
  f.journal.enqueue(job);
  assert.equal(await f.journal.compareAndSwap(job, { ...job, revision: 1, executing: true }), true);
  f.db.close();
  const reopened = f.open();
  const intent = reopened.journal.get(job.id)!;
  assert.equal(intent.executing, true);
  assert.equal(reopened.journal.enqueue(job).executing, true, 'duplicate POST only returns persisted state');
  await recoverInterruptedMaintenance(intent, reopened.journal);
  assert.equal(reopened.journal.get(job.id)?.reason, 'interrupted');
  assert.throws(() => reopened.journal.enqueue(create('another')), MaintenanceConflict, 'unknown stopped/fenced state must be reconciled before a new job');
});

test('two database connections serialize admission and stale CAS loses without overwriting', async t => {
  const first = fixture(t), second = first.open(), job = create();
  first.journal.enqueue(job);
  assert.throws(() => second.journal.enqueue(create('second')), MaintenanceConflict);
  const intent = { ...job, revision: 1, executing: true as const };
  assert.equal(await first.journal.compareAndSwap(job, intent), true);
  assert.equal(await second.journal.compareAndSwap(job, intent), false);
  assert.deepEqual(second.journal.active(job.nodeId), intent);
  assert.doesNotThrow(() => second.journal.enqueue(create('other-node-job', 'node:2')));
});

test('identity, deadline and operation are immutable; duplicate IDs never start new work', async t => {
  const { journal } = fixture(t), job = create();
  journal.enqueue(job);
  for (const patch of [{ nodeId: 'other' }, { actorId: 'other' }, { operation: 'restart' as const }, { deadline: 70_000 }]) {
    assert.throws(() => journal.enqueue({ ...job, ...patch }), MaintenanceConflict);
    await assert.rejects(journal.compareAndSwap(job, { ...job, ...patch, revision: 1, executing: true }), /Invalid maintenance journal transition/);
  }
  assert.deepEqual(journal.get(job.id), job);
});

test('foreign transaction or weakened durability never acknowledges a durable intent', async t => {
  const { db, journal } = fixture(t), job = create();
  journal.enqueue(job);
  db.exec('BEGIN');
  await assert.rejects(journal.compareAndSwap(job, { ...job, revision: 1, executing: true }), /transaction/i);
  db.exec('ROLLBACK');
  assert.deepEqual(journal.get(job.id), job);
  db.exec('PRAGMA synchronous = NORMAL');
  await assert.rejects(journal.compareAndSwap(job, { ...job, revision: 1, executing: true }), /durable file-backed/);
  assert.deepEqual(journal.get(job.id), job);
  const memory = new DatabaseSync(':memory:');
  try { assert.throws(() => new SqliteMaintenanceJournal(memory), /durable file-backed/); } finally { memory.close(); }
});

test('corrupted indexed projection or record is rejected rather than resumed', t => {
  const { db, journal } = fixture(t), job = create();
  journal.enqueue(job);
  db.prepare('UPDATE connector_maintenance_jobs SET revision = 42 WHERE id = ?').run(job.id);
  assert.throws(() => journal.get(job.id), /Invalid maintenance journal record/);
  db.prepare('UPDATE connector_maintenance_jobs SET record = ? WHERE id = ?').run('{', job.id);
  assert.throws(() => journal.get(job.id), /Invalid maintenance journal record/);
});

test('field ordering does not prevent CAS and release pin cannot be replaced', async t => {
  const { journal } = fixture(t), job = create();
  journal.enqueue(job);
  const reordered = Object.fromEntries(Object.entries(job).reverse()) as typeof job;
  const intent = { ...job, revision: 1, executing: true as const };
  assert.equal(await journal.compareAndSwap(reordered, intent), true);
  const release = { revision: 'a'.repeat(40), manifestSha256: 'b'.repeat(64) };
  const drain = { ...job, stage: 'drain' as const, revision: 2, release };
  assert.equal(await journal.compareAndSwap(intent, drain), true);
  await assert.rejects(journal.compareAndSwap(drain, { ...drain, revision: 3, executing: true, release: { ...release, revision: 'c'.repeat(40) } }), /Invalid maintenance journal transition/);
});

test('operator completion audits the exact readiness failure and cannot replay deployment or overwrite a changed receipt', async context => {
  const { journal, db, open } = fixture(context), job = create();
  const release = { revision: 'a'.repeat(40), manifestSha256: 'b'.repeat(64) };
  const adapter: MaintenanceAdapter = {
    authorize: async () => true, prepare: async () => release,
    inspect: async current => ({ nodeId: current.nodeId, observedAt: 2000, nativeVerified: true,
      activeRuns: 0, backgroundTerminals: 0, pendingExecutions: 0, queuedMessages: 0, inFlightWrites: 0,
      ...(current.fenceId ? { fenceId: current.fenceId } : {}) }),
    fence: async current => ({ nodeId: current.nodeId, fenceId: 'fence:1' }),
    releaseFence: async () => { throw new Error('Never release in reconciliation'); },
    stop: async () => {}, stopped: async current => ({ nodeId: current.nodeId, serviceStopped: true, descendantsStopped: true }),
    backup: async current => ({ nodeId: current.nodeId, backupId: 'backup:1', consistent: true, verified: true }),
    activate: async () => release, start: async () => {}, ready: async () => { throw new Error('readiness failed'); },
  };
  journal.enqueue(job);
  for (let step = 0; journal.get(job.id)?.stage !== 'attention' && step < 20; step++) {
    await advanceMaintenance(journal.get(job.id)!, journal, adapter, () => 2000);
  }
  const failed = journal.get(job.id)!;
  assert.equal(failed.failedStage, 'ready');
  assert.throws(() => journal.completeReleasedReadiness({ ...failed, failedStage: 'release' }, 100_000));
  db.exec(`CREATE TRIGGER deny_completion_audit BEFORE INSERT ON connector_maintenance_reconciliations
    BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
  assert.throws(() => journal.completeReleasedReadiness(failed, 100_000));
  assert.deepEqual(journal.get(job.id), failed);
  db.exec('DROP TRIGGER deny_completion_audit');
  const completed = journal.completeReleasedReadiness(failed, 100_000)!;
  assert.equal(completed.stage, 'succeeded');
  assert.equal(completed.fenceId, failed.fenceId); assert.equal(completed.backupId, failed.backupId);
  assert.equal(completed.deadline, failed.deadline); assert.deepEqual(completed.release, failed.release);
  const reopened = open().journal;
  assert.deepEqual(reopened.get(job.id), completed);
  assert.equal(reopened.completeReleasedReadiness(failed, 100_000), undefined);
  assert.deepEqual(reopened.enqueue(job), completed);
  const audit = db.prepare('SELECT previous_record, next_record FROM connector_maintenance_reconciliations').get() as { previous_record: string; next_record: string };
  assert.deepEqual(JSON.parse(audit.previous_record), failed); assert.deepEqual(JSON.parse(audit.next_record), completed);
  assert.equal(reopened.unresolved(job.nodeId), undefined);
});

for (const operation of ['restart', 'upgrade'] as const) {
  test(`${operation}: real SQLite journal accepts full coordinator flow and idempotent receipts`, async t => {
    const { journal, open } = fixture(t), job = { ...create(), operation };
    const release = { revision: 'a'.repeat(40), manifestSha256: 'b'.repeat(64) };
    const calls: string[] = [];
    const adapter: MaintenanceAdapter = {
      async authorize() { return true; }, async prepare() { return release; },
      async inspect(job) { return { nodeId: job.nodeId, observedAt: 2000, nativeVerified: true,
        activeRuns: 0, backgroundTerminals: 0, pendingExecutions: 0, queuedMessages: 0, inFlightWrites: 0,
        ...(job.fenceId ? { fenceId: job.fenceId } : {}) }; },
      async fence(job) { return { nodeId: job.nodeId, fenceId: 'fence:1' }; },
      async releaseFence(job) { return { nodeId: job.nodeId, fenceId: job.fenceId!, released: true }; },
      async stop() { calls.push('stop'); },
      async stopped(job) { return { nodeId: job.nodeId, serviceStopped: true, descendantsStopped: true }; },
      async backup(job) { return { nodeId: job.nodeId, backupId: 'backup:1', consistent: true, verified: true }; },
      async activate() { calls.push('activate'); return release; }, async start() { calls.push('start'); },
      async ready(job) { return { ...release, nodeId: job.nodeId, protocolCompatible: true, projectionVerified: true, businessReadVerified: true }; },
    };
    journal.enqueue(job);
    const second = open().journal;
    for (let step = 0; journal.get(job.id)?.stage !== 'succeeded' && step < 20; step++) {
      const snapshot = second.get(job.id)!;
      await advanceMaintenance(snapshot, journal, adapter, () => 2000);
    }
    assert.equal(second.get(job.id)?.stage, 'succeeded');
    assert.deepEqual(calls, ['stop', ...(operation === 'upgrade' ? ['activate'] : []), 'start']);
    assert.equal(second.enqueue(job).stage, 'succeeded');
    assert.equal(second.active(job.nodeId), undefined);
    assert.equal(second.enqueue(create('next-request')).stage, 'prepare');
  });
}

test('journal refuses skipped stages or an effect without a preceding durable intent', async t => {
  const { journal } = fixture(t), job = create();
  journal.enqueue(job);
  const release = { revision: 'a'.repeat(40), manifestSha256: 'b'.repeat(64) };
  await assert.rejects(journal.compareAndSwap(job, { ...job, revision: 1, stage: 'drain', release }), /Invalid maintenance journal transition/);
  const intent = { ...job, revision: 1, executing: true as const };
  assert.equal(await journal.compareAndSwap(job, intent), true);
  await assert.rejects(journal.compareAndSwap(intent, { ...job, revision: 2, stage: 'succeeded', release, fenceId: 'forged', backupId: 'forged' }), /Invalid maintenance journal transition/);
  assert.equal(journal.get(job.id)?.executing, true);
});
