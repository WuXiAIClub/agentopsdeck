import { randomUUID } from 'node:crypto';
import { threadId } from 'node:worker_threads';

const operations = ['application-transaction-gate', 'connector-automation', 'sdk-owned-lifecycle', 'hub-notebook-machine', 'rollout-read', 'rollout-reader-close', 'rollout-snapshot-wait', 'codex-interrupt-observation', 'storage-admission', 'codex-execution-change', 'codex-execution-recovery', 'codex-stopped-recovery', 'codex-stopped-recovery-owner', 'codex-stopped-unknown-disposition', 'codex-stopped-unknown-owner',
  'connector-session-settings', 'connector-session-media', 'openclaw-session-source', 'connector-runtime-assembly', 'standalone-connector-layer', 'combined-application-layer', 'connector-machine-files', 'connector-machine-services', 'codex-native-resume', 'codex-creation-change', 'codex-session-creation', 'command-receipt-recovery', 'command-receipt-migration', 'openclaw-execution-change', 'openclaw-execution-recovery',
  'codex-files', 'codex-public-usage', 'codex-session-deletion', 'turn-worker-pass', 'turn-worker-probe', 'hub-revocation-pass', 'hub-usage-pass', 'hub-usage-reconcile', 'hub-revocation-reconcile', 'hub-execution-sync',
  'hub-preference-migration', 'hub-connection-display-migration', 'hub-delivery-append', 'hub-delivery-read', 'hub-preference-read', 'hub-users-read', 'hub-connections-read', 'hub-workspace-revisions-read',
  'hub-workspace-preferences-read', 'hub-workspace-layout-read', 'hub-workspace-board-read', 'hub-notebook-snapshot-read', 'hub-completion-summary-read', 'hub-delegation-directory-read', 'hub-metrics-sources-read',
  'connector-event-stream', 'connector-event-projection', 'connector-agent-catalog', 'connector-users-http', 'connector-grants-http', 'connector-storage-maintenance', 'hub-event-stream', 'hub-event-broker', 'hub-session-state-read', 'hub-connector-users-read', 'hub-request-authority', 'system-operation', 'system-read-wait',
  'async-storage-admission', 'storage-admission-release', 'storage-admission-release-recovery', 'storage-sync-contract', 'storage-coordinator-recovery', 'owned-wal-checkpoint', 'sdk-execution-change',
  'command-receipt-claim', 'command-receipt-reclaim', 'command-receipt-admission', 'command-receipt-settle', 'hub-message-http', 'application-message-http', 'application-compact-http', 'turn-queue-change', 'turn-queue-admission', 'turn-queue-notify', 'command-receipt-evidence', 'codex-context-normalize',
  'native-token-snapshot', 'native-token-cumulative', 'native-token-snapshot-admission', 'usage-manifest-admission', 'usage-manifest-collection', 'hub-usage-manifest-http', 'hub-board-binding-http', 'hub-delegation-http', 'hub-delegation-effect', 'hub-content-document-http', 'hub-content-overview-http', 'hub-content-replica-http',
  'hub-content-replica-effect', 'connector-content-replica-http', 'hub-content-batch-http', 'hub-content-batch-effect', 'hub-content-background', 'hub-native-file-effect', 'hub-native-file-background',
  'automation-store-change', 'automation-configuration-change', 'interaction-store-change',
  'hermes-journal-change', 'hermes-message-http', 'hermes-message-stop', 'native-queue-http', 'native-queue-projection', 'hermes-queue-http', 'hermes-queue-projection', 'hermes-async-dispatch', 'hermes-history-sync', 'hermes-tool-commit', 'hermes-terminal-settlement', 'hermes-execution-protection', 'hermes-runtime-close', 'hermes-session-deletion', 'hermes-session-creation', 'hermes-lifecycle', 'execution-grant-change', 'execution-issuer-check', 'content-authority-check', 'node-authority-check',
  'maintenance-policy-check', 'maintenance-authority-check', 'hub-maintenance-effect', 'hub-shared-creation-effect', 'hub-issuer-management-effect', 'delegation-authority-check', 'checkpoint-authority-check', 'connector-event-change', 'mirror-outbox-change',
  'auth-audit-initialize', 'auth-audit-append', 'auth-audit-page', 'auth-audit-list',
  'auth-login-check', 'auth-login-change', 'auth-route-persistence', 'auth-sqlite-command', 'auth-sqlite-owner', 'auth-sqlite-owner-failure', 'auth-current-key-binding', 'connector-token-storage', 'connector-token-owner', 'update-lock-cleanup', 'update-mutation-lock', 'claude-transcript-append', 'copilot-transcript-append',
  'sdk-transcript-counts-install', 'sdk-async-projection', 'sdk-async-driver', 'sdk-message-http', 'sdk-message-admission', 'hermes-message-admission', 'sdk-local-http', 'sdk-queue-http', 'sdk-deletion-http', 'sdk-compact-http', 'sdk-recovery-http', 'sdk-async-dispatch', 'sdk-async-attachments', 'sdk-async-compact', 'turn-dispatch-snapshot', 'storage-connection-recovery', 'storage-connection-close', 'storage-settlement-rejected', 'shutdown-drain', 'shutdown-cleanup', 'application-drain',
  'storage-startup-cleanup', 'storage-startup-owner', 'storage-startup-admission', 'storage-coordinator-startup', 'storage-owner-close', 'hub-route-drain', 'auth-route-drain', 'hub-owner-control-http', 'hub-shared-creation-http', 'hub-workspace-sync', 'browser-owner-drain', 'connector-startup-task', 'process-startup', 'process-shutdown', 'process-shutdown-owner',
  'hub-shared-session-http', 'connector-session-discovery', 'application-command-scope', 'application-command-authority',
  'hub-permission-http', 'hub-governance-http',
  'session-file-index-rebuild', 'session-file-index-change', 'auth-passkey-change', 'auth-passkey-schema', 'auth-passkey-read', 'auth-display-read', 'readonly-sql-owner-failure', 'maintenance-journal-change', 'storage-diagnostics-failure',
  'maintenance-journal-rpc', 'maintenance-journal-owner', 'maintenance-sql-owner-failure', 'maintenance-stopped-receipt', 'maintenance-host-halt', 'maintenance-host-close', 'maintenance-supervisor-step',
  'hub-member-sqlite-owner', 'hub-member-sqlite-command', 'connector-sqlite-owner', 'connector-sqlite-command', 'connector-maintenance-change', 'hub-user-change', 'hub-connector-user-change', 'hub-connector-user-http', 'hub-connection-mutation',
  'quick-chat-change', 'hub-quick-chat', 'hub-workspace-remote', 'hub-workspace-research', 'hub-workspace-browser', 'completion-unread-change', 'hub-identity-change', 'hub-identity-check', 'hub-connection-change', 'auth-compatibility-check', 'weixin-binding-change', 'weixin-original-effect', 'weixin-service-drain', 'hub-event-feed-command',
  'role-access-change', 'execution-issuer-change', 'execution-usage-migration', 'execution-usage-reserve', 'execution-usage-admission',
  'session-creation-ownership', 'session-share-change', 'delegation-store-change', 'content-replica-change', 'hub-deletion-projection',
  'usage-manifest-change', 'session-guidance-change', 'hub-session-guidance', 'task-session-change', 'auth-issue-change', 'archive-upgrade-prepare',
  'workspace-board-binding-change', 'workspace-board-file-change', 'workspace-card-file-change',
  'workspace-board-capability-change', 'workspace-card-configuration-change', 'workspace-card-change',
  'workspace-board-change', 'workspace-drawing-change', 'workspace-native-drawio-change', 'workspace-report-change',
  'workspace-file-prepare', 'workspace-file-write-prepare', 'workspace-file-revoke', 'workspace-file-reconcile', 'notebook-bound-move', 'notebook-bound-finish', 'notebook-bound-prepare', 'openclaw-dispatch', 'codex-dispatch', 'openclaw-reconcile', 'openclaw-projection', 'openclaw-message', 'openclaw-message-http', 'codex-stop', 'codex-message', 'codex-message-http', 'openclaw-stop', 'openclaw-status',
  'openclaw-compact', 'openclaw-application', 'mirror-delivery', 'openclaw-history-projection', 'gateway-observation', 'codex-native-observation', 'codex-native-effect', 'codex-projection', 'codex-startup', 'codex-history-read', 'turn-bootstrap-body', 'content-proposal-change', 'content-batch-change', 'notebook-capability-change', 'notebook-move-change', 'session-preference-change', 'codex-final-history', 'session-read-request'] as const;
