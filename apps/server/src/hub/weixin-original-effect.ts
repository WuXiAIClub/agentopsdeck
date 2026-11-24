import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { WeixinError } from './weixin-transport.js';

/** Deadline/abort is not an acknowledgement of original dispatch completion.
 * Retain late responses, body-reader cancellation ACKs and the original error
 * until all have settled. No retry, new dispatch or authority is minted here. */
export async function weixinOriginalEffect<T>(signal: AbortSignal, deadlineMs: number,
  interruptedCode: 'unknown' | 'unavailable',
  run: (signal: AbortSignal, retain: (body: ReadableStream<Uint8Array>) => ReadableStreamDefaultReader<Uint8Array>) => Promise<T>,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics): Promise<T> {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) throw new WeixinError('unavailable');
  const controller = new AbortController(), readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  const cancellations = new Map<ReadableStreamDefaultReader<Uint8Array>, Promise<unknown>>();
  const trace = guardedTrace(diagnostics, 'weixin-original-effect');
  let reject!: (reason: Error) => void, failed = false;
  const interrupted = new Promise<never>((_, fail) => { reject = fail; });
  // Attach immediately: already-aborted signals must not create an unhandled
  // rejection while the original callback is still being invoked.
  void interrupted.catch(() => {});
  const cancel = (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    if (cancellations.has(reader)) return;
    const ack = Promise.resolve().then(() => reader.cancel());
    cancellations.set(reader, ack);
    void ack.catch(() => {});
  };
  const abort = () => {
    controller.abort();
    for (const reader of readers) cancel(reader);
    reject(new WeixinError(interruptedCode));
  };
  signal.addEventListener('abort', abort, { once: true });
  const deadline = setTimeout(abort, deadlineMs);
  const warning = setInterval(() => trace.reportPending({ pending: 1,
    cancelled: controller.signal.aborted ? 1 : 0 }), 30_000); warning.unref();
  if (signal.aborted) abort();
  const original = (async () => {
    controller.signal.throwIfAborted();
    return run(controller.signal, body => {
      const reader = body.getReader(); readers.add(reader);
      if (controller.signal.aborted) cancel(reader);
      return reader;
    });
  })();
  try {
    const result = await Promise.race([original, interrupted]);
    controller.signal.throwIfAborted();
    return result;
  } catch (error) { failed = true; throw error; }
  finally {
    // Keep the external abort listener until original dispatch and any late
    // body are owned. A late response registers cancellation immediately.
    controller.abort();
    for (const reader of readers) cancel(reader);
    await Promise.allSettled([original]);
    for (const reader of readers) cancel(reader);
    const acks = await Promise.allSettled(cancellations.values());
    for (const reader of readers) reader.releaseLock();
    clearTimeout(deadline); clearInterval(warning); signal.removeEventListener('abort', abort);
    trace.add('settled', 1);
    if (failed || acks.some(ack => ack.status === 'rejected')) trace.add('unknown', 1);
    trace.finish(failed || acks.some(ack => ack.status === 'rejected'));
  }
}
