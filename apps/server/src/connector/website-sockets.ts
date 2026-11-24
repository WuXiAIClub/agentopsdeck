import WebSocket from 'ws';
import { HTTPException } from 'hono/http-exception';
import { websiteResourceUrl } from './website-access.js';
import type { WebsiteService } from './websites.js';

export const WEBSITE_SOCKET_FRAME_BYTES = 64 * 1024;
export type WebsiteSocketPolicy = { path: string; protocols: string[] };
export type WebsiteSocketFrame = { bodyBase64: string; binary: boolean };
export const validSocketProtocol = (value: unknown): value is string => typeof value === 'string' && /^[!#$%&'*+\-.^_`|~\da-zA-Z]{1,64}$/.test(value);
export function parseWebsiteSockets(value: unknown): WebsiteSocketPolicy[] | undefined {
  if (value === undefined) return;
  const invalid = () => new Error('Website sockets require at most four unique absolute paths with explicit allowed subprotocols');
  if (!Array.isArray(value) || value.length > 4) throw invalid();
  const paths = new Set<string>();
  return value.map(v => {
    if (!v || typeof v !== 'object' || Object.keys(v).some(k => !['path', 'protocols'].includes(k))
      || typeof v.path !== 'string' || !/^\/(?:[a-zA-Z0-9_/-]{0,127})$/.test(v.path) || v.path.includes('//') || paths.has(v.path)
      || !Array.isArray(v.protocols) || v.protocols.length > 4 || !v.protocols.every(validSocketProtocol)
      || new Set(v.protocols).size !== v.protocols.length) throw invalid();
    paths.add(v.path); return { path: v.path, protocols: [...v.protocols] };
  });
}
export function validWebsiteSocketFrame(value: unknown): value is WebsiteSocketFrame {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 2) return false;
  const v = value as WebsiteSocketFrame;
  if (typeof v.binary !== 'boolean' || typeof v.bodyBase64 !== 'string' || v.bodyBase64.length > Math.ceil(WEBSITE_SOCKET_FRAME_BYTES / 3) * 4) return false;
  const bytes = Buffer.from(v.bodyBase64, 'base64');
  if (bytes.length > WEBSITE_SOCKET_FRAME_BYTES || bytes.toString('base64') !== v.bodyBase64) return false;
  try { if (!v.binary) new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true; } catch { return false; }
}

/** One explicit bidirectional website channel, never a generic TCP tunnel.
 * No browser/Hub cookies or auth headers, redirects, compression or disk cache.
 * No replay: a lost read/write response closes the channel. */
export class WebsiteSocket {
  private lifecycle = new AbortController();
  get signal() { return this.lifecycle.signal; }
  private socket: WebSocket;
  private queue: WebsiteSocketFrame[] = [];
  private buffered = 0;
  private total = 0;
  private frames = 0;
  private wake: (() => void) | undefined;
  private reading = false;
  private writing = false;
  private ended = false;
  private lifetime: ReturnType<typeof setTimeout>;
  private idle: ReturnType<typeof setTimeout>;
  private detach: () => void;
  readonly ready: Promise<string>;
  /** Physical ws close, distinct from local invalidation and HTTP settlement. */
  readonly settled: Promise<void>;
  constructor(service: WebsiteService, path: string, protocols: string[], signal: AbortSignal, expiresAt: number) {
    const target = new URL(websiteResourceUrl(service, path));
    const rule = service.sockets?.find(p => p.path === target.pathname);
    if (!rule || !Array.isArray(protocols) || protocols.length > 4 || !protocols.every(p => validSocketProtocol(p) && rule.protocols.includes(p))
      || new Set(protocols).size !== protocols.length || (!protocols.length && rule.protocols.length)) throw new HTTPException(403);
    signal.throwIfAborted();
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    this.socket = new WebSocket(target, protocols, { followRedirects: false, perMessageDeflate: false, maxPayload: WEBSITE_SOCKET_FRAME_BYTES,
      handshakeTimeout: 8_000 });
    this.lifetime = setTimeout(() => this.close(), Math.max(1, expiresAt - Date.now()));
    this.idle = setTimeout(() => this.close(), 60_000);
    const abort = () => this.close();
    signal.addEventListener('abort', abort, { once: true });
    this.detach = () => signal.removeEventListener('abort', abort);
    this.ready = new Promise((resolve, reject) => {
      this.socket.once('open', () => { if (this.ended) reject(new HTTPException(410)); else resolve(this.socket.protocol); });
      this.socket.once('error', () => reject(new HTTPException(502, { message: 'Website channel unavailable' })));
      this.socket.once('close', () => reject(new HTTPException(502, { message: 'Website channel closed' })));
    });
    this.settled = new Promise(resolve => this.socket.once('close', () => resolve()));
    this.socket.on('error', () => this.close());
    this.socket.on('close', () => this.close());
    this.socket.on('message', (data, binary) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      if (this.ended || !this.budget(bytes.length) || this.queue.length >= 64 || this.buffered + bytes.length > 256 * 1024) return this.close();
      this.queue.push({ binary, bodyBase64: bytes.toString('base64') }); this.buffered += bytes.length; this.wake?.();
    });
  }
  private budget(bytes: number) { this.total += bytes; this.frames++; return bytes <= WEBSITE_SOCKET_FRAME_BYTES && this.total <= 8 * 1024 * 1024 && this.frames <= 4096; }
  close() {
    if (this.ended) return;
    this.ended = true; clearTimeout(this.lifetime); clearTimeout(this.idle); this.detach();
    this.queue = []; this.buffered = 0; this.socket.terminate(); this.wake?.(); this.lifecycle.abort();
  }
  get closed() { return this.ended; }
  private touch() { if (this.ended) throw new HTTPException(410); this.idle.refresh(); }
  async read(signal: AbortSignal) {
    signal.throwIfAborted(); this.touch();
    if (this.reading) throw new HTTPException(409);
    this.reading = true;
    const abort = () => this.close(); signal.addEventListener('abort', abort, { once: true });
    try {
      if (!this.queue.length) await new Promise<void>(resolve => {
        const timeout = setTimeout(finish, 25_000);
        function finish() { clearTimeout(timeout); resolve(); }
        this.wake = finish;
      });
      signal.throwIfAborted(); this.touch();
      const frames = this.queue; this.queue = []; this.buffered = 0;
      return { frames };
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      throw new HTTPException(this.ended ? 410 : 502, { message: 'Website channel unavailable' });
    } finally { this.wake = undefined; this.reading = false; signal.removeEventListener('abort', abort); }
  }
  async send(frame: WebsiteSocketFrame, signal: AbortSignal) {
    signal.throwIfAborted(); this.touch();
    if (!validWebsiteSocketFrame(frame)) throw new HTTPException(400);
    if (this.writing) throw new HTTPException(409);
    const bytes = Buffer.from(frame.bodyBase64, 'base64');
    if (!this.budget(bytes.length) || this.socket.bufferedAmount > 256 * 1024 || this.socket.readyState !== WebSocket.OPEN) { this.close(); throw new HTTPException(429); }
    this.writing = true;
    const abort = () => this.close(); signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 8_000);
    try {
      await new Promise<void>((resolve, reject) => this.socket.send(bytes, { binary: frame.binary }, error => error ? reject(new HTTPException(502)) : resolve()));
      signal.throwIfAborted(); this.touch();
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      throw new HTTPException(this.ended ? 410 : 502, { message: 'Website channel unavailable' });
    } finally { this.writing = false; clearTimeout(timeout); signal.removeEventListener('abort', abort); }
  }
}
