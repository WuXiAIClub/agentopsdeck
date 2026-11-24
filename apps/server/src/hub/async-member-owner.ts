import { validHubFileBindingReply, type HubFileBindingCommand } from './member-file-binding-domain.js';
import { matchesWeixinBindingEffectReply, type WeixinBindingEffectOwner } from './member-weixin-domain.js';
import { matchesWeixinBackgroundReply, type WeixinBackgroundOwner } from './weixin-background-domain.js';
import { nativeFileExpectation, validHubNativeFileReply } from './member-native-file-domain.js';
import { validHubLifecycleReply, type HubLifecycleCommand } from './member-lifecycle-domain.js';
import { validHubMaintenanceReply, type HubMaintenanceCommand } from './member-maintenance-domain.js';
import { createHash } from 'node:crypto';
import { matchesContentBackgroundReply, type ContentBackgroundOwner } from './content-background-domain.js';
import {matchesNativeFileBackgroundReply, type NativeFileBackgroundOwner} from './native-file-background-domain.js';
import { safeEqual } from '../auth/access-key.js';
import { matchesConnectionControlSettlement, type ConnectionControlSettlementOwner } from './member-connection-control-domain.js';
import { AuthPersistenceError } from '../auth/private-store.js';
import { AuthCurrentKeyBinding, type CurrentKeyBindingResult } from '../auth/current-key-binding.js';
import type { SqliteAuthRouteOwner } from '../auth/async-sqlite-route-port.js';
import { SQLITE_AUTH_COMMAND_BYTES, SQLITE_AUTH_RESULT_BYTES, sqliteAuthKinds, type SqliteAuthKind,
  type SqliteAuthCommands, sqliteAuthRefusalError, sqliteAuthRefusal } from '../auth/sqlite-owner-domain.js';
import { validHubLegacyAuthCommand, validHubLegacyAuthResult, type HubLegacyAuthCommand,
  type HubLegacyAuthResult } from './legacy-auth-domain.js';
import type { OriginalJsonSessionInput, OriginalJsonEvidence } from '../auth/original-json-command-domain.js';
import { hubNotebookReplyExpectation, validHubNotebookReply, type HubNotebookReplyExpectation } from './member-notebook-domain.js';
import { hubNotebookControlExpectation, validHubNotebookControlReply } from './member-notebook-control-domain.js';
import { notebookMachineExpectation, validHubNotebookMachineReply } from './member-notebook-machine-domain.js';
import { Worker } from 'node:worker_threads';
import type { ApplicationTransactionAuthEndpoint } from '../auth/application-transaction-gate.js';
import { hubBoardMachineReplyExpectation, validHubBoardMachineReply,
  type HubBoardMachineReplyExpectation } from './member-board-machine-domain.js';
import { hubBoardCapabilityReplyExpectation, validHubBoardCapabilityReply,
  type HubBoardCapabilityReplyExpectation } from './member-board-capability-domain.js';
import { hubBoardReplyExpectation, validHubBoardReply, type HubBoardReplyExpectation } from './member-board-domain.js';
import { validHubReportReply } from './member-report-domain.js';
import { validHubProjectionReply, type HubProjectionCommand } from './member-projection-domain.js';
import { hubConfigurationExpectation, validHubConfigurationReply, type HubConfigurationExpectation } from './member-configuration-domain.js';
import { hubVisualExpectation, validHubVisualReply, type HubVisualExpectation } from './member-visual-domain.js';
import { validHubExecutionIssuerReply, type HubExecutionIssuerCommand } from './member-execution-issuer-domain.js';
import { validHubOwnerControlReply, type HubOwnerControlCommand } from './member-owner-control-domain.js';
import { validHubConnectorAccessReply, type HubConnectorAccessCommand } from './member-connector-access-domain.js';
import { validHubSharedDirectoryReply, type HubSharedDirectoryCommand } from './member-shared-directory-domain.js';
import { validHubExecutionLeaseReply, type HubExecutionLeaseCommand } from './member-execution-lease-domain.js';
import { validHubQuickChatCleanupReply, type HubQuickChatCleanupCommand } from './member-quick-chat-cleanup-domain.js';
import { validHubEventReplayReply, type HubEventReplayCommand } from './member-event-replay-domain.js';
import { validEventFeedOwner, validHubEventFeedReply, type HubEventFeedInput, type HubEventFeedOwner } from './event-feed-domain.js';
import { validHubQuickChatStateReply, type HubQuickChatStateCommand } from './member-quick-chat-state-domain.js';
import { hubGuidanceReplyExpectation, validHubGuidanceReply, type HubGuidanceReplyExpectation } from './member-guidance-domain.js';
import { validHubSessionSharingReply, type HubSessionSharingCommand } from './member-session-sharing-domain.js';
import { validHubOwnedSessionSharingReply, type HubOwnedSessionSharingCommand } from './member-owned-session-sharing-domain.js';
import { validHubSessionCollaboratorReply, type HubSessionCollaboratorCommand } from './member-session-collaborators-domain.js';
import { validHubCreationDiscoveryReply, type HubCreationDiscoveryCommand } from './member-creation-discovery-domain.js';
import { validHubReceivedGrantReply, type HubReceivedGrantCommand } from './member-received-grants-domain.js';
import { resolve } from 'node:path';
import { types } from 'node:util';
import { HubMemberOwnerUnavailable } from './member-owner-domain.js';
import { startupDatabaseOwners } from '../storage/startup-owner.js';
import { validHubExecutionCommandReply, type HubExecutionCommand } from './member-execution-command-domain.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { createOriginalWorkerStop } from '../storage/original-worker-stop.js';
import { hubConnectionReplyExpectation, validHubConnectionReply, type HubConnectionReplyExpectation } from './member-connection-change-domain.js';
import { hubRoleReplyExpectation, validHubRoleReply, type HubRoleReplyExpectation } from './member-role-domain.js';
import { validHubAccessDirectoryReply } from './member-access-directory-domain.js';
import { hubMembershipReplyExpectation, validHubMembershipReply, type HubMembershipCommand } from './member-membership-domain.js';
import { hubGrantReplyExpectation, validHubGrantReply, type HubGrantCommand } from './member-grant-domain.js';
import { encodeHubEventJson } from './member-event-domain.js';
import { hubMemberKinds, hubMemberCommandSteps, validHubMemberInput, validHubMemberOutput, HUB_MEMBER_COMMAND_BYTES,
  hubMemberOwnerConfig, HUB_MEMBER_CONFIG_BYTES, type HubMemberOwnerConfig,
  hubMemberResultBytes, hubMemberResultBudget, hubMemberCommandBytes, hubMemberCommandBudget, hubMemberCommandNodes, hubMemberCommandArrayLength,
  type HubMemberCommands, type HubMemberKind } from './member-owner-domain.js';

