import type { AgentReadiness } from '@agentopsdeck/shared';
import type { ConnectorAgentLifecycle } from './agent-runtimes.js';
import type { SdkAgentId } from './sdk-execution-journal.js';
import type { AdmissionPause } from '../lifecycle/request-drain.js';
import type { HistoryRefreshOptions } from '../refresh/history.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

type Facts = { ownershipHeld: boolean; cleanupUnconfirmed: boolean; closed: boolean; faulted: boolean; assertCurrent?(): void };
type Owned<R extends SdkAgentId> = ConnectorAgentLifecycle & {
  readonly id: R;
  readonly ready: boolean;
  readonly status: AgentReadiness;
  initialize(): Promise<boolean>;
  refreshDirectory(): Promise<void>;
  refreshProjection(): Promise<void>;
  inspectMaintenance(): Promise<Facts>;
};
type Pause = { lease: AdmissionPause; original?: AdmissionPause; complete: boolean; originalDrain?: Promise<void> };
const unavailable = () => Error('SDK asynchronous runtime unavailable; original ownership retained');

/** Deferred physical assembly. No DB, HOME or native side effects at construction.
 * The sole original factory and its cleanup remain owned even after close, an
 * aborted caller, or failed startup. This is NOT a synchronous commands shim. */
export class AsyncSdkConnectorRuntime<R extends SdkAgentId, O extends Owned<R>> implements ConnectorAgentLifecycle {
  private owned: O | undefined;
  private activated = false;
  private closed = false;
  private faulted = false;
  private acquisition: Promise<void> | undefined;
  private startup: Promise<void> | undefined;
  private pause: Pause | undefined;
  private ownedClose: Promise<void> | undefined;
  private closing: Promise<void> | undefined;

