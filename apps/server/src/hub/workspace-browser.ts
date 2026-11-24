import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { createIndependentDrain, type IndependentDrain } from '../lifecycle/independent-drain.js';
import { BrowserAuthorization, type BrowserAuthorize } from './browser-authorization.js';

/** The browser service is a separate trust boundary, never the Hub's browser/profile.
 * Network policy here is defence in depth; the runtime MUST also have public-only
 * egress enforced outside Chromium (including DNS, redirects and WebRTC). */
export type WorkspaceBrowserConfig = { endpoint: string; users: string[]; hosts: string[] };
export function parseWorkspaceBrowserConfig(env: NodeJS.ProcessEnv): WorkspaceBrowserConfig | undefined {
  const endpoint = env.AOD_BROWSER_ENDPOINT;
  if (!endpoint) return undefined;
  const invalid = () => new Error('Invalid isolated browser configuration');
  let url: URL; try { url = new URL(endpoint); } catch { throw invalid(); }
  if (!(url.protocol === 'wss:' || (url.protocol === 'ws:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
    || url.username || url.password || url.search || url.hash || env.AOD_BROWSER_EGRESS_ISOLATED !== 'true') throw invalid();
  const users = (env.AOD_BROWSER_USER_IDS ?? '').split(',').map(v => v.trim()).filter(Boolean);
  const hosts = (env.AOD_BROWSER_HOSTS ?? '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  if (!users.length || users.length > 100 || users.some(v => !/^[\w:-]{1,128}$/.test(v)) || !hosts.length || hosts.length > 64
    || hosts.some(v => !validHost(v.replace(/^\*\./, '')))) throw invalid();
  return { endpoint: url.href, users: [...new Set(users)], hosts: [...new Set(hosts)] };
}
function validHost(host: string): boolean {
  return !isIP(host) && host.length <= 253 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host)
    && !/(?:^|\.)(?:localhost|local|internal|test|invalid|example|home|lan)$/.test(host);
}
export function browserUrl(value: unknown, hosts: readonly string[]): string | undefined {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x20\x7f\\]/.test(value)) return undefined;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.port || !validHost(u.hostname)
      || !hosts.some(h => h.startsWith('*.') ? u.hostname.endsWith(h.slice(1)) : u.hostname === h)) return undefined;
    return u.href;
  } catch { return undefined; }
}
export type BrowserAction = { seq: number } & ({ kind: 'navigate'; url: string } | { kind: 'back' | 'forward' | 'reload' }
  | { kind: 'click'; x: number; y: number } | { kind: 'scroll'; dy: number }
  | { kind: 'text'; text: string } | { kind: 'key'; key: string });
export function validBrowserAction(value: unknown, hosts: readonly string[]): value is BrowserAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (!Number.isSafeInteger(v.seq) || Number(v.seq) < 1) return false;
  const keys: Record<string, string[]> = { navigate: ['url'], back: [], forward: [], reload: [], click: ['x', 'y'], scroll: ['dy'], text: ['text'], key: ['key'] };
  if (typeof v.kind !== 'string' || !Object.hasOwn(keys, v.kind)) return false;
  const permitted = ['kind', 'seq', ...keys[v.kind]!];
  if (Object.keys(v).some(k => !permitted.includes(k))) return false;
  switch (v.kind) {
    case 'navigate': return !!browserUrl(v.url, hosts);
    case 'click': return Number.isFinite(v.x) && Number.isFinite(v.y) && Number(v.x) >= 0 && Number(v.x) < 1024 && Number(v.y) >= 0 && Number(v.y) < 720;
    case 'scroll': return Number.isFinite(v.dy) && Math.abs(Number(v.dy)) <= 1440;
    case 'text': return typeof v.text === 'string' && v.text.length > 0 && v.text.length <= 4000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v.text);
    case 'key': return typeof v.key === 'string' && ['Enter', 'Tab', 'Shift+Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'ControlOrMeta+A'].includes(v.key);
    default: return true;
  }
}
export class BrowserError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 429 | 502 | 503, readonly code: string) { super(code); }
}
type Lease = { id: string; owner: string; permission: BrowserAuthorization; checking?: boolean; created: number; seen: number; busy: boolean; seq: number; closed: boolean; starting: boolean;
  browser?: Browser; context?: BrowserContext; page?: Page; hash?: string; captured?: number;
  removal?: IndependentDrain; removedBrowser?: Browser | undefined; removedContext?: BrowserContext | undefined };