type Operation = typeof operations[number];
const metrics = ['beginMs', 'bodyMs', 'commitMs', 'rollbackMs', 'prefixVerificationMs', 'snapshotVerificationMs',
  'projectionMs', 'sourceBytes', 'prefixBytes', 'snapshotBytes', 'records', 'cacheHit', 'reusedPrefix',
  'sampleMs', 'receiptScanMs', 'receipts', 'changed', 'livePrefix', 'fileBytes',
  'queueMs', 'releaseMs', 'pending', 'admitted', 'settled', 'unknown', 'pressureUnknown', 'classificationUnknown', 'deferred', 'nested', 'rollbackFailed',
  'logFrames', 'checkpointedFrames', 'busy', 'timedOut', 'cancelled', 'recovered', 'step', 'startupStage', 'generation', 'sqlErrorCode', 'rollbackErrorCode', 'ownerFailureCode', 'admissionRefusalCode',
  'dispatchFailureStage', 'nativeRpcRejection', 'nativeRpcErrorClass'] as const;
type Metric = typeof metrics[number];
type Observation = { component: 'agentopsdeck-performance'; instance: string; sequence: number;
  processId: number; threadId: number; startedAtUnixMs: number; observedAtUnixMs: number;
  operation: Operation; phase: 'pending' | 'finished'; category: 'routine' | 'slow' | 'failed';
  elapsedMs: number; delivery: 'not-attempted' | 'rate-limited' | 'delivered' | 'failed'; suppressed: number;
} & Partial<Record<Metric, number>>;
const RECOVERY_OBSERVATION_LIMIT = 128;
export type PerformanceTrace = { add: (metric: Metric, value: number) => void;
  /** Observation only: same trace identity; no completion or stored-metric mutation. */
  reportPending: (snapshot?: Partial<Record<Metric, number>>) => void;
  finish: (failed?: boolean) => void };

