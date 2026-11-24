import { randomBytes } from 'node:crypto';
import { HTTPException } from 'hono/http-exception';
import type { WebsiteService } from './websites.js';

export const WEBSITE_ACCESS_TTL = 5 * 60_000;
export const WEBSITE_RESOURCE_BYTES = 2 * 1024 * 1024;
export const validWebsiteAccessId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export type WebsiteResource = { status: number; contentType: string; bodyBase64: string };
const transports = new WeakMap<typeof fetch, Set<Promise<unknown>>>();

export function runWebsiteTransport<Result>(fetcher: typeof fetch, input: string | URL, init: RequestInit,
  signal: AbortSignal, retain: (work: Promise<unknown>) => void, consume: (response: Response) => Promise<Result>): Promise<Result> {
  signal.throwIfAborted();
  const pending = transports.get(fetcher) ?? new Set<Promise<unknown>>();
  if (pending.size >= 4) throw new HTTPException(429);
  transports.set(fetcher, pending);
  const work = Promise.resolve().then(() => {
    signal.throwIfAborted();
    return fetcher(input, init);
  }).then(async response => {
    if (signal.aborted) {
      await response.body?.cancel().catch(() => {});
      throw signal.reason;
    }
    return consume(response);
  });
  pending.add(work);
  void work.then(() => pending.delete(work), () => pending.delete(work));
  retain(work);
  return new Promise<Result>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
type Entry<T> = { id: string; owner: string; expiresAt: number; value: T; controller: AbortController };

/** Bounded, process-local leases; no timers, persisted credentials or auto-renewal.
 * Closing/expiring aborts in-flight work. Callers must still reauthorize delivery. */
export class WebsiteAccessStore<T> {
  private entries = new Map<string, Entry<T>>();
  constructor(private now = Date.now, private limits = { total: 128, perOwner: 16 }) {}
  private sweep() { for (const [id, entry] of this.entries) if (entry.expiresAt <= this.now()) this.remove(id); }
  create(owner: string, value: T, deadline = this.now() + WEBSITE_ACCESS_TTL, replaceId?: string) {
    this.sweep();
    // Synchronous replacement consumes one existing slot, never a temporary
    // extra slot. Validate everything before invalidating the previous handle.
    const previous = replaceId === undefined ? undefined : this.get(replaceId, owner);
    if (!previous && (this.entries.size >= this.limits.total || [...this.entries.values()].filter(e => e.owner === owner).length >= this.limits.perOwner)) throw new HTTPException(429);
    const expiresAt = Math.min(deadline, this.now() + WEBSITE_ACCESS_TTL, previous?.expiresAt ?? Infinity);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now()) throw new HTTPException(410);
    const entry = { id: randomBytes(32).toString('base64url'), owner, value, expiresAt, controller: new AbortController() };
    if (previous) this.remove(previous.id);
    this.entries.set(entry.id, entry);
    return entry;
  }
  get(id: string, owner: string) {
    this.sweep();
    const entry = validWebsiteAccessId(id) ? this.entries.get(id) : undefined;
    if (!entry || entry.owner !== owner) throw new HTTPException(404);
    return entry;
  }
  remove(id: string) { const entry = this.entries.get(id); this.entries.delete(id); entry?.controller.abort(); }
  close() { for (const id of this.entries.keys()) this.remove(id); }
}

const mimeTypes = new Set(['text/html', 'text/plain', 'text/css', 'text/javascript', 'application/javascript', 'application/json',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/x-icon', 'image/vnd.microsoft.icon',
  'font/woff', 'font/woff2']);
export function validWebsiteResource(value: unknown): value is WebsiteResource {
  if (!value || typeof value !== 'object') return false;
  const v = value as WebsiteResource;
  return Number.isInteger(v.status) && v.status >= 200 && v.status <= 599 && !(v.status >= 300 && v.status < 400)
    && typeof v.contentType === 'string' && v.contentType.length <= 128 && !/[\x00-\x1f\x7f]/.test(v.contentType)
    && mimeTypes.has(v.contentType.split(';')[0]!.trim().toLowerCase())
    && typeof v.bodyBase64 === 'string' && v.bodyBase64.length <= Math.ceil(WEBSITE_RESOURCE_BYTES / 3) * 4
    && Buffer.byteLength(v.bodyBase64, 'base64') <= WEBSITE_RESOURCE_BYTES
    && Buffer.from(v.bodyBase64, 'base64').toString('base64') === v.bodyBase64;
}

export function websiteResourceUrl(service: WebsiteService, path: unknown): string {
  if (!service.browse || new URL(service.url).pathname !== '/' || typeof path !== 'string' || path.length > 4096
    || !path.startsWith('/') || path.startsWith('//') || /[^\x21-\x7e]|[#\\]/.test(path) || /%(?![a-f\d]{2})/i.test(path)) throw new HTTPException(400);
  const url = new URL(path, service.url);
  if (url.origin !== new URL(service.url).origin || url.pathname + url.search !== path) throw new HTTPException(400);
  return url.href;
}

export async function readWebsiteResource(service: WebsiteService, path: unknown, signal: AbortSignal, fetcher: typeof fetch = fetch,
  retain: (work: Promise<unknown>) => void = () => {}): Promise<WebsiteResource> {
  const url = websiteResourceUrl(service, path);
  const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), 8_000);
  const combined = AbortSignal.any([signal, deadline.signal]);
  try {
    combined.throwIfAborted();
    return await runWebsiteTransport(fetcher, url, { method: 'GET', signal: combined, credentials: 'omit', redirect: 'error',
      headers: { accept: '*/*', 'accept-encoding': 'identity' } }, combined, retain, async response => {
      const reader = response.body?.getReader();
      let cancellation: Promise<void> | undefined;
      const cancel = () => cancellation ??= reader?.cancel(combined.reason).catch(() => {}) ?? Promise.resolve();
      combined.addEventListener('abort', cancel, { once: true });
      try {
        const contentType = response.headers.get('content-type') ?? '';
        if (response.headers.has('content-disposition') || !validWebsiteResource({ status: response.status, contentType, bodyBase64: '' })) throw new HTTPException(415);
        const chunks: Uint8Array[] = []; let bytes = 0;
        if (reader) for (;;) {
          combined.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > WEBSITE_RESOURCE_BYTES) throw new HTTPException(413);
          chunks.push(chunk.value);
        }
        combined.throwIfAborted();
        return { status: response.status, contentType, bodyBase64: Buffer.concat(chunks, bytes).toString('base64') };
      } finally {
        combined.removeEventListener('abort', cancel);
        await cancel(); reader?.releaseLock();
      }
    });
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    throw new HTTPException(deadline.signal.aborted ? 504 : 502, { message: 'Website resource unavailable' });
  } finally {
    clearTimeout(timer);
  }
}
