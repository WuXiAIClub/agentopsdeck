import type { DatabaseSync } from 'node:sqlite';
import { observedTransaction } from '../storage/observed-transaction.js';
import { observedParticipant } from '../storage/observed-participant.js';
import { requireConnectionReady } from '../storage/connection-recovery.js';
import { MaintenanceReceiptReader } from './maintenance-receipt-reader.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { recoveredReadinessEvidence, validRecoveredReadinessProof, type RecoveredReadinessProof } from './maintenance-recovery-reconciliation.js';
import { validMaintenanceJob, terminalMaintenanceJob, type MaintenanceJob, type MaintenanceJournal, type MaintenanceStage } from './connector-maintenance.js';
import { validSupersededPreFenceProof, type SupersededPreFenceProof,
  validUnstartedPreparationProof, type UnstartedPreparationProof } from './maintenance-reconciliation.js';

export class MaintenanceConflict extends Error {
  constructor() { super('Maintenance request conflicts with an existing job'); }
}

/** Owner-local policy only; never supplied by a browser/RPC proof. Synchronous
 * checks stay inside the write lock. Cross-file token revocation is not atomic
 * with SQLite, even with the final pre-COMMIT reread. */
export type MaintenanceReconciliationPolicy = {
  now(): number;
  authorize(job: Readonly<MaintenanceJob>): boolean;
};

function encode(job: MaintenanceJob) {
  if (!validMaintenanceJob(job)) throw new Error('Invalid maintenance journal record');
  // A deterministic key order makes CAS independent of JSON field ordering.
  return JSON.stringify(job, ['version', 'id', 'nodeId', 'actorId', 'operation', 'createdAt', 'deadline', 'revision',
    'stage', 'executing', 'release', 'manifestSha256', 'fenceId', 'backupId', 'reason',
    'recoveryRuns', 'sessionKey', 'commandId', 'connectionId', 'runId', 'failedStage', 'failureCode',
    'observationRetry', 'attempts', 'nextAttemptAt', 'code',
    'archiveBootstrap', 'authorizationId', 'serviceInvocationId', 'previous', 'candidate', 'sessions']);
}
const immutable = (job: MaintenanceJob) => JSON.stringify([job.version, job.id, job.nodeId, job.actorId, job.operation, job.createdAt, job.deadline,
  job.archiveBootstrap ? JSON.parse(encode(job)).archiveBootstrap : null]);
const edges: Record<MaintenanceStage, MaintenanceStage[]> = {
  prepare: ['drain'], drain: ['drain', 'fence'], fence: ['recheck'], recheck: ['recheck', 'stop', 'unfence'], unfence: ['drain'],
  stop: ['stopped', 'unfence'], stopped: ['backup'], backup: ['activate', 'start', 'recover'], recover: ['start'], activate: ['start'], start: ['ready'],
  ready: ['release'], release: ['succeeded'], succeeded: [], attention: [], cancelled: [],
};
function validTransition(previous: MaintenanceJob, next: MaintenanceJob) {
  if (immutable(previous) !== immutable(next) || next.revision !== previous.revision + 1
    || terminalMaintenanceJob(previous)) return false;
  if (next.executing) {
    const snapshot = { ...next, revision: previous.revision }; delete snapshot.executing;
    return !previous.executing && encode(snapshot) === encode(previous);
  }
  if (!previous.executing && !(next.stage === 'attention' && next.reason === 'deadline')) return false;
  if (next.stage !== 'attention' && !edges[previous.stage].includes(next.stage)) return false;
  if (next.observationRetry && (next.stage !== previous.stage
    || next.observationRetry.attempts !== (previous.observationRetry?.attempts ?? 0) + 1)) return false;
  if (previous.stage === 'recheck' && next.stage === 'recheck' && !next.observationRetry) return false;
  if (next.failedStage !== undefined && next.failedStage !== previous.stage) return false;
  if (previous.release && (previous.release.revision !== next.release?.revision || previous.release.manifestSha256 !== next.release?.manifestSha256)) return false;
  if (!previous.release && next.release && !(previous.stage === 'prepare' && next.stage === 'drain')) return false;
  if (previous.backupId && previous.backupId !== next.backupId) return false;
  if (!previous.backupId && next.backupId && !(previous.stage === 'backup' && ['activate', 'start', 'recover'].includes(next.stage))) return false;
  if (previous.fenceId !== next.fenceId && !((previous.stage === 'fence' && next.stage === 'recheck')
    || (previous.stage === 'unfence' && next.stage === 'drain' && !next.fenceId))) return false;
  if (JSON.stringify(previous.recoveryRuns) !== JSON.stringify(next.recoveryRuns)
    && !((previous.stage === 'drain' && next.stage === 'fence' && !previous.recoveryRuns)
      || (previous.stage === 'unfence' && next.stage === 'drain' && !next.recoveryRuns))) return false;
  return !(previous.stage === 'backup' && next.stage !== 'attention'
    && next.stage !== (previous.operation === 'upgrade' ? 'activate' : previous.operation === 'recover' ? 'recover' : 'start'));
}

