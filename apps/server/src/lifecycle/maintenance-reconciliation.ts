import { validMaintenanceJob, type MaintenanceJob, type ReleaseProof, type QuiescenceProof } from './connector-maintenance.js';
import type { SqliteMaintenanceJournal } from './maintenance-journal.js';

export type UnstartedPreparationProof = {
  nodeId: string; observedAt: number; workerStopped: true; serviceRunning: true;
  serviceStartedAt: number; serviceInvocationId: string;
  originalRelease: ReleaseProof; originalReleaseVerified: true;
  preparationDirectoryAbsent: true; admissionReleased: true; failedInvocationFenceAbsent: true;
};

/** Only failures before the adapter created its exclusive job directory are
 * eligible. Partial preparation, unknown effects and later phases stay blocked. */
export function validUnstartedPreparationProof(job: MaintenanceJob, proof: UnstartedPreparationProof, at: number) {
  return validMaintenanceJob(job) && job.stage === 'attention' && job.reason === 'operation_failed'
    && job.failedStage === 'prepare' && !job.executing && job.operation === 'upgrade'
    && !job.archiveBootstrap && !job.release && !job.fenceId && !job.backupId && !job.recoveryRuns
    && job.revision === 2 && Number.isSafeInteger(at) && at >= job.createdAt
    && !!proof && proof.nodeId === job.nodeId && Number.isSafeInteger(proof.observedAt)
    && proof.observedAt <= at && proof.observedAt >= at - 5000 && proof.workerStopped === true
    && proof.serviceRunning === true && Number.isSafeInteger(proof.serviceStartedAt)
    && proof.serviceStartedAt > 0 && proof.serviceStartedAt <= job.createdAt
    && /^[a-f0-9]{32}$/.test(proof.serviceInvocationId)
    && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(proof.originalRelease?.revision)
    && /^[a-f0-9]{64}$/.test(proof.originalRelease?.manifestSha256)
    && proof.originalReleaseVerified === true && proof.preparationDirectoryAbsent === true
    && proof.admissionReleased === true && proof.failedInvocationFenceAbsent === true;
}

export async function cancelUnstartedPreparation(job: MaintenanceJob, deps: {
  journal: { cancelUnstartedPreparation(...args: Parameters<SqliteMaintenanceJournal['cancelUnstartedPreparation']>):
    MaintenanceJob | undefined | Promise<MaintenanceJob | undefined> };
  authorize: (job: Readonly<MaintenanceJob>) => Promise<boolean>;
  inspect: (job: Readonly<MaintenanceJob>) => Promise<UnstartedPreparationProof>;
  now?: () => number;
}) {
  const original = structuredClone(job), now = deps.now ?? Date.now;
  const fail = () => new Error('Unstarted preparation cancellation is unverified');
  if (!await deps.authorize(structuredClone(original))) throw fail();
  const proof = structuredClone(await deps.inspect(structuredClone(original))), at = now();
  if (!validUnstartedPreparationProof(original, proof, at) || !await deps.authorize(structuredClone(original))) throw fail();
  const committedAt = now();
  if (committedAt < at || !validUnstartedPreparationProof(original, proof, committedAt)) throw fail();
  return deps.journal.cancelUnstartedPreparation(original, proof, committedAt);
}

export type PreFenceReconciliationProof = {
  nodeId: string;
  observedAt: number;
  workerStopped: true;
  serviceStartedAt: number;
  serviceRunning: true;
  originalReleaseVerified: true;
  candidate: ReleaseProof;
  admissionReleased: true;
  failedInvocationFenceAbsent: true;
};

/** A failed observation was superseded by an independently installed candidate.
 * This cancels the old request; it does NOT certify the external deployment or
 * native quiescence. The next operation must obtain its own stop/backup proof.
 */
export type SupersededPreFenceProof = Omit<PreFenceReconciliationProof, 'originalReleaseVerified'> & {
  previousReleaseVerified: true;
  currentRelease: ReleaseProof;
  serviceInvocationId: string;
  /** Explicit operator evidence for a different, independently accepted release.
   * Hashes bind the archived receipts; this never certifies native quiescence. */
  replacementAcceptance?: { release: ReleaseProof; deploymentSha256: string; acceptanceSha256: string };
};

