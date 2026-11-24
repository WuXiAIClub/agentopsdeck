import { HTTPException } from 'hono/http-exception';
import { HubMemberRequestError } from './async-member-request.js';

/** Own accepted uploads through the original reader cancellation ACK. A timeout
 * stops delivery, but never releases the physical upload early. */
export class HubRequestBodies {
  private closed = false;
  private readonly uploads = new Set<() => Promise<void>>();
  private closing?: Promise<void>;
  async read(request: Request, maxBytes: number, timeoutMs = 10_000): Promise<unknown> {
    if (this.closed) throw new HubMemberRequestError(503);
    if (!request.body) throw new HTTPException(400);
    const reader = request.body.getReader();
    let finished = false, expired = false, cancellation: Promise<void> | undefined;
    const cancel = () => {
      if (cancellation) return cancellation;
      if (finished) return Promise.resolve();
      cancellation = Promise.resolve().then(() => reader.cancel());
      return cancellation;
    };
    const abort = () => { void cancel().catch(() => {}); };
    const timer = setTimeout(() => { expired = true; abort(); }, timeoutMs);
    timer.unref?.();
    this.uploads.add(cancel);
    request.signal.addEventListener('abort', abort, { once: true });
    const check = () => {
      if (this.closed) throw new HubMemberRequestError(503);
      if (request.signal.aborted) throw new HubMemberRequestError(499);
      if (expired) throw new HTTPException(408);
    };
    try {
      check();
      const chunks: Uint8Array[] = []; let bytes = 0;
      for (;;) {
        const next = await reader.read(); check();
        if (next.done) { finished = true; break; }
        bytes += next.value.byteLength;
        if (bytes > maxBytes) throw new HTTPException(413);
        chunks.push(next.value);
      }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw new HTTPException(400); }
    } finally {
      clearTimeout(timer); request.signal.removeEventListener('abort', abort);
      try { await cancel(); }
      finally { this.uploads.delete(cancel); reader.releaseLock(); }
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = Promise.allSettled([...this.uploads].map(cancel => cancel())).then(results => {
      if (results.some(result => result.status === 'rejected')) throw new HubMemberRequestError(503);
    });
    return this.closing;
  }
}
