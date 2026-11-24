/**
 * One-step, persist-before-effect maintenance coordinator.
 *
 * This is owned by an EXTERNAL node supervisor, never by the Connector being
 * stopped. The adapter must implement actual node/service-manager evidence.
 * It does not interpret Hub-provided commands, paths, repositories or flags.
 * A successful admission receipt is not a successful maintenance operation.
 */
import { sameStoppedCodexRuns, validStoppedCodexRuns, type StoppedCodexRun } from '../codex/stopped-recovery.js';
import { MaintenanceObservationUnavailable, type ObservationFailureCode } from './maintenance-observation-error.js';

export type MaintenanceOperation = 'restart' | 'upgrade' | 'recover';
export type MaintenanceStage = 'prepare' | 'drain' | 'fence' | 'recheck' | 'unfence' | 'stop'
  | 'stopped' | 'backup' | 'recover' | 'activate' | 'start' | 'ready' | 'release' | 'succeeded' | 'attention' | 'cancelled';
export type ReleaseProof = { revision: string; manifestSha256: string };
/** Local operator grant only. Never admitted through the lifecycle HTTP API.
 * Pending stays visible; only the exact archived set may survive native drain.
 */
export type ArchiveBootstrap = {
  authorizationId: string;
  serviceInvocationId: string;
  previous: ReleaseProof;
  candidate: ReleaseProof;
  sessions: string[];
};
export type MaintenanceJob = {
  version: 1;
  id: string;
  nodeId: string;
  actorId: string;
  operation: MaintenanceOperation;
  createdAt: number;
  deadline: number;
  revision: number;
  stage: MaintenanceStage;
  /** Written durably BEFORE invocation. An interrupted invocation is not replayed. */
  executing?: true;
  release?: ReleaseProof;
  fenceId?: string;
  backupId?: string;
  recoveryRuns?: StoppedCodexRun[];
  archiveBootstrap?: ArchiveBootstrap;
  reason?: 'deadline' | 'interrupted' | 'invalid_evidence' | 'operation_failed' | 'authorization_changed';
  failedStage?: MaintenanceStage;
  failureCode?: ObservationFailureCode;
  observationRetry?: { attempts: number; nextAttemptAt: number; code: ObservationFailureCode };
};
export type QuiescenceProof = {
  nodeId: string;
  observedAt: number;
  nativeVerified: true;
  activeRuns: number;
  backgroundTerminals: number;
  pendingExecutions: number;
  queuedMessages: number;
  inFlightWrites: number;
  /** Required for the second check; binds evidence to our admission fence. */
  fenceId?: string;
  recoveryRuns?: StoppedCodexRun[];
};
export type ReadyProof = ReleaseProof & {
  nodeId: string;
  protocolCompatible: true;
  projectionVerified: true;
  businessReadVerified: true;
};
export interface MaintenanceJournal {
  /** Atomic CAS must fsync the new record before returning true. */
  compareAndSwap(previous: MaintenanceJob, next: MaintenanceJob): Promise<boolean>;
}
export interface MaintenanceAdapter {
  /** Checks current native credential scope, node identity and local policy. */
  authorize(job: Readonly<MaintenanceJob>): Promise<boolean>;
  /** Current immutable release for restart; clean, pinned main candidate for upgrade. */
  prepare(job: Readonly<MaintenanceJob>): Promise<ReleaseProof>;
  inspect(job: Readonly<MaintenanceJob>): Promise<QuiescenceProof>;
  fence(job: Readonly<MaintenanceJob>): Promise<{ nodeId: string; fenceId: string }>;
  releaseFence(job: Readonly<MaintenanceJob>): Promise<{ nodeId: string; fenceId: string; released: true }>;
  stop(job: Readonly<MaintenanceJob>): Promise<void>;
  stopped(job: Readonly<MaintenanceJob>): Promise<{ nodeId: string; serviceStopped: true; descendantsStopped: true }>;
  backup(job: Readonly<MaintenanceJob>): Promise<{ nodeId: string; backupId: string; consistent: true; verified: true }>;
  recover?(job: Readonly<MaintenanceJob>): Promise<{ nodeId: string; recovered: true }>;
  activate(job: Readonly<MaintenanceJob>): Promise<ReleaseProof>;
  start(job: Readonly<MaintenanceJob>): Promise<void>;
  ready(job: Readonly<MaintenanceJob>): Promise<ReadyProof>;
}

