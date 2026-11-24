import type { AdmissionPause } from '../lifecycle/request-drain.js';
import { readRecoveryPage, type RecoveryPageSource } from './recovery-page.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

/** Read-only scheduling port. Admissions are wake hints, not execution proof.
 * No queue mutation or callback is sent to a database Worker. */
export interface TurnWorkerQueue {
  sessionPage(runtime: string, after: string, limit: number): string[] | Promise<string[]>;
  onAdmission(listener: (runtime: string) => void): () => void;
}

/** Scheduling metadata only: SQLite remains the sole pending-work queue.
 * Explicit start, no overlapping passes, bounded fair pages and no idle timer.
 * Reconciliation may retry; the callback must never resend an uncertain turn.
 */
export class TurnWorker {
  private started = false;
  private closed = false;
  private timer: NodeJS.Timeout | undefined;
  private immediateTimer = false;
  private inflight: Promise<void> | undefined;
  private wakePending = false;
  private unsubscribe: (() => void) | undefined;
  private cursor = '';
  private pauseLease: AdmissionPause | undefined;
  private readonly stallWarningMs: number;
  private readonly recoveryWorker: TurnWorker | undefined;
  private readonly reconciling = new Set<string>();

  constructor(private readonly options: {
    queue: TurnWorkerQueue;
    runtime: string;
    reconcile: (sessionKey: string) => Promise<void>;
    retryMs?: number;
    pageSize?: number;
    additionalSessionPage?: (after: string, limit: number, isCurrent: () => boolean) => string[] | Promise<string[]>;
    diagnostics?: PerformanceDiagnostics;
    /** Observation only: never a deadline, retry or authority to unlock work. */
    stallWarningMs?: number;
    isolateRecovery?: boolean;
    concurrency?: 1 | 2;
  }) {
    const interval = options.stallWarningMs ?? 30_000;
    if (!Number.isSafeInteger(interval) || interval < 1000 || interval > 86_400_000) {
      throw Error('Invalid turn worker observation interval');
    }
    this.stallWarningMs = interval;
    if (options.isolateRecovery && options.additionalSessionPage) {
      this.recoveryWorker = new TurnWorker({
        queue: {
          sessionPage: (_runtime, after, limit) => options.additionalSessionPage!(after, limit,
            () => !this.closed && !this.pauseLease),
          onAdmission: () => () => {},
        },
        runtime: options.runtime,
        reconcile: key => this.reconcileOwned(key),
        ...(options.retryMs !== undefined ? { retryMs: options.retryMs } : {}),
        ...(options.pageSize !== undefined ? { pageSize: options.pageSize } : {}),
        ...(options.diagnostics !== undefined ? { diagnostics: options.diagnostics } : {}),
        stallWarningMs: interval,
        concurrency: 1,
      });
    }
  }

  start() {
    if (this.started || this.closed) return;
    this.started = true;
    this.recoveryWorker?.start();
    this.unsubscribe = this.options.queue.onAdmission((runtime) => {
      if (runtime === this.options.runtime) this.wake();
    });
    this.wake();
  }

  wake() {
    if (!this.started || this.closed || this.pauseLease) return false;
    this.recoveryWorker?.wake();
    if (this.inflight) { this.wakePending = true; return true; }
    if (this.timer && this.immediateTimer) return true;
    // A new admission or runtime completion need not wait for a retry deadline.
    // Bursts share the same immediate timer; they cannot postpone its firing.
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    // The read itself belongs to the original flight. Do not start an async
    // probe outside pause/close ownership, or infer an empty queue from Promise.
    this.schedule(0);
    return true;
  }

  async close() {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.wakePending = false;
    await Promise.all([this.inflight, this.recoveryWorker?.close()]);
  }

  pause(): AdmissionPause {
    if (this.pauseLease) return this.pauseLease;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.wakePending = false;
    let settled = false;
    const recoveryPause = this.recoveryWorker?.pause();
    const pending = Promise.all([this.inflight, recoveryPause?.drained]).then(() => { settled = true; });
    const lease: AdmissionPause = {
      drained: pending,
      resume: () => {
        if (this.pauseLease !== lease || !settled || this.closed) return false;
        if (recoveryPause && !recoveryPause.resume()) return false;
        this.pauseLease = undefined;
        this.wake();
        return true;
      },
    };
    this.pauseLease = lease;
    return lease;
  }

