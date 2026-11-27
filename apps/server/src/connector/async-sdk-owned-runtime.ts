import type { AgentReadiness, AntigravityQuotaWaitState } from '@agentopsdeck/shared';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import type { AsyncSdkExecutionDriver } from './async-sdk-execution-driver.js';
import type { SdkOwnedTurn } from './sdk-execution-driver.js';
import type { SdkAgentId } from './sdk-execution-journal.js';
import type { SdkDeletionAdmission } from './connector-sdk-lifecycle-domain.js';
import { sdkSessionView } from './sdk-session-view.js';
import { PrivateAgentHomeLease } from './private-agent-home-lease.js';
import type { SdkPreflight } from './sdk-owned-runtime.js';
import type { PrivateWorkerDeletion } from './private-worker-preflight.js';
import type { DeckStore } from '../projection/deck-store.js';
import type { AdmissionPause } from '../lifecycle/request-drain.js';
import { captureMaintenanceFacts } from './maintenance-facts.js';
import type { ConnectorAgentLifecycle } from './agent-runtimes.js';
import type { HistoryRefreshOptions } from '../refresh/history.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import type { ApplicationCommandScope } from '../auth/application-command-scope.js';
import type { ApplicationTransactionEvidence } from '../auth/application-transaction-gate.js';

type Owner = Pick<AsyncConnectorOwner, 'command' | 'runtimeOwnerFile'>;
type Config = { homeDirectory: string; model?: string };
type Driver = Pick<AsyncSdkExecutionDriver<SdkOwnedTurn>, 'inspect' | 'wake' | 'pauseQueueWorker' | 'close'> & {
  isOccupied?: (key: string) => boolean;
  canRecover?: (key: string, expectedRunId: string) => boolean;
  releaseRecovered?: (key: string, expectedRunId: string) => Promise<void>;
};
export type AsyncSdkOwnedOptions<R extends SdkAgentId, C extends Config, D extends Driver> = {
  owner: Owner; runtime: R; config: C; diagnostics?: PerformanceDiagnostics;
  projection?: Pick<DeckStore, 'upsertSession' | 'replaceMessages' | 'removeSession'>;
  changed?: (key: string) => void;
  getQuotaWait?: (key: string) => AntigravityQuotaWaitState | undefined;
  hasNativeBinding?: (config: C, nativeSessionId: string) => boolean;
  check: (config: C) => SdkPreflight;
  deleteNative: (config: C, request: PrivateWorkerDeletion) => SdkPreflight;
  driver: (hooks: { admissionReady: () => boolean; assertOwnership: () => void; changed: (key: string) => void }) => D;
};
const owners = new WeakMap<Owner, Set<SdkAgentId>>();
const failed = () => Error('SDK asynchronous lifecycle is unavailable; original ownership is retained');

/** Main-side physical lifecycle ONLY. Sole worker owns journal, queue, history,
 * deletion authorization and receipts. No synchronous-store fallback. */
export class AsyncSdkOwnedRuntime<R extends SdkAgentId, C extends Config, D extends Driver> implements ConnectorAgentLifecycle {
  readonly id: R;
  readonly driver: D;
  private readonly config: C;
  private startupState: 'pending' | 'checking' | 'recovering' | 'ready' | 'failed' = 'pending';
  private startup: Promise<boolean> | undefined;
  private initialized = false;
  private preflight: SdkPreflight | undefined;
  private closed = false;
  private faulted = false;
  private closing: Promise<void> | undefined;
  private pauseLease: AdmissionPause | undefined;
  private readonly historyReady = new Set<string>();
  private readonly reads = new Map<string, { generation: number; history: boolean; work: Promise<void> }>();
  private generation = 0;
  private readonly fingerprints = new Map<string, string>();
  private projectionRefresh: Promise<void> | undefined;
  private projectionGeneration = 0;
  private readonly deletions = new Set<Promise<SdkDeletionAdmission | { error: 401 | 403 | 409 | 503 }>>();
  private readonly deleting = new Set<string>();
  private readonly recoveries = new Set<Promise<{ error: 401 | 403 | 404 | 409 } | { requested: true }>>();
  private readonly workers = new Set<SdkPreflight>();
  private constructor(private readonly options: AsyncSdkOwnedOptions<R, C, D>,
    private readonly file: string, private readonly lease: PrivateAgentHomeLease) {
    this.id = options.runtime; this.config = structuredClone(options.config);
    this.driver = options.driver({ admissionReady: () => this.canExecute(),
      assertOwnership: () => { if (!this.canExecute()) throw failed(); this.assertOwnership(); },
      changed: key => {
        if (this.closed) return;
        this.historyReady.delete(key);
        void this.read(key, true).then(() => { try { options.changed?.(key); } catch { /* committed fact survives notifier */ } }, () => this.fence(3));
      } });
  }