const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
const revision = (value: unknown): value is string => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const terminalMaintenanceJob = (job: MaintenanceJob) => ['succeeded', 'attention', 'cancelled'].includes(job.stage);
const sameRelease = (first: ReleaseProof, second?: ReleaseProof) => first.revision === second?.revision && first.manifestSha256 === second?.manifestSha256;
const releaseProof = (value: ReleaseProof) => value && revision(value.revision) && digest(value.manifestSha256);
const count = (value: number) => Number.isSafeInteger(value) && value >= 0;
const stages: MaintenanceStage[] = ['prepare', 'drain', 'fence', 'recheck', 'unfence', 'stop', 'stopped', 'backup', 'recover', 'activate', 'start', 'ready', 'release', 'succeeded', 'attention', 'cancelled'];

export function requireMaintenanceObservation(proof: QuiescenceProof, job: MaintenanceJob, now: number, fenced: boolean) {
  requireEvidence(proof?.nodeId === job.nodeId && proof.nativeVerified === true
    && Number.isSafeInteger(proof.observedAt) && proof.observedAt <= now && proof.observedAt >= now - 5000
    && count(proof.activeRuns) && count(proof.backgroundTerminals) && count(proof.pendingExecutions)
    && count(proof.queuedMessages) && count(proof.inFlightWrites)
    && (!fenced || proof.fenceId === job.fenceId));
  if (job.operation === 'recover') {
    // Explicit recovery restarts the whole configured service. Only known
    // interrupted terminals may be unresolved; never interrupt another run or
    // accept an unknown send. Queued messages stay behind the durable fence.
    return proof.activeRuns === 0 && proof.inFlightWrites === 0 && validStoppedCodexRuns(proof.recoveryRuns)
      && proof.pendingExecutions === proof.recoveryRuns.length
      && (!fenced || sameStoppedCodexRuns(proof.recoveryRuns, job.recoveryRuns));
  }
  return proof.activeRuns === 0 && proof.backgroundTerminals === 0
    && proof.pendingExecutions === (job.archiveBootstrap?.sessions.length ?? 0)
    && proof.queuedMessages === 0 && proof.inFlightWrites === 0;
}

