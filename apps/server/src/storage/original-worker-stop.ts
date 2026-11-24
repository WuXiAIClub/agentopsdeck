import type { Worker } from 'node:worker_threads';

/** Physical cleanup only. The owner decides when retirement is permitted,
 * fences admission and retains original outcomes before calling request().
 * Retry only refused stop requests against this exact worker, not SQL, effects
 * or replacement. A fulfilled/pending stop is NOT exit evidence. */
export function createOriginalWorkerStop(worker: Pick<Worker, 'terminate'>, observeRefusal: () => void) {
  let exited = false, requested = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const refused = () => {
    if (exited) return;
    try { observeRefusal(); } catch { /* Logging cannot prevent original cleanup. */ }
    // Retain the outstanding guard through diagnostic reentry and cooldown.
    if (exited) return;
    retry = setTimeout(() => {
      retry = undefined; requested = false; request();
    }, 1000);
    retry.unref();
  };
  const request = () => {
    if (exited || requested) return;
    requested = true;
    try { void worker.terminate().then(() => {}, refused); }
    catch { refused(); }
  };
  return {
    request,
    confirmExit: () => {
      exited = true; clearTimeout(retry); retry = undefined;
    },
  };
}
