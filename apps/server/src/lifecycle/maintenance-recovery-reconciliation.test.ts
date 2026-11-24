import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { newMaintenanceJob, type MaintenanceJob } from './connector-maintenance.js';
import { SqliteMaintenanceJournal } from './maintenance-journal.js';
import { reconcileRecoveredReadiness, validRecoveredReadinessProof, type RecoveredReadinessProof } from './maintenance-recovery-reconciliation.js';

const job: MaintenanceJob = { ...newMaintenanceJob({ id: 'recover:original', nodeId: 'node:1', actorId: 'actor:1',
  operation: 'recover', createdAt: 1000, deadline: 60_000 }), revision: 22, stage: 'attention', reason: 'operation_failed',
  failedStage: 'ready', release: { revision: 'a'.repeat(64), manifestSha256: 'a'.repeat(64) }, fenceId: 'original-fence', backupId: 'original-backup',
  recoveryRuns: [{ sessionKey: 'codex:original', commandId: 'command', connectionId: 'connection', runId: 'run', revision: 80 }] };
const proof: RecoveredReadinessProof = { nodeId: job.nodeId, observedAt: 100_000, workerStopped: true,
  serviceStartedAt: 2000, serviceInvocationId: 'b'.repeat(32), serviceRunning: true, release: job.release!,
  backupId: job.backupId!, backupVerified: true, fenceId: job.fenceId!, releaseAccepted: true, originalSessionReadVerified: true,
  native: { nodeId: job.nodeId, observedAt: 100_000, nativeVerified: true, activeRuns: 0, backgroundTerminals: 0,
    pendingExecutions: 0, queuedMessages: 0, inFlightWrites: 0 },
  recovered: [{ nodeId: job.nodeId, fenceId: job.fenceId!, observedAt: 100_000, revision: job.release!.revision,
    sessionKey: 'codex:original', recoveredRunId: 'run', messageCount: 1, projectionVerified: true, businessReadVerified: true }] };

test('recovered readiness requires exact interrupted-run proof and fresh released quiescence', () => {
  assert.equal(validRecoveredReadinessProof(job, proof, 100_000), true);
  for (const patch of [{ operation: 'upgrade' }, { failedStage: 'recover' }, { executing: 'ready' }, { recoveryRuns: undefined },
    { reason: 'deadline' }, { stage: 'release' }, { revision: Number.MAX_SAFE_INTEGER }]) {
    assert.equal(validRecoveredReadinessProof({ ...job, ...patch } as MaintenanceJob, proof, 100_000), false);
  }
  for (const patch of [{ workerStopped: false }, { backupVerified: false }, { releaseAccepted: false }, { backupId: 'other' },
    { serviceStartedAt: 500 }, { observedAt: 94_999 }, { recovered: [] }, { recovered: [...proof.recovered, ...proof.recovered] },
    { serviceInvocationId: '' }, { release: { ...proof.release, revision: 'c'.repeat(64) } }]) {
    assert.equal(validRecoveredReadinessProof(job, { ...proof, ...patch } as RecoveredReadinessProof, 100_000), false);
  }
  for (const patch of [{ recoveredRunId: 'other' }, { sessionKey: 'codex:other' }, { fenceId: 'other' }, { observedAt: 94_999 },
    { messageCount: 0 }, { businessReadVerified: false }]) {
    assert.equal(validRecoveredReadinessProof(job, { ...proof, recovered: [{ ...proof.recovered[0], ...patch }] } as RecoveredReadinessProof, 100_000), false);
  }
  for (const patch of [{ fenceId: job.fenceId! }, { pendingExecutions: 1 }, { activeRuns: 1 }, { backgroundTerminals: 1 },
    { queuedMessages: 1 }, { inFlightWrites: 1 }, { recoveryRuns: job.recoveryRuns! }, { observedAt: 100_001 }]) {
    assert.equal(validRecoveredReadinessProof(job, { ...proof, native: { ...proof.native, ...patch } }, 100_000), false);
  }
});

test('reconciliation rechecks authority and evidence age before touching journal', async () => {
  let writes = 0, checks = 0, clock = 0;
  const deps = { now: () => 100_000, authorize: async () => true, inspect: async () => proof,
    journal: { completeRecoveredReadiness() { writes++; return undefined; } } };
  await assert.rejects(reconcileRecoveredReadiness(job, { ...deps, authorize: async () => ++checks < 2 }));
  await assert.rejects(reconcileRecoveredReadiness(job, { ...deps, now: () => ++clock === 1 ? 100_000 : 105_001 }));
  assert.equal(writes, 0);
  assert.equal(await reconcileRecoveredReadiness(job, deps), undefined);
  assert.equal(writes, 1);
});

test('recovery completion retains original failure and run identities with atomic proof and CAS', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-recovered-ready-'));
  const db = new DatabaseSync(join(directory, 'journal.sqlite'));
  try {
    db.exec('PRAGMA synchronous=FULL');
    const journal = new SqliteMaintenanceJournal(db);
    db.prepare('INSERT INTO connector_maintenance_jobs VALUES (?, ?, ?, ?, ?)')
      .run(job.id, job.nodeId, job.stage, job.revision, JSON.stringify(job, [
        'version', 'id', 'nodeId', 'actorId', 'operation', 'createdAt', 'deadline', 'revision', 'stage',
        'release', 'manifestSha256', 'fenceId', 'backupId', 'reason', 'recoveryRuns',
        'sessionKey', 'commandId', 'connectionId', 'runId', 'failedStage',
      ]));
    assert.throws(() => journal.completeRecoveredReadiness(job, { ...proof, recovered: [] }, 100_000));
    assert.throws(() => journal.completeReleasedReadiness(job, 100_000));
    const result = journal.completeRecoveredReadiness(job, proof, 100_000)!;
    assert.equal(result.stage, 'succeeded'); assert.equal(result.revision, 23);
    assert.deepEqual(result.recoveryRuns, job.recoveryRuns); assert.equal(result.backupId, job.backupId);
    const audit = db.prepare('SELECT previous_record FROM connector_maintenance_reconciliations').get() as { previous_record: string };
    assert.deepEqual(JSON.parse(audit.previous_record), job);
    const evidence = db.prepare('SELECT evidence FROM connector_maintenance_reconciliation_evidence').get() as { evidence: string };
    assert.deepEqual(JSON.parse(evidence.evidence), proof);
    assert.equal(journal.completeRecoveredReadiness(job, proof, 100_000), undefined);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
