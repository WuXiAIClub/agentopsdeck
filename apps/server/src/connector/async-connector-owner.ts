import { Worker } from 'node:worker_threads';
import type { ApplicationTransactionConnectorEndpoint, ApplicationTransactionAuthEndpoint } from '../auth/application-transaction-gate.js';
import { ChangeSignal } from '../utils/change-signal.js';
import { isConnectorHermesLifecycleKind, connectorHermesLifecycleReplyMatches, type ConnectorHermesLifecycleCommands } from './connector-hermes-lifecycle-domain.js';
import { isConnectorHermesHistoryKind, connectorHermesHistoryReplyMatches, type ConnectorHermesHistoryCommands } from './connector-hermes-history-domain.js';
import { isConnectorHermesDispatchKind, connectorHermesDispatchReplyMatches, type ConnectorHermesDispatchCommands } from './connector-hermes-dispatch-domain.js';
import { isConnectorHermesExecutionKind, connectorHermesReplyMatches, type HermesReplyExpectation } from './connector-hermes-execution-domain.js';
import { isConnectorHermesMessageKind } from './connector-hermes-message-domain.js';
import { isConnectorHermesReadKind, type HermesReadIdentity } from './connector-hermes-read-domain.js';
import { isConnectorOpenClawReadKind } from './connector-openclaw-read-domain.js';
import { isConnectorCodexReadKind } from './connector-codex-read-domain.js';
import { connectorCodexDispatchReplyMatches, type ConnectorCodexDispatchCommands } from './connector-codex-dispatch-domain.js';
import { isConnectorCodexQueuePlanKind, connectorCodexQueuePlanReplyMatches,
  type ConnectorCodexQueuePlanKind, type ConnectorCodexQueuePlanCommands } from './connector-codex-queue-plan-domain.js';
import type { RuntimeReadIdentity } from './connector-runtime-read-domain.js';
import { localCredentialsMatch, type LocalCredentialsCommands, type LocalCredentialBundle } from './local-credentials-domain.js';
import { connectorEventReplayMatches, type ConnectorEventReplay } from './connector-event-domain.js';
import { resolve } from 'node:path';
import { startupDatabaseOwners } from '../storage/startup-owner.js';
import { createOriginalWorkerStop } from '../storage/original-worker-stop.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ConnectorOwnerUnavailable, connectorOwnerConfig, connectorOwnerKinds, connectorOwnerSteps,
  encodeConnectorOwnerJson, encodeConnectorOwnerInput, validConnectorOwnerInput, validConnectorOwnerOutput,
  CONNECTOR_RESULT_BYTES, connectorOwnerResultBytes, connectorOwnerLargeResult, CONNECTOR_PENDING_LIMIT, CONNECTOR_PENDING_INPUT_BYTES, connectorOwnerCommandBytes, connectorOwnerLargeInput,
  type ConnectorOwnerConfig, type ConnectorOwnerKind, type ConnectorOwnerCommands } from './connector-owner-domain.js';
import { sessionRuntimeId } from '@agentopsdeck/shared';
import type { SdkAgentId, SdkCompactRef, SdkJournalSnapshot } from './sdk-execution-journal.js';
import { isConnectorSdkTranscriptKind, sameSdkTranscriptRef, type SdkTranscriptAck } from './connector-sdk-transcript-domain.js';
import { isConnectorSdkInteractionKind } from './connector-sdk-interaction-domain.js';
import { isConnectorSdkHistoryKind } from './connector-sdk-history-domain.js';
import { isConnectorSdkUsageKind } from './connector-sdk-usage-domain.js';
import { isConnectorSdkFilesKind } from './connector-sdk-files-domain.js';
import { isConnectorSdkMetadataKind } from './connector-sdk-metadata-domain.js';

import { mirrorDeliveryReplyMatches, type ConnectorMirrorDeliveryCommands } from './connector-mirror-delivery-domain.js';

type Kind = ConnectorOwnerKind | 'close';
type Waiter = { kind: Kind; userId: string | undefined; sessionKey?: string | undefined; page?: { after: string; limit: number } | undefined;
  mirrorClaim?: ConnectorMirrorDeliveryCommands['mirrorDeliveryClaim']['input'] | undefined;
  automationRequest?: string | undefined;
  codexQueuePlan?: { kind: ConnectorCodexQueuePlanKind; input: ConnectorCodexQueuePlanCommands[ConnectorCodexQueuePlanKind]['input'] } | undefined;
  hermes?: HermesReplyExpectation | undefined;
  hermesDispatch?: { kind: keyof ConnectorHermesDispatchCommands; input: ConnectorHermesDispatchCommands[keyof ConnectorHermesDispatchCommands]['input'] } | undefined;
  hermesHistory?: { kind: keyof ConnectorHermesHistoryCommands; input: ConnectorHermesHistoryCommands[keyof ConnectorHermesHistoryCommands]['input'] } | undefined;
  hermesLifecycle?: { kind: keyof ConnectorHermesLifecycleCommands; input: ConnectorHermesLifecycleCommands[keyof ConnectorHermesLifecycleCommands]['input'] } | undefined;
  localCredentials?: LocalCredentialsCommands['localCredentialsCreate']['input'] | { leaseId: string } | undefined;
  metadata?: { runtime: string; key?: string; readerId?: string } | undefined;
  hermesRead?: { key: string; readerId?: string; stored?: string; digest?: string } | undefined;
  runtimeRead?: { key: string; readerId?: string } | undefined;
  codexDispatch?: ConnectorCodexDispatchCommands['codexDispatchClaim']['input'] | undefined;
  files?: { runtime: string; key: string; jobId?: string } | undefined;
  usage?: { runtime: string; key: string; requestId?: string; from?: number; to?: number; bucketMs?: number } | undefined;
  history?: { runtime: string; key: string; readerId?: string; nativeSessionId?: string; messageId?: string; limit?: number } | undefined;
  interaction?: { key: string; requestId?: string; runId?: string; claimId?: string } | undefined;
  message?: { runtime: SdkAgentId | 'hermes'; key: string; commandKey: string } | undefined;
  stopRef?: { ref: SdkCompactRef | null } | undefined;
  transcript?: Pick<SdkTranscriptAck, 'runtime' | 'ref'> | undefined;
  lifecycle?: { runtime: SdkAgentId; key: string; history?: boolean; commandKey?: string; receiptId?: string } | undefined;
  eventAfter?: { after: string | null } | undefined;
  localRecovery?: { runtime: SdkAgentId; operation: 'create' | 'settings'; commandKey: string; key?: string | undefined } | undefined;
  localCommand?: { runtime: SdkAgentId; commandKey: string; key?: string | undefined } | undefined;
  receiptKey?: string | undefined;
  receiptScope?: { key: string; targetId?: string | undefined } | undefined;
  queuePage?: { key: string; after: number } | undefined;
  attachment?: { ref: { key: string; id: string; epoch: string; nativeSessionId: string }; admissionId?: string; id?: string; offset?: number; size?: number } | undefined;
  sdk?: { runtime: SdkAgentId; key?: string; id?: string; epoch?: string; nativeSessionId?: string } | undefined;
  resolve(value: unknown): void; reject(error: Error): void };