export type BrowserConnect = (endpoint: string) => Promise<Browser>;
const connect: BrowserConnect = async endpoint => (await import('playwright-core')).chromium.connect(endpoint, { timeout: 10_000 });
async function bounded<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('browser_timeout')), ms); })]); }
  finally { clearTimeout(timer); }
}
export class WorkspaceBrowser {
  private leases = new Map<string, Lease>();
  private readonly results = new WeakMap<object, Lease>();
  private closed = false;
  private readonly accepted = new Set<Promise<unknown>>();
  private readonly nativeStops = new WeakMap<object, IndependentDrain>();
  private readonly drain: IndependentDrain;
  private timer: ReturnType<typeof setInterval>;
  constructor(readonly config?: WorkspaceBrowserConfig, private connector: BrowserConnect = connect) {
    this.drain = createIndependentDrain([
      () => this.removeAll(),
      async () => {
        // Original requests (including connects and operations whose caller
        // deadline expired) remain owners until they actually settle. Stop
        // current handles independently, then collect any late-created ones.
        await Promise.allSettled([...this.accepted]);
        await this.removeAll();
      },
    ], 'browser-owner-drain');
    this.timer = setInterval(() => {
      for (const l of this.leases.values()) {
        if (l.closed || l.checking) continue;
        l.checking = true;
        void this.invoke(async () => {
          try { const checked = this.check(l); if (checked) await checked; }
          catch { await this.remove(l); }
          finally { l.checking = false; }
        }).catch(() => {});
      }
    }, 5000); this.timer.unref();
  }
  enabled(owner: string) { return !this.closed && !!this.config?.users.includes(owner); }
  private invoke<T>(run: () => Promise<T>): Promise<T> {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const work = new Promise<T>((ok, bad) => { resolve = ok; reject = bad; });
    // Install before invoking a callback which may synchronously request close.
    this.accepted.add(work);
    void work.then(() => this.accepted.delete(work), () => this.accepted.delete(work));
    try { void run().then(resolve, reject); } catch (error) { reject(error); }
    return work;
  }
  private admission<T>(run: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new BrowserError(403, 'browser_disabled'));
    if (this.accepted.size >= 16) return Promise.reject(new BrowserError(429, 'browser_capacity'));
    return this.invoke(run);
  }
  private stopNative(resource: Browser | BrowserContext | undefined) {
    if (!resource) return;
    let close = this.nativeStops.get(resource);
    if (!close) {
      close = createIndependentDrain([() => resource.close()], 'browser-owner-drain');
      this.nativeStops.set(resource, close);
    }
    return close();
  }
  private prune(l: Lease) {
    if (l.closed && !l.starting && !l.busy && l.removal?.snapshot().state === 'drained' && this.leases.get(l.id) === l) this.leases.delete(l.id);
  }
  private remove(l: Lease): Promise<void> {
    l.closed = true;
    // context.close drops all ephemeral cookies; closing a connected Browser
    // disconnects our client, not the operator's shared browser server.
    if (!l.removal || l.removedContext !== l.context || l.removedBrowser !== l.browser) {
      const context = l.context, browser = l.browser;
      l.removedContext = context; l.removedBrowser = browser;
      l.removal = createIndependentDrain([() => this.stopNative(context), () => this.stopNative(browser)], 'browser-owner-drain');
    }
    const work = l.removal();
    void work.then(() => this.prune(l), () => {});
    return work;
  }
  private removeAll() {
    // Every lease receives stop even if a peer fails. Retained resource drains
    // prevent replay across concurrent stop, expiry and application close.
    return createIndependentDrain([...this.leases.values()].map(l => () => this.remove(l)), 'browser-owner-drain')();
  }
  snapshot() {
    return { ...this.drain.snapshot(), accepted: this.accepted.size, leases: this.leases.size, closed: this.closed };
  }
  private lookup(owner: string, id: string) {
    if (!this.enabled(owner)) throw new BrowserError(403, 'browser_disabled');
    const l = this.leases.get(id);
    if (!l || l.owner !== owner || l.closed) throw new BrowserError(404, 'browser_expired');
    if (Date.now() - l.seen > 120_000 || Date.now() - l.created > 1_800_000) {
      void this.remove(l).catch(() => {}); throw new BrowserError(404, 'browser_expired');
    }
    l.seen = Date.now(); return l;
  }
  private current(l: Lease) {
    if (this.closed || l.closed || this.leases.get(l.id) !== l || !this.enabled(l.owner)
      || Date.now() - l.seen > 120_000 || Date.now() - l.created > 1_800_000) throw Error('browser_revoked');
    l.permission.current();
  }
  private permission(valid?: BrowserAuthorize) {
    return valid ? new BrowserAuthorization(valid, run => this.invoke(run)) : undefined;
  }
  private check(l: Lease, caller?: BrowserAuthorization): void | Promise<void> {
    this.current(l);
    const finish = () => { this.current(l); caller?.current(); };
    const request = () => {
      this.current(l);
      const checked = caller?.check();
      if (checked) return checked.then(finish);
      finish();
    };
    const checked = l.permission.check();
    return checked ? checked.then(request) : request();
  }
  private remember<T extends object>(l: Lease, result: T): T { this.results.set(result, l); return result; }
  private state(l: Lease) { return this.remember(l, { id: l.id, url: l.page?.url() ?? 'about:blank', seq: l.seq, width: 1024, height: 720 }); }
  /** Response proof stays bound to the original lease, not an id that might
   * have been removed/recreated while HTTP auditing awaited its ACK. */
  assertDelivery(owner: string, result: object) {
    const l = this.results.get(result);
    if (!l || l.owner !== owner) throw new BrowserError(403, 'browser_revoked');
    try { this.current(l); } catch { throw new BrowserError(this.closed ? 503 : 403, 'browser_revoked'); }
    if ((result as { seq?: unknown }).seq !== l.seq) throw new BrowserError(409, 'browser_state_changed');
    return l;
  }
  confirmDelivery(owner: string, result: object, valid?: BrowserAuthorize) {
    return this.admission(async () => {
      const l = this.assertDelivery(owner, result), caller = this.permission(valid);
      try { const checked = this.check(l, caller); if (checked) await checked; }
      catch { await this.remove(l).catch(() => {}); throw new BrowserError(this.closed ? 503 : 403, 'browser_revoked'); }
      this.assertDelivery(owner, result); caller?.current();
    });
  }
  start(owner: string, id: string, valid: BrowserAuthorize, caller?: BrowserAuthorize) { return this.admission(() => this.startOwned(owner, id, valid, caller)); }
  private async startOwned(owner: string, id: string, valid: BrowserAuthorize, caller?: BrowserAuthorize) {
    if (!this.enabled(owner)) throw new BrowserError(403, 'browser_disabled');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new BrowserError(400, 'invalid_browser_id');
    if (this.leases.has(id)) {
      const l = this.lookup(owner, id);
      if (l.busy) throw new BrowserError(409, 'browser_busy');
      l.busy = true;
      try { const checked = this.check(l, this.permission(caller ?? valid)); if (checked) await checked; this.current(l); return this.state(l); }
      catch { throw new BrowserError(403, 'browser_revoked'); }
      finally { l.busy = false; this.prune(l); }
    }
    if (this.leases.size >= 4 || [...this.leases.values()].filter(l => l.owner === owner).length >= 2) throw new BrowserError(429, 'browser_capacity');
    const l: Lease = { owner, id, permission: new BrowserAuthorization(valid, run => this.invoke(run)), busy: true, seq: 0, closed: false, starting: true, created: Date.now(), seen: Date.now() };
    const request = this.permission(caller);
    this.leases.set(id, l);
    let dispatched = false;
    try {
      const checked = this.check(l, request); if (checked) await checked; this.current(l); request?.current();
      dispatched = true;
      l.browser = await this.connector(this.config!.endpoint);
      await this.check(l, request); this.current(l); request?.current();
      // Acquisition is an original owner, not a timeout race. Await the actual
      // handle so shutdown can dispose it even after cancellation/revocation.
      l.context = await l.browser.newContext({ viewport: { width: 1024, height: 720 }, acceptDownloads: false, serviceWorkers: 'block', permissions: [] });
      await this.check(l, request); this.current(l); request?.current();
      l.context.setDefaultTimeout(8000); l.context.setDefaultNavigationTimeout(12_000);
      await l.context.route('**/*', route => browserUrl(route.request().url(), this.config!.hosts) ? route.continue() : route.abort('blockedbyclient'));
      await this.check(l, request); this.current(l); request?.current();
      await l.context.routeWebSocket('**/*', socket => socket.close());
      await this.check(l, request); this.current(l); request?.current();
      l.context.on('page', page => { if (l.page && page !== l.page) void page.close().catch(() => {}); });
      l.page = await l.context.newPage();
      l.page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
      l.page.on('download', download => { void download.cancel().catch(() => {}); });
      await this.check(l, request); this.current(l); request?.current();
      l.busy = false; return this.state(l);
    } catch {
      // A lease can expire while connect is pending; late handles still close.
      await this.remove(l).catch(() => {}); throw new BrowserError(dispatched ? 502 : 403, dispatched ? 'browser_start_failed' : 'browser_disabled');
    } finally {
      l.starting = false; l.busy = false; this.prune(l);
    }
  }
  frame(owner: string, id: string, previous?: string, valid?: BrowserAuthorize) { return this.admission(() => this.frameOwned(owner, id, previous, valid)); }
  private async frameOwned(owner: string, id: string, previous?: string, valid?: BrowserAuthorize) {
    const l = this.lookup(owner, id);
    if (l.busy || !l.page || Date.now() - (l.captured ?? 0) < 750) throw new BrowserError(409, 'browser_busy');
    l.busy = true;
    const request = this.permission(valid);
    let dispatched = false;
    try {
      const checked = this.check(l, request); if (checked) await checked; this.current(l); request?.current();
      dispatched = true;
      const image = await l.page.screenshot({ type: 'jpeg', quality: 55, timeout: 5000 });
      await this.check(l, request); this.current(l); request?.current();
      if (image.byteLength > 1_000_000) throw new Error('frame limit');
      l.hash = createHash('sha256').update(image).digest('hex'); l.captured = Date.now();
      const title = (await bounded(this.invoke(() => l.page!.title()), 2000)).slice(0, 200);
      await this.check(l, request); this.current(l); request?.current();
      return this.remember(l, { ...this.state(l), title, hash: l.hash,
        ...(previous === l.hash ? {} : { image: image.toString('base64') }) });
    } catch { await this.remove(l).catch(() => {}); throw new BrowserError(dispatched ? 502 : 404, dispatched ? 'browser_disconnected' : 'browser_expired'); }
    finally { l.busy = false; this.prune(l); }
  }
  act(owner: string, id: string, action: BrowserAction, valid?: BrowserAuthorize) { return this.admission(() => this.actOwned(owner, id, structuredClone(action), valid)); }
  private async actOwned(owner: string, id: string, action: BrowserAction, valid?: BrowserAuthorize) {
    const l = this.lookup(owner, id);
    if (!validBrowserAction(action, this.config!.hosts)) throw new BrowserError(400, 'browser_action_invalid');
    if (l.busy || !l.page) throw new BrowserError(409, 'browser_busy');
    if (action.seq <= l.seq) throw new BrowserError(409, 'browser_action_already_consumed');
    l.busy = true;
    const request = this.permission(valid);
    const page = l.page;
    let dispatched = false;
    try {
      const checked = this.check(l, request); if (checked) await checked; this.current(l); request?.current();
      l.seq = action.seq; // Consume once, immediately before the original effect.
      dispatched = true;
      await bounded(this.invoke(async () => { switch (action.kind) {
        case 'navigate': await page.goto(action.url, { waitUntil: 'domcontentloaded' }); break;
        case 'back': await page.goBack({ waitUntil: 'domcontentloaded' }); break;
        case 'forward': await page.goForward({ waitUntil: 'domcontentloaded' }); break;
        case 'reload': await page.reload({ waitUntil: 'domcontentloaded' }); break;
        case 'click': await page.mouse.click(action.x, action.y); break;
        case 'scroll': await page.mouse.wheel(0, action.dy); break;
        case 'text': await page.keyboard.insertText(action.text); break;
        case 'key': await page.keyboard.press(action.key); break;
      } }), 15_000);
      await this.check(l, request); this.current(l); request?.current();
      return this.state(l);
    } catch {
      // Never retry input/navigation (which can submit forms). An uncertain
      // operation closes the context, preventing delayed input on a new page.
      await this.remove(l).catch(() => {}); throw new BrowserError(dispatched ? 502 : 404, dispatched ? 'browser_action_unconfirmed' : 'browser_expired');
    } finally { l.busy = false; this.prune(l); }
  }
  async stop(owner: string, id: string) {
    const l = this.leases.get(id);
    if (l && l.owner === owner) {
      try { await this.remove(l); } catch { throw new BrowserError(502, 'browser_close_unconfirmed'); }
    }
  }
  close(): Promise<void> { this.closed = true; clearInterval(this.timer); return this.drain(); }
}