  constructor(readonly id: R, private readonly createOwner: () => Promise<O>,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {}

  private observe(step: number, failed: boolean) {
    const trace = guardedTrace(this.diagnostics, 'sdk-owned-lifecycle');
    trace.add('step', step + (this.id === 'ghcp' ? 100 : 0)); trace.finish(failed);
  }
  activate(): void {
    if (this.activated || this.closed) return;
    this.activated = true;
    // Publish original work before invoking a factory or observer that may
    // synchronously reenter pause/close. No alternate factory on failure.
    this.acquisition = Promise.resolve().then(async () => {
      if (this.closed) return;
      const original = await this.createOwner();
      this.owned = original;
      if (this.closed) { await this.closeOwned(); return; }
      if (this.pause) this.bindPause(this.pause);
      else this.start();
      this.observe(6, false);
    }).catch(() => { this.faulted = true; this.observe(6, true); });
  }
  private start(): void {
    if (!this.owned || this.startup || this.closed || this.faulted || this.pause) return;
    const original = this.owned;
    this.startup = Promise.resolve().then(async () => {
      if (this.closed || this.pause) return;
      await original.initialize();
      if (!this.closed && original.status === 'failed') this.faulted = true;
    }).catch(() => { this.faulted = true; this.observe(6, true); });
    // A pause may arrive before the deferred call; then initialize has not
    // started at all and resume must still be allowed to invoke it once.
    void this.startup.then(() => {
      if (!this.closed && this.pause && original.status === 'maintenance') this.startup = undefined;
    });
  }
  /** Await the ORIGINAL acquisition and preflight, never poll cached readiness
   * or resolve just because activation was scheduled. close retains both. */
  async whenStarted(): Promise<void> {
    this.activate();
    await this.acquisition;
    await this.startup;
    if (!this.ready) throw unavailable();
  }
  /** Root preparation barrier, NOT execution readiness. A restored maintenance
   * lease may acquire the original HOME/SQL owner and hydrate its projection
   * without launching preflight or recovering queued effects. Ordinary callers
   * must still use whenStarted/withReady. Capture and recheck the exact lease
   * around every physical drain so resume/close cannot counterfeit preparation. */
  async whenPrepared(): Promise<void> {
    this.activate();
    await this.acquisition;
    await this.startup;
    if (this.ready) return;
    const pause = this.pause;
    if (!pause || !this.owned || this.closed || this.faulted) throw unavailable();
    await pause.lease.drained;
    await pause.originalDrain;
    if (this.owned.status === 'failed') this.faulted = true;
    if (this.closed || this.faulted || this.pause !== pause || !pause.original || !pause.complete
      || this.owned.status !== 'maintenance') throw unavailable();
  }
  get status(): AgentReadiness {
    if (this.closed) return 'closed';
    if (this.faulted || this.owned?.status === 'failed') return 'failed';
    if (this.pause) return 'maintenance';
    return this.owned?.status ?? 'starting';
  }
  get ready(): boolean { return this.status === 'ready' && this.owned?.ready === true; }

  /** Execution access is not authorization; the driver still performs its
   * original worker/local-epoch checks immediately before physical handoff. */
  withReady<T>(run: (original: O) => T): T {
    if (!this.ready || !this.owned) throw unavailable();
    return run(this.owned);
  }
  /** Original control only. Maintenance vetoes fresh execution, not a stop
   * targeting this owner's existing physical invocation. Driver/worker still
   * enforce original references, epoch, authority and one-shot settlement. */
  withRetainedOwner<T>(run: (original: O) => T): T {
    if (this.closed || !this.owned) throw unavailable();
    return run(this.owned);
  }
  async refreshDirectory(): Promise<void> {
    if (this.closed || this.faulted) throw unavailable();
    await this.acquisition;
    if (this.closed || this.faulted || !this.owned) throw unavailable();
    await this.owned.refreshDirectory();
    if (this.closed || this.faulted) throw unavailable();
  }
  async refreshSession(key: string, options: HistoryRefreshOptions = {}): Promise<void> {
    if (this.closed || this.faulted) throw unavailable();
    await this.acquisition;
    if (this.closed || this.faulted || !this.owned) throw unavailable();
    await this.owned.refreshSession(key, options);
    if (this.closed || this.faulted) throw unavailable();
  }
  async refreshProjection(): Promise<void> {
    if (this.closed || this.faulted) throw unavailable();
    await this.acquisition;
    if (this.closed || this.faulted || !this.owned) throw unavailable();
    try { await this.owned.refreshProjection(); }
    catch { throw unavailable(); }
    if (this.closed || this.faulted) throw unavailable();
  }
  isSessionHistoryReady(key: string): boolean {
    return !this.closed && !this.faulted && this.owned?.isSessionHistoryReady(key) === true;
  }
  private bindPause(pause: Pause): void {
    if (!this.owned || pause.original || this.closed) return;
    pause.complete = false;
    try {
      pause.original = this.owned.pauseQueueWorker();
      pause.originalDrain = Promise.resolve(pause.original.drained).then(() => { pause.complete = true; });
      void pause.originalDrain.catch(() => { this.faulted = true; this.observe(7, true); });
    } catch { this.faulted = true; throw unavailable(); }
  }
  pauseQueueWorker(): AdmissionPause {
    if (this.closed) throw unavailable();
    if (this.pause) return this.pause.lease;
    const pause: Pause = { complete: false, lease: {
      drained: Promise.resolve().then(async () => {
        await this.acquisition;
        if (this.closed || this.faulted) throw unavailable();
        this.bindPause(pause);
        await pause.originalDrain;
        if (this.closed || this.faulted) throw unavailable();
        if (!this.activated) pause.complete = true;
        this.observe(7, false);
      }),
      resume: () => {
        if (this.closed || this.faulted || this.owned?.status === 'failed' || this.pause !== pause || !pause.complete
          || this.activated && (!this.owned || !pause.original)) return false;
        try { if (pause.original && pause.original.resume() !== true) return false; }
        catch { this.faulted = true; return false; }
        this.pause = undefined;
        if (this.activated) this.start();
        return true;
      },
    } };
    this.pause = pause;
    void pause.lease.drained.catch(() => {});
    // Freeze an already-created runtime synchronously, not after a microtask.
    this.bindPause(pause);
    return pause.lease;
  }
  async inspectMaintenance(): Promise<Awaited<ReturnType<O['inspectMaintenance']>> & { assertCurrent(): void }> {
    if (this.closed || this.faulted) throw unavailable();
    await this.acquisition;
    if (this.closed || this.faulted || !this.owned) throw unavailable();
    if (this.pause) await this.pause.originalDrain;
    const original = this.owned;
    const pause = this.pause;
    const facts = await original.inspectMaintenance();
    if (this.closed || this.faulted || this.pause !== pause || original.status === 'failed' || original.status === 'closed'
      || facts.ownershipHeld !== true || facts.cleanupUnconfirmed !== false
      || facts.closed !== false || facts.faulted !== false) throw unavailable();
    return { ...facts, assertCurrent: () => {
      if (this.closed || this.faulted || this.owned !== original || this.pause !== pause
        || original.status === 'failed' || original.status === 'closed') throw unavailable();
      facts.assertCurrent?.();
    } } as Awaited<ReturnType<O['inspectMaintenance']>> & { assertCurrent(): void };
  }
  private closeOwned(): Promise<void> {
    if (!this.owned) return Promise.resolve();
    return this.ownedClose ??= Promise.resolve().then(() => this.owned!.close());
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    // Start cleanup of known workers immediately; waiting for initialize first
    // would deadlock on a preflight whose physical exit needs close().
    const early = this.closeOwned();
    this.closing = Promise.resolve().then(async () => {
      const first = await Promise.allSettled([early, this.acquisition]);
      const rest = await Promise.allSettled([this.closeOwned(), this.startup]);
      if ([...first, ...rest].some(value => value.status === 'rejected')) {
        this.observe(8, true); throw unavailable();
      }
      this.observe(8, false);
    });
    void this.closing.catch(() => {});
    return this.closing;
  }
}
