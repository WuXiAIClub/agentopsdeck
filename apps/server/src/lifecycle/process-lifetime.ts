import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';

type Owner = { close: () => void | Promise<void>; canRetry: () => boolean; started: boolean; settled: boolean };
type Options = { diagnostics?: PerformanceDiagnostics; warningMs?: number; retryMs?: number; keepAlive?: boolean;
  onFailure?: () => void; onClosed: (exitCode: number) => void };

/** Process shutdown retains the exact registered owners. All ingress stops and
 * application fences start synchronously; one failed owner cannot skip another.
 * Only an owner's explicit close-protocol evidence permits another close call.
 * A pending/unknown drain is never timed out, replayed, or replaced. */
export class ProcessLifetime {
  private readonly owners: Owner[] = [];
  private flight: Promise<boolean> | undefined;
  private warning: ReturnType<typeof setInterval> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private trace?: ReturnType<PerformanceDiagnostics['start']>;
  private started = false;
  private completed = false;
  private completionAttempted = false;
  private exitCode = 0;
  private attempts = 0;
  private readonly diagnostics: PerformanceDiagnostics;
  private readonly warningMs: number;
  private readonly retryMs: number;

  constructor(private readonly options: Options) {
    this.diagnostics = options.diagnostics ?? performanceDiagnostics;
    this.warningMs = options.warningMs ?? 30_000;
    this.retryMs = options.retryMs ?? 1000;
    for (const value of [this.warningMs, this.retryMs])
      if (!Number.isSafeInteger(value) || value < 1 || value > 86_400_000) throw Error('Invalid process cleanup interval');
  }

  own(close: Owner['close'], canRetry: Owner['canRetry'] = () => false): void {
    if (this.started) throw Error('Process ownership registration has closed');
    this.owners.push({ close, canRetry, started: false, settled: false });
  }

  snapshot() {
    return Object.freeze({ started: this.started, closed: this.completed, active: !!this.flight,
      attempts: this.attempts, pending: this.owners.filter(owner => !owner.settled).length,
      settled: this.owners.filter(owner => owner.settled).length, exitCode: this.exitCode });
  }

  /** Always consumes failures, including thrown/rejected undefined. Safe for
   * signal handlers to discard this Promise; false is not a cleanup ACK. */
  shutdown(exitCode = 0): Promise<boolean> {
    if (this.flight) {
      if (exitCode !== 0) this.markFailure();
      return this.flight;
    }
    if (this.completed || this.completionAttempted) {
      if (exitCode !== 0) this.markFailure();
      return Promise.resolve(this.completed);
    }
    let resolve!: (closed: boolean) => void;
    const active = new Promise<boolean>(done => { resolve = done; });
    this.flight = active; // Fence failure/log/close callbacks before invoking any observer.
    this.attempts++;
    if (this.retry) { clearTimeout(this.retry); this.retry = undefined; }
    const firstAttempt = !this.started;
    this.started = true;
    if (exitCode !== 0) this.markFailure();
    if (firstAttempt) {
      this.trace = guardedTrace(this.diagnostics, 'process-shutdown');
      // Keep the process alive while an owner is unknown. This interval only
      // observes; it cannot release a resource or turn a Promise into success.
      this.warning = setInterval(() => this.trace?.reportPending({ pending: this.snapshot().pending,
        settled: this.snapshot().settled }), this.warningMs);
      if (this.options.keepAlive === false) this.warning.unref();
    }
    const pending: Promise<void>[] = [];
    for (const [index, owner] of [...this.owners].reverse().entries()) {
      if (owner.settled || (owner.started && !this.retryPermitted(owner))) continue;
      const retrying = owner.started;
      owner.started = true;
      const trace = guardedTrace(this.diagnostics, 'process-shutdown-owner'); trace.add('step', index + 1);
      let result: Promise<void>;
      try { result = Promise.resolve(owner.close()); } catch (error) { result = Promise.reject(error); }
      pending.push(result.then(() => {
        owner.settled = true; trace.add(retrying ? 'recovered' : 'settled', 1); trace.finish();
      }, () => { this.markFailure(); trace.add('unknown', 1); trace.finish(true); }));
    }
    void Promise.all(pending).then(() => {
      if (this.owners.every(owner => owner.settled)) {
        this.completionAttempted = true;
        if (this.warning) clearInterval(this.warning);
        // Emit owner-closure evidence before onClosed can terminate the process.
        this.trace?.add('settled', this.owners.length); this.trace?.finish();
        try {
          this.options.onClosed(this.exitCode);
          this.completed = true;
        } catch {
          // Never replay a process-exit callback whose own effect is unknown.
          this.markFailure();
          const trace = guardedTrace(this.diagnostics, 'process-shutdown-owner'); trace.add('step', 0); trace.add('unknown', 1); trace.finish(true);
        }
      } else if (this.owners.some(owner => !owner.settled && this.retryPermitted(owner))) {
        this.retry = setTimeout(() => { this.retry = undefined; void this.shutdown(this.exitCode); }, this.retryMs);
        if (this.options.keepAlive === false) this.retry.unref();
      }
      // Retain the original flight through completion and retry-evidence callbacks.
      this.flight = undefined;
      resolve(this.completed);
    });
    return active;
  }

  private retryPermitted(owner: Owner) { try { return owner.canRetry() === true; } catch { return false; } }
  private markFailure() {
    if (this.exitCode === 1) return;
    this.exitCode = 1; // Fence a reentrant failure observer before invoking it.
    try { this.options.onFailure?.(); } catch { /* Observation cannot release owners. */ }
  }
}
