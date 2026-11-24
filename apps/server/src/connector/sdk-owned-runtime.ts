import type { ConnectorUserStore } from './connector-user-store.js';
import { PrivateAgentHomeLease } from './private-agent-home-lease.js';
import type { SdkExecutionDriver, SdkOwnedTurn } from './sdk-execution-driver.js';
import type { SdkExecutionJournal, SdkAgentId } from './sdk-execution-journal.js';
import { SdkCommands, type SdkCommandOptions } from './sdk-commands.js';
import type { ConnectorAgentLifecycle } from './agent-runtimes.js';
import type { HistoryRefreshOptions } from '../refresh/history.js';
import type { AdmissionPause } from '../lifecycle/request-drain.js';
import { captureMaintenanceFacts } from './maintenance-facts.js';
import { randomUUID } from 'node:crypto';
import { requiredSynchronousEffectAuthority as synchronousEffectAuthority } from '../auth/synchronous-effect-authority.js';
import { SessionDeletionConflict } from '../commands/turn-queue.js';
import type { PrivateWorkerDeletion } from './private-worker-preflight.js';
import type { AgentReadiness } from '@agentopsdeck/shared';

type PrivateConfig = { homeDirectory: string; startupTimeoutMs: number; model: string; modelChoices?: string[] };
type OwnedDriver = Pick<SdkExecutionDriver<SdkOwnedTurn>, 'inspect' | 'wake' | 'interrupt' | 'pauseQueueWorker' | 'close'> & Partial<Pick<SdkExecutionDriver<SdkOwnedTurn>, 'compact'>>;
export type SdkPreflight = { ready: Promise<boolean>; finished: Promise<void>; inspectQuiescence(): boolean; close(): void };
export type SdkOwnedProjection = { publish(key: string, ready: boolean): unknown; publishSummary(key: string, ready: boolean): void };
export type SdkOwnedOptions<R extends SdkAgentId, C extends PrivateConfig, D extends OwnedDriver> = {
  runtime: R; store: ConnectorUserStore; journal: SdkExecutionJournal; config: C;
  authorize: SdkCommandOptions<R>['authorize']; changed?: ((key: string) => void) | undefined;
  projection?: SdkOwnedProjection | undefined;
  check: (config: C) => SdkPreflight;
  deleteNative: (config: C, request: PrivateWorkerDeletion) => SdkPreflight;
  driver: (hooks: { admissionReady: () => boolean; assertOwnership: () => void; changed: (key: string) => void }) => D;
};
const owners = new WeakMap<ConnectorUserStore, Set<SdkAgentId>>();
const failed = () => new Error('SDK runtime requires exclusive Connector store and private home ownership');

/** Shared private ownership/lifecycle composition; routes authorize separately. No credential
 * or SDK reads here. The Connector owns the DB and must close this runtime
 * BEFORE closing that DB. No existing CLI sessions are adopted or imported. */
export class SdkOwnedRuntime<R extends SdkAgentId, C extends PrivateConfig, D extends OwnedDriver> implements ConnectorAgentLifecycle {
  readonly id: R;
  readonly driver: D;
  readonly commands: SdkCommands<R>;
  private readonly ownerFile: string;
  private readonly lease: PrivateAgentHomeLease;
  private closing: Promise<void> | undefined;
  private readonly config: C;
  private readonly projection: SdkOwnedProjection | undefined;
  private startup: Promise<boolean> | undefined;
  private startupState: 'pending' | 'checking' | 'ready' | 'failed' = 'pending';
  private preflight: SdkPreflight | undefined;
  private maintenancePause: AdmissionPause | undefined;
  private readonly historyReady = new Set<string>();
  private readonly deletionWorkers = new Set<SdkPreflight>();
  private readonly deletionJobs = new Set<Promise<void>>();
  private deletionCleanupUnconfirmed = false;

