import { performanceDiagnostics, type PerformanceDiagnostics, type PerformanceTrace } from '../diagnostics/performance.js';

export type ConnectorAuthorization = () => void | Promise<void>;

/** A transport preflight, NOT the original SQL mutation's permission boundary.
 * Cancellation stops this wait; it does not acknowledge/cancel owner work or
 * release its leases. Late settlement is observed and never dispatches work.
 * The caller supplies the transport's existing deadline via its AbortSignal. */
export async function connectorAuthorization(check: ConnectorAuthorization, signal: AbortSignal,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics): Promise<void> {
  signal.throwIfAborted();
  let trace: PerformanceTrace | undefined;
  const observe = (action: () => void) => { try { action(); } catch { /* Observation cannot grant authority. */ } };
  observe(() => { trace = diagnostics.start('hub-request-authority'); });
  let failed = false;
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      // Immediate grants are normal, not recovery failures. Only an actual
      // prolonged wait belongs in the bounded pending/failure log ring.
      const warning = setTimeout(() => {
        if (!settled) observe(() => trace?.reportPending({ pending: 1 }));
      }, 30_000);
      warning.unref?.();
      const finish = (error?: unknown, rejected = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(warning);
        signal.removeEventListener('abort', abort);
        if (rejected) reject(error); else resolve();
      };
      const abort = () => finish(signal.reason, true);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      try {
        const original = Promise.resolve(check());
        original.then(() => {
          if (signal.aborted) abort(); else finish();
        }, error => finish(error, true));
      } catch (error) { finish(error, true); }
    });
    signal.throwIfAborted();
    observe(() => trace?.add('settled', 1));
  } catch (error) {
    failed = true;
    observe(() => trace?.add('deferred', signal.aborted ? 1 : 0));
    throw error;
  } finally {
    observe(() => trace?.add('pending', 0));
    observe(() => trace?.finish(failed));
  }
}