const RESULT_BUDGET = 16 * CONNECTOR_RESULT_BYTES;

/** Owns the WHOLE ConnectorUserStore connection and shared participants. The
 * production process factory owns this worker; runtime.ts is legacy/test only.
 * Never construct beside a legacy writer. No dispatch/authorization fallback,
 * timed replacement or command replay. */
export class AsyncConnectorOwner {
  readonly authorityChanges = new ChangeSignal();
  private authorityRevision = 0;
  private readonly worker: Worker;
  private readonly ready: Promise<void>;
  private readonly exited: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readonly originalStop: ReturnType<typeof createOriginalWorkerStop>;
  private readonly pending = new Map<number, Waiter>();
  private readonly accepted = new Set<Promise<unknown>>();
  private sequence = 0;
  private inputBytes = 0;
  private largeInputBytes = 0;
  private resultBytes = 0;
  private largeResultBytes = 0;
  private readyReceived = false;
  private unavailable = false;
  private closing = false;
  private exitConfirmed = false;
  private closeAcknowledged = false;
  private closeWork: Promise<void> | undefined;
  private retirementWork: Promise<void> | undefined;
  private startupWarning: ReturnType<typeof setTimeout> | undefined;
  private readonly originalFile: string;
  /** Bootstrap-only original peer; transferred exactly once to its Hub layer. */
  readonly applicationTransactionAuthEndpoint: ApplicationTransactionAuthEndpoint | undefined;