/** Fixed-size process-wide limiter; no paths, business IDs, SQL, content or exceptions.
 * Numeric process/thread identity and monotonic-derived epoch timestamps let
 * operators correlate Hub/Connector/owner logs; they are not recovery authority.
 * Independent budgets prevent routine polling from hiding slow/failing work.
 * Durations use a monotonic clock. Diagnostic failure never changes authority.
 */
export class PerformanceDiagnostics {
  private readonly instance = randomUUID();
  private sequence = 0;
  private readonly recent: Observation[] = [];
  private readonly totals = { observations: 0, finished: 0, failed: 0, pending: 0,
    unknownObservations: 0, suppressed: 0, sinkFailures: 0 };
  /** Volatile numeric evidence only, not a durable receipt or recovery authority.
   * Reading never starts IO, repairs an owner, clears state or changes budgets. */
  snapshot() {
    return { scope: 'process' as const, retention: 'volatile' as const,
      capacity: RECOVERY_OBSERVATION_LIMIT, totals: { ...this.totals },
      events: this.recent.map(event => ({ ...event })) };
  }
  private count(metric: keyof PerformanceDiagnostics['totals']) {
    this.totals[metric] = Math.min(Number.MAX_SAFE_INTEGER, this.totals[metric] + 1);
  }
  private readonly buckets = {
    routine: { since: 0, count: 0, suppressed: 0 },
    slow: { since: 0, count: 0, suppressed: 0 },
    failed: { since: 0, count: 0, suppressed: 0 },
  };
  // One bounded reserve for the original process's startup/shutdown boundary.
  // Per-owner drain/transaction traffic must not consume its final closure ACK.
  // Owner detail remains under the ordinary budget; no unbounded bypass.
  private readonly processBuckets = {
    routine: { since: 0, count: 0, suppressed: 0 },
    slow: { since: 0, count: 0, suppressed: 0 },
    failed: { since: 0, count: 0, suppressed: 0 },
  };
  // A single fixed reserve for original database owner lifecycle. Display
  // polling and ordinary transactions cannot hide retirement or actual exit. This
  // is not a per-owner budget and cannot consume the process shutdown reserve.
  private readonly databaseOwnerLifecycleBuckets = {
    routine: { since: 0, count: 0, suppressed: 0 },
    slow: { since: 0, count: 0, suppressed: 0 },
    failed: { since: 0, count: 0, suppressed: 0 },
  };
  // A fixed admission-refusal reserve: failed close attempts across retained
  // owners must not consume the capacity/acquisition refusal diagnosis. This
  // remains globally bounded, not an unbounded per-file logging budget.
  private readonly startupOwnerBuckets = {
    routine: { since: 0, count: 0, suppressed: 0 },
    slow: { since: 0, count: 0, suppressed: 0 },
    failed: { since: 0, count: 0, suppressed: 0 },
  };
  // Historical IO wait/settlement has one fixed reserve, independent of
  // ordinary polling and database/process shutdown. Never a per-path budget.
  private readonly rolloutOwnerBuckets = {
    routine: { since: 0, count: 0, suppressed: 0 },
    slow: { since: 0, count: 0, suppressed: 0 },
    failed: { since: 0, count: 0, suppressed: 0 },
  };
  // One process-wide bounded reserve for request authority refusal and auth
  // persistence pending/unknown outcomes. Unrelated fault traffic cannot hide
  // why a cookie or buffered Hub response was refused. Successful checks still
  // use ordinary sampling; this cannot acknowledge SQL or authorize recovery.
  private readonly authorityFailureBucket = { since: 0, count: 0, suppressed: 0 };
  // One fixed transport-lifecycle reserve. Routine chat traffic cannot hide
  // a pending drain or its actual settlement; never a per-chat bypass.
  private readonly quickChatDrainBuckets = {
    routine: { since: 0, count: 0, suppressed: 0 },
    slow: { since: 0, count: 0, suppressed: 0 },
    failed: { since: 0, count: 0, suppressed: 0 },
  };
  constructor(private readonly sink: (line: string) => void = line => console.info(line),
    private readonly clock: () => number = () => performance.now()) {}

