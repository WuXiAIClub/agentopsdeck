import { HTTPException } from 'hono/http-exception';
import { validWebsiteActions, websiteBase64Bytes, WEBSITE_ACTION_BYTES, type WebsiteAction, type WebsiteActionReceipt } from '@agentopsdeck/shared';
import type { WebsiteCookieSession } from './website-cookie-session.js';
import { runWebsiteTransport } from './website-access.js';

export type WebsiteActionPolicy = WebsiteAction & { path: string };
export function parseWebsiteActions(value: unknown): WebsiteActionPolicy[] | undefined {
  if (value === undefined) return;
  if (!validWebsiteActions({ actions: value })) throw Error('Invalid website action policy');
  return (value as WebsiteActionPolicy[]).map(action => {
    if (Object.keys(action).some(k => !['id', 'label', 'method', 'contentType', 'maxBytes', 'path', 'download', 'csrf'].includes(k))
      || typeof action.path !== 'string' || !action.path.startsWith('/') || action.path.startsWith('//') || action.path.length > 2048
      || /[^\x21-\x7e]|[?#\\%]/.test(action.path) || new URL(action.path, 'http://policy.invalid').pathname !== action.path) throw Error('Invalid website action policy');
    return { ...action };
  });
}

/** Reserve the single execution before I/O. Re-reading a receipt never resends.
 * Unknown includes an interrupted response: it does not imply rollback. */
export class WebsiteActionExecution {
  receipt: WebsiteActionReceipt = { state: 'ready' };
  constructor(readonly url: string, readonly action: WebsiteActionPolicy, readonly session?: WebsiteCookieSession, readonly serviceId?: string) {}
  async execute(body: unknown, signal: AbortSignal, fetcher: typeof fetch = fetch,
    retain: (work: Promise<unknown>) => void = () => {}) {
    if (this.receipt.state !== 'ready') return this.receipt;
    const binary = this.action.contentType === 'application/octet-stream';
    const bytes = binary ? websiteBase64Bytes(body) : typeof body === 'string' ? Buffer.byteLength(body) : undefined;
    if (typeof body !== 'string' || bytes === undefined || bytes > this.action.maxBytes) throw new HTTPException(413);
    if (this.action.contentType === 'application/json' && body.length) {
      try { JSON.parse(body); } catch { throw new HTTPException(400); }
    }
    signal.throwIfAborted();
    const target = new URL(this.action.path, this.url);
    if (this.action.csrf && !this.session) throw new HTTPException(409);
    let sessionHeaders: Record<string, string>;
    try { sessionHeaders = this.session?.headers(target, this.action.csrf) ?? {}; } catch { throw new HTTPException(409); }
    this.receipt = { state: 'pending' };
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), 8000);
    const combined = AbortSignal.any([signal, deadline.signal]);
    try {
      this.receipt = await runWebsiteTransport(fetcher, target, { method: this.action.method, ...(this.action.method === 'GET' ? {} : { body: binary ? Buffer.from(body, 'base64') : body }),
        credentials: 'omit', redirect: 'error', signal: combined,
        headers: { 'content-type': this.action.contentType, accept: 'application/json, text/plain', 'accept-encoding': 'identity', ...sessionHeaders } }, combined, retain, async response => {
        const reader = response.body?.getReader();
        let cancellation: Promise<void> | undefined;
        const cancel = () => cancellation ??= reader?.cancel(combined.reason).catch(() => {}) ?? Promise.resolve();
        combined.addEventListener('abort', cancel, { once: true });
        try {
          const download = this.action.download && response.ok ? this.action.download : undefined;
          if (response.status >= 300 && response.status < 400 || !download && (response.headers.has('content-disposition')
            || !/^(application\/json|text\/plain)(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') && ![204, 205].includes(response.status))) throw Error('Unsupported response');
          const chunks: Uint8Array[] = []; let size = 0;
          if (reader) for (;;) {
            combined.throwIfAborted();
            const next = await reader.read(); if (next.done) break;
            size += next.value.byteLength; if (size > (download?.maxBytes ?? WEBSITE_ACTION_BYTES)) throw Error('Response budget exceeded');
            chunks.push(next.value);
          }
          combined.throwIfAborted();
          const data = Buffer.concat(chunks, size);
          this.session?.accept(target, response.headers);
          return { state: 'completed' as const, status: response.status, text: download ? '' : new TextDecoder('utf-8', { fatal: true }).decode(data),
            ...(download ? { file: { filename: download.filename, base64: data.toString('base64') } } : {}) };
        } finally {
          combined.removeEventListener('abort', cancel);
          await cancel(); reader?.releaseLock();
        }
      });
    } catch (error) {
      if (error instanceof HTTPException && error.status === 429) { this.receipt = { state: 'ready' }; throw error; }
      this.receipt = { state: 'unknown' };
    }
    finally { clearTimeout(timer); }
    return this.receipt;
  }
}