/** Strict persisted schema; reject arbitrary extra data rather than forwarding it to node hooks. */
export function validMaintenanceJob(value: unknown): value is MaintenanceJob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const job = value as MaintenanceJob;
  const fields = ['version', 'id', 'nodeId', 'actorId', 'operation', 'createdAt', 'deadline', 'revision', 'stage', 'executing', 'release', 'fenceId', 'backupId', 'reason', 'recoveryRuns', 'archiveBootstrap', 'failedStage', 'failureCode', 'observationRetry'];
  if (Object.keys(job).some(key => !fields.includes(key)) || job.version !== 1 || !identifier(job.id) || !identifier(job.nodeId) || !identifier(job.actorId)
    || !['restart', 'upgrade', 'recover'].includes(job.operation) || !count(job.createdAt) || !count(job.deadline) || job.deadline <= job.createdAt
    || job.deadline - job.createdAt > 24 * 60 * 60 * 1000 || !count(job.revision) || !stages.includes(job.stage)
    || (job.executing !== undefined && job.executing !== true) || (terminalMaintenanceJob(job) && job.executing)
    || (job.release !== undefined && (!releaseProof(job.release) || Object.keys(job.release).some(key => !['revision', 'manifestSha256'].includes(key))))
    || (job.fenceId !== undefined && !identifier(job.fenceId)) || (job.backupId !== undefined && !identifier(job.backupId))
    || (job.reason !== undefined && !['deadline', 'interrupted', 'invalid_evidence', 'operation_failed', 'authorization_changed'].includes(job.reason))
    || (job.recoveryRuns !== undefined && (job.operation !== 'recover' || !validStoppedCodexRuns(job.recoveryRuns)))) return false;
  if (job.archiveBootstrap !== undefined) {
    const grant = job.archiveBootstrap;
    const pin = (value: ReleaseProof) => releaseProof(value) && Object.keys(value).length === 2;
    if (!grant || typeof grant !== 'object' || Array.isArray(grant) || job.operation !== 'upgrade'
      || Object.keys(grant).sort().join(',') !== 'authorizationId,candidate,previous,serviceInvocationId,sessions'
      || !identifier(grant.authorizationId) || !/^[a-f0-9]{32}$/.test(grant.serviceInvocationId)
      || !pin(grant.previous) || !pin(grant.candidate) || sameRelease(grant.previous, grant.candidate)
      || (job.release && !sameRelease(job.release, grant.candidate))
      || !Array.isArray(grant.sessions) || grant.sessions.length < 1 || grant.sessions.length > 64
      || grant.sessions.some(key => typeof key !== 'string' || !/^codex:[a-f0-9-]{36}$/.test(key))
      || JSON.stringify(grant.sessions) !== JSON.stringify([...new Set(grant.sessions)].sort())) return false;
  }
  const failureCode = (code: unknown) => code === 'observation_unavailable' || code === 'transport_unavailable';
  if (job.failedStage !== undefined && (job.stage !== 'attention' || !stages.includes(job.failedStage)
    || ['attention', 'succeeded', 'cancelled'].includes(job.failedStage))) return false;
  if (job.failureCode !== undefined && (job.stage !== 'attention' || !job.failedStage || !failureCode(job.failureCode))) return false;
  if (job.observationRetry !== undefined) {
    const retry = job.observationRetry;
    if (!retry || typeof retry !== 'object' || Array.isArray(retry)
      || Object.keys(retry).some(key => !['attempts', 'nextAttemptAt', 'code'].includes(key))
      || !['drain', 'recheck'].includes(job.stage) || !count(retry.attempts) || retry.attempts < 1 || retry.attempts > 4
      || !count(retry.nextAttemptAt) || retry.nextAttemptAt < job.createdAt || retry.nextAttemptAt > job.deadline
      || !failureCode(retry.code)) return false;
  }
  if (job.stage === 'attention') return !!job.reason;
  if (job.reason) return false;
  // Cancellation is an operator-only pre-fence receipt, never a completed
  // deployment or permission to forget an interrupted/stopped operation.
  // A first-prepare failure may be cancelled before a candidate was installed
  // into its receipt. Only the audited local journal method can perform this
  // transition; ordinary compareAndSwap cannot create cancellation receipts.
  if (job.stage === 'cancelled') return job.operation !== 'recover'
    && (!!job.release || (job.operation === 'upgrade' && job.revision === 3 && !job.archiveBootstrap))
    && !job.fenceId && !job.backupId && !job.recoveryRuns;
  if (job.operation === 'recover' && !['prepare', 'drain'].includes(job.stage) && !job.recoveryRuns) return false;
  if (['prepare', 'drain'].includes(job.stage) && job.recoveryRuns) return false;
  if (job.stage === 'prepare' && (job.release || job.fenceId || job.backupId)) return false;
  if (['drain', 'fence'].includes(job.stage) && (job.fenceId || job.backupId)) return false;
  if (['recheck', 'unfence', 'stop', 'stopped', 'backup'].includes(job.stage) && job.backupId) return false;
  if (job.stage !== 'prepare' && !job.release) return false;
  if (['recheck', 'unfence', 'stop', 'stopped', 'backup', 'recover', 'activate', 'start', 'ready', 'release', 'succeeded'].includes(job.stage) && !job.fenceId) return false;
  if (['recover', 'activate', 'start', 'ready', 'release', 'succeeded'].includes(job.stage) && !job.backupId) return false;
  return !(job.operation !== 'upgrade' && job.stage === 'activate') && !(job.operation !== 'recover' && job.stage === 'recover');
}