export type { HubMemberOwnerConfig } from './member-owner-domain.js';
type Kind = HubMemberKind | 'close';
type ResultAdmission = { workspace: boolean; bytes: number; budget: number; reserved: boolean;
  ready: Promise<void>; resolve(): void; reject(error: Error): void };
interface ReplyReservation { resultLimit?: number; storageAction?: string; notebookMachineReply?: ReturnType<typeof notebookMachineExpectation> }
type ExecutionLeaseWaiter = { maintenanceReply?: HubMaintenanceCommand; lifecycleReply?: HubLifecycleCommand; executionCommandReply?: HubExecutionCommand; fileBindingReply?: HubFileBindingCommand; reportReply?: string; projectionReply?: HubProjectionCommand; configurationReply?: HubConfigurationExpectation; visualReply?: HubVisualExpectation; notebookControlReply?: ReturnType<typeof hubNotebookControlExpectation>; sharedDirectoryReply?: HubSharedDirectoryCommand; notebookReply?: HubNotebookReplyExpectation; boardMachineReply?: HubBoardMachineReplyExpectation; boardCapabilityReply?: HubBoardCapabilityReplyExpectation; boardReply?: HubBoardReplyExpectation; executionIssuerReply?: HubExecutionIssuerCommand; executionLeaseReply?: HubExecutionLeaseCommand; connectorAccessReply?: HubConnectorAccessCommand; ownerControlReply?: HubOwnerControlCommand };
type Waiter = ExecutionLeaseWaiter & { nativeFileReply?: ReturnType<typeof nativeFileExpectation>; eventFeedReply?: HubEventFeedInput; eventReplay?: HubEventReplayCommand; kind: Kind; authReply?: HubLegacyAuthCommand['kind']; quickChatCleanupReply?: HubQuickChatCleanupCommand; quickChatReply?: HubQuickChatStateCommand; guidanceReply?: HubGuidanceReplyExpectation; ownedSharingReply?: HubOwnedSessionSharingCommand; sharingReply?: HubSessionSharingCommand; collaboratorReply?: HubSessionCollaboratorCommand; creationReply?:HubCreationDiscoveryCommand; receivedReply?: HubReceivedGrantCommand; connectionReply?: HubConnectionReplyExpectation; roleReply?: HubRoleReplyExpectation; membershipReply?: HubMembershipCommand; grantReply?: HubGrantCommand; directoryScope?: string; resolve(value: unknown): void; reject(error: Error): void };

/** Copy data using descriptors before serialization. Never invoke a caller's
 * getter/toJSON/then or serialize a callback. Byte/depth/shape limits apply
 * before invoking an owner; oversized old records fail rather than truncate. */
export function encodeHubMemberJson(value: unknown, maximum: number, maximumNodes = 16_384, maximumArrayLength = 8192): string {
  let bytes = 0, nodes = 0;
  const active = new Set<object>();
  const copy = (v: unknown, depth: number): unknown => {
    if (depth > 32 || ++nodes > maximumNodes) throw new HubMemberOwnerUnavailable();
    if (typeof v === 'string') { bytes += Buffer.byteLength(v); if (bytes > maximum) throw new HubMemberOwnerUnavailable(); return v; }
    if (v === null || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)) return v;
    // Descriptor/prototype inspection is safe for plain objects, but runs
    // arbitrary traps on a Proxy (including a revoked one). Reject before any
    // inspection, including Array.isArray, for every nested input and config.
    if (!v || typeof v !== 'object' || types.isProxy(v) || active.has(v)) throw new HubMemberOwnerUnavailable();
    const array = Array.isArray(v), prototype = Object.getPrototypeOf(v);
    if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) throw new HubMemberOwnerUnavailable();
    const properties = Object.getOwnPropertyDescriptors(v);
    if (Reflect.ownKeys(properties).some(key => typeof key !== 'string')) throw new HubMemberOwnerUnavailable();
    active.add(v);
    try {
      if (array) {
        const length = properties.length!.value as number;
        if (length > maximumArrayLength || Object.keys(properties).length !== length + 1) throw new HubMemberOwnerUnavailable();
        const result: unknown[] = [];
        for (let i = 0; i < length; i++) {
          const descriptor = properties[String(i)];
          if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new HubMemberOwnerUnavailable();
          result.push(copy(descriptor.value, depth + 1));
        }
        return result;
      }
      const result: Record<string, unknown> = Object.create(null);
      for (const [key, descriptor] of Object.entries(properties)) {
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new HubMemberOwnerUnavailable();
        bytes += Buffer.byteLength(key); if (bytes > maximum) throw new HubMemberOwnerUnavailable();
        result[key] = copy(descriptor.value, depth + 1);
      }
      return result;
    } finally { active.delete(v); }
  };
  try {
    const body = JSON.stringify(copy(value, 0));
    if (Buffer.byteLength(body) > maximum) throw new HubMemberOwnerUnavailable();
    return body;
  } catch { throw new HubMemberOwnerUnavailable(); }
}

/** Initial typed member-identity surface of a COMPLETE HubStore worker.
 * Hub-only application-enabled; all-role must migrate shared local runtime
 * callers before activation. Never instantiate next to a synchronous HubStore.
 * Shared reservations fence member workers and legacy synchronous connections
 * in this process, not separate processes. No administrator fallback.
 * Warnings do not release slots, cancel writes or retry commands. */
