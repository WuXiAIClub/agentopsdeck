import { boundedDispatch } from './transport.js';

export const MANIFEST_DOWNLOAD = { maxBytes: 1024 * 1024, deadlineMs: 10_000 };
export const ARTIFACT_DOWNLOAD = { maxBytes: 256 * 1024 * 1024, deadlineMs: 120_000 };

// A total deadline includes headers and body. Limits count decoded bytes, not a
// possibly compressed Content-Length. No per-chunk object list or new timer owner.
export async function downloadUpdate(
  url: string,
  limits: { maxBytes: number; deadlineMs: number },
  signal?: AbortSignal,
): Promise<Buffer> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let failure = 'update download failed';
  try {
    const response = await boundedDispatch(
      request => fetch(request.url, { signal: request.signal, redirect: request.redirect }),
      limits.deadlineMs,
    )(new Request(url, { redirect: 'error', ...(signal ? { signal } : {}) }));
    try {
      if (response.status !== 200 || !response.body) throw new Error();
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) throw new Error();
      if (length !== null && Number(length) > limits.maxBytes) {
        failure = 'update download exceeds size limit';
        throw new Error();
      }
      reader = response.body.getReader();
    } finally {
      if (!reader) await response.body?.cancel();
    }
    let buffer = Buffer.alloc(0);
    let used = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return buffer.subarray(0, used);
      const next = used + value.byteLength;
      if (next > limits.maxBytes) {
        failure = 'update download exceeds size limit';
        throw new Error();
      }
      if (next > buffer.length) {
        const grown = Buffer.allocUnsafe(Math.min(limits.maxBytes, Math.max(next, buffer.length * 2, 64 * 1024)));
        buffer.copy(grown, 0, 0, used);
        buffer = grown;
      }
      buffer.set(value, used);
      used = next;
    }
  } catch {
    // Never relay fetch errors, URLs, abort reasons or upstream response bodies.
    throw new Error(failure);
  } finally {
    if (reader) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
