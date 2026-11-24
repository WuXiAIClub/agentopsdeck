import { validMaintenanceJob, type MaintenanceJob } from './connector-maintenance.js';
import { validStoppedCodexRuns } from '../codex/stopped-recovery.js';
import type { MaintenanceBusinessObservation } from '../connector/maintenance-readiness.js';
import type { ReleasedReadinessProof } from './maintenance-reconciliation.js';
import type { SqliteMaintenanceJournal } from './maintenance-journal.js';

export type RecoveredReadinessProof = ReleasedReadinessProof & {
  serviceInvocationId: string;
  recovered: MaintenanceBusinessObservation[];
};

/** Persist only validated metadata, not arbitrary adapter output or payloads. */
export function recoveredReadinessEvidence(proof: RecoveredReadinessProof): RecoveredReadinessProof {
  return { nodeId: proof.nodeId, observedAt: proof.observedAt, workerStopped: true,
    serviceStartedAt: proof.serviceStartedAt, serviceInvocationId: proof.serviceInvocationId, serviceRunning: true,
    release: { revision: proof.release.revision, manifestSha256: proof.release.manifestSha256 },
    backupId: proof.backupId, backupVerified: true, fenceId: proof.fenceId, releaseAccepted: true,
    originalSessionReadVerified: true,
    native: { nodeId: proof.native.nodeId, observedAt: proof.native.observedAt, nativeVerified: true,
      activeRuns: 0, backgroundTerminals: 0, pendingExecutions: 0, queuedMessages: 0, inFlightWrites: 0 },
    recovered: proof.recovered.map(item => ({ nodeId: item.nodeId, fenceId: item.fenceId, observedAt: item.observedAt,
      revision: item.revision, sessionKey: item.sessionKey, messageCount: item.messageCount,
      projectionVerified: true, businessReadVerified: true,
      ...(item.recoveredRunId !== undefined ? { recoveredRunId: item.recoveredRunId } : {}) })) };
}

export function validRecoveredReadinessProof(job: MaintenanceJob, proof: RecoveredReadinessProof, at: number) {
  const fresh = (value: number) => Number.isSafeInteger(value) && value <= at && value >= at - 5000;
  return validMaintenanceJob(job) && job.stage === 'attention' && job.reason === 'operation_failed'
    && job.failedStage === 'ready' && !job.executing && job.operation === 'recover' && !job.archiveBootstrap
    && !!job.release && !!job.fenceId && !!job.backupId && validStoppedCodexRuns(job.recoveryRuns)
    && job.revision < Number.MAX_SAFE_INTEGER && Number.isSafeInteger(at) && at >= job.createdAt
    && !!proof && proof.nodeId === job.nodeId && fresh(proof.observedAt) && proof.workerStopped === true
    && Number.isSafeInteger(proof.serviceStartedAt) && proof.serviceStartedAt > job.createdAt && proof.serviceStartedAt <= at
    && /^[a-f0-9]{32}$/.test(proof.serviceInvocationId) && proof.serviceRunning === true
    && proof.release?.revision === job.release.revision && proof.release?.manifestSha256 === job.release.manifestSha256
    && proof.backupId === job.backupId && proof.backupVerified === true && proof.fenceId === job.fenceId
    && proof.releaseAccepted === true && proof.originalSessionReadVerified === true
    && proof.native?.nodeId === job.nodeId && fresh(proof.native.observedAt) && proof.native.nativeVerified === true
    && proof.native.fenceId === undefined && proof.native.activeRuns === 0 && proof.native.backgroundTerminals === 0
    && proof.native.pendingExecutions === 0 && proof.native.queuedMessages === 0 && proof.native.inFlightWrites === 0
    && (proof.native.recoveryRuns === undefined || proof.native.recoveryRuns.length === 0)
    && Array.isArray(proof.recovered) && proof.recovered.length === job.recoveryRuns.length
    && new Set(proof.recovered.map(item => item.sessionKey)).size === proof.recovered.length
    && job.recoveryRuns.every(run => proof.recovered.some(item => item.nodeId === job.nodeId
      && item.fenceId === job.fenceId && item.sessionKey === run.sessionKey && item.recoveredRunId === run.runId
      && item.revision === job.release!.revision && fresh(item.observedAt)
      && item.projectionVerified === true && item.businessReadVerified === true
      && Number.isSafeInteger(item.messageCount) && item.messageCount >= 1));
}

export async function reconcileRecoveredReadiness(job: MaintenanceJob, deps: {
  journal: { completeRecoveredReadiness(...args: Parameters<SqliteMaintenanceJournal['completeRecoveredReadiness']>):
    MaintenanceJob | undefined | Promise<MaintenanceJob | undefined> };
  authorize: (job: Readonly<MaintenanceJob>) => Promise<boolean>;
  inspect: (job: Readonly<MaintenanceJob>) => Promise<RecoveredReadinessProof>;
  now?: () => number;
}) {
  const original = structuredClone(job), now = deps.now ?? Date.now;
  const fail = () => new Error('Recovered readiness reconciliation is unverified');
  if (!await deps.authorize(structuredClone(original))) throw fail();
  const proof = structuredClone(await deps.inspect(structuredClone(original))), at = now();
  if (!validRecoveredReadinessProof(original, proof, at) || !await deps.authorize(structuredClone(original))) throw fail();
  const committedAt = now();
  if (committedAt < at || !validRecoveredReadinessProof(original, proof, committedAt)) throw fail();
  return deps.journal.completeRecoveredReadiness(original, proof, committedAt);
}
