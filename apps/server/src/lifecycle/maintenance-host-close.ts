import { createShutdownCleanup } from './shutdown-cleanup.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

/** Close only the original host's retained owners. Listener refusal must not
 * skip signaling an in-flight maintenance effect, or close its journal before
 * the effect and listener have actually drained. An explicit retry repeats
 * only failed cleanup, never business effects or the original drain. */
export function createMaintenanceHostClose(options: {
  stopAdmissions(): void;
  closeListener(): Promise<void>;
  drainWorker(): Promise<void>;
  closeJournal(): Promise<void>;
}, diagnostics: PerformanceDiagnostics = performanceDiagnostics) {
  options = { ...options };
  let listener: Promise<void> | undefined;
  const signalListener = () => {
    // Never let a synchronous listener failure omit the independent effect
    // drain. Attach rejection handling before waiting on that original drain.
    try { listener = options.closeListener(); }
    catch (error) { listener = Promise.reject(error); }
    void listener.catch(() => {
      try {
        const trace = diagnostics.start('maintenance-host-close');
        trace.add('step', 1); trace.add('unknown', 1); trace.finish(true);
      } catch { /* Evidence only; not a listener acknowledgement. */ }
    });
  };
  return createShutdownCleanup(() => {
    options.stopAdmissions();
    signalListener();
    return options.drainWorker();
  }, [async () => {
    if (!listener) signalListener();
    try { await listener; }
    catch (error) { listener = undefined; throw error; }
  }, () => options.closeJournal()], diagnostics, { stopAfterFailure: true });
}
