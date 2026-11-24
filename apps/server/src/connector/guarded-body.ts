const cleanups = new WeakMap<ReadableStream<Uint8Array>, () => Promise<void>>();

/** A stream error/abort makes reader.cancel() reject without invoking the
 * underlying source again. Lifecycle owners must still retain its original
 * cancellation ACK, including one already started by the request signal. */
export function cancelGuardedBody(body: ReadableStream<Uint8Array>): Promise<void> {
  return cleanups.get(body)?.() ?? Promise.resolve();
}

// A single pull-driven body gate for local files and proxied media. No payload
// queue, whole-file buffer or independent retry owner. Transport owns deadlines.
export function guardedBody(source: ReadableStream<Uint8Array>, options: {
  authorize: (signal: AbortSignal) => void | Promise<void>; signal?: AbortSignal; maxBytes?: number; expectedBytes?: number;
  drain?: () => Promise<void>;
  /** Lifecycle bookkeeping after a successful end (cancellation uses drain). */
  onComplete?: () => void;
}) {
  const reader = source.getReader();
  let sourceFailure: { error: unknown } | undefined;
  // A transport abort can error this reader before our cancel begins. That
  // rejection is a delivered stream error, not a failed cancellation hook.
  void reader.closed.then(() => {}, error => { sourceFailure = { error }; });
  const lifetime = new AbortController();
  let output!: ReadableStreamDefaultController<Uint8Array>;
  let bytes = 0, disposed = false, closing: Promise<void> | undefined;
  const cleanup = () => options.signal?.removeEventListener('abort', abort);
  const close = (reason?: unknown): Promise<void> => {
    if (closing) return closing;
    if (disposed) return Promise.resolve();
    disposed = true;
    closing = Promise.resolve().then(async () => {
      try {
        try { await reader.cancel(reason); }
        catch (error) {
          // Only an owned transport drain can prove the real cancellation ACK
          // behind an already-errored stream. A rejecting cancel hook still
          // fails close (reader.closed resolves when cancellation starts).
          if (!options.drain || !sourceFailure || sourceFailure.error !== error) throw error;
        }
      }
      finally { try { await options.drain?.(); } finally { reader.releaseLock(); } }
    });
    lifetime.abort(reason);
    cleanup();
    return closing;
  };
  const abort = () => {
    if (disposed) return;
    output.error(options.signal?.reason);
    void close(options.signal?.reason).catch(() => {});
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
    },
    async pull(controller) {
      try {
        await options.authorize(lifetime.signal);
        // A cancelled pending authority result must never start another read.
        if (disposed) return;
        const next = await reader.read();
        if (disposed) return;
        await options.authorize(lifetime.signal);
        if (disposed) return;
        if (next.done) {
          if (options.expectedBytes !== undefined && bytes !== options.expectedBytes) throw new Error('Connector media ended before its declared length');
          disposed = true; cleanup(); reader.releaseLock(); controller.close(); options.onComplete?.(); return;
        }
        bytes += next.value.byteLength;
        if (bytes > (options.maxBytes ?? 64 * 1024 * 1024)) throw new Error('Connector media exceeds size limit');
        controller.enqueue(next.value);
      } catch (error) {
        if (!disposed) controller.error(error);
        await close(error);
      }
    },
    cancel: close,
  }, { highWaterMark: 0 });
  cleanups.set(body, () => close());
  return body;
}
