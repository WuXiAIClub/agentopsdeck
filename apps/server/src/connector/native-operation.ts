/** A timeout/transport error after invocation does not prove the Agent rejected
 * the command. Callers must journal intent before invoking, freeze uncertain
 * delivery, and reconcile the original command rather than replaying it. */
export class NativeOperationError extends Error {
  constructor(readonly outcome: 'not_started' | 'unknown', readonly reason: 'aborted' | 'deadline' | 'native_error') {
    super(outcome === 'not_started' ? 'Native operation was not started' : 'Native operation outcome is unknown; do not resend automatically');
    this.name = 'NativeOperationError';
  }
}

/** Bound the ACK wait independently of SDK timeouts. In particular, a SDK's
 * "sendAndWait" timeout can start AFTER send's ACK and never cover a lost ACK.
 * Does not abort native execution or automatically close a shared process. */
export function runNativeOperation<T>(invoke: () => Promise<T>, options: { timeoutMs: number; signal?: AbortSignal }): Promise<T> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 2_147_483_647) {
    return Promise.reject(new RangeError('A finite positive native operation deadline is required'));
  }
  if (options.signal?.aborted) return Promise.reject(new NativeOperationError('not_started', 'aborted'));
  return new Promise<T>((resolve, reject) => {
    let invoked = false, settled = false;
    const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); };
    const fail = (reason: NativeOperationError['reason']) => {
      if (settled) return;
      settled = true; cleanup(); reject(new NativeOperationError(invoked ? 'unknown' : 'not_started', reason));
    };
    const abort = () => fail('aborted');
    const timer = setTimeout(() => fail('deadline'), options.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) { abort(); return; }
    invoked = true;
    try {
      // Install both handlers even if invoke synchronously aborted the wait.
      // Late rejection must not escape as an unhandled rejection; late success
      // must not change the already-reported uncertain outcome.
      Promise.resolve(invoke()).then(value => {
        if (settled) return;
        settled = true; cleanup(); resolve(value);
      }, () => fail('native_error'));
    } catch { fail('native_error'); }
  });
}