export function newMaintenanceJob(input: { id: string; nodeId: string; actorId: string; operation: MaintenanceOperation; createdAt: number; deadline: number }): MaintenanceJob {
  const job: MaintenanceJob = { ...input, version: 1, revision: 0, stage: 'prepare' };
  if (!validMaintenanceJob(job)) throw new Error('Invalid maintenance request');
  return job;
}

export class MaintenanceEvidenceError extends Error {}
const requireEvidence: (value: unknown) => asserts value = value => { if (!value) throw new MaintenanceEvidenceError('Maintenance evidence invalid'); };

/**
 * Caller supplies a fresh journal snapshot. Concurrent/stale snapshots lose CAS
 * and do not call the adapter. Only classified observation failures may be
 * retried by a later tick, with durable backoff; effects are never retried.
 */
export async function advanceMaintenance(job: MaintenanceJob, journal: MaintenanceJournal, adapter: MaintenanceAdapter,
  now: () => number = Date.now): Promise<MaintenanceJob | undefined> {
  if (!validMaintenanceJob(job)) throw new Error('Invalid maintenance journal');
  if (terminalMaintenanceJob(job) || job.executing) return job;
  const original = structuredClone(job);
  // Reserve two increments for intent/result before performing any effect.
  if (original.revision > Number.MAX_SAFE_INTEGER - 2) throw new Error('Maintenance revision exhausted');
  const failed = (reason: NonNullable<MaintenanceJob['reason']>): MaintenanceJob => {
    const next = { ...original, revision: original.revision + 1, stage: 'attention' as const, reason, failedStage: original.stage };
    delete next.executing;
    delete next.observationRetry;
    return next;
  };
  if (now() >= original.deadline) {
    const next = failed('deadline');
    return await journal.compareAndSwap(original, next) ? next : undefined;
  }
  if (original.observationRetry && now() < original.observationRetry.nextAttemptAt) return job;
  // The durable intent also serializes concurrent supervisors. The worker must
  // not reuse its pre-CAS snapshot after a lost acknowledgment.
  const intent: MaintenanceJob = { ...original, revision: original.revision + 1, executing: true };
  if (!await journal.compareAndSwap(original, intent)) return undefined;
  let next: MaintenanceJob = { ...intent, revision: intent.revision + 1 };
  delete next.executing;
  delete next.observationRetry;
  const target = (stage: MaintenanceStage) => { next.stage = stage; };
  const view = () => structuredClone(intent);
  try {
    // Once stopped, authorization cannot depend on the stopped HTTP process.
    // The node adapter must consult durable local policy/credential authority.
    if (!await adapter.authorize(view())) {
      next.stage = 'attention'; next.reason = 'authorization_changed';
    } else if (now() >= original.deadline) {
      next.stage = 'attention'; next.reason = 'deadline';
    } else switch (original.stage) {
      case 'prepare': {
        const proof = await adapter.prepare(view());
        requireEvidence(releaseProof(proof) && (!original.archiveBootstrap || sameRelease(proof, original.archiveBootstrap.candidate)));
        next.release = { revision: proof.revision, manifestSha256: proof.manifestSha256 };
        target('drain'); break;
      }
      case 'drain': case 'recheck': {
        const proof = await adapter.inspect(view());
        const quiet = requireMaintenanceObservation(proof, original, now(), original.stage === 'recheck');
        if (original.operation === 'recover' && original.stage === 'drain' && quiet) next.recoveryRuns = structuredClone(proof.recoveryRuns!);
        target(original.stage === 'drain' ? (quiet ? 'fence' : 'drain') : (quiet ? 'stop' : 'unfence'));
        break;
      }
      case 'fence': {
        const proof = await adapter.fence(view());
        requireEvidence(proof?.nodeId === original.nodeId && identifier(proof.fenceId));
        next.fenceId = proof.fenceId; target('recheck'); break;
      }
      case 'unfence': case 'release': {
        const proof = await adapter.releaseFence(view());
        requireEvidence(proof?.nodeId === original.nodeId && proof.fenceId === original.fenceId && proof.released === true);
        if (original.stage === 'unfence') { delete next.fenceId; delete next.recoveryRuns; target('drain'); }
        else target('succeeded');
        break;
      }
      case 'stop': {
        // The worker may have been delayed after committing `recheck`. A
        // previous observation is not a durable license to terminate processes.
        const proof = await adapter.inspect(view());
        if (!requireMaintenanceObservation(proof, original, now(), true)) { target('unfence'); break; }
        if (!await adapter.authorize(view())) { next.stage = 'attention'; next.reason = 'authorization_changed'; break; }
        if (now() >= original.deadline) { next.stage = 'attention'; next.reason = 'deadline'; break; }
        await adapter.stop(view()); target('stopped'); break;
      }
      case 'stopped': {
        const proof = await adapter.stopped(view());
        requireEvidence(proof?.nodeId === original.nodeId && proof.serviceStopped === true && proof.descendantsStopped === true);
        target('backup'); break;
      }
      case 'backup': {
        const proof = await adapter.backup(view());
        requireEvidence(proof?.nodeId === original.nodeId && proof.consistent === true && proof.verified === true && identifier(proof.backupId));
        next.backupId = proof.backupId; target(original.operation === 'upgrade' ? 'activate' : original.operation === 'recover' ? 'recover' : 'start'); break;
      }
      case 'recover': {
        const proof = await adapter.recover?.(view());
        requireEvidence(proof?.nodeId === original.nodeId && proof.recovered === true);
        target('start'); break;
      }
      case 'activate': {
        const proof = await adapter.activate(view());
        requireEvidence(proof && sameRelease(proof, original.release)); target('start'); break;
      }
      case 'start': await adapter.start(view()); target('ready'); break;
      case 'ready': {
        const proof = await adapter.ready(view());
        requireEvidence(proof?.nodeId === original.nodeId && sameRelease(proof, original.release)
          && proof.protocolCompatible === true && proof.projectionVerified === true && proof.businessReadVerified === true);
        target('release'); break;
      }
    }
  } catch (error) {
    // No raw exception/command output: it may include filesystem secrets or
    // credentials. Diagnostics belong in a node-local private operator log.
    const retryable = error instanceof MaintenanceObservationUnavailable && ['drain', 'recheck'].includes(original.stage);
    const attempts = (original.observationRetry?.attempts ?? 0) + 1;
    if (retryable && attempts < 5 && now() < original.deadline) {
      next.observationRetry = { attempts, nextAttemptAt: Math.min(original.deadline, now() + 1000 * 2 ** (attempts - 1)), code: error.code };
    } else {
      next.stage = 'attention';
      next.reason = now() >= original.deadline ? 'deadline' : error instanceof MaintenanceEvidenceError ? 'invalid_evidence' : 'operation_failed';
      if (error instanceof MaintenanceObservationUnavailable) next.failureCode = error.code;
    }
  }
  if (next.stage === 'attention') next.failedStage = original.stage;
  if (!validMaintenanceJob(next)) throw new Error('Invalid maintenance transition');
  return await journal.compareAndSwap(intent, next) ? next : undefined;
}

/** Call ONLY after external supervision proves the old worker has exited. */
export async function recoverInterruptedMaintenance(job: MaintenanceJob, journal: MaintenanceJournal): Promise<MaintenanceJob | undefined> {
  if (!validMaintenanceJob(job)) throw new Error('Invalid maintenance journal');
  if (!job.executing) return job;
  if (job.revision === Number.MAX_SAFE_INTEGER) throw new Error('Maintenance revision exhausted');
  const next: MaintenanceJob = { ...job, revision: job.revision + 1, stage: 'attention', reason: 'interrupted', failedStage: job.stage };
  delete next.executing;
  delete next.observationRetry;
  return await journal.compareAndSwap(job, next) ? next : undefined;
}