/**
 * Durable single-node execution journal, owned by the independent supervisor.
 * The operator supplies a private, file-backed database; its creation and parent
 * directory must already be durably synced. Never share the Connector's database
 * or put this inside a data tree that is swapped/restored during an upgrade.
 * Each write is its own FULL-synchronous transaction. A caller transaction is
 * rejected so an effect cannot run before the intent is actually committed.
 */
export class SqliteMaintenanceJournal implements MaintenanceJournal {
  private readonly receipts: MaintenanceReceiptReader;
  constructor(private readonly db: DatabaseSync, private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics,
    private readonly reconciliationPolicy?: MaintenanceReconciliationPolicy) {
    this.receipts = new MaintenanceReceiptReader(db);
    this.requireDurability();
    this.write(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS connector_maintenance_jobs (
      id TEXT PRIMARY KEY NOT NULL, node_id TEXT NOT NULL, stage TEXT NOT NULL, revision INTEGER NOT NULL,
      record TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS connector_maintenance_reconciliations (
      job_id TEXT NOT NULL, revision INTEGER NOT NULL, observed_at INTEGER NOT NULL,
      previous_record TEXT NOT NULL, next_record TEXT NOT NULL,
      PRIMARY KEY(job_id, revision)
    );
    CREATE TABLE IF NOT EXISTS connector_maintenance_reconciliation_evidence (
      job_id TEXT NOT NULL, revision INTEGER NOT NULL, evidence TEXT NOT NULL,
      PRIMARY KEY(job_id, revision)
    );`);
      // Upgrade the old partial index atomically. Older supervisors cannot
      // interpret cancellation receipts and must not be restarted on this DB.
      const index = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'connector_maintenance_one_active_node'")
        .get() as { sql: string } | undefined;
      if (index && !index.sql.includes("'cancelled'")) db.exec('DROP INDEX connector_maintenance_one_active_node');
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS connector_maintenance_one_active_node
        ON connector_maintenance_jobs(node_id) WHERE stage NOT IN ('succeeded', 'attention', 'cancelled')`);
    });
  }

  private requireDurability() {
    requireConnectionReady(this.db);
    const databases = this.db.prepare('PRAGMA database_list').all() as { name: string; file: string }[];
    const synchronous = this.db.prepare('PRAGMA synchronous').get() as { synchronous: number };
    const mode = this.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    if (!databases.some(database => database.name === 'main' && database.file)
      || synchronous.synchronous < 2 || !['wal', 'delete', 'truncate', 'persist'].includes(mode.journal_mode)) {
      throw new Error('Maintenance journal requires a durable file-backed database');
    }
  }

  private write<T>(operation: () => T extends PromiseLike<unknown> ? never : T): T {
    this.requireDurability();
    return observedTransaction<T>(this.db, 'maintenance-journal-change', operation, this.diagnostics);
  }

  private checkReconciliation(previous: MaintenanceJob, submittedAt: number, valid: (at: number) => boolean) {
    if (!this.reconciliationPolicy) return submittedAt; // Existing synchronous operator boundary.
    const before = observedParticipant(this.db, 'maintenance-policy-check', () => this.reconciliationPolicy!.now());
    if (!Number.isSafeInteger(before) || before < submittedAt || !valid(before)
      || observedParticipant(this.db, 'maintenance-policy-check', () =>
        this.reconciliationPolicy!.authorize(structuredClone(previous))) !== true) throw new MaintenanceConflict();
    // Loading current durable authority can itself block. Recheck freshness
    // afterwards, and reject a clock moving backwards within/between checks.
    const after = observedParticipant(this.db, 'maintenance-policy-check', () => this.reconciliationPolicy!.now());
    if (!Number.isSafeInteger(after) || after < before || !valid(after)) throw new MaintenanceConflict();
    return after;
  }

  get(id: string): MaintenanceJob | undefined {
    return this.receipts.get(id);
  }

  active(nodeId: string): MaintenanceJob | undefined {
    return this.receipts.active(nodeId);
  }

  /** Includes attention: a stopped/fenced node must not look idle to its operator. */
  unresolved(nodeId: string): MaintenanceJob | undefined {
    return this.receipts.unresolved(nodeId);
  }

  /** Same request ID is query-only; IDs are never recycled, including after completion. */
  enqueue(job: MaintenanceJob): MaintenanceJob {
    const encoded = encode(job);
    if (job.stage !== 'prepare' || job.revision !== 0 || job.executing) throw new Error('Invalid initial maintenance job');
    return this.write(() => {
      const existing = this.get(job.id);
      if (existing) {
        if (immutable(existing) !== immutable(job)) throw new MaintenanceConflict();
        return existing;
      }
      // An attention job might have left a stopped service or admission fence.
      // It must be reconciled by an operator, never superseded by another job.
      if (this.unresolved(job.nodeId)) throw new MaintenanceConflict();
      if (job.archiveBootstrap && this.db.prepare(`SELECT 1 FROM connector_maintenance_jobs
        WHERE json_extract(record, '$.archiveBootstrap.authorizationId') = ? LIMIT 1`)
        .get(job.archiveBootstrap.authorizationId)) throw new MaintenanceConflict();
      this.db.prepare('INSERT INTO connector_maintenance_jobs (id, node_id, stage, revision, record) VALUES (?, ?, ?, ?, ?)')
        .run(job.id, job.nodeId, job.stage, job.revision, encoded);
      return structuredClone(job);
    });
  }

  async compareAndSwap(previous: MaintenanceJob, next: MaintenanceJob): Promise<boolean> {
    const before = encode(previous), after = encode(next);
    if (!validTransition(previous, next)) throw new Error('Invalid maintenance journal transition');
    return this.write(() => this.db.prepare(`UPDATE connector_maintenance_jobs SET stage = ?, revision = ?, record = ?
      WHERE id = ? AND revision = ? AND record = ?`).run(next.stage, next.revision, after, previous.id, previous.revision, before).changes === 1);
  }

  /** Local operator only, after fresh proof that the worker is stopped, the
   * original service/release is unchanged and admission is released. A new
   * deployment must use a new request identity and pass every drain gate again.
   */
  cancelObservation(previous: MaintenanceJob, observedAt: number): MaintenanceJob | undefined {
    const before = encode(previous);
    if (previous.stage !== 'drain' || previous.executing || !previous.release
      || previous.fenceId || previous.backupId || previous.recoveryRuns || previous.operation === 'recover'
      || !Number.isSafeInteger(observedAt) || observedAt < previous.createdAt
      || previous.revision >= Number.MAX_SAFE_INTEGER) throw new MaintenanceConflict();
    const next: MaintenanceJob = { ...previous, revision: previous.revision + 1, stage: 'cancelled' };
    delete next.observationRetry;
    const after = encode(next);
    return this.write(() => {
      const updated = this.db.prepare(`UPDATE connector_maintenance_jobs SET stage = ?, revision = ?, record = ?
        WHERE id = ? AND revision = ? AND record = ?`).run(next.stage, next.revision, after, previous.id, previous.revision, before);
      if (updated.changes !== 1) return undefined;
      this.db.prepare(`INSERT INTO connector_maintenance_reconciliations
        (job_id, revision, observed_at, previous_record, next_record) VALUES (?, ?, ?, ?, ?)`)
        .run(previous.id, next.revision, observedAt, before, after);
      return structuredClone(next);
    });
  }

  cancelUnstartedPreparation(previous: MaintenanceJob, proof: UnstartedPreparationProof, observedAt: number): MaintenanceJob | undefined {
    if (!validUnstartedPreparationProof(previous, proof, observedAt)) throw new MaintenanceConflict();
    const before = encode(previous);
    const next: MaintenanceJob = { ...previous, revision: previous.revision + 1, stage: 'cancelled' };
    delete next.reason; delete next.failedStage; delete next.failureCode; delete next.observationRetry;
    const after = encode(next);
    const evidence = JSON.stringify({ kind: 'unstarted-preparation-cancellation', nodeId: proof.nodeId,
      observedAt: proof.observedAt, serviceStartedAt: proof.serviceStartedAt, serviceInvocationId: proof.serviceInvocationId,
      revision: proof.originalRelease.revision, manifestSha256: proof.originalRelease.manifestSha256,
      workerStopped: true, serviceRunning: true, originalReleaseVerified: true, preparationDirectoryAbsent: true,
      admissionReleased: true, failedInvocationFenceAbsent: true });
    return this.write(() => {
      const checkedAt = this.checkReconciliation(previous, observedAt, at => validUnstartedPreparationProof(previous, proof, at));
      const updated = this.db.prepare(`UPDATE connector_maintenance_jobs SET stage = ?, revision = ?, record = ?
        WHERE id = ? AND revision = ? AND record = ?`).run(next.stage, next.revision, after, previous.id, previous.revision, before);
      if (updated.changes !== 1) return undefined;
      this.db.prepare(`INSERT INTO connector_maintenance_reconciliations
        (job_id, revision, observed_at, previous_record, next_record) VALUES (?, ?, ?, ?, ?)`)
        .run(previous.id, next.revision, observedAt, before, after);
      this.db.prepare('INSERT INTO connector_maintenance_reconciliation_evidence VALUES (?, ?, ?)')
        .run(previous.id, next.revision, evidence);
      this.checkReconciliation(previous, checkedAt, at => validUnstartedPreparationProof(previous, proof, at));
      return structuredClone(next);
    });
  }

  /** Explicit operator cancellation with a preserved failed receipt and exact
   * new-generation proof, committed together. Never marks deployment succeeded.
   */
  cancelSupersededObservation(previous: MaintenanceJob, proof: SupersededPreFenceProof, observedAt: number): MaintenanceJob | undefined {
    if (!validSupersededPreFenceProof(previous, proof, observedAt)) throw new MaintenanceConflict();
    const before = encode(previous);
    const next: MaintenanceJob = { ...previous, revision: previous.revision + 1, stage: 'cancelled' };
    delete next.reason; delete next.failedStage; delete next.failureCode; delete next.observationRetry;
    const after = encode(next);
    // Persist only bounded proof fields, never arbitrary adapter output.
    const evidence = JSON.stringify({ kind: 'superseded-pre-fence-cancellation', nodeId: proof.nodeId,
      observedAt: proof.observedAt, serviceStartedAt: proof.serviceStartedAt, serviceInvocationId: proof.serviceInvocationId,
      revision: proof.currentRelease.revision, manifestSha256: proof.currentRelease.manifestSha256,
      workerStopped: true, serviceRunning: true, previousReleaseVerified: true,
      admissionReleased: true, failedInvocationFenceAbsent: true,
      ...(proof.replacementAcceptance ? { replacementAcceptance: {
        deploymentSha256: proof.replacementAcceptance.deploymentSha256,
        acceptanceSha256: proof.replacementAcceptance.acceptanceSha256,
      } } : {}) });
    return this.write(() => {
      const checkedAt = this.checkReconciliation(previous, observedAt, at => validSupersededPreFenceProof(previous, proof, at));
      const updated = this.db.prepare(`UPDATE connector_maintenance_jobs SET stage = ?, revision = ?, record = ?
        WHERE id = ? AND revision = ? AND record = ?`).run(next.stage, next.revision, after, previous.id, previous.revision, before);
      if (updated.changes !== 1) return undefined;
      this.db.prepare(`INSERT INTO connector_maintenance_reconciliations
        (job_id, revision, observed_at, previous_record, next_record) VALUES (?, ?, ?, ?, ?)`)
        .run(previous.id, next.revision, observedAt, before, after);
      this.db.prepare('INSERT INTO connector_maintenance_reconciliation_evidence VALUES (?, ?, ?)')
        .run(previous.id, next.revision, evidence);
      this.checkReconciliation(previous, checkedAt, at => validSupersededPreFenceProof(previous, proof, at));
      return structuredClone(next);
    });
  }

  /** Local operator-only reconciliation. Caller must prove the old worker is
   * stopped, the target is still on its original generation/release, candidate
   * intact and no admission fence exists. Not exposed through Hub/HTTP.
   * Original receipt + changed deadline are retained atomically, not erased.
   */
  resumeObservation(previous: MaintenanceJob, deadline: number, observedAt: number): MaintenanceJob | undefined {
    const before = encode(previous);
    if (previous.stage !== 'attention' || previous.reason !== 'operation_failed' || previous.executing
      || !previous.release || previous.fenceId || previous.backupId || previous.recoveryRuns
      || previous.operation === 'recover' || (previous.failedStage !== undefined && previous.failedStage !== 'drain')
      || !Number.isSafeInteger(observedAt) || observedAt < previous.createdAt
      || !Number.isSafeInteger(deadline) || deadline <= observedAt || deadline < previous.deadline
      || deadline - observedAt > 30 * 60_000) throw new MaintenanceConflict();
    const next: MaintenanceJob = { ...previous, revision: previous.revision + 1, stage: 'drain', deadline };
    delete next.reason; delete next.failedStage; delete next.failureCode; delete next.observationRetry;
    const after = encode(next);
    return this.write(() => {
      const updated = this.db.prepare(`UPDATE connector_maintenance_jobs SET stage = ?, revision = ?, record = ?
        WHERE id = ? AND revision = ? AND record = ?`).run(next.stage, next.revision, after, previous.id, previous.revision, before);
      if (updated.changes !== 1) return undefined;
      this.db.prepare(`INSERT INTO connector_maintenance_reconciliations
        (job_id, revision, observed_at, previous_record, next_record) VALUES (?, ?, ?, ?, ?)`)
        .run(previous.id, next.revision, observedAt, before, after);
      return structuredClone(next);
    });
  }

  completeReleasedReadiness(previous: MaintenanceJob, observedAt: number): MaintenanceJob | undefined {
    const before = encode(previous);
    if (previous.stage !== 'attention' || previous.reason !== 'operation_failed' || previous.failedStage !== 'ready'
      || previous.executing || previous.operation === 'recover' || previous.archiveBootstrap || previous.recoveryRuns
      || !previous.release || !previous.fenceId || !previous.backupId || previous.revision >= Number.MAX_SAFE_INTEGER
      || !Number.isSafeInteger(observedAt) || observedAt < previous.createdAt) throw new MaintenanceConflict();
    const next: MaintenanceJob = { ...previous, revision: previous.revision + 1, stage: 'succeeded' };
    delete next.reason; delete next.failedStage; delete next.failureCode; delete next.observationRetry;
    const after = encode(next);
    return this.write(() => {
      const updated = this.db.prepare(`UPDATE connector_maintenance_jobs SET stage = ?, revision = ?, record = ?
        WHERE id = ? AND revision = ? AND record = ?`).run(next.stage, next.revision, after, previous.id, previous.revision, before);
      if (updated.changes !== 1) return undefined;
      this.db.prepare(`INSERT INTO connector_maintenance_reconciliations
        (job_id, revision, observed_at, previous_record, next_record) VALUES (?, ?, ?, ?, ?)`)
        .run(previous.id, next.revision, observedAt, before, after);
      return structuredClone(next);
    });
  }

  completeRecoveredReadiness(previous: MaintenanceJob, proof: RecoveredReadinessProof, observedAt: number): MaintenanceJob | undefined {
    const before = encode(previous);
    if (!validRecoveredReadinessProof(previous, proof, observedAt)) throw new MaintenanceConflict();
    const next: MaintenanceJob = { ...previous, revision: previous.revision + 1, stage: 'succeeded' };
    delete next.reason; delete next.failedStage; delete next.failureCode; delete next.observationRetry;
    const after = encode(next);
    const evidence = JSON.stringify(recoveredReadinessEvidence(proof));
    return this.write(() => {
      const checkedAt = this.checkReconciliation(previous, observedAt, at => validRecoveredReadinessProof(previous, proof, at));
      const updated = this.db.prepare(`UPDATE connector_maintenance_jobs SET stage = ?, revision = ?, record = ?
        WHERE id = ? AND revision = ? AND record = ?`).run(next.stage, next.revision, after, previous.id, previous.revision, before);
      if (updated.changes !== 1) return undefined;
      this.db.prepare(`INSERT INTO connector_maintenance_reconciliations
        (job_id, revision, observed_at, previous_record, next_record) VALUES (?, ?, ?, ?, ?)`)
        .run(previous.id, next.revision, observedAt, before, after);
      this.db.prepare(`INSERT INTO connector_maintenance_reconciliation_evidence (job_id, revision, evidence) VALUES (?, ?, ?)`)
        .run(previous.id, next.revision, evidence);
      this.checkReconciliation(previous, checkedAt, at => validRecoveredReadinessProof(previous, proof, at));
      return structuredClone(next);
    });
  }
}
