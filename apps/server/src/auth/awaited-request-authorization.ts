import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AuthPersistenceError } from './private-store.js';
import { AuthRoutePersistence } from './route-persistence.js';

export type RequestAuthorization = (request: Request) => boolean | PromiseLike<boolean>;
export type RequestAuthorizationOutcome = 'authorized' | 'denied' | 'unavailable' | 'cancelled';

/** Read-only request boundary, not an SQL mutation permission callback.
 * Disconnect or deadline ends the HTTP wait, never the original authority
 * operation. Its pending budget belongs to AuthRoutePersistence until actual
 * settlement. No cached grant, replay, cancellation claim or budget release.
 * A JavaScript timer bounds asynchronous waiting, not synchronous SQL runtime. */
export class AwaitedRequestAuthorization {
  private readonly persistence: AuthRoutePersistence;
  private closed = false;
  constructor(private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics,
    warningMs?: number, private readonly requestTimeoutMs = 30_000) {
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 2_147_483_647) throw new AuthPersistenceError();
    this.persistence = new AuthRoutePersistence(diagnostics, warningMs);
  }
  get pending() { return this.persistence.pending; }
  close(): Promise<void> {
    this.closed = true;
    return this.persistence.close();
  }
  async check(request: Request, authorize: RequestAuthorization, signal: AbortSignal = request.signal): Promise<RequestAuthorizationOutcome> {
    if (this.closed) return 'unavailable';
    if (request.signal.aborted || signal.aborted) {
      this.observeWaitEnd('cancelled');
      return 'cancelled';
    }
    let abort!: () => void;
    const cancelled = new Promise<RequestAuthorizationOutcome>(resolve => {
      abort = () => resolve('cancelled');
      request.signal.addEventListener('abort', abort, { once: true });
      if (signal !== request.signal) signal.addEventListener('abort', abort, { once: true });
    });
    let timer!: ReturnType<typeof setTimeout>;
    // Keep a deadline distinct from an original authority refusal. Both map
    // to unavailable for HTTP, but only the actual winning deadline is a
    // timeout observation. This is internal data, never an authority grant.
    const deadline = Symbol('authorization-read-deadline');
    const expired = new Promise<RequestAuthorizationOutcome | typeof deadline>(resolve => {
      timer = setTimeout(() => {
        if (request.signal.aborted || signal.aborted) { resolve('cancelled'); return; }
        resolve(deadline);
      }, this.requestTimeoutMs);
    });
    // Observe both original outcomes even when the HTTP wait has ended.
    const original = this.persistence.run(6, () => authorize(request)).then<RequestAuthorizationOutcome, RequestAuthorizationOutcome>(
      ({ value }) => value === true ? 'authorized' : 'denied', () => 'unavailable');
    try {
      const result = await Promise.race([original, cancelled, expired]);
      const outcome = request.signal.aborted || signal.aborted ? 'cancelled' : result === deadline ? 'unavailable' : result;
      if (outcome === 'cancelled') this.observeWaitEnd('cancelled');
      else if (result === deadline) this.observeWaitEnd('timedOut');
      // A grant that settled during shutdown cannot admit a new stream or
      // publish private frames after its original storage owner has drained.
      return this.closed ? 'unavailable' : outcome;
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', abort);
      if (signal !== request.signal) signal.removeEventListener('abort', abort);
    }
  }
  private observeWaitEnd(outcome: 'timedOut' | 'cancelled') {
    try {
      const trace = this.diagnostics.start('auth-route-persistence');
      trace.add('step', 6); trace.add(outcome, 1); trace.add('pending', this.pending); trace.finish(true);
    } catch { /* Observation cannot grant authority or settle original SQL. */ }
  }
}
