import { randomBytes } from 'node:crypto';
import { HTTPException } from 'hono/http-exception';
import { WEBSITE_ACCESS_TTL, validWebsiteResource, type WebsiteResource } from '../connector/website-access.js';
import type { WebsiteSocketPeer } from './website-socket-gateway.js';
import { HubRequestWork } from './async-request-work.js';
import { HubMemberRequestError } from './async-member-request.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';

export type WebsiteGatewayConfig = { originTemplate: string; parentOrigin: string; port: number };
const slot = '{access}';
const loopback = (name: string) => name === 'localhost' || name.endsWith('.localhost') || name === '127.0.0.1' || name === '[::1]';

/** Dedicated listener, explicitly configured wildcard origin, never a Hub host. */
export function parseWebsiteGateway(env: NodeJS.ProcessEnv): WebsiteGatewayConfig | undefined {
  const template = env.AOD_WEBSITE_GATEWAY_ORIGIN;
  const parent = env.AOD_WEBSITE_GATEWAY_HUB_ORIGIN;
  const port = Number(env.AOD_WEBSITE_GATEWAY_PORT);
  if (template === undefined && parent === undefined && env.AOD_WEBSITE_GATEWAY_PORT === undefined) return;
  const invalid = () => new Error('Website gateway requires an isolated https://{access}.domain origin, exact Hub origin and dedicated port (1024–65535); HTTP is only allowed for loopback development');
  try {
    if (!template || !parent || !Number.isInteger(port) || port < 1024 || port > 65535) throw invalid();
    const sample = template.replace(slot, 'sample'), origin = new URL(sample), hub = new URL(parent);
    if (origin.origin !== sample || hub.origin !== parent || !origin.hostname.startsWith('sample.')
      || template.split(slot).length !== 2 || !['http:', 'https:'].includes(origin.protocol)
      || !['http:', 'https:'].includes(hub.protocol)) throw invalid();
    const suffix = origin.hostname.slice('sample.'.length);
    if (!/^[a-z0-9.-]+$/.test(suffix) || suffix.includes('..') || suffix.endsWith('.')
      || hub.hostname === suffix || hub.hostname.endsWith(`.${suffix}`) || suffix.endsWith(`.${hub.hostname}`)) throw invalid();
    // Different registrable domains are an operator requirement. Conservatively
    // reject a shared final two labels too; this is not a public-suffix parser.
    if (!loopback(origin.hostname) && suffix.split('.').slice(-2).join('.') === hub.hostname.split('.').slice(-2).join('.')) throw invalid();
    if ((origin.protocol !== 'https:' || hub.protocol !== 'https:') && !(loopback(origin.hostname) && loopback(hub.hostname))) throw invalid();
    return { originTemplate: template, parentOrigin: parent, port };
  } catch { throw invalid(); }
}

type Binding = {
  key: string; owner: string; expiresAt: number; signal: AbortSignal;
  authorize: () => void | Promise<void>;
  read: (path: string, signal: AbortSignal) => Promise<WebsiteResource>;
  connect?: (path: string, protocols: string[], signal: AbortSignal) => Promise<WebsiteSocketPeer>;
};
type Visit = Binding & { id: string; controller: AbortController; detach: () => void; active: number; reads: number; bytes: number; sockets: number; socketOpens: number };

/** Ephemeral capabilities, no cookies, disk cache, API routes or upstream headers.
 * URLs are secrets scoped to one website; proxy access logs must omit them.
 * Opaque-origin sandbox + CSP reduces browser privileges. It is NOT a general
 * network sandbox: a malicious page can navigate its own frame off-origin.
 */
