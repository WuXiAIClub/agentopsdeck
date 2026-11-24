/** Cleanup of an already retired read-only worker, not a writer/reconnect
 * policy. Retry only refused physical stop requests against this exact worker.
 * Fulfilment of terminate() does not prove exit or release an original drain.
 * The caller must confirm the actual exit event, including clean close exits. */
export { createOriginalWorkerStop as createReadonlyWorkerStop } from './original-worker-stop.js';