  private readingClock = false;
  private readClock(): number {
    if (this.readingClock) return NaN;
    this.readingClock = true;
    try { return this.clock(); }
    finally { this.readingClock = false; }
  }

  start(operation: Operation): PerformanceTrace {
    let started = NaN;
    try { started = this.readClock(); } catch { /* Best effort only. */ }
    const sequence = ++this.sequence, values: Partial<Record<Metric, number>> = {};
    let finished = false;
    const emit = (phase: 'pending' | 'finished', failed: boolean, snapshot?: Partial<Record<Metric, number>>) => {
      try {
        if (!operations.includes(operation)) return;
        const now = this.readClock(), elapsedMs = Math.max(0, now - started);
        if (!Number.isFinite(elapsedMs)) return;
        // An unresolved operation must not disappear behind routine polling.
        const category = failed || phase === 'pending' ? 'failed' : elapsedMs >= (operation === 'rollout-read' ? 250 : 50) ? 'slow' : 'routine';
        const processBoundary = operation === 'process-startup' || operation === 'process-shutdown';
        const observed = { ...values };
        for (const [key, value] of Object.entries(snapshot ?? {})) {
          if (metrics.includes(key as Metric) && typeof value === 'number' && Number.isFinite(value) && value >= 0) {
            observed[key as Metric] = Math.min(Number.MAX_SAFE_INTEGER, value);
          }
        }
        const databaseOwnerLifecycle = ((operation === 'auth-display-read' || operation === 'hub-delivery-read' || operation === 'hub-preference-read' || operation === 'hub-users-read' || operation === 'hub-workspace-revisions-read')
          && (observed.step === 3 || observed.step === 4 || observed.step === 6 || observed.step === 7 || observed.step === 8))
          || (operation === 'maintenance-journal-owner' && (observed.step === 1 || observed.step === 2 || observed.step === 3))
          || operation === 'hub-member-sqlite-owner' || operation === 'connector-sqlite-owner' || operation === 'hub-connection-change' || operation === 'auth-sqlite-owner' || operation === 'auth-sqlite-owner-failure' || operation === 'codex-stopped-recovery-owner' || operation === 'readonly-sql-owner-failure' || operation === 'maintenance-sql-owner-failure' || operation === 'storage-admission-release-recovery' || operation === 'storage-coordinator-recovery' || operation === 'storage-startup-owner' || operation === 'storage-startup-admission' || operation === 'storage-startup-cleanup'
          || operation === 'codex-stopped-unknown-owner'
          || operation === 'auth-current-key-binding' || operation === 'hub-maintenance-effect' || operation === 'hub-shared-creation-effect' || operation === 'hub-issuer-management-effect'
          || (operation === 'connector-token-owner' && (observed.step === 1 || observed.step === 2 || observed.step === 4))
          // Read polling must not hide the stage that refused process readiness.
          // Reuse the bounded owner budget; this is not an unthrottled sink.
          || (category === 'failed' && (operation === 'combined-application-layer' || operation === 'connector-runtime-assembly'));
        const rolloutOwnerLifecycle = ((operation === 'codex-projection' || operation === 'codex-startup') && (observed.step === 1 || observed.step === 6 || category === 'failed'))
          || operation === 'rollout-snapshot-wait' || operation === 'rollout-reader-close' || operation === 'codex-interrupt-observation' || operation === 'codex-final-history' || operation === 'codex-dispatch' || operation === 'codex-native-effect' || operation === 'hub-session-guidance'
          || operation === 'codex-session-deletion' || operation === 'hermes-execution-protection' || operation === 'hermes-runtime-close' || operation === 'hermes-session-deletion' || operation === 'hermes-session-creation' || operation === 'codex-session-creation' || operation === 'hermes-message-stop' || operation === 'hermes-lifecycle';
        const authorityFailure = category === 'failed' && (operation === 'hub-connector-user-http' || operation === 'connector-event-stream' || operation === 'connector-event-projection' || operation === 'hub-request-authority' || operation === 'connector-users-http' || operation === 'connector-grants-http' || operation === 'connector-storage-maintenance'
          || operation === 'hub-member-sqlite-command' || operation === 'connector-sqlite-command' || operation === 'hub-user-change' || operation === 'hub-connector-user-change' || operation === 'hub-connection-mutation' || operation === 'auth-route-persistence' || operation === 'auth-sqlite-command' || operation === 'auth-compatibility-check' || operation === 'session-preference-change' || operation === 'session-read-request');
        const quickChatDrain = (operation === 'hub-quick-chat' && observed.step === 17)
          || (operation === 'hub-event-broker' && observed.step === 4);
        // Local feed retirement/refusal remains queryable in the bounded ring,
        // but must not consume the global shutdown drain's reserved budget.
        const eventFeedLifecycle = operation === 'hub-event-broker' && (observed.step === 5 || observed.step === 6 || observed.step === 7 || observed.step === 8);
        const bucket = authorityFailure ? this.authorityFailureBucket : (processBoundary ? this.processBuckets : quickChatDrain ? this.quickChatDrainBuckets : rolloutOwnerLifecycle ? this.rolloutOwnerBuckets : operation === 'storage-startup-owner' || operation === 'storage-startup-admission' ? this.startupOwnerBuckets
          : databaseOwnerLifecycle ? this.databaseOwnerLifecycleBuckets : this.buckets)[category];
        if (now - bucket.since >= 60_000 || now < bucket.since) { bucket.since = now; bucket.count = 0; }
        const rounded = Object.fromEntries(Object.entries(observed).map(([key, value]) => [key, Math.round(value! * 100) / 100]));
        const event: Observation = { component: 'agentopsdeck-performance', instance: this.instance, sequence,
          processId: process.pid, threadId,
          startedAtUnixMs: Math.floor(performance.timeOrigin + started),
          observedAtUnixMs: Math.floor(performance.timeOrigin + now),
          operation, phase, category, elapsedMs: Math.round(elapsedMs * 100) / 100,
          ...rounded, suppressed: bucket.suppressed, delivery: 'not-attempted' };
        this.count('observations');
        if (phase === 'pending') this.count('pending');
        else { this.count('finished'); if (failed) this.count('failed'); }
        if ((observed.unknown ?? 0) > 0) this.count('unknownObservations');
        // Preserve bounded recovery evidence before rate limiting or a failing
        // output sink. Routine traffic cannot evict pending/failure/slow events.
        // A successful HTTP response can still represent an unresolved provider
        // outcome. Retain that recovery evidence, not every routine chat read.
        const quickChatUnknown = operation === 'hub-quick-chat' && (observed.unknown ?? 0) > 0;
        // Original transport drain is lifecycle evidence even when it finishes
        // quickly. Keep its real acknowledgement after ordinary chat polling.
        if (processBoundary || rolloutOwnerLifecycle || databaseOwnerLifecycle || quickChatUnknown || quickChatDrain || eventFeedLifecycle || category !== 'routine' || this.recent.some(previous => previous.sequence === sequence && previous.phase === 'pending')) {
          if (this.recent.length === RECOVERY_OBSERVATION_LIMIT) this.recent.shift();
          this.recent.push(event);
        }
        if (bucket.count >= (category === 'routine' ? 20 : 60)) {
          bucket.suppressed = Math.min(Number.MAX_SAFE_INTEGER, bucket.suppressed + 1);
          event.delivery = 'rate-limited'; this.count('suppressed'); return;
        }
        bucket.count++;
        try {
          const { delivery: _delivery, ...line } = event;
          this.sink(JSON.stringify(line));
          event.delivery = 'delivered';
          bucket.suppressed = 0;
        } catch { event.delivery = 'failed'; this.count('sinkFailures'); }

      } catch { /* Observation cannot replace a read, commit or rollback result. */ }
    };
    return {
      add: (metric, value) => {
        if (finished || !metrics.includes(metric) || !Number.isFinite(value) || value < 0) return;
        values[metric] = Math.min(Number.MAX_SAFE_INTEGER, (values[metric] ?? 0) + value);
      },
      reportPending: snapshot => { if (!finished) emit('pending', false, snapshot); },
      finish: (failed = false) => {
        if (finished) return;
        finished = true;
        emit('finished', failed);
      },
    };
  }
}

export const performanceDiagnostics = new PerformanceDiagnostics();