  static async create<R extends SdkAgentId, C extends Config, D extends Driver>(options: AsyncSdkOwnedOptions<R, C, D>): Promise<AsyncSdkOwnedRuntime<R, C, D>> {
    const config = structuredClone(options.config), file = options.owner.runtimeOwnerFile;
    if (!file || owners.get(options.owner)?.has(options.runtime)) throw failed();
    const node = await options.owner.command('nodeIdentity', {});
    // Concurrent creates must recheck after the original worker reply.
    if (options.owner.runtimeOwnerFile !== file || owners.get(options.owner)?.has(options.runtime)) throw failed();
    const lease = PrivateAgentHomeLease.acquire(options.runtime, config.homeDirectory, file, node);
    const owned = owners.get(options.owner) ?? new Set<SdkAgentId>();
    owned.add(options.runtime); owners.set(options.owner, owned);
    try { return new AsyncSdkOwnedRuntime({ ...options, config }, file, lease); }
    catch (error) {
      // A constructor may have partially created a physical driver. Fail closed:
      // no marker release without a runtime's original cleanup evidence.
      throw error;
    }
  }
  private observe(step: number, failed: boolean) {
    const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'sdk-owned-lifecycle');
    trace.add('step', step); trace.add('pending', this.reads.size + this.deletions.size + this.recoveries.size);
    trace.add('unknown', Number(this.faulted)); trace.finish(failed);
  }
  private fence(step: number) { this.faulted = true; this.observe(step, true); }
  private assertOwnership() {
    if (this.options.owner.runtimeOwnerFile !== this.file) throw failed();
    this.lease.assertHeld();
  }
  private canExecute(): boolean {
    if (this.closed || this.faulted || this.pauseLease || !['recovering', 'ready'].includes(this.startupState)) return false;
    const state = this.driver.inspect();
    if (state.closed || state.faulted || state.cleanupUnconfirmed || state.admissionPaused) return false;
    try { this.assertOwnership(); return true; } catch { return false; }
  }
  get ready(): boolean { return this.initialized && this.startupState === 'ready' && this.canExecute(); }
  get status(): AgentReadiness {
    if (this.closed) return 'closed';
    if (this.faulted || this.startupState === 'failed') return 'failed';
    try { this.assertOwnership(); } catch { return 'failed'; }
    const state = this.driver.inspect();
    if (state.closed || state.faulted || state.cleanupUnconfirmed) return 'failed';
    if (this.pauseLease || state.admissionPaused) return 'maintenance';
    return this.ready ? 'ready' : 'starting';
  }
  initialize(): Promise<boolean> {
    if (this.closed || this.pauseLease) return Promise.resolve(false);
    if (this.startup) return this.startup;
    this.startupState = 'checking';
    this.startup = Promise.resolve().then(async () => {
      try {
        this.assertOwnership();
        await this.refreshDirectory();
        if (this.closed) throw failed();
        this.preflight = this.options.check(structuredClone(this.config));
        const passed = await this.preflight.ready;
        await this.preflight.finished;
        if (passed !== true || this.preflight.inspectQuiescence() !== true || this.closed) throw failed();
        this.assertOwnership(); this.startupState = 'recovering';
        await this.refreshDirectory();
        await this.directory(async key => { if (this.canExecute()) await this.driver.wake(key); });
        if (this.closed || this.faulted) throw failed();
        this.startupState = 'ready';
        await this.refreshDirectory();
        this.initialized = true;
        // Maintenance can arrive during original preflight. It suppresses
        // admission, not successful physical startup or future resume.
        if (this.closed || this.faulted || this.driver.inspect().faulted || this.driver.inspect().cleanupUnconfirmed) throw failed();
        this.observe(1, false); return this.ready;
      } catch {
        this.startupState = 'failed';
        try { this.preflight?.close(); } catch { this.fence(1); }
        this.observe(1, true); return false;
      }
    });
    return this.startup;
  }
  private async directory(visit: (key: string) => Promise<void>) {
    let after = '';
    while (!this.closed) {
      const keys = await this.options.owner.command('sdkSessionPage', { runtime: this.id, after, limit: 64 });
      if (this.closed) throw failed();
      for (const key of keys) { if (this.closed) throw failed(); await visit(key); }
      if (keys.length < 64) return;
      after = keys.at(-1)!;
    }
    throw failed();
  }
  refreshDirectory(): Promise<void> { return this.directory(key => this.read(key, false)); }
  /** Complete SDK fragment of the global snapshot barrier, including history
   * and vanished keys. Never substitute a directory-only refresh for this. */
  refreshProjection(): Promise<void> {
    if (this.closed || this.faulted) return Promise.reject(failed());
    ++this.projectionGeneration;
    if (this.projectionRefresh) return this.projectionRefresh;
    const work = Promise.resolve().then(async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const generation = this.projectionGeneration;
        const missing = new Set(this.fingerprints.keys());
        await this.directory(async key => { missing.delete(key); await this.read(key, true); });
        for (const key of missing) { if (this.closed) throw failed(); await this.read(key, true); }
        if (this.closed || this.faulted) throw failed();
        // A caller arriving after its head observation needs a scan begun AFTER
        // that call, not the tail of an older scan. Merge a fresh successor.
        if (generation === this.projectionGeneration) return;
      }
      throw failed();
    }).finally(() => { if (this.projectionRefresh === work) this.projectionRefresh = undefined; });
    this.projectionRefresh = work;
    return work;
  }
  refreshSession(key: string, _options: HistoryRefreshOptions = {}): Promise<void> { return this.read(key, true); }
  isSessionHistoryReady(key: string): boolean { return !this.closed && this.historyReady.has(key); }
  private read(key: string, history: boolean): Promise<void> {
    if (this.closed || !key.startsWith(`${this.id}:`) || this.reads.size >= 128 && !this.reads.has(key)) return Promise.reject(failed());
    this.historyReady.delete(key);
    const existing = this.reads.get(key);
    if (existing) {
      // One original request plus one merged successor, not a promise/SQL
      // backlog for every streaming notification.
      existing.generation = ++this.generation; existing.history ||= history;
      return existing.work;
    }
    const entry = { generation: ++this.generation, history, work: Promise.resolve() };
    const work = Promise.resolve().then(async () => {
      while (!this.closed) {
      const generation = entry.generation, includeHistory = entry.history;
      const value = await this.options.owner.command('sdkLifecycleRead', { runtime: this.id, key, history: includeHistory });
      if (this.closed) return;
      if (entry.generation !== generation) continue;
      this.assertOwnership();
      const { snapshot, page, messageCount } = value, target = this.options.projection;
      if (snapshot.deletion?.phase === 'deleted' || !snapshot.session) {
        this.fingerprints.delete(key); target?.removeSession(key); return;
      }
      const session = { ...snapshot.session, ...(snapshot.deletion ? { nativeState: 'unknown' as const } : {}) };
      const quotaWait = this.options.getQuotaWait?.(key);
      const summary = sdkSessionView(this.id, session, snapshot.execution ?? undefined, this.startupState === 'ready' && this.canExecute(), {
        ...(messageCount !== undefined ? { messageCount } : {}),
        ...(quotaWait ? { quotaWait } : {}),
      });
      const resolvedModel = session.model ?? this.config.model;
      if (resolvedModel !== undefined) summary.model = resolvedModel;
      const fingerprint = JSON.stringify(summary);
      if (this.fingerprints.get(key) !== fingerprint) target?.upsertSession(summary);
      this.fingerprints.set(key, fingerprint);
      if (includeHistory && page) { target?.replaceMessages(key, page.messages, { authoritative: true }); this.historyReady.add(key); }
      return;
      }
    }).finally(() => { if (this.reads.get(key) === entry) this.reads.delete(key); });
    entry.work = work; this.reads.set(key, entry); return work;
  }
  remove(key: string, commandKey: string, authorization: string, signal?: AbortSignal, application?: ApplicationTransactionEvidence,
    authority?: ApplicationCommandScope): Promise<SdkDeletionAdmission | { error: 401 | 403 | 409 | 503 }> {
    if (!this.ready || this.deleting.has(key) || this.deletions.size >= 128 || signal?.aborted) return Promise.reject(failed());
    this.deleting.add(key);
    const evidence = application === undefined ? undefined : structuredClone(application);
    const job = this.removeOwned(key, commandKey, authorization, signal, evidence, authority).finally(() => { this.deleting.delete(key); this.deletions.delete(job); });
    this.deletions.add(job); return job;
  }
  recoverSession(key: string, expectedRunId: string, authorization: string, signal?: AbortSignal): Promise<{ error: 401 | 403 | 404 | 409 } | { requested: true }> {
    const blocked = () => this.driver.canRecover
      ? !this.driver.canRecover(key, expectedRunId)
      : Boolean(this.driver.isOccupied?.(key));
    if (!this.ready || this.deleting.has(key) || blocked() || this.recoveries.size >= 128 || signal?.aborted) {
      return Promise.reject(failed());
    }
    const job = Promise.resolve().then(async () => {
      const view = await this.options.owner.command('sdkLifecycleRead', { runtime: this.id, key, history: false });
      if (!this.ready || this.deleting.has(key) || blocked() || signal?.aborted) throw failed();
      this.assertOwnership();
      const hasNativeBinding = view.snapshot.session && this.options.hasNativeBinding
        ? this.options.hasNativeBinding(structuredClone(this.config), view.snapshot.session.nativeSessionId)
        : undefined;
      const result = await this.options.owner.command('sdkSessionRecover', {
        runtime: this.id, key, authorization, expectedRunId,
        ...(hasNativeBinding === undefined ? {} : { hasNativeBinding }),
      });
      if ('requested' in result) {
        await this.driver.releaseRecovered?.(key, expectedRunId);
        this.historyReady.delete(key);
        if (!this.closed) {
          await this.read(key, true);
          this.options.changed?.(key);
          if (this.canExecute()) void this.driver.wake(key);
        }
      }
      return result;
    }).finally(() => { this.recoveries.delete(job); });
    this.recoveries.add(job); return job;
  }
  private async removeOwned(key: string, commandKey: string, authorization: string, signal?: AbortSignal,
    application?: ApplicationTransactionEvidence, authority?: ApplicationCommandScope) {
    await authority?.authorize('prepare'); authority?.local();
    const result = await this.options.owner.command('sdkDeletionClaim', { runtime: this.id, key, commandKey, authorization,
      ...(application === undefined ? {} : { application }) });
    if ('error' in result || !result.admitted || !result.intent) return result;
    const ref = { runtime: this.id, key, intent: result.intent, receiptId: result.receipt.id };
    let worker: SdkPreflight | undefined, acceptedDeletion = false;
    try {
      await authority?.authorize('effect'); authority?.local();
      if (!this.ready || signal?.aborted) throw failed();
      const allowed = await this.options.owner.command('sdkDeletionReady', { ...ref, authorization });
      authority?.local();
      if (allowed !== true || !this.ready || signal?.aborted) throw failed();
      this.assertOwnership();
      if (result.nativeRequired) {
        worker = this.options.deleteNative(structuredClone(this.config), { kind: 'delete-native', id: result.intent.id, nativeSessionId: result.intent.nativeSessionId });
        this.workers.add(worker);
        const accepted = await worker.ready;
        await worker.finished;
        if (accepted !== true || worker.inspectQuiescence() !== true) throw failed();
      }
      const settled = await this.options.owner.command('sdkDeletionSettle', { ...ref, accepted: true, nativeQuiescent: true });
      if (settled === false || settled.receipt.state !== 'accepted') throw failed();
      acceptedDeletion = true;
      return settled;
    } catch {
      try { worker?.close(); } catch { this.fence(4); }
      if (worker) { await Promise.allSettled([worker.ready, worker.finished]); }
      try { await this.options.owner.command('sdkDeletionSettle', { ...ref, accepted: false, nativeQuiescent: false }); }
      catch { this.fence(4); }
      throw failed();
    } finally {
      if (worker) {
        try { worker.close(); if (worker.inspectQuiescence() !== true) throw failed(); this.workers.delete(worker); }
        catch { this.fence(4); }
      }
      this.historyReady.delete(key);
      if (!this.closed) { try {
        if (authority) {
          if (acceptedDeletion) {
            await authority.authorize('prepare'); authority.local(); this.assertOwnership();
            if (!this.closed) { this.fingerprints.delete(key); this.options.projection?.removeSession(key); this.options.changed?.(key); }
          }
        } else { await this.read(key, false); this.options.changed?.(key); }
      } catch { this.observe(3, true); } }
    }
  }
  pauseQueueWorker(): AdmissionPause {
    if (this.closed) throw failed();
    if (this.pauseLease) return this.pauseLease;
    const driver = this.driver.pauseQueueWorker(); let drained = false;
    const lease: AdmissionPause = { drained: Promise.all([driver.drained,
      Promise.allSettled([this.startup, this.projectionRefresh, ...this.deletions, ...this.recoveries, ...[...this.reads.values()].map(r => r.work)])]).then(() => {
      if (this.preflight && this.preflight.inspectQuiescence() !== true || [...this.workers].some(w => w.inspectQuiescence() !== true)) throw failed();
      drained = true;
    }), resume: () => {
      if (!drained || this.closed || this.faulted || this.pauseLease !== lease) return false;
      try { this.assertOwnership(); } catch { return false; }
      if (!driver.resume()) return false;
      this.pauseLease = undefined; return true;
    } };
    this.pauseLease = lease; return lease;
  }
  async inspectMaintenance() {
    const [unresolvedExecutions, queuedInputs] = await Promise.all([
      this.options.owner.command('sdkPendingCount', { runtime: this.id }),
      this.options.owner.command('turnMaintenanceCount', { runtime: this.id }),
    ]);
    // Counts may cross owner loss/close while awaiting SQL. Root also retains
    // this synchronous native guard across other agents and final fence reads.
    return { ...captureMaintenanceFacts(() => {
      let ownershipHeld = true; try { this.assertOwnership(); } catch { ownershipHeld = false; }
      return { ...this.driver.inspect(), ownershipHeld, startupState: this.startupState,
        startupWorkers: Number(!!this.preflight && this.preflight.inspectQuiescence() !== true) + this.workers.size };
    }), unresolvedExecutions, queuedInputs };
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.historyReady.clear();
    const jobs: Promise<unknown>[] = [];
    try { jobs.push(this.driver.close()); } catch { this.fence(5); }
    for (const worker of [this.preflight, ...this.workers]) {
      if (!worker) continue;
      try { worker.close(); } catch { this.fence(5); }
      jobs.push(worker.ready, worker.finished);
    }
    // Operation cancellation is not physical cleanup failure. Drain every
    // original operation; driver/physical proofs decide HOME release.
    jobs.push(Promise.allSettled([this.startup, this.projectionRefresh, ...this.deletions, ...this.recoveries, ...[...this.reads.values()].map(r => r.work)]));
    this.closing = this.lease.releaseAfter(async () => {
      const results = await Promise.allSettled(jobs);
      if (this.faulted || results.some(r => r.status === 'rejected')
        || this.preflight && this.preflight.inspectQuiescence() !== true
        || [...this.workers].some(w => w.inspectQuiescence() !== true)) throw failed();
    }).then(() => { owners.get(this.options.owner)?.delete(this.id); this.observe(5, false); });
    return this.closing;
  }
}