  constructor(private readonly options: SdkOwnedOptions<R, C, D>) {
    const file = options.store.runtimeOwnerFile;
    if (!file || owners.get(options.store)?.has(options.runtime) || options.journal.runtime !== options.runtime) throw failed();
    this.id = options.runtime; this.ownerFile = file;
    this.config = structuredClone(options.config); this.projection = options.projection;
    this.lease = PrivateAgentHomeLease.acquire(options.runtime, this.config.homeDirectory, file, options.store.nodeId);
    const owned = owners.get(options.store) ?? new Set<SdkAgentId>();
    owned.add(options.runtime); owners.set(options.store, owned);
    this.driver = options.driver({
      admissionReady: () => this.ready,
      assertOwnership: () => {
        if (!this.ready || options.store.runtimeOwnerFile !== file) throw failed();
        this.lease.assertHeld();
      },
      changed: key => {
        try {
          if (this.projection && !this.closing) {
            this.historyReady.delete(key);
            this.projection.publish(key, this.ready); this.historyReady.add(key);
          }
        } finally { options.changed?.(key); }
      },
    });
    this.commands = new SdkCommands({ runtime: options.runtime, journal: options.journal,
      store: options.store, driver: this.driver, authorize: options.authorize, models: this.config,
      assertAvailable: requireStartup => {
        if (this.closing || this.maintenancePause || this.driver.inspect().admissionPaused
          || !options.store.sdkCommandAdmissionOpen || options.store.runtimeOwnerFile !== this.ownerFile) throw failed();
        this.lease.assertHeld();
        if (requireStartup && !this.ready) throw new Error('SDK runtime is not ready');
      },
      changed: key => {
        this.historyReady.delete(key); this.projection?.publish(key, this.ready); options.changed?.(key);
      },
    });
  }

  /** Local control-channel readiness only, NOT provider/model authentication. */
  get ready() {
    const state = this.driver.inspect();
    if (this.closing || this.startupState !== 'ready' || this.options.store.runtimeOwnerFile !== this.ownerFile
      || state.closed || state.faulted || state.cleanupUnconfirmed || this.deletionCleanupUnconfirmed) return false;
    try { this.lease.assertHeld(); return true; } catch { return false; }
  }

  /** Bounded, public diagnostic. Never include native errors, paths or keys. */
  get status(): AgentReadiness {
    if (this.closing) return 'closed';
    const state = this.driver.inspect();
    if (this.startupState === 'failed' || state.closed || state.faulted || state.cleanupUnconfirmed
      || this.deletionCleanupUnconfirmed || this.options.store.runtimeOwnerFile !== this.ownerFile) return 'failed';
    try { this.lease.assertHeld(); } catch { return 'failed'; }
    if (this.maintenancePause || state.admissionPaused || !this.options.store.sdkCommandAdmissionOpen) return 'maintenance';
    return this.startupState === 'ready' ? 'ready' : 'starting';
  }

  initialize(): Promise<boolean> {
    if (this.closing) return Promise.resolve(false);
    if (this.startup) return this.startup;
    if (this.maintenancePause) return Promise.resolve(false);
    this.startupState = 'checking';
    this.startup = Promise.resolve().then(async () => {
      try {
        if (this.closing || this.options.store.runtimeOwnerFile !== this.ownerFile) throw failed();
        this.lease.assertHeld();
        this.refreshDirectory();
        this.preflight = this.options.check(structuredClone(this.config));
        const passed = await this.preflight.ready;
        await this.preflight.finished;
        if (!passed || !this.preflight.inspectQuiescence() || this.closing || this.options.store.runtimeOwnerFile !== this.ownerFile) throw failed();
        this.lease.assertHeld();
        this.startupState = 'ready';
        this.refreshDirectory();
        // Reauthorization and journal recovery still apply to every batch.
        for (const key of this.options.store.turns.sessions(this.id)) void this.driver.wake(key);
        return true;
      } catch {
        this.startupState = 'failed';
        this.preflight?.close();
        return false;
      }
    });
    return this.startup;
  }

  /** Local journal discovery only. No native query or transcript scans. The
   * authorized session-list route is responsible for filtering the result. */
  refreshDirectory() {
    if (this.closing) throw failed();
    let after: string | undefined;
    for (;;) {
      const keys = this.options.journal.sessionKeys(after);
      for (const key of keys) this.projection?.publishSummary(key, this.ready);
      if (keys.length < 200) return;
      after = keys.at(-1)!;
    }
  }

  async refreshSession(key: string, _options: HistoryRefreshOptions = {}) {
    if (this.closing || !this.projection || !this.options.journal.session(key)) throw failed();
    this.historyReady.delete(key);
    this.projection.publish(key, this.ready);
    this.historyReady.add(key);
  }

  isSessionHistoryReady(key: string) { return !this.closing && this.historyReady.has(key); }

  remove(key: string, authorize: () => void, acknowledge: () => void): Promise<void> {
    const job = this.removeOwned(key, authorize, acknowledge);
    this.deletionJobs.add(job);
    void job.finally(() => this.deletionJobs.delete(job)).catch(() => {});
    return job;
  }