  private schedule(delay: number) {
    this.immediateTimer = delay === 0;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // Install inflight before reconcile can synchronously admit more work.
      const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'turn-worker-pass');
      // A pending callback can leave the event loop healthy. Report its original
      // trace once, without settling the pass, resending work or granting a
      // pause/close drain ACK. This timer observes, never releases an owner.
      let step = 0;
      const warning = setTimeout(() => trace.reportPending({ pending: 1, step }), this.stallWarningMs);
      warning.unref();
      let failed = false;
      let more: boolean | undefined = false;
      this.inflight = Promise.resolve().then(async () => {
        if (this.closed || this.pauseLease) return;
        step = 1;
        const work = await this.hasWork();
        if (this.closed || this.pauseLease || work === false) return;
        if (work === undefined) { more = undefined; return; }
        step = 2;
        await this.pass();
        if (!this.closed && !this.pauseLease) { step = 3; more = await this.hasWork(); }
      }).catch(() => {
        failed = true;
        trace.add('deferred', 1);
        more = undefined;
      }).finally(() => {
        clearTimeout(warning);
        trace.add('step', step);
        trace.finish(failed);
        this.inflight = undefined;
        const nextDelay = !failed && this.wakePending ? 0 : this.retryDelay();
        this.wakePending = false;
        if (!this.closed && !this.pauseLease) {
          // An admission during the final read requires another bounded scan,
          // even if that earlier snapshot was empty. There is still one flight.
          if (more !== false || nextDelay === 0) this.schedule(more === undefined ? this.retryDelay() : nextDelay);
        }
      });
    }, delay);
    this.timer.unref();
  }

  private retryDelay() {
    const delay = this.options.retryMs ?? 5000;
    return Number.isFinite(delay) ? Math.max(1, Math.min(60_000, delay)) : 5000;
  }

  // A failed probe is not proof that the durable queue is empty. Retain a
  // bounded reconciliation timer, without mutating/replaying queued work.
  private async hasWork(): Promise<boolean | undefined> {
    const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'turn-worker-probe');
    try {
      const work = !!(await this.sessionPage('', 1)).length;
      trace.finish();
      return work;
    } catch {
      trace.add('deferred', 1); trace.finish(true);
      return undefined;
    }
  }

  private async pass() {
    let keys = await this.sessionPage(this.cursor);
    if (this.closed || this.pauseLease) return;
    if (!keys.length) keys = await this.sessionPage('');
    if (this.closed || this.pauseLease) return;
    if (!keys.length) this.cursor = '';
    let deferred = false;
    // Two rolling slots, still one original bounded pass. A retained runtime
    // read owns its slot until it actually settles, but cannot strand the idle
    // slot behind an allSettled batch barrier. Never start a new page to replace
    // retained work or infer quiescence from an observation/deadline.
    let index = 0;
    const slot = async () => {
      while (index < keys.length && !this.closed && !this.pauseLease) {
        const key = keys[index++]!;
        this.cursor = key;
        try { await Promise.resolve().then(() => this.reconcileOwned(key)); }
        catch { deferred = true; }
      }
    };
    await Promise.all(Array.from({ length: this.recoveryWorker ? 1 : this.options.concurrency ?? 2 }, slot));
    if (deferred) throw new Error('Turn reconciliation deferred');
  }

  private async reconcileOwned(sessionKey: string) {
    if (this.reconciling.has(sessionKey)) return;
    this.reconciling.add(sessionKey);
    try { await this.options.reconcile(sessionKey); }
    finally { this.reconciling.delete(sessionKey); }
  }

  private async sessionPage(after: string, limit = this.options.pageSize ?? 16) {
    limit = Math.max(1, Math.min(limit, 64));
    const isCurrent = () => !this.closed && !this.pauseLease;
    const sources: RecoveryPageSource[] = [
      (cursor, size) => this.options.queue.sessionPage(this.options.runtime, cursor, size),
    ];
    if (this.options.additionalSessionPage && !this.recoveryWorker) sources.push(
      (cursor, size) => this.options.additionalSessionPage!(cursor, size, isCurrent));
    // Validate the queue port too: an invalid async reply must not become an
    // empty-queue acknowledgement or an unbounded/native reconciliation page.
    return readRecoveryPage(after, limit, sources, isCurrent);
  }
}