  constructor(config: ConnectorOwnerConfig, private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics,
    launch?: () => Worker, private readonly warningMs = 30_000, transactionPeer?: ApplicationTransactionConnectorEndpoint) {
    if (launch && transactionPeer) throw new ConnectorOwnerUnavailable();
    transactionPeer?.begin();
    let constructed = false;
    try {
    this.applicationTransactionAuthEndpoint = transactionPeer?.auth;
    if (!Number.isSafeInteger(warningMs) || warningMs < 1 || warningMs > 2_147_483_647) throw new ConnectorOwnerUnavailable();
    const copied = connectorOwnerConfig(JSON.parse(encodeConnectorOwnerJson(config)));
    copied.file = resolve(copied.file);
    this.originalFile = copied.file;
    if (copied.tokenFile !== undefined) copied.tokenFile = resolve(copied.tokenFile);
    let release: () => void;
    const reservations: (() => void)[] = [];
    try {
      reservations.push(startupDatabaseOwners.reserveExclusive(copied.file));
      if (copied.tokenFile !== undefined) reservations.push(startupDatabaseOwners.reserveExclusive(copied.tokenFile));
      release = () => { for (const dispose of reservations) dispose(); };
    }
    catch { for (const dispose of reservations) dispose(); this.observe(7, 1); throw new ConnectorOwnerUnavailable(); }
    try {
      const source = new URL(import.meta.url).pathname.endsWith('.ts');
      const entry = new URL(source ? './connector-owner-worker.ts' : './connector-owner-worker.js', import.meta.url);
      this.worker = launch ? launch() : new Worker(`(async () => {
        const { workerData } = require('node:worker_threads');
        if (workerData.loader) { const { tsImport } = await import(workerData.loader); await tsImport(workerData.entry, workerData.entry); }
        else await import(workerData.entry);
      })().catch(() => process.exit(1));`, { eval: true, execArgv: [], workerData: {
        ...copied, entry: entry.href, loader: source ? import.meta.resolve('tsx/esm/api') : undefined,
        ...(transactionPeer ? { applicationTransactionPort: transactionPeer.data } : {}),
      }, ...(transactionPeer ? { transferList: [transactionPeer.data] } : {}) });
      constructed = true;
    } catch { release(); throw new ConnectorOwnerUnavailable(); }
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    void this.ready.catch(() => {});
    this.originalStop = createOriginalWorkerStop(this.worker, () => this.observe(4, 9));
    this.exited = new Promise(resolveExit => this.worker.once('exit', code => {
      this.exitConfirmed = true;
      // Neither fail(), RPC rejection nor terminate() fulfillment proves that
      // a previously granted original SQL writer has stopped.
      transactionPeer?.confirmExit();
      clearTimeout(this.startupWarning);
      release(); this.originalStop.confirmExit();
      if (!this.closing || !this.closeAcknowledged || code !== 0) this.fail(3);
      this.observe(2); resolveExit();
    }));
    this.worker.on('error', () => this.fail(2));
    this.worker.on('message', (value: unknown) => this.receive(value));
    this.startupWarning = setTimeout(() => this.observe(0), warningMs); this.startupWarning.unref();
    } catch (error) {
      if (!constructed) transactionPeer?.confirmExit();
      throw error;
    }
  }
  open() { return this.ready; }
  /** Trusted constructor-bound capability, not a caller-selected DB path. */
  get runtimeOwnerFile(): string | undefined {
    return this.readyReceived && !this.unavailable && !this.closing && !this.exitConfirmed ? this.originalFile : undefined;
  }
  snapshot() {
    return { scope: 'process' as const, ready: this.readyReceived, unavailable: this.unavailable,
      closing: this.closing, ownerExitConfirmed: this.exitConfirmed, closeAcknowledged: this.closeAcknowledged,
      pending: this.pending.size, accepted: this.accepted.size, inputBytes: this.inputBytes, resultBytes: this.resultBytes };
  }
  private observe(step: number, cause?: number) {
    const trace = guardedTrace(this.diagnostics, 'connector-sqlite-owner');
    trace.add('step', step); trace.add('pending', Math.max(this.pending.size, this.accepted.size));
    if (cause !== undefined) trace.add('ownerFailureCode', cause);
    if (step === 2) trace.add('settled', 1); else if (step !== 3 && step !== 7) trace.add('unknown', 1);
    if (step === 7) trace.add('deferred', 1);
    trace.finish(cause !== undefined);
  }
  private fail(cause: number) {
    if (this.unavailable) return;
    this.unavailable = true; this.authorityChanges.notify(); clearTimeout(this.startupWarning);
    this.rejectReady(new ConnectorOwnerUnavailable());
    for (const waiter of this.pending.values()) waiter.reject(new ConnectorOwnerUnavailable());
    this.pending.clear(); this.observe(1, cause);
  }
  private receive(message: unknown) {
    if (this.unavailable) return;
    const r = message as { id?: number; kind?: Kind | 'ready' | 'authorityChanged'; ok?: boolean; body?: string } | null;
    if (!r || typeof r !== 'object' || Array.isArray(r)) { this.fail(4); return; }
    if (!this.readyReceived) {
      if (r.kind !== 'ready' || Object.keys(r).length !== 1) { this.fail(4); return; }
      this.readyReceived = true; clearTimeout(this.startupWarning); this.resolveReady(); this.observe(3); return;
    }
    if (r.kind === 'authorityChanged') {
      const notice = message as { kind: string; revision: number };
      if (Object.keys(notice).sort().join(',') !== 'kind,revision' || !Number.isSafeInteger(notice.revision)
        || notice.revision <= this.authorityRevision) { this.fail(4); return; }
      this.authorityRevision = notice.revision; this.authorityChanges.notify(); return;
    }
    const waiter = Number.isSafeInteger(r.id) ? this.pending.get(r.id!) : undefined;
    const keys = r.ok === true ? ['id', 'kind', 'ok', 'body'] : ['id', 'kind', 'ok'];
    if (!waiter || r.kind !== waiter.kind || typeof r.ok !== 'boolean' || Object.keys(r).length !== keys.length
      || !keys.every(key => Object.hasOwn(r, key))) { this.fail(4); return; }
    if (!r.ok) {
      this.pending.delete(r.id!); waiter.reject(new ConnectorOwnerUnavailable()); return;
    }
    let value: unknown;
    try {
      if (typeof r.body !== 'string' || Buffer.byteLength(r.body) > connectorOwnerResultBytes(waiter.kind)) throw new ConnectorOwnerUnavailable();
      value = JSON.parse(r.body);
      if (waiter.kind === 'close' ? value !== null : !validConnectorOwnerOutput(waiter.kind, value)) throw new ConnectorOwnerUnavailable();
      if (waiter.mirrorClaim && !mirrorDeliveryReplyMatches(waiter.mirrorClaim,
        value as ConnectorMirrorDeliveryCommands['mirrorDeliveryClaim']['output'])) throw new ConnectorOwnerUnavailable();
      if (waiter.automationRequest && (value as { ok: boolean }).ok) {
        const receipt = (value as { value: { requestId: string } | null }).value;
        if (receipt && receipt.requestId !== waiter.automationRequest) throw new ConnectorOwnerUnavailable();
      }
      if (waiter.codexDispatch && !connectorCodexDispatchReplyMatches(waiter.codexDispatch,
        value as ConnectorCodexDispatchCommands['codexDispatchClaim']['output'])) throw new ConnectorOwnerUnavailable();
      if (waiter.codexQueuePlan && !connectorCodexQueuePlanReplyMatches(waiter.codexQueuePlan.kind, waiter.codexQueuePlan.input, value)) throw new ConnectorOwnerUnavailable();
      if (waiter.localCredentials && (waiter.kind === 'localCredentialsCreate'
        ? !localCredentialsMatch(waiter.localCredentials as LocalCredentialsCommands['localCredentialsCreate']['input'], value as LocalCredentialBundle)
        : (value as { leaseId: string }).leaseId !== waiter.localCredentials.leaseId)) throw new ConnectorOwnerUnavailable();
      if (waiter.runtimeRead && !Object.hasOwn(value as object, 'error')) {
        const actual = value as RuntimeReadIdentity;
        if (Object.entries(waiter.runtimeRead).some(([key, entry]) => actual[key as keyof RuntimeReadIdentity] !== entry)) throw new ConnectorOwnerUnavailable();
      }
      if (waiter.hermesRead && !Object.hasOwn(value as object, 'error')) {
        const actual = value as HermesReadIdentity;
        if (Object.entries(waiter.hermesRead).some(([key, entry]) => actual[key as keyof HermesReadIdentity] !== entry)) throw new ConnectorOwnerUnavailable();
      }
      if (waiter.metadata && !Object.hasOwn(value as object, 'error')) {
        const actual = value as { runtime: string; key?: string; readerId: string };
        if (Object.entries(waiter.metadata).some(([key, entry]) => actual[key as keyof typeof actual] !== entry)) throw new ConnectorOwnerUnavailable();
      }
      if (waiter.files && !Object.hasOwn(value as object, 'error')) {
        const expected = waiter.files, actual = value as { runtime: string; key: string; body: { id?: string } };
        if (actual.runtime !== expected.runtime || actual.key !== expected.key
          || expected.jobId !== undefined && actual.body.id !== expected.jobId) throw new ConnectorOwnerUnavailable();
      }
      if (waiter.usage && !Object.hasOwn(value as object, 'error')) {
        const expected = waiter.usage, actual = value as { runtime: string; key: string; body: {
          requestId?: string; from?: number; to?: number; bucketMs?: number;
          usage?: { from: number; to: number; bucketMs: number }; data?: { usage: { from: number; to: number; bucketMs: number } };
        } };
        const range = actual.body.data?.usage ?? actual.body.usage ?? actual.body;
        if (actual.runtime !== expected.runtime || actual.key !== expected.key
          || expected.requestId !== undefined && actual.body.requestId !== expected.requestId
          || expected.from !== undefined && (range.from !== expected.from || range.to !== expected.to || range.bucketMs !== expected.bucketMs)) throw new ConnectorOwnerUnavailable();
      }
      if (waiter.history && !Object.hasOwn(value as object, 'error')) {
        const expected = waiter.history, actual = value as { runtime: string; key: string; readerId: string; nativeSessionId: string; messageId?: string;
          body?: { message?: { id: string }; messages?: unknown[] } };
        if (actual.runtime !== expected.runtime || actual.key !== expected.key
          || expected.readerId !== undefined && actual.readerId !== expected.readerId
          || expected.nativeSessionId !== undefined && actual.nativeSessionId !== expected.nativeSessionId
          || expected.messageId !== undefined && actual.messageId !== expected.messageId
          || expected.limit !== undefined && (actual.body?.messages?.length ?? Infinity) > expected.limit) throw new ConnectorOwnerUnavailable();
      }
      if (waiter.lifecycle && value !== false && !Object.hasOwn(value as object, 'error')) {
        const actual = value as { runtime: string; key: string; receipt?: { key: string; id: string }; page?: unknown };
        if (actual.runtime !== waiter.lifecycle.runtime || actual.key !== waiter.lifecycle.key
          || waiter.lifecycle.commandKey !== undefined && actual.receipt?.key !== waiter.lifecycle.commandKey
          || waiter.lifecycle.receiptId !== undefined && actual.receipt?.id !== waiter.lifecycle.receiptId
          || waiter.lifecycle.history === false && actual.page !== null) throw new ConnectorOwnerUnavailable();
      }
      if (waiter.attachment) {
        const expected = waiter.attachment, actual = value as typeof expected;
        if (Object.entries(expected.ref).some(([key, entry]) => actual.ref[key as keyof typeof actual.ref] !== entry)
          || ['admissionId', 'id', 'offset', 'size'].some(key => Object.hasOwn(expected, key)
            && actual[key as keyof typeof actual] !== expected[key as keyof typeof expected])) throw new ConnectorOwnerUnavailable();
      }
      if (waiter.hermes && !connectorHermesReplyMatches(waiter.hermes, value)) throw new ConnectorOwnerUnavailable();
      if (waiter.hermesDispatch && !connectorHermesDispatchReplyMatches(waiter.hermesDispatch.kind, waiter.hermesDispatch.input, value)) throw new ConnectorOwnerUnavailable();
      if (waiter.hermesHistory && !connectorHermesHistoryReplyMatches(waiter.hermesHistory.kind, waiter.hermesHistory.input, value)) throw new ConnectorOwnerUnavailable();
      if (waiter.hermesLifecycle && !connectorHermesLifecycleReplyMatches(waiter.hermesLifecycle.kind, waiter.hermesLifecycle.input, value)) throw new ConnectorOwnerUnavailable();
      if (waiter.page) {
        const page = value as string[], boundary = Buffer.from(waiter.page.after);
        if (page.length > waiter.page.limit || page.some((key, index) => Buffer.compare(Buffer.from(key), boundary) <= 0
          || index > 0 && Buffer.compare(Buffer.from(page[index - 1]!), Buffer.from(key)) >= 0)) throw new ConnectorOwnerUnavailable();
      }
      if (waiter.localCommand && 'receipt' in (value as object)) {
        const actual = value as { runtime: SdkAgentId; key: string | null; receipt: { key: string } };
        if (actual.runtime !== waiter.localCommand.runtime || actual.receipt.key !== waiter.localCommand.commandKey
          || waiter.localCommand.key !== undefined && actual.key !== waiter.localCommand.key) throw new ConnectorOwnerUnavailable();
      }
      if (waiter.message && 'receipt' in (value as object)) {
        const actual = value as { runtime: SdkAgentId | 'hermes'; key: string; commandKey: string };
        if (Object.entries(waiter.message).some(([key, entry]) => actual[key as keyof typeof actual] !== entry)) throw new ConnectorOwnerUnavailable();
      }
      if (waiter.stopRef && 'execution' in (value as object)) {
        const actual = (value as { execution: SdkCompactRef | null }).execution;
        if (actual && (!waiter.stopRef.ref || !sameSdkTranscriptRef(actual, waiter.stopRef.ref))) throw new ConnectorOwnerUnavailable();
      }
      if (waiter.localRecovery && 'receipt' in (value as object)) {
        const actual = value as { runtime: SdkAgentId; operation: string; commandKey: string; key: string | null };
        const expected = waiter.localRecovery;
        if (actual.runtime !== expected.runtime || actual.operation !== expected.operation || actual.commandKey !== expected.commandKey
          || expected.key !== undefined && actual.key !== expected.key) throw new ConnectorOwnerUnavailable();
      }
      if (waiter.sessionKey && value !== null && (value as { sessionKey: string }).sessionKey !== waiter.sessionKey) throw new ConnectorOwnerUnavailable();
      if (waiter.queuePage && 'page' in (value as object)) {
        const actual = value as { key: string; page: { items: Array<{ version: string }> } };
        if (actual.key !== waiter.queuePage.key || actual.page.items.some(item => Number(item.version.split(':')[0]) <= waiter.queuePage!.after))
          throw new ConnectorOwnerUnavailable();
      }
      if (waiter.receiptKey && 'receipt' in (value as object)) {
        const actual = value as { key: string; targetId: string; receipt: { key: string } | null };
        if (actual.key !== waiter.receiptScope?.key
          || waiter.receiptScope.targetId !== undefined && actual.targetId !== waiter.receiptScope.targetId
          || actual.receipt && actual.receipt.key !== waiter.receiptKey) throw new ConnectorOwnerUnavailable();
      }
      if (waiter.transcript) {
        const actual = value as SdkTranscriptAck;
        if (actual.runtime !== waiter.transcript.runtime || !sameSdkTranscriptRef(actual.ref, waiter.transcript.ref)) throw new ConnectorOwnerUnavailable();
      }
      if (waiter.interaction && (value as { ok: boolean }).ok) {
        const actual = (value as { value: unknown }).value;
        const expected = waiter.interaction;
        const records = waiter.kind === 'sdkInteractionObserve'
          ? (actual as { requests: Array<{ request: { sessionKey: string; requestId: string; runId: string } }> }).requests
          : actual && typeof actual === 'object' && 'state' in actual
            ? [{ request: (actual as { state: { request: { sessionKey: string; requestId: string; runId: string } } }).state.request }] : [];
        if (records.some(({ request }) => request.sessionKey !== expected.key
          || expected.requestId !== undefined && request.requestId !== expected.requestId
          || expected.runId !== undefined && request.runId !== expected.runId)
          || expected.claimId !== undefined && (actual as { claimId?: string })?.claimId !== expected.claimId) throw new ConnectorOwnerUnavailable();
      }
      if (waiter.sdk) {
        if (waiter.kind === 'sdkInteractionPrepare' && value !== null) {
          const actual = (value as { ref: SdkCompactRef }).ref;
          if (['key', 'id', 'epoch', 'nativeSessionId'].some(key => actual[key as keyof SdkCompactRef]
            !== waiter.sdk![key as keyof typeof waiter.sdk])) throw new ConnectorOwnerUnavailable();
        }
        if (waiter.kind === 'sdkCompactClaim' && 'receipt' in (value as object)) {
          const actual = value as { key: string; execution: { key: string; id: string; epoch: string; nativeSessionId: string } | null };
          if (actual.key !== waiter.sdk.key || actual.execution && ['key', 'id', 'epoch', 'nativeSessionId']
            .some(key => actual.execution![key as keyof typeof actual.execution] !== waiter.sdk![key as keyof typeof waiter.sdk])) throw new ConnectorOwnerUnavailable();
        }
        if ((waiter.kind === 'sdkDispatchPlan' || waiter.kind === 'sdkDispatchClaim' || waiter.kind === 'sdkInterruptClaim')
          && value !== null && value !== 'blocked') {
          const actual = value as { key: string; id?: string; epoch?: string; nativeSessionId?: string };
          if (actual.key !== waiter.sdk.key || sessionRuntimeId(actual.key) !== waiter.sdk.runtime
            || waiter.sdk.id !== undefined && actual.id !== waiter.sdk.id
            || waiter.sdk.epoch !== undefined && actual.epoch !== waiter.sdk.epoch
            || waiter.sdk.nativeSessionId !== undefined && actual.nativeSessionId !== waiter.sdk.nativeSessionId) throw new ConnectorOwnerUnavailable();
        }
        if (waiter.kind === 'sdkCompactInterruptClaim'
          && value !== null && value !== 'blocked') {
          const actual = value as { key: string; id?: string; epoch?: string; nativeSessionId?: string };
          if (actual.key !== waiter.sdk.key || sessionRuntimeId(actual.key) !== waiter.sdk.runtime
            || waiter.sdk.id !== undefined && actual.id !== waiter.sdk.id
            || waiter.sdk.epoch !== undefined && actual.epoch !== waiter.sdk.epoch
            || waiter.sdk.nativeSessionId !== undefined && actual.nativeSessionId !== waiter.sdk.nativeSessionId) throw new ConnectorOwnerUnavailable();
        }
        if (waiter.kind === 'sdkSessionPage' && (value as string[]).some(key => sessionRuntimeId(key) !== waiter.sdk!.runtime)) throw new ConnectorOwnerUnavailable();
        if (waiter.kind === 'sdkSnapshotRead' && [(value as SdkJournalSnapshot).session, (value as SdkJournalSnapshot).execution,
          (value as SdkJournalSnapshot).deletion].some(record => record !== null &&
            (record.key !== waiter.sdk!.key || sessionRuntimeId(record.key) !== waiter.sdk!.runtime))) throw new ConnectorOwnerUnavailable();
      }
      if (waiter.eventAfter && !connectorEventReplayMatches(waiter.eventAfter.after, value as ConnectorEventReplay)) throw new ConnectorOwnerUnavailable();
      const resultUser = waiter.kind === 'authorizedUserGet' || waiter.kind === 'authorizedUserUpdate'
        ? (value as { authorized: boolean; value?: unknown }).value : value;
      if (waiter.userId && resultUser != null && (resultUser as { id: string }).id !== waiter.userId) throw new ConnectorOwnerUnavailable();
    } catch { this.fail(4); return; }
    this.pending.delete(r.id!);
    if (waiter.kind === 'close') this.closeAcknowledged = true;
    waiter.resolve(value);
  }
  private async send(kind: Kind, body: string): Promise<unknown> {
    await this.ready;
    if (this.unavailable || this.exitConfirmed) throw new ConnectorOwnerUnavailable();
    if (this.sequence === Number.MAX_SAFE_INTEGER) { this.fail(7); throw new ConnectorOwnerUnavailable(); }
    return new Promise((resolveReply, reject) => {
      const id = ++this.sequence;
      const userId = kind === 'userGet' || kind === 'userUpdate' || kind === 'authorizedUserGet' || kind === 'authorizedUserUpdate'
        ? JSON.parse(body).id as string : undefined;
      const page = kind === 'turnSessionPage' || kind === 'turnRecoveryPage' || kind === 'executionSessionPage' || kind === 'codexConnectionRecoveryPage' || kind === 'sdkSessionPage'
        ? { after: JSON.parse(body).after as string, limit: JSON.parse(body).limit as number } : undefined;
      const sessionKey = kind === 'codexExecutionRead' || kind === 'openClawExecutionRead' ? JSON.parse(body).sessionKey as string : undefined;
      const sdkInput = JSON.parse(body);
      const automationRequest = kind === 'automationConfigure' || kind === 'automationConfigurationOriginal' ? sdkInput.requestId as string : undefined;
      const interaction = isConnectorSdkInteractionKind(kind) ? {
        key: (sdkInput.key ?? sdkInput.ref?.key) as string,
        ...(sdkInput.requestId ? { requestId: sdkInput.requestId as string } : {}),
        ...(sdkInput.submission?.runId || sdkInput.ref?.id ? { runId: (sdkInput.submission?.runId ?? sdkInput.ref.id) as string } : {}),
        ...(kind === 'sdkInteractionSettle' ? { claimId: sdkInput.claimId as string } : {}),
      } : undefined;
      const lifecycle = kind === 'sdkLifecycleRead' || kind === 'sdkDeletionClaim' || kind === 'sdkDeletionSettle'
        ? { runtime: sdkInput.runtime as SdkAgentId, key: sdkInput.key as string,
          ...(kind === 'sdkLifecycleRead' ? { history: sdkInput.history as boolean } : kind === 'sdkDeletionClaim'
            ? { commandKey: sdkInput.commandKey as string } : { receiptId: sdkInput.receiptId as string }) } : undefined;
      const transcript = isConnectorSdkTranscriptKind(kind) ? { runtime: sdkInput.runtime as SdkAgentId, ref: sdkInput.ref } : undefined;
      const attachment = kind === 'sdkExecutionAttachmentManifest' || kind === 'sdkExecutionAttachmentChunk' ? sdkInput : undefined;
      const queuePage = kind === 'nativeQueuePage' || kind === 'nativeQueueCommandPage' || kind === 'sdkQueuePage' || kind === 'sdkQueueCommandPage' || kind === 'hermesQueuePage' || kind === 'hermesQueueCommandPage'
        ? { key: sdkInput.key as string, after: sdkInput.after as number } : undefined;
      const receiptKey = kind === 'sdkCompactClaim' ? sdkInput.commandKey as string
        : kind === 'sdkQueuedCancel' || kind === 'sdkQueuedEdit' || kind === 'sdkQueueReceiptRead'
          || kind === 'nativeQueuedCancel' || kind === 'nativeQueuedEdit' || kind === 'nativeQueueReceiptRead'
          || kind === 'hermesQueuedCancel' || kind === 'hermesQueuedEdit' || kind === 'hermesQueueReceiptRead' ? sdkInput.mutationKey as string : undefined;
      const receiptScope = receiptKey ? { key: sdkInput.key as string, targetId: sdkInput.target?.messageId as string | undefined } : undefined;
      const sdk = kind === 'sdkSnapshotRead' || kind === 'sdkSessionPage' || kind === 'sdkDispatchPlan' || kind === 'sdkDispatchClaim' || kind === 'sdkCompactClaim'
        ? sdkInput as { runtime: SdkAgentId; key?: string; id?: string; epoch?: string }
        : kind === 'sdkInterruptClaim' || kind === 'sdkCompactInterruptClaim' || kind === 'sdkInteractionPrepare'
          ? { runtime: sdkInput.runtime as SdkAgentId, ...sdkInput.ref } : undefined;
      const localCommand = kind === 'sdkSessionCreate' || kind === 'sdkModelUpdate'
        ? { runtime: sdkInput.runtime as SdkAgentId, commandKey: sdkInput.commandKey as string,
          ...(kind === 'sdkModelUpdate' ? { key: sdkInput.key as string } : {}) } : undefined;
      const localRecovery = kind === 'sdkLocalReceiptRead' ? { runtime: sdkInput.runtime as SdkAgentId,
        operation: sdkInput.operation as 'create' | 'settings', commandKey: sdkInput.commandKey as string,
        ...(sdkInput.operation === 'settings' ? { key: sdkInput.key as string } : {}) } : undefined;
      const eventAfter = kind === 'eventReplay' ? { after: sdkInput.after as string | null } : undefined;
      const message = isConnectorHermesMessageKind(kind) ? { runtime: 'hermes' as const, key: sdkInput.key as string, commandKey: sdkInput.commandKey as string }
        : kind === 'sdkMessageSend' || kind === 'sdkMessageReceiptRead' || kind === 'sdkMessageSendReceiptRead' || kind === 'sdkDeletionReceiptRead' || kind === 'sdkCompactReceiptRead' || kind === 'sdkMessageStopClaim' || kind === 'sdkMessageStatus' || kind === 'sdkMessageStatusRead'
        ? { runtime: sdkInput.runtime as SdkAgentId, key: sdkInput.key as string, commandKey: sdkInput.commandKey as string } : undefined;
      const stopRef = kind === 'sdkMessageStopClaim' ? { ref: sdkInput.ref as SdkCompactRef | null } : undefined;
      const history = isConnectorSdkHistoryKind(kind) ? { runtime: sdkInput.runtime as string, key: sdkInput.key as string,
        ...(kind === 'sdkHistoryDeliver' ? { readerId: sdkInput.readerId as string, nativeSessionId: sdkInput.nativeSessionId as string }
          : kind === 'sdkHistoryPage' ? { limit: sdkInput.limit as number } : { messageId: sdkInput.messageId as string }) } : undefined;
      const usage = isConnectorSdkUsageKind(kind) ? { runtime: sdkInput.runtime as string, key: sdkInput.key as string,
        ...(kind === 'sdkUsageSnapshotRead' || kind === 'sdkUsageSnapshotCreate' ? { requestId: sdkInput.requestId as string } : {}),
        ...(kind === 'sdkUsageSnapshotRead' ? {} : { from: sdkInput.from as number, to: sdkInput.to as number, bucketMs: sdkInput.bucketMs as number }) } : undefined;
      const files = isConnectorSdkFilesKind(kind) ? { runtime: sdkInput.runtime as string, key: sdkInput.key as string,
        ...(kind === 'sdkFilesStep' || kind === 'sdkFilesCancel' ? { jobId: sdkInput.jobId as string } : {}) } : undefined;
      const metadata = isConnectorSdkMetadataKind(kind) ? { runtime: sdkInput.runtime as string,
        ...(kind === 'sdkStateRead' ? { key: sdkInput.key as string } : kind === 'sdkModelsDeliver' ? { readerId: sdkInput.readerId as string } : {}) } : undefined;
      const localCredentials = kind === 'localCredentialsCreate' || kind === 'localCredentialsRelease'
        ? sdkInput as LocalCredentialsCommands['localCredentialsCreate']['input'] | { leaseId: string } : undefined;
      const hermes: HermesReplyExpectation | undefined = !isConnectorHermesExecutionKind(kind) ? undefined
        : kind === 'hermesExecutionRead' ? { sessionKey: sdkInput.sessionKey as string }
        : kind === 'hermesExecutionPage' || kind === 'hermesRecoveryPage' ? { after: sdkInput.after as string, limit: sdkInput.limit as number }
        : { ...(({ key, id, live, epoch }) => ({ key, id, live, epoch }))(sdkInput.execution as { key: string; id: string; live: string; epoch: string }),
          ...(kind === 'hermesExecutionTool' ? { tool: { id: sdkInput.observation.toolId, phase: sdkInput.observation.phase } } : {}) };
      const hermesDispatch = isConnectorHermesDispatchKind(kind) ? { kind, input: JSON.parse(body) as ConnectorHermesDispatchCommands[typeof kind]['input'] } : undefined;
      const hermesHistory = isConnectorHermesHistoryKind(kind) ? { kind, input: JSON.parse(body) as ConnectorHermesHistoryCommands[typeof kind]['input'] } : undefined;
      const readInput = isConnectorHermesReadKind(kind) ? JSON.parse(body) as { key: string; readerId?: string; stored?: string; digest?: string } : undefined;
      const hermesRead = readInput ? { key: readInput.key, ...(kind === 'hermesReadDeliver'
        ? { readerId: readInput.readerId!, stored: readInput.stored!, digest: readInput.digest! } : {}) } : undefined;
      const runtimeReadInput = isConnectorOpenClawReadKind(kind) || isConnectorCodexReadKind(kind)
        ? JSON.parse(body) as { key: string; readerId?: string } : undefined;
      const runtimeRead = runtimeReadInput ? { key: runtimeReadInput.key,
        ...(kind === 'openClawReadDeliver' || kind === 'codexReadDeliver' ? { readerId: runtimeReadInput.readerId! } : {}) } : undefined;
      const codexDispatch = kind === 'codexDispatchClaim' ? JSON.parse(body) as ConnectorCodexDispatchCommands['codexDispatchClaim']['input'] : undefined;
      const codexQueuePlan = isConnectorCodexQueuePlanKind(kind) ? { kind, input: JSON.parse(body) as ConnectorCodexQueuePlanCommands[typeof kind]['input'] } : undefined;
      const hermesLifecycle = isConnectorHermesLifecycleKind(kind) ? { kind, input: JSON.parse(body) as ConnectorHermesLifecycleCommands[typeof kind]['input'] } : undefined;
      const mirrorClaim = kind === 'mirrorDeliveryClaim' ? JSON.parse(body) as ConnectorMirrorDeliveryCommands['mirrorDeliveryClaim']['input'] : undefined;
      this.pending.set(id, { kind, userId, sessionKey, page, automationRequest, sdk, queuePage, attachment, receiptKey, receiptScope, localCommand, localRecovery, eventAfter, message, transcript, lifecycle, stopRef, interaction, history, usage, files, metadata, runtimeRead, codexDispatch, codexQueuePlan, hermesRead, localCredentials, hermes, hermesDispatch, hermesHistory, hermesLifecycle, mirrorClaim, resolve: resolveReply, reject });
      try { this.worker.postMessage({ id, kind, body }); } catch { this.fail(6); }
    });
  }
  command<K extends ConnectorOwnerKind>(kind: K, input: ConnectorOwnerCommands[K]['input']): Promise<ConnectorOwnerCommands[K]['output']> {
    let body: string;
    const resultBudget = connectorOwnerResultBytes(kind);
    const largeResult = connectorOwnerLargeResult(kind);
    const available = () => !this.closing && !this.unavailable && !this.exitConfirmed
      && this.accepted.size < CONNECTOR_PENDING_LIMIT
      && (largeResult ? this.largeResultBytes === 0 : this.resultBytes + resultBudget <= RESULT_BUDGET);
    try {
      if (!available() || !connectorOwnerKinds.includes(kind)) throw new ConnectorOwnerUnavailable();
      body = encodeConnectorOwnerInput(kind, input);
      if (!validConnectorOwnerInput(kind, JSON.parse(body)) || !available()
        || (connectorOwnerLargeInput(kind, Buffer.byteLength(body)) ? this.largeInputBytes !== 0
          : this.inputBytes + Buffer.byteLength(body) > CONNECTOR_PENDING_INPUT_BYTES)) throw new ConnectorOwnerUnavailable();
    } catch {
      const trace = guardedTrace(this.diagnostics, 'connector-sqlite-command');
      trace.add('step', connectorOwnerKinds.includes(kind) ? connectorOwnerSteps[kind] : 0);
      trace.add('deferred', 1); trace.finish(true);
      return Promise.reject(new ConnectorOwnerUnavailable());
    }
    // Reserve synchronously BEFORE any sink can reenter command/close.
    const size = Buffer.byteLength(body);
    const large = connectorOwnerLargeInput(kind, size);
    if (large) this.largeInputBytes += size; else this.inputBytes += size;
    if (largeResult) this.largeResultBytes += resultBudget; else this.resultBytes += resultBudget;
    const work = Promise.resolve().then(async () => {
      const trace = guardedTrace(this.diagnostics, 'connector-sqlite-command');
      trace.add('step', connectorOwnerSteps[kind]); trace.add('admitted', 1); trace.add('sourceBytes', size);
      const warning = setTimeout(() => trace.reportPending({ pending: 1 }), this.warningMs); warning.unref();
      let failed = true;
      try {
        const value = await this.send(kind, body);
        const projectionUnavailable = (kind === 'eventProjectionAppend' || kind === 'eventProjectionRecover')
          && (value as { cursor: string | null }).cursor === null;
        failed = projectionUnavailable;
        trace.add(projectionUnavailable ? 'unknown' : 'settled', 1);
        if (kind === 'eventProjectionRecover' && (value as { recovered: boolean }).recovered) trace.add('recovered', 1);
        return value as ConnectorOwnerCommands[K]['output'];
      } catch (error) { trace.add('unknown', 1); throw error; }
      finally { clearTimeout(warning); trace.finish(failed); }
    });
    this.accepted.add(work);
    const release = () => { this.accepted.delete(work); if (large) this.largeInputBytes -= size; else this.inputBytes -= size;
      if (largeResult) this.largeResultBytes -= resultBudget; else this.resultBytes -= resultBudget; };
    void work.then(release, release);
    return work;
  }
  close(): Promise<void> {
    if (this.closeWork) return this.closeWork;
    this.closing = true;
    this.closeWork = (async () => {
      const warning = setTimeout(() => this.observe(5), this.warningMs); warning.unref();
      try {
        await Promise.allSettled([...this.accepted]);
        let failed = this.unavailable;
        if (!failed) { try { await this.send('close', '{}'); } catch { failed = true; } }
        if (failed) { this.fail(8); this.originalStop.request(); }
        await this.exited;
        if (failed || this.unavailable || !this.closeAcknowledged) throw new ConnectorOwnerUnavailable();
      } finally { clearTimeout(warning); }
    })();
    void this.closeWork.catch(() => {});
    return this.closeWork;
  }
  async closeForShutdown(): Promise<void> {
    try { await this.close(); }
    catch {
      if (!this.closing || !this.exitConfirmed || this.pending.size || this.accepted.size || this.inputBytes || this.largeInputBytes || this.resultBytes || this.largeResultBytes) throw new ConnectorOwnerUnavailable();
    }
  }
  /** Explicit shutdown of THIS owner only. Unknown writes stay unknown; the
   * stop Promise/close ACK cannot release its file reservation before exit. */
  retireForShutdown(): Promise<void> {
    if (this.retirementWork) return this.retirementWork;
    this.closing = true;
    this.retirementWork = Promise.resolve().then(() => {
      if (!this.exitConfirmed) this.fail(11);
      return this.closeForShutdown();
    });
    void this.retirementWork.catch(() => {});
    return this.retirementWork;
  }
}