export function validSupersededPreFenceProof(original: MaintenanceJob, proof: SupersededPreFenceProof, at: number) {
  const replacement = proof?.replacementAcceptance;
  const sameRelease = proof?.currentRelease?.revision === original.release?.revision
    && proof?.currentRelease?.manifestSha256 === original.release?.manifestSha256;
  const acceptedReplacement = replacement !== undefined
    && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(replacement.release?.revision)
    && /^[a-f0-9]{64}$/.test(replacement.release?.manifestSha256)
    && /^[a-f0-9]{64}$/.test(replacement.deploymentSha256)
    && /^[a-f0-9]{64}$/.test(replacement.acceptanceSha256)
    && proof.currentRelease?.revision === replacement.release.revision
    && proof.currentRelease?.manifestSha256 === replacement.release.manifestSha256;
  return validMaintenanceJob(original) && original.stage === 'attention' && original.reason === 'operation_failed'
    && original.failedStage === 'drain' && !original.executing && original.operation === 'upgrade'
    && !original.archiveBootstrap && !original.fenceId && !original.backupId && !original.recoveryRuns
    && !!original.release && original.revision < Number.MAX_SAFE_INTEGER
    && Number.isSafeInteger(at) && at >= original.createdAt
    && !!proof && proof.nodeId === original.nodeId && Number.isSafeInteger(proof.observedAt)
    && proof.observedAt <= at && proof.observedAt >= at - 5000 && proof.workerStopped === true
    && Number.isSafeInteger(proof.serviceStartedAt) && proof.serviceStartedAt > original.createdAt && proof.serviceStartedAt <= at
    && /^[a-f0-9]{32}$/.test(proof.serviceInvocationId) && proof.serviceRunning === true
    && proof.previousReleaseVerified === true && proof.admissionReleased === true && proof.failedInvocationFenceAbsent === true
    && proof.candidate?.revision === original.release.revision && proof.candidate?.manifestSha256 === original.release.manifestSha256
    && (replacement === undefined ? sameRelease : acceptedReplacement);
}

export async function cancelSupersededPreFenceMaintenance(job: MaintenanceJob, deps: {
  journal: { cancelSupersededObservation(...args: Parameters<SqliteMaintenanceJournal['cancelSupersededObservation']>):
    MaintenanceJob | undefined | Promise<MaintenanceJob | undefined> };
  authorize: (job: Readonly<MaintenanceJob>) => Promise<boolean>;
  inspect: (job: Readonly<MaintenanceJob>) => Promise<SupersededPreFenceProof>;
  now?: () => number;
}) {
  const original = structuredClone(job), now = deps.now ?? Date.now;
  const fail = () => new Error('Superseded pre-fence cancellation is unverified');
  if (!await deps.authorize(structuredClone(original))) throw fail();
  const proof = structuredClone(await deps.inspect(structuredClone(original))), at = now();
  if (!validSupersededPreFenceProof(original, proof, at) || !await deps.authorize(structuredClone(original))) throw fail();
  const committedAt = now();
  if (committedAt < at || !validSupersededPreFenceProof(original, proof, committedAt)) throw fail();
  return deps.journal.cancelSupersededObservation(original, proof, committedAt);
}

export type ReleasedReadinessProof = {
  nodeId: string;
  observedAt: number;
  workerStopped: true;
  serviceStartedAt: number;
  serviceRunning: true;
  release: ReleaseProof;
  backupId: string;
  backupVerified: true;
  fenceId: string;
  releaseAccepted: true;
  originalSessionReadVerified: true;
  native: QuiescenceProof;
};

