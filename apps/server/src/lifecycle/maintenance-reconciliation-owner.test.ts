import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import test from 'node:test';
import { chmodSync, lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConnectorTokenStore } from '../auth/connector-token.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { newMaintenanceJob, type MaintenanceJob } from './connector-maintenance.js';
import { AsyncMaintenanceJournal, MaintenanceJournalUnavailable } from './async-maintenance-journal.js';
import { recoverableConnection, StorageConnectionUnavailable, connectionRecoverySnapshot } from '../storage/connection-recovery.js';
import { MaintenanceConflict, SqliteMaintenanceJournal } from './maintenance-journal.js';
import type { RecoveredReadinessProof } from './maintenance-recovery-reconciliation.js';
import type { SupersededPreFenceProof, UnstartedPreparationProof } from './maintenance-reconciliation.js';

const release = { revision: 'a'.repeat(64), manifestSha256: 'b'.repeat(64) };
function cases(at: number, actorId = 'actor:1') {
  const base = newMaintenanceJob({ id: 'job:1', nodeId: 'node:1', actorId, operation: 'upgrade', createdAt: at - 10_000, deadline: at + 60_000 });
  const failed: MaintenanceJob = { ...base, revision: 2, stage: 'attention', reason: 'operation_failed', failedStage: 'prepare' };
  const prepare: UnstartedPreparationProof = { nodeId: base.nodeId, observedAt: at, workerStopped: true, serviceRunning: true,
    serviceStartedAt: base.createdAt - 1000, serviceInvocationId: 'c'.repeat(32), originalRelease: release,
    originalReleaseVerified: true, preparationDirectoryAbsent: true, admissionReleased: true, failedInvocationFenceAbsent: true };
  const superseded: MaintenanceJob = { ...failed, revision: 4, failedStage: 'drain', release };
  const supersededProof: SupersededPreFenceProof = { nodeId: base.nodeId, observedAt: at, workerStopped: true, serviceRunning: true,
    serviceStartedAt: at - 1000, serviceInvocationId: 'c'.repeat(32), previousReleaseVerified: true,
    candidate: release, currentRelease: release, admissionReleased: true, failedInvocationFenceAbsent: true };
  const recovered: MaintenanceJob = { ...superseded, revision: 22, operation: 'recover', failedStage: 'ready', fenceId: 'fence', backupId: 'backup',
    recoveryRuns: [{ sessionKey: 'codex:original', commandId: 'command', connectionId: 'connection', runId: 'run', revision: 80 }] };
  const recoveredProof: RecoveredReadinessProof = { nodeId: base.nodeId, observedAt: at, workerStopped: true, serviceRunning: true,
    serviceStartedAt: at - 1000, serviceInvocationId: 'c'.repeat(32), release, backupId: 'backup', backupVerified: true,
    fenceId: 'fence', releaseAccepted: true, originalSessionReadVerified: true,
    native: { nodeId: base.nodeId, observedAt: at, nativeVerified: true, activeRuns: 0, backgroundTerminals: 0,
      pendingExecutions: 0, queuedMessages: 0, inFlightWrites: 0 },
    recovered: [{ nodeId: base.nodeId, fenceId: 'fence', observedAt: at, revision: release.revision, sessionKey: 'codex:original',
      recoveredRunId: 'run', messageCount: 1, projectionVerified: true, businessReadVerified: true }] };
  return [
    { kind: 'cancelUnstartedPreparation' as const, job: failed, proof: prepare },
    { kind: 'cancelSupersededObservation' as const, job: superseded, proof: supersededProof },
    { kind: 'completeRecoveredReadiness' as const, job: recovered, proof: recoveredProof },
  ];
}
type Case = ReturnType<typeof cases>[number];
function invoke(owner: SqliteMaintenanceJournal | AsyncMaintenanceJournal, c: Case, at: number) {
  if (c.kind === 'cancelUnstartedPreparation') return owner.cancelUnstartedPreparation(c.job, c.proof, at);
  if (c.kind === 'cancelSupersededObservation') return owner.cancelSupersededObservation(c.job, c.proof, at);
  return owner.completeRecoveredReadiness(c.job, c.proof, at);
}
function seed(db: DatabaseSync, job: MaintenanceJob) {
  const keys = ['version', 'id', 'nodeId', 'actorId', 'operation', 'createdAt', 'deadline', 'revision', 'stage', 'executing',
    'release', 'manifestSha256', 'fenceId', 'backupId', 'reason', 'recoveryRuns', 'sessionKey', 'commandId', 'connectionId', 'runId',
    'failedStage', 'failureCode', 'observationRetry', 'attempts', 'nextAttemptAt', 'code', 'archiveBootstrap',
    'authorizationId', 'serviceInvocationId', 'previous', 'candidate', 'sessions'];
  db.prepare('INSERT INTO connector_maintenance_jobs VALUES (?, ?, ?, ?, ?)')
    .run(job.id, job.nodeId, job.stage, job.revision, JSON.stringify(job, keys));
}
const quiet = new PerformanceDiagnostics(() => {});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-reconciliation-owner-')), file = join(dir, 'journal.sqlite');
  const db = new DatabaseSync(file); db.exec('PRAGMA synchronous=FULL; PRAGMA journal_mode=WAL'); chmodSync(file, 0o600);
  return { dir, file, db, dispose: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

for (const c of cases(100_000)) for (const fault of ['lock-age', 'commit-age', 'authority-read-age', 'revoked', 'backwards', 'commit-backwards', 'evidence-write'] as const) {
  test(`${c.kind}: ${fault} rolls back receipt and evidence, retaining the original failure`, () => {
    const f = fixture(), logs: string[] = []; let reads = 0, checks = 0;
    try {
      const journal = new SqliteMaintenanceJournal(f.db, new PerformanceDiagnostics(line => logs.push(line)), {
        now: () => { assert.equal(f.db.isTransaction, true); reads++;
          return fault === 'lock-age' || fault === 'commit-age' && reads > 2 || fault === 'authority-read-age' && reads > 1 ? 105_001
            : fault === 'backwards' ? 99_999 : fault === 'commit-backwards' ? (reads <= 2 ? 101_000 : 100_500) : 100_000; },
        authorize: () => ++checks < (fault === 'revoked' ? 2 : Infinity),
      });
      seed(f.db, c.job);
      if (fault === 'evidence-write') f.db.exec(`CREATE TRIGGER deny_evidence BEFORE INSERT ON connector_maintenance_reconciliation_evidence
        BEGIN SELECT RAISE(ABORT, 'private-payload'); END`);
      assert.throws(() => invoke(journal, c, 100_000));
      assert.deepEqual(journal.get(c.job.id), c.job);
      for (const table of ['connector_maintenance_reconciliations', 'connector_maintenance_reconciliation_evidence'])
        assert.equal((f.db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count, 0);
      assert.equal(f.db.isTransaction, false);
      assert.ok(logs.some(line => JSON.parse(line).category === 'failed'));
      assert.doesNotMatch(logs.join('\n'), /private-payload|actor:1|codex:original/);
    } finally { f.dispose(); }
  });
}

for (const kind of cases(100_000).map(c => c.kind)) test(`${kind}: real worker checks current durable authority and stores only proof metadata`, async () => {
  const f = fixture(), tokenFile = join(f.dir, 'tokens.json'), tokens = new ConnectorTokenStore(tokenFile);
  const actorId = tokens.create({ label: 'isolated-test', scopes: ['connector:lifecycle'] }).record.id;
  assert.equal(lstatSync(tokenFile).mode & 0o777, 0o600, 'original token save must be private; do not mutate an opened owner');
  const c = cases(Date.now(), actorId).find(c => c.kind === kind)!;
  const { dev, ino } = lstatSync(f.file);
  const owner = new AsyncMaintenanceJournal({ file: f.file, dev, ino,
    reconciliation: { nodeId: 'node:1', tokenFile, operations: ['upgrade', 'recover'] } }, quiet);
  try {
    new SqliteMaintenanceJournal(f.db, quiet); seed(f.db, c.job);
    await owner.open();
    tokens.revoke(actorId);
    await assert.rejects(async () => invoke(owner, c, c.proof.observedAt), MaintenanceConflict);
    assert.deepEqual(await owner.get(c.job.id), c.job);
    // New receipt identity with independently issued current authority.
    const replacement = tokens.create({ label: 'isolated-test-2', scopes: ['connector:lifecycle'] }).record.id;
    f.db.exec('DELETE FROM connector_maintenance_jobs');
    const fresh = cases(Date.now(), replacement).find(c => c.kind === kind)!; seed(f.db, fresh.job);
    Object.assign(fresh.proof, { privatePayload: 'secret-not-persisted' });
    if (fresh.kind === 'completeRecoveredReadiness') {
      Object.assign(fresh.proof.native, { privatePayload: 'secret-not-persisted' });
      Object.assign(fresh.proof.recovered[0]!, { privatePayload: 'secret-not-persisted' });
    }
    const result = await invoke(owner, fresh, fresh.proof.observedAt);
    assert.equal(result?.revision, fresh.job.revision + 1);
    assert.equal(result?.stage, kind === 'completeRecoveredReadiness' ? 'succeeded' : 'cancelled');
    assert.equal(await invoke(owner, fresh, fresh.proof.observedAt), undefined, 'no replay on a stale receipt');
    const audit = f.db.prepare('SELECT previous_record FROM connector_maintenance_reconciliations').get() as { previous_record: string };
    assert.deepEqual(JSON.parse(audit.previous_record), fresh.job);
    const evidence = f.db.prepare('SELECT evidence FROM connector_maintenance_reconciliation_evidence').get() as { evidence: string };
    assert.doesNotMatch(evidence.evidence, /privatePayload|secret-not-persisted/);
  } finally { await owner.close(); f.dispose(); }
});

for (const c of cases(100_000)) for (const fault of ['begin', 'commit', 'rollback'] as const) {
  test(`${c.kind}: lost ${fault} ACK retains original settlement and never replays`, () => {
    const f = fixture(), logs: string[] = []; let clock = 0;
    const db = recoverableConnection(f.db, new PerformanceDiagnostics(line => logs.push(line)), () => clock);
    const journal = new SqliteMaintenanceJournal(db, new PerformanceDiagnostics(line => logs.push(line)), {
      now: () => 100_000, authorize: () => true,
    });
    const exec = db.exec;
    try {
      seed(f.db, c.job);
      if (fault === 'rollback') f.db.exec(`CREATE TRIGGER deny_reconciliation BEFORE INSERT ON connector_maintenance_reconciliation_evidence
        BEGIN SELECT RAISE(ABORT, 'original-sql-failure'); END`);
      db.exec = sql => {
        if (fault === 'rollback' && sql === 'ROLLBACK') throw Error('cleanup-failure');
        exec(sql);
        if (sql === (fault === 'begin' ? 'BEGIN IMMEDIATE' : fault === 'commit' ? 'COMMIT' : 'not-sql')) throw Error('lost-ack');
      };
      assert.throws(() => invoke(journal, c, 100_000), fault === 'rollback' ? /original-sql-failure/ : /lost-ack/);
      if (fault === 'rollback') {
        assert.equal(connectionRecoverySnapshot(db).state, 'owner-rollback-required');
        assert.throws(() => journal.get(c.job.id), StorageConnectionUnavailable);
        db.exec = exec; clock += 1000;
        assert.throws(() => journal.get(c.job.id), StorageConnectionUnavailable);
        assert.equal(connectionRecoverySnapshot(db).state, 'ready');
      } else db.exec = exec;
      assert.equal(f.db.isTransaction, false);
      const current = journal.get(c.job.id)!;
      assert.equal(current.revision, c.job.revision + Number(fault === 'commit'));
      assert.equal((f.db.prepare('SELECT count(*) AS n FROM connector_maintenance_reconciliation_evidence').get() as { n: number }).n,
        Number(fault === 'commit'));
      assert.ok(logs.some(line => JSON.parse(line).unknown === 1));
      assert.doesNotMatch(logs.join('\n'), /original-sql-failure|cleanup-failure|lost-ack|actor:1/);
      if (fault === 'commit') assert.equal(invoke(journal, c, 100_000), undefined);
    } finally { db.exec = exec; f.dispose(); }
  });
}

class ReplyWorker extends EventEmitter {
  requests: { id: number; kind: string; args: unknown[] }[] = [];
  postMessage(request: { id: number; kind: string; args: unknown[] }) { this.requests.push(request); }
  async terminate() { this.emit('exit', 1); return 1; }
}
for (const c of cases(100_000)) test(`${c.kind}: unexpected next receipt fences transport; input snapshots exclude extra proof payloads`, async () => {
  const worker = new ReplyWorker();
  const owner = new AsyncMaintenanceJournal({ file: 'unused', dev: 0, ino: 0 }, quiet, () => {}, () => worker as unknown as Worker);
  worker.emit('message', { kind: 'ready' });
  const original = structuredClone(c);
  Object.assign(c.proof, { privatePayload: 'not-sent' });
  const pending = invoke(owner, c, 100_000);
  const rejected = assert.rejects(async () => pending, MaintenanceJournalUnavailable);
  c.job.actorId = 'changed-after-call'; c.proof.observedAt++;
  await Promise.resolve(); await Promise.resolve();
  const request = worker.requests[0]!;
  assert.deepEqual(request.args[0], original.job);
  assert.doesNotMatch(JSON.stringify(request.args[1]), /privatePayload|not-sent/);
  const next: MaintenanceJob = { ...original.job, revision: original.job.revision + 1,
    stage: c.kind === 'completeRecoveredReadiness' ? 'succeeded' : 'cancelled' };
  delete next.reason; delete next.failedStage;
  next.deadline++; // Valid-looking receipt but not the exact original operation.
  worker.emit('message', { id: request.id, kind: c.kind, ok: true, value: next });
  await rejected;
  assert.equal(owner.unavailable, true); assert.equal(worker.requests.length, 1);
  await owner.close();
});

test('reconciliation owner without a durable policy fails closed, and expired/future proof cannot release a receipt', async () => {
  const f = fixture(), { dev, ino } = lstatSync(f.file);
  const owner = new AsyncMaintenanceJournal({ file: f.file, dev, ino }, quiet);
  try {
    new SqliteMaintenanceJournal(f.db, quiet);
    const c = cases(Date.now())[0]!; seed(f.db, c.job);
    await assert.rejects(async () => invoke(owner, c, c.proof.observedAt), MaintenanceConflict);
    const old = cases(Date.now() - 6000)[0]!;
    await assert.rejects(async () => invoke(owner, old, old.proof.observedAt), MaintenanceConflict);
    const future = cases(Date.now() + 60_000)[0]!;
    await assert.rejects(async () => invoke(owner, future, future.proof.observedAt), MaintenanceConflict);
    assert.deepEqual(await owner.get(c.job.id), c.job);
  } finally { await owner.close(); f.dispose(); }
});

for (const fault of ['expired-behind-lock', 'revoked-behind-lock'] as const) test(`real worker ${fault} rejects after acquiring the write lock`, async () => {
  const f = fixture(), tokenFile = join(f.dir, 'tokens.json'), tokens = new ConnectorTokenStore(tokenFile);
  const actorId = tokens.create({ label: 'isolated-lock-test', scopes: ['connector:lifecycle'] }).record.id;
  assert.equal(lstatSync(tokenFile).mode & 0o777, 0o600, 'original token save must be private; do not mutate an opened owner');
  const { dev, ino } = lstatSync(f.file);
  const owner = new AsyncMaintenanceJournal({ file: f.file, dev, ino,
    reconciliation: { nodeId: 'node:1', tokenFile, operations: ['upgrade'] } }, quiet);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    new SqliteMaintenanceJournal(f.db, quiet); await owner.open();
    const c = cases(Date.now() - (fault === 'expired-behind-lock' ? 4800 : 0), actorId)[0]!; seed(f.db, c.job);
    f.db.exec('BEGIN IMMEDIATE');
    const pending = invoke(owner, c, c.proof.observedAt);
    timer = setTimeout(() => {
      if (fault === 'revoked-behind-lock') tokens.revoke(actorId);
      f.db.exec('ROLLBACK');
    }, 300);
    await assert.rejects(async () => pending, MaintenanceConflict);
    assert.deepEqual(await owner.get(c.job.id), c.job);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM connector_maintenance_reconciliations').get() as { n: number }).n, 0);
  } finally {
    if (timer) clearTimeout(timer);
    if (f.db.isTransaction) f.db.exec('ROLLBACK');
    await owner.close(); f.dispose();
  }
});
