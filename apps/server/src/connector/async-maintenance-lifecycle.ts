import type { AdmissionPause } from '../lifecycle/request-drain.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';

/** Root-private lifecycle capability, not an HTTP authorization or native-idle proof. */
export type AsyncMaintenancePause = {
  readonly asynchronous: true;
  readonly drained: Promise<void>;
  resume(authorize: () => Promise<void>, assertLocal: () => void): Promise<boolean>;
};
type Owner = Pick<AsyncConnectorOwner, 'command'>;
type Pause = {
  lease: AsyncMaintenancePause;
  locals: AdmissionPause[];
  generation?: number;
  drained: boolean;
  releaseStarted: boolean;
};

/** Coordinates original local gates and the sole worker's generation fence.
 * This owns accepted operations through physical completion, never the shared
 * owner itself. It does not substitute projection state for native inspection.
 */
export class AsyncMaintenanceLifecycle {
  private current: Pause | undefined;
  private stopped = false;
  private closing: Promise<void> | undefined;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly owner: Owner, private readonly localPauses: readonly (() => AdmissionPause)[],
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {}

  private retain<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    void work.then(() => this.pending.delete(work), () => this.pending.delete(work));
    return work;
  }

  pause = (): AsyncMaintenancePause => {
    if (this.current) return this.current.lease;
    let complete!: () => void, fail!: (reason: unknown) => void;
    const drained = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
    const state: Pause = { lease: { asynchronous: true, drained,
      resume: (authorize, assertLocal) => this.resume(state, authorize, assertLocal) },
    locals: [], drained: false, releaseStarted: false };
    // Publish ownership before invoking arbitrary original local factories.
    this.current = state;
    this.retain(drained);
    const waits: Promise<unknown>[] = [];
    for (const pause of this.localPauses) {
      try {
        const local = pause();
        state.locals.push(local);
        waits.push(local.drained);
      } catch (error) { waits.push(Promise.reject(error)); }
    }
    const worker = Promise.resolve().then(() => this.owner.command('maintenancePause', {})).then(generation => {
      if (!Number.isSafeInteger(generation) || generation < 1) throw Error('Invalid maintenance pause acknowledgement');
      state.generation = generation;
    });
    waits.push(worker);
    // A rejected local drain must not abandon a still-running worker command.
    void Promise.allSettled(waits).then(results => {
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') fail(failure.reason);
      else { state.drained = true; complete(); }
    });
    return state.lease;
  };

  private resume(state: Pause, authorize: () => Promise<void>, assertLocal: () => void): Promise<boolean> {
    if (this.stopped || this.current !== state || !state.drained || state.releaseStarted) return Promise.resolve(false);
    state.releaseStarted = true;
    return this.retain(Promise.resolve().then(async () => {
      const trace = guardedTrace(this.diagnostics, 'connector-sqlite-command');
      trace.add('step', 345);
      let failed = true;
      const warning = setTimeout(() => trace.reportPending({ pending: 1 }), 30_000); warning.unref();
      const current = () => {
        if (this.stopped || this.current !== state) throw Error('Maintenance lifecycle is fenced');
        assertLocal();
      };
      try {
        current(); await authorize(); current();
        const released = await this.owner.command('maintenanceResume', { generation: state.generation! });
        if (!released) { await this.refence(state); return false; }
        // Neither the worker ACK nor an earlier operator check authorizes the
        // original local effects after this await boundary.
        current(); await authorize(); current();
        for (const local of state.locals) {
          current();
          if (local.resume() !== true) { await this.refence(state); return false; }
        }
        current();
        this.current = undefined;
        failed = false; trace.add('settled', 1);
        return true;
      } catch (error) {
        // Includes unknown ACK and partially released local gates. All local
        // producers are frozen synchronously, then the worker is repaused FIFO.
        try { await this.refence(state); }
        catch (cleanup) { throw new AggregateError([error, cleanup], 'Maintenance refence failed; admission remains fenced'); }
        throw error;
      } finally { clearTimeout(warning); trace.finish(failed); }
    }));
  }

  private refence(state: Pause): Promise<void> {
    if (this.current === state) this.current = undefined;
    return this.pause().drained;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    let complete!: () => void, fail!: (reason: unknown) => void;
    this.closing = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
    this.stopped = true;
    // Refreeze even when a local resume synchronously reentered shutdown.
    this.current = undefined;
    const paused = this.pause();
    const stop = this.retain(Promise.resolve().then(() => this.owner.command('maintenanceStop', {})));
    void Promise.resolve().then(async () => {
      const results = await Promise.allSettled([paused.drained, stop]);
      const failures = results.filter(result => result.status === 'rejected').map(result => result.reason);
      while (this.pending.size) {
        // Accepted operations retain physical ownership even when shutdown
        // correctly vetoes their result. Their caller-visible rejection is
        // not failure of this shutdown's independent pause + permanent stop.
        // Those required acknowledgements above MUST still succeed.
        await Promise.allSettled([...this.pending]);
      }
      if (failures.length) throw new AggregateError(failures, 'Maintenance shutdown could not confirm drain');
    }).then(complete, fail);
    return this.closing;
  }
}
