import { HTTPException } from 'hono/http-exception';

/** Node's HTTP adapter supplies a stream even for an empty DELETE/POST.
 * Check actual bytes, without trusting headers or buffering an arbitrary body. */
export async function requireEmptyBody(request: Request, timeoutMs = 10_000): Promise<void> {
  if (!request.body) return;
  const reader = request.body.getReader();
  let reject: (error: Error) => void = () => {};
  const interrupted = new Promise<never>((_, fail) => { reject = fail; });
  const abort = () => reject(new HTTPException(408));
  const timer = setTimeout(abort, timeoutMs);
  let stopped = false, finished = false;
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) abort();
  try {
    await Promise.race([interrupted, (async () => {
      while (!stopped) {
        const next = await reader.read();
        if (stopped) return;
        if (next.done) { finished = true; return; }
        if (next.value.byteLength) throw new HTTPException(400);
      }
    })()]);
  } finally {
    stopped = true; clearTimeout(timer); request.signal.removeEventListener('abort', abort);
    if (!finished) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Enforce byte and time limits on the actual stream, not Content-Length. */
export function readJsonBody(request: Request, maxBytes: number, timeoutMs = 10_000): Promise<unknown> {
  return readBoundedJson(request, maxBytes, timeoutMs, false);
}

/** An actually empty HTTP stream is absent; whitespace/malformed JSON is not. */
export function readOptionalJsonBody(request: Request, maxBytes: number, timeoutMs = 10_000): Promise<unknown> {
  return readBoundedJson(request, maxBytes, timeoutMs, true);
}

async function readBoundedJson(request: Request, maxBytes: number, timeoutMs: number, optional: boolean): Promise<unknown> {
  if (!request.body) {
    if (optional) return undefined;
    throw new HTTPException(400, { message: 'JSON object required' });
  }
  const reader = request.body.getReader();
  let reject: (error: Error) => void = () => {};
  const interrupted = new Promise<never>((_, fail) => { reject = fail; });
  const abort = () => reject(new HTTPException(408, { message: 'Request body interrupted' }));
  const timer = setTimeout(abort, timeoutMs);
  const buffer = Buffer.alloc(maxBytes);
  let size = 0, finished = false, stopped = false;
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) abort();
  try {
    const consume = async () => {
      while (true) {
        const next = await reader.read();
        if (stopped) return;
        if (next.done) { finished = true; break; }
        if (size + next.value.byteLength > maxBytes) throw new HTTPException(413, { message: 'Request body too large' });
        buffer.set(next.value, size);
        size += next.value.byteLength;
      }
      if (size === 0 && optional) return undefined;
      try { return JSON.parse(buffer.toString('utf8', 0, size)); }
      catch { throw new HTTPException(400, { message: 'Invalid JSON body' }); }
    };
    return await Promise.race([consume(), interrupted]);
  } finally {
    stopped = true;
    clearTimeout(timer);
    request.signal.removeEventListener('abort', abort);
    if (!finished) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