export class WebsiteGateway {
  private visits = new Map<string, Visit>();
  private active = 0;
  private waiting: Array<() => void> = [];
  private stopped = false;
  private sockets = 0;
  private work = new HubRequestWork(1024);
  private cleanup = new HubRequestWork(1024);
  private closing: Promise<void> | undefined;
  constructor(readonly config: WebsiteGatewayConfig, private now = Date.now) {}
  private remove(id: string) {
    const visit = this.visits.get(id);
    this.visits.delete(id); visit?.detach(); visit?.controller.abort();
  }
  private sweep() { for (const visit of this.visits.values()) if (visit.expiresAt <= this.now()) this.remove(visit.id); }
  open(binding: Binding) { return this.work.run(async () => {
    this.sweep(); await binding.authorize(); binding.signal.throwIfAborted();
    if (this.stopped) throw new HTTPException(503);
    if (binding.expiresAt <= this.now() || binding.expiresAt > this.now() + WEBSITE_ACCESS_TTL) throw new HTTPException(410);
    const previous = [...this.visits.values()].find(v => v.key === binding.key && v.owner === binding.owner);
    if (previous) return this.describe(previous);
    if (this.visits.size >= 128 || [...this.visits.values()].filter(v => v.owner === binding.owner).length >= 16) throw new HTTPException(429);
    const id = randomBytes(24).toString('hex'), abort = () => this.remove(id);
    const visit: Visit = { ...binding, id, controller: new AbortController(), active: 0, reads: 0, bytes: 0, sockets: 0, socketOpens: 0,
      detach: () => binding.signal.removeEventListener('abort', abort) };
    this.visits.set(id, visit); binding.signal.addEventListener('abort', abort, { once: true });
    return this.describe(visit);
  }); }
  private describe(visit: Visit) {
    return { url: this.config.originTemplate.replace(slot, visit.id) + '/', expiresAt: visit.expiresAt };
  }
  openSocket(host: string, path: string, protocols: string[], parentSignal: AbortSignal) { return this.work.run(async () => {
    this.sweep();
    const id = host.split('.')[0]!, visit = this.visits.get(id);
    if (this.stopped || !/^[a-f0-9]{48}$/.test(id) || !visit?.connect || new URL(this.config.originTemplate.replace(slot, id)).host !== host) throw new HTTPException(404);
    await this.checkVisit(visit, parentSignal);
    parentSignal.throwIfAborted();
    if (this.sockets >= 8 || visit.sockets >= 2 || visit.socketOpens >= 32) throw new HTTPException(429);
    this.sockets++; visit.sockets++; visit.socketOpens++;
    const controller = new AbortController();
    const signal = AbortSignal.any([parentSignal, controller.signal, visit.controller.signal]);
    const timer = setTimeout(() => controller.abort(), Math.max(1, visit.expiresAt - this.now()));
    let peer: WebsiteSocketPeer | undefined, closed = false, peerClose: Promise<void> | undefined;
    const closePeer = () => {
      if (peer && !peerClose) peerClose = this.cleanup.run(() => peer!.close()).catch(() => {});
      return peerClose;
    };
    const close = () => {
      if (closed) return;
      closed = true; clearTimeout(timer); signal.removeEventListener('abort', close); controller.abort();
      this.sockets--; visit.sockets--;
      void closePeer();
    };
    signal.addEventListener('abort', close, { once: true });
    const check = () => this.work.run(() => this.checkVisit(visit, signal));
    try {
      peer = await visit.connect(path, protocols, signal);
      await check();
      if (peer.protocol && !protocols.includes(peer.protocol)) throw new HTTPException(502);
      const original = peer;
      return { peer: { protocol: original.protocol,
        read: (readSignal: AbortSignal) => this.work.run(() => original.read(readSignal)),
        send: (frame: Parameters<WebsiteSocketPeer['send']>[0], writeSignal: AbortSignal) => this.work.run(() => original.send(frame, writeSignal)),
        close: async () => { close(); await closePeer(); } }, signal, check, close };
    } catch (error) { close(); await closePeer(); throw error; }
  }); }
  private async checkVisit(visit: Visit, signal: AbortSignal) {
    const trace = guardedTrace(performanceDiagnostics, 'hub-request-authority'); trace.add('step', 97);
    try {
      signal.throwIfAborted(); visit.controller.signal.throwIfAborted();
      await visit.authorize();
      signal.throwIfAborted(); visit.controller.signal.throwIfAborted();
      if (this.stopped || this.visits.get(visit.id) !== visit || visit.expiresAt <= this.now()) throw new HTTPException(404);
      trace.add('settled', 1); trace.finish();
    } catch (error) { trace.add('deferred', 1); trace.finish(true); throw error; }
  }
  private async acquire(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.active < 4) { this.active++; return; }
    if (this.waiting.length >= 32) throw new HTTPException(429);
    await new Promise<void>((resolve, reject) => {
      const ready = () => { signal.removeEventListener('abort', abort); resolve(); };
      const abort = () => { this.waiting = this.waiting.filter(entry => entry !== ready); reject(signal.reason); };
      this.waiting.push(ready); signal.addEventListener('abort', abort, { once: true });
    });
  }
  private release() {
    const next = this.waiting.shift();
    if (next) next(); else this.active--;
  }
  fetch = async (request: Request): Promise<Response> => {
    try { return await this.work.run(() => this.fetchResource(request)); }
    catch { return new Response('Website preview unavailable', { status: 503, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } }); }
  };
  private fetchResource = async (request: Request): Promise<Response> => {
    const headers = new Headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=(), clipboard-write=()',
      'content-type': 'text/plain; charset=utf-8' });
    let visit: Visit | undefined, admitted = false;
    try {
      if (this.stopped) throw new HTTPException(503);
      this.sweep();
      const url = new URL(request.url), id = url.hostname.split('.')[0]!;
      if (!/^[a-f0-9]{48}$/.test(id)) throw new HTTPException(404);
      // Reverse proxies may terminate TLS, but must preserve Host. Never trust
      // forwarded host headers; all resource URLs use the configured HTTPS origin.
      const origin = new URL(this.config.originTemplate.replace(slot, id));
      if (url.host !== origin.host || request.headers.has('service-worker')) throw new HTTPException(404);
      visit = this.visits.get(id);
      if (!visit) throw new HTTPException(404);
      const socketOrigin = origin.origin.replace(/^http/, 'ws');
      headers.set('content-security-policy', `default-src 'none'; script-src ${origin.origin} 'unsafe-inline'; style-src ${origin.origin} 'unsafe-inline'; img-src ${origin.origin} data:; font-src ${origin.origin}; connect-src ${origin.origin}${visit.connect ? ` ${socketOrigin}` : ''}; base-uri ${origin.origin}; form-action 'none'; frame-ancestors ${this.config.parentOrigin}; sandbox allow-scripts`);
      headers.set('access-control-allow-origin', 'null'); // opaque sandbox, no credentials
      if (request.method !== 'GET' || request.headers.get('sec-fetch-dest') === 'document') throw new HTTPException(405);
      const source = request.headers.get('origin');
      if (source !== null && source !== 'null') throw new HTTPException(403);
      await this.checkVisit(visit, request.signal);
      if (visit.reads >= 256 || visit.bytes >= 32 * 1024 * 1024) throw new HTTPException(429);
      visit.reads++;
      const signal = AbortSignal.any([request.signal, visit.controller.signal, AbortSignal.timeout(Math.max(1, visit.expiresAt - this.now()))]);
      await this.acquire(signal); admitted = true; visit.active++;
      await this.checkVisit(visit, signal);
      const resource = await visit.read(url.pathname + url.search, signal);
      await this.checkVisit(visit, signal); this.sweep();
      if (!this.visits.has(id)) throw new HTTPException(404);
      if (!validWebsiteResource(resource)) throw new HTTPException(502);
      const body = Buffer.from(resource.bodyBase64, 'base64');
      visit.bytes += body.byteLength;
      if (visit.bytes > 32 * 1024 * 1024) throw new HTTPException(429);
      headers.set('content-type', resource.contentType);
      return new Response([204, 205, 304].includes(resource.status) ? null : body, { status: resource.status, headers });
    } catch (error) {
      const status = error instanceof HTTPException || error instanceof HubMemberRequestError ? error.status : 502;
      if (visit && [401, 403, 404, 410].includes(status)) this.remove(visit.id);
      return new Response('Website preview unavailable', { status, headers });
    } finally { if (admitted) { this.release(); visit!.active--; } }
  };
  close(): Promise<void> {
    if (this.closing) return this.closing;
    let finish!: () => void, fail!: (error: unknown) => void;
    this.closing = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    this.stopped = true;
    for (const id of this.visits.keys()) this.remove(id);
    void (async () => { await this.work.close(); await this.cleanup.close(); })().then(finish, fail);
    return this.closing;
  }
}