  private async removeOwned(key: string, authorize: () => void, acknowledge: () => void) {
    const { store, journal } = this.options;
    if (!this.ready || this.maintenancePause || this.driver.inspect().admissionPaused || !store.sdkCommandAdmissionOpen) {
      throw new SessionDeletionConflict('SDK runtime is not ready for deletion');
    }
    synchronousEffectAuthority(authorize);
    if (!journal.canStart(key) || !store.canDeleteSession(key)) throw new SessionDeletionConflict('SDK session cannot be deleted while work is unresolved');
    const session = journal.session(key)!;
    // No await between authority/admission checks, durable exclusion and fork.
    const intent = journal.beginDeletion(key, randomUUID());
    let worker: SdkPreflight | undefined;
    try {
      if (session.nativeState === 'ready') {
        worker = this.options.deleteNative(structuredClone(this.config), { kind: 'delete-native', id: intent.id, nativeSessionId: intent.nativeSessionId });
        this.deletionWorkers.add(worker);
        const accepted = await worker.ready;
        await worker.finished;
        if (!accepted || !worker.inspectQuiescence()) throw new Error('SDK native deletion outcome is unknown');
      }
      // Native fact survives client disconnect/revocation. Never re-run a
      // mutation because projection or the response transport subsequently fails.
      journal.settleDeletion(intent, true, () => { store.sdkAttachments.remove(key); acknowledge(); });
    } catch {
      worker?.close();
      if (worker) await worker.finished;
      journal.settleDeletion(intent, false);
      throw new Error('SDK deletion outcome is unknown; inspect the original receipt, do not retry');
    } finally {
      if (worker) {
        if (worker.inspectQuiescence()) this.deletionWorkers.delete(worker);
        else this.deletionCleanupUnconfirmed = true;
      }
      this.historyReady.delete(key);
      try { this.projection?.publishSummary(key, this.ready); this.options.changed?.(key); } catch { /* durable lifecycle survives projection failure */ }
    }
  }

  /** Drain startup as well as admissions. This is NOT proof that an active
   * native turn is finished; maintenance must also inspect workers/journal. */
  pauseQueueWorker(): AdmissionPause {
    if (this.closing) throw failed();
    if (this.maintenancePause) return this.maintenancePause;
    const driver = this.driver.pauseQueueWorker();
    let drained = false;
    const lease: AdmissionPause = {
      drained: Promise.all([driver.drained, this.startup, Promise.allSettled([...this.deletionJobs])]).then(() => {
        if (this.preflight && !this.preflight.inspectQuiescence()) throw failed();
        if ([...this.deletionWorkers].some(worker => !worker.inspectQuiescence())) throw failed();
        drained = true;
      }),
      resume: () => {
        if (!drained || this.closing || this.maintenancePause !== lease
          || !this.inspectMaintenance().ownershipHeld || !driver.resume()) return false;
        this.maintenancePause = undefined;
        return true;
      },
    };
    this.maintenancePause = lease;
    return lease;
  }

  inspectMaintenance() {
    return captureMaintenanceFacts(() => this.maintenanceFacts());
  }

  private maintenanceFacts() {
    const state = this.driver.inspect();
    let ownershipHeld = this.options.store.runtimeOwnerFile === this.ownerFile;
    try { this.lease.assertHeld(); } catch { ownershipHeld = false; }
    return { ...state, ownershipHeld, startupState: this.startupState,
      startupWorkers: (this.preflight && !this.preflight.inspectQuiescence() ? 1 : 0)
        + [...this.deletionWorkers].filter(worker => !worker.inspectQuiescence()).length,
      unresolvedExecutions: this.options.journal.pendingCount(),
      queuedInputs: this.options.store.turns.maintenanceCount(this.id) };
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    // Close admission synchronously, before any already scheduled wake gets
    // its next microtask. Keep the HOME marker until native cleanup resolves.
    const cleanup = this.driver.close();
    this.preflight?.close();
    for (const worker of this.deletionWorkers) worker.close();
    this.closing = this.lease.releaseAfter(async () => {
      const results = await Promise.allSettled([cleanup, this.startup, this.preflight?.finished,
        Promise.allSettled([...this.deletionJobs])]);
      if (results.some(result => result.status === 'rejected')
        || this.preflight && !this.preflight.inspectQuiescence()
        || [...this.deletionWorkers].some(worker => !worker.inspectQuiescence())) throw failed();
    }).then(() => {
      owners.get(this.options.store)?.delete(this.id);
    });
    // A failed close deliberately keeps the in-process owner and persistent
    // marker. Neither constructing again nor calling close twice clears it.
    return this.closing;
  }
}
