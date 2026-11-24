import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';

type Awaitable<T> = T | PromiseLike<T>;
export class ReadRequestError extends Error {
  constructor(readonly status: 408 | 503) { super(status === 408 ? 'request_cancelled' : 'read_unavailable'); }
}
export type ReadRequestContext = {
  /** Advisory cancellation only. Ownership is held until original settlement. */
  signal: AbortSignal;
  check(): void;
  stage<T>(step: number, work: () => Awaitable<T>): Promise<{ value: T }>;
};

/** Read-only original ownership. Ending an HTTP wait never cancels work,
 * releases capacity, replays a request or acknowledges a SQL mutation. */
export class ReadRequestOwner {
  private readonly originals = new Map<Promise<unknown>, AbortController>();
  private closed = false;
  private closeWork: Promise<void> | undefined;
  private capacityObservation = false;
  private readonly diagnostics: PerformanceDiagnostics;
  private readonly waitMs: number;
  private readonly limit: number;
  constructor(private readonly operation: Parameters<PerformanceDiagnostics['start']>[0], options: {
    diagnostics?: PerformanceDiagnostics | undefined; waitMs?: number | undefined; limit?: number;
  } = {}) {
    this.diagnostics = options.diagnostics ?? performanceDiagnostics;
    this.waitMs = options.waitMs ?? 30_000; this.limit = options.limit ?? 64;
    if (!Number.isSafeInteger(this.waitMs) || this.waitMs < 1 || this.waitMs > 2_147_483_647
      || !Number.isSafeInteger(this.limit) || this.limit < 1 || this.limit > 256) throw new ReadRequestError(503);
  }
  get pending() { return this.originals.size; }
  async run<T>(request: Request, work: (context: ReadRequestContext) => Awaitable<T>): Promise<{ value: T }> {
    if (request.signal.aborted) throw new ReadRequestError(408);
    if (this.closed) throw new ReadRequestError(503);
    if (this.pending >= this.limit) {
      if (!this.capacityObservation) {
        this.capacityObservation = true;
        try {
          const trace = guardedTrace(this.diagnostics, this.operation);
          trace.add('step', 99); trace.add('pending', this.pending); trace.add('deferred', 1); trace.finish(true);
        } finally { this.capacityObservation = false; }
      }
      throw new ReadRequestError(503);
    }
    let ended: ReadRequestError | undefined;
    const controller = new AbortController(), deadline = performance.now() + this.waitMs;
    const check = () => {
      if (request.signal.aborted) throw new ReadRequestError(408);
      if (this.closed) throw new ReadRequestError(503);
      if (ended) throw ended;
      // A synchronous callback may outlive the deadline before the timer gets
      // its next event-loop turn. It cannot publish a late successful read.
      if (performance.now() >= deadline) { ended = new ReadRequestError(503); controller.abort(); throw ended; }
    };
    const stage: ReadRequestContext['stage'] = async (step, action) => {
      check();
      const trace = guardedTrace(this.diagnostics, this.operation); trace.add('step', step);
      const timer = setTimeout(() => trace.reportPending({ pending: 1 }), 30_000); timer.unref();
      let failed = true, admitted = false;
      try {
        check(); admitted = true; trace.add('admitted', 1); check();
        const value = await action(); check(); failed = false;
        return { value };
      } finally { clearTimeout(timer); if (admitted) trace.add('settled', 1); trace.finish(failed); }
    };
    // Reserve before any diagnostic, authority or provider callback can reenter.
    const original = Promise.resolve().then(async () => { check(); const value = await work({ check, stage, signal: controller.signal }); check(); return { value }; });
    this.originals.set(original, controller);
    void original.then(() => this.originals.delete(original), () => this.originals.delete(original));
    let abort!: () => void, timer!: ReturnType<typeof setTimeout>;
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => { ended = new ReadRequestError(408); reject(ended); controller.abort(); };
      request.signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { ended = new ReadRequestError(request.signal.aborted ? 408 : 503); reject(ended); controller.abort(); }, this.waitMs);
      if (request.signal.aborted) abort();
    });
    const trace = guardedTrace(this.diagnostics, this.operation); trace.add('step', 0);
    let failed = true;
    try {
      const result = await Promise.race([original, interrupted]); check(); failed = false; return result;
    } finally {
      clearTimeout(timer); request.signal.removeEventListener('abort', abort);
      trace.add('pending', this.pending); trace.add('settled', 1);
      if (ended) trace.add(ended.status === 408 ? 'cancelled' : 'timedOut', 1);
      trace.finish(failed);
    }
  }
  close(): Promise<void> {
    if (this.closeWork) return this.closeWork;
    this.closed = true;
    // Never wait for a caller's timeout in place of the accepted originals.
    const draining = Promise.allSettled([...this.originals.keys()]);
    this.closeWork = Promise.resolve().then(async () => {
      const trace = guardedTrace(this.diagnostics, this.operation); trace.add('step', 98); trace.add('pending', this.pending);
      const warning = setTimeout(() => trace.reportPending({ pending: this.pending }), 30_000); warning.unref();
      try { const outcomes = await draining; trace.add('settled', outcomes.length); trace.finish(outcomes.some(result => result.status === 'rejected')); }
      finally { clearTimeout(warning); }
    });
    for (const controller of this.originals.values()) controller.abort();
    return this.closeWork;
  }
}