export async function reconcileReleasedReadiness(job: MaintenanceJob, deps: {
  journal: Pick<SqliteMaintenanceJournal, 'completeReleasedReadiness'>;
  authorize: (job: Readonly<MaintenanceJob>) => Promise<boolean>;
  inspect: (job: Readonly<MaintenanceJob>) => Promise<ReleasedReadinessProof>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now, original = structuredClone(job);
  const fail = () => new Error('Released readiness reconciliation is unverified');
  if (!validMaintenanceJob(original) || original.stage !== 'attention' || original.reason !== 'operation_failed'
    || original.failedStage !== 'ready' || original.executing || original.operation === 'recover'
    || original.archiveBootstrap || original.recoveryRuns || !original.release || !original.fenceId || !original.backupId
    || original.revision >= Number.MAX_SAFE_INTEGER || !await deps.authorize(structuredClone(original))) throw fail();
  const proof = await deps.inspect(structuredClone(original));
  const at = now();
  const fresh = (value: number) => Number.isSafeInteger(value) && value <= at && value >= at - 5000;
  if (!proof || proof.nodeId !== original.nodeId || !fresh(proof.observedAt) || proof.workerStopped !== true
    || !Number.isSafeInteger(proof.serviceStartedAt) || proof.serviceStartedAt < original.createdAt || proof.serviceStartedAt > at
    || proof.serviceRunning !== true || proof.release?.revision !== original.release.revision
    || proof.release?.manifestSha256 !== original.release.manifestSha256 || proof.backupId !== original.backupId
    || proof.backupVerified !== true || proof.fenceId !== original.fenceId || proof.releaseAccepted !== true
    || proof.originalSessionReadVerified !== true || proof.native?.nodeId !== original.nodeId
    || !fresh(proof.native.observedAt) || proof.native.nativeVerified !== true || proof.native.fenceId !== undefined
    || proof.native.activeRuns !== 0 || proof.native.backgroundTerminals !== 0 || proof.native.pendingExecutions !== 0
    || proof.native.queuedMessages !== 0 || proof.native.inFlightWrites !== 0
    || !await deps.authorize(structuredClone(original))) throw fail();
  const committedAt = now();
  if (!Number.isSafeInteger(committedAt) || committedAt < at || committedAt - Math.min(proof.observedAt, proof.native.observedAt) > 5000) throw fail();
  return deps.journal.completeReleasedReadiness(original, committedAt);
}

/** Cancel only an idle observation step. Never resumes the old candidate,
 * changes its pin, clears a business fence or stops a service. This is NOT a
 * native-quiescence proof and cannot authorize the next deployment to stop.
 */
export async function cancelPreFenceMaintenance(job: MaintenanceJob, deps: {
  journal: Pick<SqliteMaintenanceJournal, 'cancelObservation'>;
  authorize: (job: Readonly<MaintenanceJob>) => Promise<boolean>;
  inspect: (job: Readonly<MaintenanceJob>) => Promise<PreFenceReconciliationProof>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now, original = structuredClone(job);
  const fail = () => new Error('Pre-fence maintenance cancellation is unverified');
  if (!validMaintenanceJob(original) || original.stage !== 'drain' || original.executing
    || !original.release || original.fenceId || original.backupId || original.recoveryRuns
    || original.operation === 'recover' || original.revision >= Number.MAX_SAFE_INTEGER) throw fail();
  if (!await deps.authorize(structuredClone(original))) throw fail();
  const proof = await deps.inspect(structuredClone(original));
  const at = now();
  if (!proof || proof.nodeId !== original.nodeId || !Number.isSafeInteger(proof.observedAt)
    || proof.observedAt > at || proof.observedAt < at - 5000 || proof.workerStopped !== true
    || !Number.isSafeInteger(proof.serviceStartedAt) || proof.serviceStartedAt <= 0 || proof.serviceStartedAt > original.createdAt
    || proof.serviceRunning !== true || proof.originalReleaseVerified !== true || proof.admissionReleased !== true
    || proof.failedInvocationFenceAbsent !== true || proof.candidate?.revision !== original.release.revision
    || proof.candidate?.manifestSha256 !== original.release.manifestSha256
    || !await deps.authorize(structuredClone(original))) throw fail();
  const committedAt = now();
  if (!Number.isSafeInteger(committedAt) || committedAt - proof.observedAt > 5000 || committedAt < at) throw fail();
  return deps.journal.cancelObservation(original, committedAt);
}

/** Explicit local operator action, not automatic job replay. The adapter must
 * inspect OS/service generation, both immutable releases and the exact failed
 * pause command. Native busy work may continue; this only rearms natural drain.
 */
export async function reconcilePreFenceMaintenance(job: MaintenanceJob, deps: {
  journal: Pick<SqliteMaintenanceJournal, 'resumeObservation'>;
  authorize: (job: Readonly<MaintenanceJob>) => Promise<boolean>;
  inspect: (job: Readonly<MaintenanceJob>) => Promise<PreFenceReconciliationProof>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now, original = structuredClone(job);
  const fail = () => new Error('Pre-fence maintenance reconciliation is unverified');
  if (original.stage !== 'attention' || original.reason !== 'operation_failed' || original.executing
    || !original.release || original.fenceId || original.backupId || original.recoveryRuns
    || original.operation === 'recover' || (original.failedStage !== undefined && original.failedStage !== 'drain')) throw fail();
  if (!await deps.authorize(structuredClone(original))) throw fail();
  const proof = await deps.inspect(structuredClone(original));
  const at = now();
  if (!proof || proof.nodeId !== original.nodeId || !Number.isSafeInteger(proof.observedAt)
    || proof.observedAt > at || proof.observedAt < at - 5000 || proof.workerStopped !== true
    || !Number.isSafeInteger(proof.serviceStartedAt) || proof.serviceStartedAt <= 0 || proof.serviceStartedAt > original.createdAt
    || proof.serviceRunning !== true || proof.originalReleaseVerified !== true || proof.admissionReleased !== true
    || proof.failedInvocationFenceAbsent !== true || proof.candidate?.revision !== original.release.revision
    || proof.candidate?.manifestSha256 !== original.release.manifestSha256
    || !await deps.authorize(structuredClone(original))) throw fail();
  const committedAt = now();
  if (committedAt - proof.observedAt > 5000 || committedAt < at) throw fail();
  const deadline = committedAt + 30 * 60_000;
  return deps.journal.resumeObservation(original, deadline, committedAt);
}