export class AsyncHubMemberOwner {
  private readonly keyBinding: AuthCurrentKeyBinding;
  /** Fixed constructor-bound original Auth capability. No replacement owner,
   * browser grant, lifecycle API or mutable digest crosses this boundary. */
  readonly legacyAuth: SqliteAuthRouteOwner | undefined;
  private readonly worker: Worker;
  private readonly ready: Promise<void>;
  private readonly exited: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readyReceived = false;
  private readonly needsMetadata: boolean;
  private readyMetadata: Readonly<{ hubId: string }> | undefined;
  get metadata(): Readonly<{ hubId: string }> {
    if (!this.readyReceived || !this.readyMetadata || this.failed || this.closing) throw new HubMemberOwnerUnavailable();
    return this.readyMetadata;
  }
  private sequence = 0;
  private failed = false;
  private failureCode: number | undefined;
  private closing = false;
  private closeWork: Promise<void> | undefined;
  private retirementWork: Promise<void> | undefined;
  private closeAcknowledged = false;
  private exitConfirmed = false;
  private startupWarning: ReturnType<typeof setTimeout> | undefined;
  private readonly originalStop: ReturnType<typeof createOriginalWorkerStop>;
  private acceptedBytes = 0;
  private acceptedResultBytes = 0;
  // Workspace documents have a separate 48MiB worst-case reply reservation.
  // Charging them against the ordinary 32MiB pool starves both directions:
  // even one small member read excludes a workspace read, and vice versa.
  // Keep both existing caps; total reserved replies remain bounded at 80MiB.
  private acceptedWorkspaceResultBytes = 0;
  private readonly resultAdmissions: ResultAdmission[] = [];
  private readonly pending = new Map<number, Waiter & ReplyReservation>();
  private readonly accepted = new Set<Promise<unknown>>();
  constructor(config: HubMemberOwnerConfig, private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics,
    launch?: () => Worker, private readonly warningMs = 30_000, transactionPeer?: ApplicationTransactionAuthEndpoint) {
    if (launch && transactionPeer) throw new HubMemberOwnerUnavailable();
    if (!Number.isSafeInteger(warningMs) || warningMs < 1 || warningMs > 2_147_483_647) throw new HubMemberOwnerUnavailable();
    this.keyBinding = new AuthCurrentKeyBinding(diagnostics, warningMs);
    const copied = hubMemberOwnerConfig(JSON.parse(encodeHubMemberJson(config, HUB_MEMBER_CONFIG_BYTES)));
    this.needsMetadata = copied.bootstrap !== undefined;
    // Pin both admission and worker I/O to the constructor's cwd. The worker
    // starts asynchronously and cannot inherit a later process.chdir target.
    copied.file = resolve(copied.file);
    const boundDigest = copied.auth && copied.administratorKey
      ? createHash('sha256').update(copied.administratorKey).digest('hex') : undefined;
    this.legacyAuth = copied.auth ? Object.freeze({
      assertAccessKeyBinding: (digest: string | undefined) => {
        if ((digest === undefined && boundDigest === undefined
          || typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest) && boundDigest !== undefined
          && safeEqual(digest, boundDigest)) && !this.failed && !this.closing && !this.exitConfirmed) return;
        try {
          const trace = this.diagnostics.start('auth-sqlite-owner');
          trace.add('step', 6); trace.add('deferred', 1); trace.add('pending', this.accepted.size); trace.finish(true);
        } catch { /* Diagnostics can never authorize a mismatched adapter. */ }
        throw new AuthPersistenceError();
      },
      snapshot: () => this.snapshot(),
      currentKeyBinding: Object.freeze({ capture: () => this.keyBinding.capture(),
        assertCurrent: (epoch: number) => this.keyBinding.assertCurrent(epoch) }),
      command: <K extends SqliteAuthKind>(kind: K, input: SqliteAuthCommands[K]['input']) => this.authCommand(kind, input),
      ...(copied.auth.kind === 'json' ? { originalJson: Object.freeze({
        session: async (input: OriginalJsonSessionInput) => (await this.command('legacyAuth', { kind: 'originalJsonSession', input })).value as boolean,
        authorized: async (input: OriginalJsonEvidence) => (await this.command('legacyAuth', { kind: 'originalJsonAuthorized', input })).value as boolean,
      }) } : {}),
    }) : undefined;
    if (copied.auth?.kind === 'json') {
      copied.auth.passkeysFile = resolve(copied.auth.passkeysFile);
      copied.auth.sessionsFile = resolve(copied.auth.sessionsFile);
    } else if (copied.auth) {
      copied.auth.file = resolve(copied.auth.file);
      copied.auth.legacyFiles = copied.auth.legacyFiles.map(p => resolve(p));
    }
    if (copied.bootstrap) {
      for (const field of ['hidden', 'archived', 'pinned'] as const) {
        copied.bootstrap.legacyPreferences[field] = resolve(copied.bootstrap.legacyPreferences[field]);
      }
    }
    const source = new URL(import.meta.url).pathname.endsWith('.ts');
    const entry = new URL(source ? './member-owner-worker.ts' : './member-owner-worker.js', import.meta.url);
    const releases: (() => void)[] = [];
    const releaseOwner = () => { for (const release of releases) release(); };
    try {
      releases.push(startupDatabaseOwners.reserveExclusive(copied.file));
      if (copied.auth?.kind === 'json') {
        releases.push(startupDatabaseOwners.reserveExclusive(copied.auth.passkeysFile));
        releases.push(startupDatabaseOwners.reserveExclusive(copied.auth.sessionsFile));
      } else if (copied.auth) releases.push(startupDatabaseOwners.reserveExclusive(copied.auth.file));
      if (copied.bootstrap?.ownLocalPreferences) {
        if (!copied.auth) throw new HubMemberOwnerUnavailable();
        for (const file of Object.values(copied.bootstrap.legacyPreferences)) {
          releases.push(startupDatabaseOwners.reserveExclusive(file));
        }
      }
    } catch { releaseOwner(); this.observeAdmissionRefusal(); throw new HubMemberOwnerUnavailable(); }
    try {
      this.worker = launch ? launch() : new Worker(`(async () => {
      const { workerData } = require('node:worker_threads');
      if (workerData.loader) { const { tsImport } = await import(workerData.loader); await tsImport(workerData.entry, workerData.entry); }
      else await import(workerData.entry);
    })().catch(() => process.exit(1));`, { eval: true, execArgv: [], workerData: {
      ...copied, entry: entry.href, loader: source ? import.meta.resolve('tsx/esm/api') : undefined,
      ...(transactionPeer ? { applicationTransactionPort: transactionPeer.data, applicationTransactionLifetime: transactionPeer.lifetime } : {}),
      }, ...(transactionPeer ? { transferList: [transactionPeer.data, transactionPeer.lifetime] } : {}) });
    } catch {
      // A throwing native constructor did not return a worker. After a worker
      // exists, ONLY its real exit may release the original reservation.
      releaseOwner(); throw new HubMemberOwnerUnavailable();
    }
    this.originalStop = createOriginalWorkerStop(this.worker, () => this.observeOwner(4, 9));
    this.ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    void this.ready.catch(() => {});
    this.exited = new Promise<void>(resolve => this.worker.once('exit', code => {
      this.exitConfirmed = true;
      if (transactionPeer) transactionPeer.retire(releaseOwner); else releaseOwner();
      this.originalStop.confirmExit();
      if (!this.closing || !this.closeAcknowledged || code !== 0) this.fail(3);
      this.observeOwner(2, this.failureCode); resolve();
    }));
    this.worker.on('error', () => this.fail(2));
    this.worker.on('message', (message: unknown) => this.receive(message));
    this.startupWarning = setTimeout(() => this.observeOwner(0), warningMs); this.startupWarning.unref();
  }
  private observeAdmissionRefusal() {
    try {
      const trace = this.diagnostics.start('hub-member-sqlite-owner');
      trace.add('step', 7); trace.add('deferred', 1); trace.finish(true);
    } catch { /* Observation cannot admit or retire a database owner. */ }
  }
  snapshot() {
    return { scope: 'process' as const, pending: this.pending.size, accepted: this.accepted.size,
      acceptedBytes: this.acceptedBytes, acceptedResultBytes: this.acceptedResultBytes,
      ready: this.readyReceived, unavailable: this.failed,
      closing: this.closing, closeAcknowledged: this.closeAcknowledged, ownerExitConfirmed: this.exitConfirmed };
  }
  open() { return this.ready; }
  private observeOwner(step: number, cause?: number) {
    try {
      const trace = this.diagnostics.start('hub-member-sqlite-owner'); trace.add('step', step);
      trace.add('pending', step === 5 ? Math.max(this.pending.size, this.accepted.size) : this.pending.size);
      if (cause !== undefined) trace.add('ownerFailureCode', cause);
      if (step !== 2 && step !== 3) trace.add('unknown', 1);
      trace.finish(cause !== undefined);
    } catch { /* Logs cannot authorize mutation, release or reopen. */ }
  }
  private fail(cause: number) {
    if (this.failed) return;
    this.failed = true; this.failureCode = cause;
    clearTimeout(this.startupWarning);
    this.rejectReady(new HubMemberOwnerUnavailable());
    for (const waiter of this.pending.values()) waiter.reject(new HubMemberOwnerUnavailable());
    this.pending.clear();
    for (const admission of this.resultAdmissions.splice(0)) admission.reject(new HubMemberOwnerUnavailable());
    this.observeOwner(1, cause);
    // No timed writer replacement, termination, reconnect or body replay.
  }
  private receive(message: unknown) {
    if (this.failed) return;
    const r = message as { kind?: Kind | 'ready'; metadata?: { hubId?: unknown }; id?: number; ok?: boolean; body?: string; refusal?: number; retryAfterSeconds?: number } | null;
    if (!r || typeof r !== 'object' || Array.isArray(r)) { this.fail(4); return; }
    if (!this.readyReceived) {
      const m = r.metadata;
      if (r.kind !== 'ready' || Object.keys(r).length !== (this.needsMetadata ? 2 : 1)
        || this.needsMetadata && (!m || typeof m !== 'object' || Array.isArray(m) || Object.keys(m).length !== 1
          || typeof m.hubId !== 'string' || !m.hubId || Buffer.byteLength(m.hubId) > 4096 || /[\x00-\x20\x7f]/.test(m.hubId))) { this.fail(4); return; }
      if (this.needsMetadata) this.readyMetadata = Object.freeze({ hubId: m!.hubId as string });
      this.readyReceived = true; clearTimeout(this.startupWarning); this.resolveReady(); this.observeOwner(3); return;
    }
    const waiter = Number.isSafeInteger(r.id) ? this.pending.get(r.id!) : undefined;
    const hasRefusal = !r.ok && waiter?.kind === 'legacyAuth' && Object.hasOwn(r, 'refusal');
    const keys = r.ok ? ['id', 'kind', 'ok', 'body'] : hasRefusal
      ? ['id', 'kind', 'ok', 'refusal', 'retryAfterSeconds'] : ['id', 'kind', 'ok'];
    if (!waiter || r.kind !== waiter.kind || typeof r.ok !== 'boolean'
      || Object.keys(r).length !== keys.length || !Object.keys(r).every(key => keys.includes(key))) { this.fail(4); return; }
    if (!r.ok) {
      let refusal: Error | undefined;
      if (hasRefusal) {
        if (!waiter.authReply || !sqliteAuthKinds.includes(waiter.authReply as SqliteAuthKind)
          || !(refusal = sqliteAuthRefusalError(waiter.authReply as SqliteAuthKind,
          { refusal: r.refusal!, retryAfterSeconds: r.retryAfterSeconds! } as Parameters<typeof sqliteAuthRefusalError>[1]))) {
          this.fail(4); return;
        }
      }
      this.pending.delete(r.id!); waiter.reject(refusal ?? new HubMemberOwnerUnavailable());
      if (waiter.kind === 'close') this.fail(10);
      return;
    }
    let value: unknown;
    try {
      if (typeof r.body !== 'string' || Buffer.byteLength(r.body) > (waiter.resultLimit ?? hubMemberResultBytes(waiter.kind))) throw new HubMemberOwnerUnavailable();
      value = JSON.parse(r.body);
      if (waiter.kind === 'close' ? value !== null : !validHubMemberOutput(waiter.kind, value)) throw new HubMemberOwnerUnavailable();
      if (waiter.authReply && (value as HubLegacyAuthResult).kind !== waiter.authReply) throw new HubMemberOwnerUnavailable();
      if (waiter.storageAction && value && typeof value === 'object' && 'action' in value
        && value.action !== waiter.storageAction) throw new HubMemberOwnerUnavailable();
      if (waiter.connectionReply && !validHubConnectionReply(waiter.connectionReply, value)) throw new HubMemberOwnerUnavailable();
      if (waiter.connectorAccessReply && !validHubConnectorAccessReply(waiter.connectorAccessReply, value)) throw new HubMemberOwnerUnavailable();
      if (waiter.eventFeedReply && !validHubEventFeedReply(waiter.eventFeedReply, value)) throw new HubMemberOwnerUnavailable();
      if (waiter.nativeFileReply && !validHubNativeFileReply(waiter.nativeFileReply, value)) throw new HubMemberOwnerUnavailable();
      if (waiter.sharedDirectoryReply && !validHubSharedDirectoryReply(waiter.sharedDirectoryReply, value)) throw new HubMemberOwnerUnavailable();
      if (waiter.ownerControlReply && !validHubOwnerControlReply(waiter.ownerControlReply, value)) throw new HubMemberOwnerUnavailable();
      if (waiter.maintenanceReply && !validHubMaintenanceReply(waiter.maintenanceReply, value)) throw new HubMemberOwnerUnavailable();
      if (waiter.eventReplay && !validHubEventReplayReply(waiter.eventReplay, value)) throw new HubMemberOwnerUnavailable();
      if (waiter.lifecycleReply && !validHubLifecycleReply(waiter.lifecycleReply, value)) throw new HubMemberOwnerUnavailable();
      if (waiter.executionCommandReply && !validHubExecutionCommandReply(waiter.executionCommandReply, value)) throw new HubMemberOwnerUnavailable();
      if (waiter.roleReply && !validHubRoleReply(waiter.roleReply, value)) throw new HubMemberOwnerUnavailable();
      if (waiter.directoryScope && !validHubAccessDirectoryReply(waiter.directoryScope, value)) throw new HubMemberOwnerUnavailable();
      if (waiter.membershipReply && !validHubMembershipReply(waiter.membershipReply, value)) throw new HubMemberOwnerUnavailable();
      if (waiter.grantReply && !validHubGrantReply(waiter.grantReply, value)) throw new HubMemberOwnerUnavailable();
      if (waiter.executionLeaseReply && !validHubExecutionLeaseReply(waiter.executionLeaseReply,value)) throw new HubMemberOwnerUnavailable();
      if (waiter.notebookReply && !validHubNotebookReply(waiter.notebookReply, value)) throw new HubMemberOwnerUnavailable();
      if (waiter.notebookControlReply && !validHubNotebookControlReply(waiter.notebookControlReply, value)) throw new HubMemberOwnerUnavailable();
      if (waiter.boardReply && !validHubBoardReply(waiter.boardReply, value)) throw new HubMemberOwnerUnavailable();
      if (waiter.fileBindingReply && !validHubFileBindingReply(waiter.fileBindingReply, value)) throw new HubMemberOwnerUnavailable();
      if (waiter.reportReply !== undefined && !validHubReportReply(waiter.reportReply, value)) throw new HubMemberOwnerUnavailable();
      if (waiter.projectionReply && !validHubProjectionReply(waiter.projectionReply, value)) throw new HubMemberOwnerUnavailable();
      if (waiter.configurationReply && !validHubConfigurationReply(waiter.configurationReply, value)) throw new HubMemberOwnerUnavailable();
      if (waiter.visualReply && !validHubVisualReply(waiter.visualReply, value)) throw new HubMemberOwnerUnavailable();
      if (waiter.boardCapabilityReply && !validHubBoardCapabilityReply(waiter.boardCapabilityReply, value)) throw new HubMemberOwnerUnavailable();
      if (waiter.boardMachineReply && !validHubBoardMachineReply(waiter.boardMachineReply, value)) throw new HubMemberOwnerUnavailable();
      if (waiter.notebookMachineReply && !validHubNotebookMachineReply(waiter.notebookMachineReply, value)) throw new HubMemberOwnerUnavailable();
      if (waiter.executionIssuerReply && !validHubExecutionIssuerReply(waiter.executionIssuerReply,value)) throw new HubMemberOwnerUnavailable();
      if (waiter.receivedReply && !validHubReceivedGrantReply(waiter.receivedReply, value)) throw new HubMemberOwnerUnavailable();
      if (waiter.creationReply && !validHubCreationDiscoveryReply(waiter.creationReply,value)) throw new HubMemberOwnerUnavailable();
      if (waiter.collaboratorReply && !validHubSessionCollaboratorReply(waiter.collaboratorReply,value)) throw new HubMemberOwnerUnavailable();
      if (waiter.ownedSharingReply && !validHubOwnedSessionSharingReply(waiter.ownedSharingReply,value)) throw new HubMemberOwnerUnavailable();
      if (waiter.sharingReply && !validHubSessionSharingReply(waiter.sharingReply,value)) throw new HubMemberOwnerUnavailable();
      if (waiter.guidanceReply && !validHubGuidanceReply(waiter.guidanceReply,value)) throw new HubMemberOwnerUnavailable();
      if (waiter.quickChatReply && !validHubQuickChatStateReply(waiter.quickChatReply,value)) throw new HubMemberOwnerUnavailable();
      if (waiter.quickChatCleanupReply && !validHubQuickChatCleanupReply(waiter.quickChatCleanupReply,value)) throw new HubMemberOwnerUnavailable();
    } catch { this.fail(4); return; }
    this.pending.delete(r.id!);
    if (waiter.kind === 'close') this.closeAcknowledged = true;
    waiter.resolve(value);
  }
  private async send(kind: Kind, body: string): Promise<unknown> {
    const notebookMachineReply = kind === 'notebookMachine'
      ? notebookMachineExpectation(JSON.parse(body) as HubMemberCommands['notebookMachine']['input']) : undefined;
    const nativeFileReply = kind === 'nativeFile'
      ? nativeFileExpectation((JSON.parse(body) as HubMemberCommands['nativeFile']['input']).command) : undefined;
    const eventFeedReply = kind === 'eventFeed' ? JSON.parse(body) as HubEventFeedInput : undefined;
    const notebookControlReply = kind === 'notebookControl'
      ? hubNotebookControlExpectation((JSON.parse(body) as HubMemberCommands['notebookControl']['input']).command) : undefined;
    const notebookReply = kind === 'personalNotebook'
      ? hubNotebookReplyExpectation((JSON.parse(body) as HubMemberCommands['personalNotebook']['input']).command) : undefined;
    const boardMachineReply = kind === 'boardMachine'
      ? hubBoardMachineReplyExpectation(JSON.parse(body) as HubMemberCommands['boardMachine']['input']) : undefined;
    const ownerControlReply = kind === 'ownerControl' ? (JSON.parse(body) as HubMemberCommands['ownerControl']['input']).command : undefined;
    const maintenanceReply = kind === 'maintenanceCommand' ? (JSON.parse(body) as HubMemberCommands['maintenanceCommand']['input']).command : undefined;
    const eventReplay = kind === 'eventReplay' ? (JSON.parse(body) as HubMemberCommands['eventReplay']['input']).command : undefined;
    const lifecycleReply = kind === 'lifecycleCommand' ? (JSON.parse(body) as HubMemberCommands['lifecycleCommand']['input']).command : undefined;
    const executionCommandReply = kind === 'executionCommand' ? (JSON.parse(body) as HubMemberCommands['executionCommand']['input']).command : undefined;
    const connectorAccessReply = kind === 'connectorAccess' ? (JSON.parse(body) as HubMemberCommands['connectorAccess']['input']).command : undefined;
    const sharedDirectoryReply = kind === 'sharedDirectory' ? (JSON.parse(body) as HubMemberCommands['sharedDirectory']['input']).command : undefined;
    const executionLeaseReply = kind === 'executionLease' ? JSON.parse(body) as HubExecutionLeaseCommand : undefined;
    const boardReply = kind === 'workspaceBoard'
      ? hubBoardReplyExpectation((JSON.parse(body) as HubMemberCommands['workspaceBoard']['input']).command) : undefined;
    const fileBindingReply = kind === 'fileBindingRead' ? (JSON.parse(body) as HubMemberCommands['fileBindingRead']['input']).command : undefined;
    const reportReply = kind === 'workspaceReport' ? (JSON.parse(body) as HubMemberCommands['workspaceReport']['input']).command.resourceId : undefined;
    const projectionReply = kind === 'workspaceProjection'
      ? (JSON.parse(body) as HubMemberCommands['workspaceProjection']['input']).command : undefined;
    const configurationReply = kind === 'workspaceConfiguration'
      ? hubConfigurationExpectation((JSON.parse(body) as HubMemberCommands['workspaceConfiguration']['input']).command) : undefined;
    const visualReply = kind === 'workspaceVisual'
      ? hubVisualExpectation((JSON.parse(body) as HubMemberCommands['workspaceVisual']['input']).command) : undefined;
    const boardCapabilityReply = kind === 'boardCapability'
      ? hubBoardCapabilityReplyExpectation((JSON.parse(body) as HubMemberCommands['boardCapability']['input']).command) : undefined;
    const executionIssuerReply = kind === 'executionIssuer' ? JSON.parse(body) as HubExecutionIssuerCommand : undefined;
    const quickChatCleanupReply = kind === 'quickChatCleanup'
      ? (JSON.parse(body) as HubMemberCommands['quickChatCleanup']['input']).command : undefined;
    const quickChatReply = kind === 'quickChatState'
      ? (JSON.parse(body) as HubMemberCommands['quickChatState']['input']).command : undefined;
    const guidanceReply = kind === 'sessionGuidance'
      ? hubGuidanceReplyExpectation((JSON.parse(body) as HubMemberCommands['sessionGuidance']['input']).command) : undefined;
    const ownedSharingReply = kind === 'ownedSessionSharing' ? (JSON.parse(body) as HubMemberCommands['ownedSessionSharing']['input']).command : undefined;
    const sharingReply = kind === 'sessionSharing' ? (JSON.parse(body) as HubMemberCommands['sessionSharing']['input']).command : undefined;
    const collaboratorReply = kind === 'sessionCollaborators' ? (JSON.parse(body) as HubMemberCommands['sessionCollaborators']['input']).command : undefined;
    const creationReply = kind === 'creationEnvironments' ? { ...(JSON.parse(body) as HubMemberCommands['creationEnvironments']['input']).command } : undefined;
    const receivedReply = kind === 'receivedGrants' ? { ...(JSON.parse(body) as HubMemberCommands['receivedGrants']['input']).command } : undefined;
    const grantReply = kind === 'grantRead' || kind === 'grantChange'
      ? hubGrantReplyExpectation((JSON.parse(body) as HubMemberCommands['grantRead']['input'] | HubMemberCommands['grantChange']['input']).command) : undefined;
    const membershipReply = kind === 'membershipRead' || kind === 'membershipSet'
      ? hubMembershipReplyExpectation((JSON.parse(body) as HubMemberCommands['membershipRead']['input'] | HubMemberCommands['membershipSet']['input']).command) : undefined;
    const directoryScope = kind === 'accessDirectory' ? (JSON.parse(body) as HubMemberCommands['accessDirectory']['input']).expectedScope : undefined;
    const roleReply = kind === 'roleRead' || kind === 'roleSet'
      ? hubRoleReplyExpectation((JSON.parse(body) as HubMemberCommands['roleSet']['input'] | HubMemberCommands['roleRead']['input']).command) : undefined;
    // Extract only fixed action/ID from our already-owned validated JSON. Do
    // not retain credentials/body or a consumer object in the pending waiter.
    const connectionReply = kind === 'connectionTarget'
      ? { action: 'target' as const, id: (JSON.parse(body) as HubMemberCommands['connectionTarget']['input']).id }
      : kind === 'connectionChange'
        ? hubConnectionReplyExpectation((JSON.parse(body) as HubMemberCommands['connectionChange']['input']).change) : undefined;
    const authReply = kind === 'legacyAuth' ? (JSON.parse(body) as HubLegacyAuthCommand).kind : undefined;
    await this.ready;
    // Admission was already reserved by command(). Closing cannot turn an
    // accepted, startup-waiting original command into a new refusal.
    if (this.failed || this.exitConfirmed) throw new HubMemberOwnerUnavailable();
    if (this.sequence === Number.MAX_SAFE_INTEGER) { this.fail(7); throw new HubMemberOwnerUnavailable(); }
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { kind, ...(sharedDirectoryReply ? { sharedDirectoryReply } : {}), ...(ownerControlReply ? { ownerControlReply } : {}), ...(connectorAccessReply ? { connectorAccessReply } : {}), ...(executionLeaseReply ? { executionLeaseReply } : {}), ...(quickChatCleanupReply ? { quickChatCleanupReply } : {}), ...(quickChatReply ? { quickChatReply } : {}), ...(guidanceReply ? { guidanceReply } : {}), ...(ownedSharingReply ? { ownedSharingReply } : {}), ...(sharingReply ? { sharingReply } : {}), ...(collaboratorReply ? { collaboratorReply } : {}), ...(creationReply?{creationReply}:{}), ...(receivedReply ? { receivedReply } : {}), ...(connectionReply ? { connectionReply } : {}), ...(roleReply ? { roleReply } : {}), ...(directoryScope ? { directoryScope } : {}), ...(membershipReply ? { membershipReply } : {}), ...(grantReply ? { grantReply } : {}), resolve, reject });
      const waiter = this.pending.get(id);
      if (waiter && kind === 'storageMaintenance') waiter.storageAction = (JSON.parse(body) as HubMemberCommands['storageMaintenance']['input']).command.action;
      if (waiter && nativeFileReply) waiter.nativeFileReply = nativeFileReply;
      if (waiter && (kind === 'eventReplay' || kind === 'delegation' || kind === 'contentDocument' || kind === 'contentBackground' || kind === 'personalNotebook')) waiter.resultLimit = hubMemberResultBytes(kind, JSON.parse(body));
      if (waiter && authReply) waiter.authReply = authReply;
      if (waiter && notebookReply) waiter.notebookReply = notebookReply;
      if (waiter && boardReply) waiter.boardReply = boardReply;
      if (waiter && fileBindingReply) waiter.fileBindingReply = fileBindingReply;
      if (waiter && reportReply !== undefined) waiter.reportReply = reportReply;
      if (waiter && projectionReply) waiter.projectionReply = projectionReply;
      if (waiter && configurationReply) waiter.configurationReply = configurationReply;
      if (waiter && visualReply) waiter.visualReply = visualReply;
      if (waiter && boardCapabilityReply) waiter.boardCapabilityReply = boardCapabilityReply;
      if (waiter && notebookControlReply) waiter.notebookControlReply = notebookControlReply;
      if (waiter && boardMachineReply) waiter.boardMachineReply = boardMachineReply;
      if (waiter && notebookMachineReply) waiter.notebookMachineReply = notebookMachineReply;
      if (waiter && executionIssuerReply) waiter.executionIssuerReply = executionIssuerReply;
      if (waiter && maintenanceReply) waiter.maintenanceReply = maintenanceReply;
      if (waiter && eventReplay) waiter.eventReplay = eventReplay;
      if (waiter && eventFeedReply) waiter.eventFeedReply = eventFeedReply;
      if (waiter && lifecycleReply) waiter.lifecycleReply = lifecycleReply;
      if (waiter && executionCommandReply) waiter.executionCommandReply = executionCommandReply;
      try { this.worker.postMessage({ id, kind, body }); } catch { this.fail(6); }
    });
  }
  command<K extends HubMemberKind>(kind: K, input: HubMemberCommands[K]['input']): Promise<HubMemberCommands[K]['output']> {
    if (kind === 'weixinBackground' || kind === 'weixinBindingEffect' || kind === 'connectionControlSettlement' || kind === 'eventFeed' || kind === 'contentBackground' || kind === 'nativeFileBackground') return Promise.reject(new HubMemberOwnerUnavailable());
    return this.submit(kind, input);
  }
  /** Private service capability; never passed into request/member services. */
  weixinBackground(): WeixinBackgroundOwner {
    return Object.freeze({command: async (input: HubMemberCommands['weixinBackground']['input']) => {
      const result = await this.submit('weixinBackground', input);
      if (!matchesWeixinBackgroundReply(input,result)) throw new HubMemberOwnerUnavailable();
      return result;
    }});
  }
  weixinBindingEffect(): WeixinBindingEffectOwner {
    return Object.freeze({command: async (input: HubMemberCommands['weixinBindingEffect']['input']) => {
      const result = await this.submit('weixinBindingEffect', input);
      if (!matchesWeixinBindingEffectReply(input, result)) throw new HubMemberOwnerUnavailable();
      return result;
    }});
  }
  connectionControlSettlement(): ConnectionControlSettlementOwner {
    return Object.freeze({command: async (input: HubMemberCommands['connectionControlSettlement']['input']) => {
      const result = await this.submit('connectionControlSettlement', input);
      if (!matchesConnectionControlSettlement(input, result)) throw new HubMemberOwnerUnavailable();
      return result;
    }});
  }
  nativeFileBackground(): NativeFileBackgroundOwner {
    return Object.freeze({command: async (command: HubMemberCommands['nativeFileBackground']['input']) => {
      const result = await this.submit('nativeFileBackground', command);
      if (!matchesNativeFileBackgroundReply(command, result)) throw new HubMemberOwnerUnavailable();
      return result;
    }});
  }
  contentBackground(): ContentBackgroundOwner {
    return Object.freeze({ command: async (command: HubMemberCommands['contentBackground']['input']) => {
      const result = await this.submit('contentBackground', command);
      if (!matchesContentBackgroundReply(command,result)) throw new HubMemberOwnerUnavailable();
      return result;
    } });
  }
  eventFeed(ownerUserId: string): HubEventFeedOwner {
    if (!validEventFeedOwner(ownerUserId)) throw new HubMemberOwnerUnavailable();
    return Object.freeze({ command: (command: HubEventFeedInput['command']) => this.submit('eventFeed', { ownerUserId, command }) });
  }
  updateCurrentKeyIdentity(keyIdentityHash?: string): Promise<void> {
    if (!this.legacyAuth || this.closing || this.failed || this.exitConfirmed) return Promise.reject(new AuthPersistenceError());
    return this.keyBinding.update(keyIdentityHash, [...this.accepted], async input => {
      const reply = await this.submit('legacyAuth', { kind: 'currentKeyBinding', input }, true) as CurrentKeyBindingResult;
      return reply.value;
    });
  }
  private reserveResult(kind: HubMemberKind, bytes: number): ResultAdmission {
    let resolve!: () => void, reject!: (error: Error) => void;
    const ready = new Promise<void>((accepted, refused) => { resolve = accepted; reject = refused; });
    const admission = { workspace: kind === 'workspaceGet' || kind === 'workspaceSave', bytes,
      budget: hubMemberResultBudget(kind), reserved: false, ready, resolve, reject };
    this.resultAdmissions.push(admission);
    this.drainResults();
    return admission;
  }
  private drainResults() {
    if (this.failed || this.exitConfirmed) return;
    const blocked = new Set<boolean>();
    for (let index = 0; index < this.resultAdmissions.length;) {
      const admission = this.resultAdmissions[index]!;
      const reserved = admission.workspace ? this.acceptedWorkspaceResultBytes : this.acceptedResultBytes - this.acceptedWorkspaceResultBytes;
      if (blocked.has(admission.workspace) || reserved + admission.bytes > admission.budget) {
        blocked.add(admission.workspace); index++; continue;
      }
      this.resultAdmissions.splice(index, 1);
      admission.reserved = true;
      this.acceptedResultBytes += admission.bytes;
      if (admission.workspace) this.acceptedWorkspaceResultBytes += admission.bytes;
      admission.resolve();
    }
  }
  private submit<K extends HubMemberKind>(kind: K, input: HubMemberCommands[K]['input'], bindingUpdate = false): Promise<HubMemberCommands[K]['output']> {
    let body: string;
    let epoch: number | undefined;
    let refusalCode = 1;
    try {
      if (!bindingUpdate) epoch = this.keyBinding.capture();
      // Reject known exhaustion before inspecting caller-owned descriptors.
      // The post-copy check still accounts for the complete copied byte size.
      if (this.closing && !bindingUpdate || this.failed || this.exitConfirmed) throw new HubMemberOwnerUnavailable();
      refusalCode = 2;
      if (this.accepted.size >= 256) throw new HubMemberOwnerUnavailable();
      refusalCode = 3;
      if (this.acceptedBytes >= hubMemberCommandBudget(kind)) throw new HubMemberOwnerUnavailable();
      refusalCode = 4;
      if (!hubMemberKinds.includes(kind)) throw new HubMemberOwnerUnavailable();
      body = kind === 'eventAppend' ? encodeHubEventJson(input)
        : encodeHubMemberJson(input, hubMemberCommandBytes(kind), hubMemberCommandNodes(kind), hubMemberCommandArrayLength(kind));
      if (!validHubMemberInput(kind, JSON.parse(body))) {
        throw new HubMemberOwnerUnavailable();
      }
      if (!bindingUpdate && kind === 'legacyAuth' && (JSON.parse(body) as HubLegacyAuthCommand).kind === 'currentKeyBinding') {
        throw new HubMemberOwnerUnavailable();
      }
      // Keep the original lifecycle/capacity fence at the reservation boundary
      // as well; copying input never authorizes dispatch into a closing owner.
      refusalCode = 1;
      if (this.closing && !bindingUpdate || this.failed || this.exitConfirmed) throw new HubMemberOwnerUnavailable();
      refusalCode = 2;
      if (this.accepted.size >= 256) throw new HubMemberOwnerUnavailable();
      refusalCode = 3;
      if (this.acceptedBytes + Buffer.byteLength(body) > hubMemberCommandBudget(kind)) throw new HubMemberOwnerUnavailable();
      refusalCode = 5;
      if (hubMemberResultBytes(kind, JSON.parse(body)) > hubMemberResultBudget(kind)) throw new HubMemberOwnerUnavailable();
    } catch {
      // No dispatch occurred: capacity/closing/invalid input is a refusal,
      // not an unknown SQL write. Log only the fixed command number (0 for an
      // unknown name), never input, paths, token, exception text or getters.
      this.observeCommand(() => {
        const trace = this.diagnostics.start('hub-member-sqlite-command');
        trace.add('step', hubMemberKinds.includes(kind) ? hubMemberCommandSteps[kind] : 0); trace.add('deferred', 1);
        trace.add('admissionRefusalCode', refusalCode);
        trace.add('pending', this.accepted.size); trace.finish(true);
      });
      return Promise.reject(new HubMemberOwnerUnavailable());
    }
    const size = Buffer.byteLength(body);
    this.acceptedBytes += size;
    const resultSize = hubMemberResultBytes(kind, JSON.parse(body));
    const admission = this.reserveResult(kind, resultSize);
    // Reserve BOTH count and bytes before any diagnostic clock/sink can
    // reenter command() or close(). Start dispatch in the next microtask so
    // close snapshots include this original startup-waiting command too.
    const work = Promise.resolve().then(async () => {
      // Log boundaries only; never tokens, origins, IDs, SQL or error text.
      let trace: ReturnType<PerformanceDiagnostics['start']> | undefined;
      this.observeCommand(() => { trace = this.diagnostics.start('hub-member-sqlite-command'); });
      this.observeCommand(() => { trace?.add('step', hubMemberCommandSteps[kind]); trace?.add('admitted', 1); });
      const warning = setTimeout(() => this.observeCommand(() => { trace?.reportPending({ pending: 1 }); }), this.warningMs); warning.unref();
      let failed = true;
      let dispatched = false;
      try {
        const waitingSince = performance.now();
        await admission.ready;
        this.observeCommand(() => { trace?.add('queueMs', performance.now() - waitingSince); });
        dispatched = true;
        const value = await this.send(kind, body);
        if (epoch !== undefined) this.keyBinding.assertCurrent(epoch);
        failed = false; this.observeCommand(() => { trace?.add('settled', 1); });
        return value as HubMemberCommands[K]['output'];
      } catch (error) {
        const authKind = kind === 'legacyAuth' ? (JSON.parse(body) as HubLegacyAuthCommand).kind : undefined;
        const refusal = authKind && sqliteAuthKinds.includes(authKind as SqliteAuthKind) ? sqliteAuthRefusal(authKind as SqliteAuthKind, error) : undefined;
        this.observeCommand(() => { trace?.add(!dispatched || refusal ? 'deferred' : 'unknown', 1); });
        throw error;
      } finally { clearTimeout(warning); this.observeCommand(() => { trace?.finish(failed); }); }
    });
    this.accepted.add(work);
    const release = () => {
      this.accepted.delete(work); this.acceptedBytes -= size;
      if (admission.reserved) {
        this.acceptedResultBytes -= resultSize;
        if (admission.workspace) this.acceptedWorkspaceResultBytes -= resultSize;
      }
      this.drainResults();
    };
    void work.then(release, release);
    return work;
  }
  /** Original auth commands share this complete worker lifetime, never another
   * writer. Replies are bound to the requested subtype, not just its shape. */
  async authCommand<K extends SqliteAuthKind>(kind: K, input: SqliteAuthCommands[K]['input']): Promise<SqliteAuthCommands[K]['output']> {
    const reply = await this.command('legacyAuth', { kind, input } as HubLegacyAuthCommand);
    return reply.value as SqliteAuthCommands[K]['output'];
  }
  private observeCommand(action: () => void) {
    try { action(); } catch { /* Observation cannot dispatch, settle, release or replay the original command. */ }
  }
  close(): Promise<void> {
    if (this.closeWork) return this.closeWork;
    this.closing = true; // Freeze admission synchronously, before the first await.
    this.closeWork = (async () => {
      // Cover the whole original close, including an accepted command stuck
      // before its ACK or even before worker startup. Observation only; never
      // cancel, release or replay that command to make shutdown look complete.
      const warning = setTimeout(() => this.observeOwner(5), this.warningMs); warning.unref();
      try {
        await Promise.allSettled([...this.accepted, ...(this.keyBinding.pending ? [this.keyBinding.pending] : [])]);
        let failure = this.failed;
        if (!failure) {
          try { await this.send('close', '{}'); } catch { failure = true; }
        }
        // Cleanup only, after all original caller promises have settled. A
        // failed close dispatch/ACK needs the same cleanup as an earlier
        // transport failure. Never resend SQL, replace the owner or grant
        // business success from a physical termination request.
        if (failure || this.failed) this.requestOriginalStop();
        await this.exited;
        if (failure || this.failed || !this.closeAcknowledged) throw new HubMemberOwnerUnavailable();
      } finally { clearTimeout(warning); }
    })();
    void this.closeWork.catch(() => {});
    return this.closeWork;
  }
  private requestOriginalStop() {
    if (this.exitConfirmed || !this.closing || !this.failed) return;
    this.originalStop.request();
  }
  /** Shutdown-only physical proof. NOT a successful SQL close, command receipt,
   * COMMIT claim, authorization decision or permission to replay business work. */
  async closeForShutdown(): Promise<void> {
    try { await this.close(); }
    catch {
      if (!this.closing || !this.exitConfirmed || this.pending.size || this.accepted.size || this.acceptedBytes) throw new HubMemberOwnerUnavailable();
    }
  }

  /** Explicit shutdown-only retirement of THIS original owner, including a
   * stuck startup/command/close. Never called by a timeout or ordinary command
   * refusal. Freeze admission before yielding; retain the original close's
   * rejection and classify unacknowledged business work as unknown. This is
   * physical cleanup, NOT COMMIT/rollback proof, cancellation, permission to
   * retry, a successful SQL close or automatic replacement/reopen. Native SQL
   * can delay terminate: only the worker's real exit satisfies this promise. */
  retireForShutdown(): Promise<void> {
    if (this.retirementWork) return this.retirementWork;
    this.closing = true;
    // Reserve ownership before diagnostics can synchronously reenter us. Fail
    // the original transport waiters, not the original worker's SQL outcome.
    this.retirementWork = Promise.resolve().then(() => {
      if (!this.exitConfirmed) this.fail(11);
      return this.closeForShutdown();
    });
    void this.retirementWork.catch(() => {});
    return this.retirementWork;
  }
}
