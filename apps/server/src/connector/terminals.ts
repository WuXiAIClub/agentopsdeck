import { delimiter, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HTTPException } from 'hono/http-exception';
import type { ConnectorPrincipal } from '../auth/connector-token.js';
import type { ChangeSignal } from '../utils/change-signal.js';
import { fileAuthorityPending } from './file-authority.js';

type Common = { id: string; label: string; tokenIds: string[]; local?: boolean; cwd: string; home: string; path: string; executable: string };
export type TerminalTarget = Common & ({ kind: 'local'; args: string[] } | { kind: 'ssh'; host: string; port: number; user: string; identityFile: string; knownHosts: string });
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && !!v && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
export const terminalId = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v);
export const terminalUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
export const terminalSize = (cols: unknown, rows: unknown) => Number.isInteger(cols) && Number(cols) >= 20 && Number(cols) <= 300 && Number.isInteger(rows) && Number(rows) >= 5 && Number(rows) <= 120;
export function parseTerminalTargets(raw?: string): TerminalTarget[] {
  if (!raw) return [];
  const bad = () => new Error('Invalid AOD_TERMINALS_JSON; see v2-workspace-terminal.md');
  let value: unknown; try { value = JSON.parse(raw); } catch { throw bad(); }
  if (!Array.isArray(value) || value.length > 16) throw bad();
  const ids = new Set<string>();
  for (const v of value) {
    if (!object(v) || !terminalId(v.id) || ids.has(v.id) || !text(v.label, 80) || !Array.isArray(v.tokenIds) || v.tokenIds.length > 32
      || !v.tokenIds.every(id => text(id, 160)) || (v.local !== undefined && typeof v.local !== 'boolean')
      || !['cwd', 'home', 'executable'].every(key => text(v[key], 4096) && isAbsolute(v[key] as string)) || !text(v.path, 4096)
      || !v.path.split(delimiter).every(segment => isAbsolute(segment))) throw bad();
    const common = ['id', 'label', 'tokenIds', 'local', 'cwd', 'home', 'path', 'executable', 'kind'];
    if (v.kind === 'local') {
      if (!Array.isArray(v.args) || v.args.length > 32 || !v.args.every(arg => typeof arg === 'string' && arg.length <= 4096 && !arg.includes('\0')) || Object.keys(v).some(k => ![...common, 'args'].includes(k))) throw bad();
    } else if (v.kind === 'ssh') {
      if (!text(v.host, 253) || !/^[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(v.host) || !text(v.user, 64) || !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(v.user)
        || !Number.isInteger(v.port) || Number(v.port) < 1 || Number(v.port) > 65535
        || !['identityFile', 'knownHosts'].every(key => text(v[key], 4096) && isAbsolute(v[key] as string))
        || /["\\%$]/.test(v.knownHosts as string)
        || Object.keys(v).some(k => ![...common, 'host', 'port', 'user', 'identityFile', 'knownHosts'].includes(k))) throw bad();
    } else throw bad();
    ids.add(v.id);
  }
  return value as TerminalTarget[];
}
// local:daily is reserved by the in-process runtime, never a user-created token ID.
export const permitsTerminal = (target: TerminalTarget, actor: ConnectorPrincipal) => target.tokenIds.includes(actor.tokenId) || (target.local === true && actor.tokenId === 'local:daily');
export function terminalLaunch(target: TerminalTarget) {
  const args = target.kind === 'local' ? target.args : ['-F', 'none', '-tt', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ClearAllForwardings=yes', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no', '-o', 'ProxyCommand=none', '-o', 'PermitLocalCommand=no', '-o', 'EscapeChar=none', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2', '-o', `UserKnownHostsFile="${target.knownHosts}"`, '-i', target.identityFile, '-p', String(target.port), '-l', target.user, target.host];
  return { executable: target.executable, args, cwd: target.cwd, env: { HOME: target.home, USERPROFILE: target.home, PATH: target.path, TERM: 'xterm-256color', LANG: 'C.UTF-8', ...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } };
}
export type TerminalPty = { write(data: string): void; resize(cols: number, rows: number): void; kill(): void; onData(fn: (text: string) => void): { dispose(): void }; onExit(fn: (event: { exitCode: number }) => void): { dispose(): void } };
export type TerminalSpawner = (target: TerminalTarget, cols: number, rows: number) => Promise<TerminalPty>;
export const spawnTerminal: TerminalSpawner = async (target, cols, rows) => {
  const pty = await import('node-pty'), launch = terminalLaunch(target);
  return pty.spawn(launch.executable, launch.args, { name: 'xterm-256color', cols, rows, cwd: launch.cwd, env: launch.env });
};
type Entry = { id: string; owner: string; target: string; requestId: string; signature: string; pty?: TerminalPty; subscriptions: { dispose(): void }[];
  text: string; offset: number; sequence: number; created: number; seen: number; ended?: number; reason?: string; stopping?: string; exited: Promise<void>; confirmExit: () => void; wake?: (() => void) | undefined; polling: boolean; inputBytes: number; inputAt: number };
export class TerminalSessions {
  private entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setInterval>;
  private closed = false;
  private pending = new Set<Promise<unknown>>();
  private sweeping: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private watcher: Promise<void> | undefined;
  private controller: AbortController | undefined;
  constructor(private spawn: TerminalSpawner = spawnTerminal, private allowed: (owner: string) => boolean | PromiseLike<boolean> = () => true,
    private now = Date.now, private changes?: Pick<ChangeSignal, 'revision' | 'wait'>) {
    this.timer = setInterval(() => { void this.sweep(); }, 1000); this.timer.unref();
  }
  private watch() {
    const changes = this.changes;
    if (!changes || this.closed || this.watcher || !this.active()) return;
    const controller = new AbortController(); this.controller = controller;
    const work = Promise.resolve().then(async () => {
      while (!this.closed && !controller.signal.aborted && this.active()) {
        const revision = changes.revision;
        await this.sweep();
        if (!this.closed && this.active()) await changes.wait(revision, controller.signal);
      }
    }).catch(() => { for (const e of this.entries.values()) this.stopEntry(e, 'revoked'); }).finally(() => {
      if (this.watcher === work) { this.watcher = undefined; this.controller = undefined; }
      // A new reservation may arrive while the previous empty watcher drains.
      this.watch();
    });
    this.watcher = this.track(work);
  }
  private active() { return [...this.entries.values()].some(e => e.ended === undefined); }
  private track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    void work.then(() => this.pending.delete(work), () => this.pending.delete(work));
    return work;
  }
  private sweep() {
    if (this.sweeping || this.closed) return this.sweeping;
    const waiting: Promise<void>[] = [];
    for (const e of this.entries.values()) {
      if (e.ended !== undefined) { if (this.now() - e.ended > 60_000) this.entries.delete(e.id); }
      else if (this.now() - e.seen > 45_000 || this.now() - e.created > 3_600_000) this.stopEntry(e, 'expired');
      else try {
        const permission = this.allowed(e.owner);
        if (fileAuthorityPending(permission)) waiting.push(Promise.resolve(permission).then(value => {
          if (value !== true) this.stopEntry(e, 'revoked');
        }, () => this.stopEntry(e, 'revoked')));
        else if (permission !== true) this.stopEntry(e, 'revoked');
      } catch { this.stopEntry(e, 'revoked'); }
    }
    if (waiting.length) {
      const work = Promise.allSettled(waiting).then(() => {}).finally(() => { if (this.sweeping === work) this.sweeping = undefined; });
      this.sweeping = this.track(work);
      return work;
    }
  }
  private authorize<T>(owner: string, action: () => T, check: () => void = () => {}): T | Promise<T> {
    if (this.closed) throw new HTTPException(404);
    const apply = (permission: boolean) => { if (this.closed || permission !== true) throw new HTTPException(404); check(); return action(); };
    const permission = this.allowed(owner);
    return fileAuthorityPending(permission) ? this.track(Promise.resolve(permission).then(apply)) : apply(permission);
  }
  private get(owner: string, id: string) { const e = this.entries.get(id); if (this.closed || !e || e.owner !== owner) throw new HTTPException(404); return e; }
  start(owner: string, target: TerminalTarget, requestId: string, cols: number, rows: number, check: () => void = () => {}) {
    if (this.closed) return Promise.reject(new HTTPException(403));
    return this.track(this.startOwned(owner, target, requestId, cols, rows, check));
  }
  private async startOwned(owner: string, target: TerminalTarget, requestId: string, cols: number, rows: number, check: () => void) {
    this.sweep();
    if (await this.allowed(owner) !== true || this.closed) throw new HTTPException(403);
    check();
    const signature = JSON.stringify([target.id, cols, rows]), prior = [...this.entries.values()].find(e => e.owner === owner && e.requestId === requestId);
    if (prior) { if (prior.signature !== signature || !prior.pty || prior.ended !== undefined || prior.stopping !== undefined) throw new HTTPException(409); return { id: prior.id }; }
    const active = [...this.entries.values()].filter(e => e.ended === undefined);
    if (active.length >= 8 || active.filter(e => e.owner === owner).length >= 2 || this.entries.size >= 128) throw new HTTPException(429);
    let confirmExit!: () => void;
    const exited = new Promise<void>(resolve => { confirmExit = resolve; });
    const e: Entry = { id: randomUUID(), owner, target: target.id, requestId, signature, subscriptions: [], text: '', offset: 0, sequence: 0, created: this.now(), seen: this.now(), polling: false, inputAt: this.now(), inputBytes: 0, exited, confirmExit };
    this.entries.set(e.id, e);
    this.watch();
    try {
      const pty = await this.spawn(target, cols, rows);
      e.pty = pty;
      const exit = pty.onExit(() => this.finishEntry(e));
      if (e.ended !== undefined) exit.dispose(); else e.subscriptions.push(exit);
      if (await this.allowed(owner) !== true || this.closed || e.stopping !== undefined || e.ended !== undefined) {
        this.stopEntry(e, 'revoked');
        throw new HTTPException(403);
      }
      check();
      e.subscriptions.push(pty.onData(data => {
        e.text += data; if (e.text.length > 262144) { const cut = e.text.length - 262144; e.text = e.text.slice(cut); e.offset += cut; }
        e.wake?.();
      }));
      return { id: e.id };
    } catch (error) {
      this.stopEntry(e, 'start_failed');
      if (!e.pty) this.finishEntry(e);
      if (error instanceof HTTPException) throw error;
      throw new HTTPException(503, { message: 'Terminal could not start' });
    }
  }
  private stopEntry(e: Entry, reason: string) {
    if (e.ended !== undefined) return;
    e.stopping ??= reason;
    e.reason = 'cleanup_unconfirmed';
    try { e.pty?.kill(); } catch { if (e.ended === undefined) e.reason = 'cleanup_unconfirmed'; }
    e.wake?.();
  }
  private finishEntry(e: Entry) {
    if (e.ended !== undefined) return;
    e.ended = this.now(); e.reason = e.stopping ?? 'exited';
    for (const s of e.subscriptions) s.dispose(); e.subscriptions = [];
    delete e.pty; e.wake?.();
    e.confirmExit();
    if (!this.active()) this.controller?.abort();
  }
  stop(owner: string, id: string) { return this.authorize(owner, () => {
    const entry = this.get(owner, id);
    this.stopEntry(entry, 'stopped');
    if (entry.ended === undefined) throw new HTTPException(503, { message: 'Terminal cleanup unconfirmed' });
  }); }
  write(owner: string, id: string, sequence: number, data: string, check: () => void = () => {}) {
    return this.authorize(owner, () => {
    const e = this.get(owner, id); if (!e.pty || e.ended !== undefined || e.stopping !== undefined || sequence !== e.sequence + 1) throw new HTTPException(409);
    if (this.now() - e.inputAt >= 1000) { e.inputBytes = 0; e.inputAt = this.now(); }
    if (e.inputBytes + data.length > 32768) throw new HTTPException(429);
    e.inputBytes += data.length; e.sequence = sequence; e.seen = this.now();
    try { e.pty.write(data); } catch { this.stopEntry(e, 'write_failed'); throw new HTTPException(409); }
    }, check);
  }
  resize(owner: string, id: string, cols: number, rows: number, check: () => void = () => {}) { return this.authorize(owner, () => { const e = this.get(owner, id); if (!e.pty || e.ended !== undefined || e.stopping !== undefined) throw new HTTPException(409); try { e.pty.resize(cols, rows); } catch { throw new HTTPException(503, { message: 'Terminal resize unavailable' }); } }, check); }
  read(owner: string, id: string, cursor: number, signal: AbortSignal, waitMs = 20_000) {
    if (this.closed) return Promise.reject(new HTTPException(404));
    return this.track(this.readOwned(owner, id, cursor, signal, waitMs));
  }
  private async readOwned(owner: string, id: string, cursor: number, signal: AbortSignal, waitMs: number) {
    await this.authorize(owner, () => {});
    const e = this.get(owner, id); if (e.polling) throw new HTTPException(409); if (cursor > e.offset + e.text.length) throw new HTTPException(400);
    e.seen = this.now(); e.polling = true;
    let timer: ReturnType<typeof setTimeout> | undefined; const abort = () => e.wake?.();
    try {
      if (!signal.aborted && e.ended === undefined && e.stopping === undefined && cursor === e.offset + e.text.length) await new Promise<void>(resolve => { e.wake = resolve; timer = setTimeout(resolve, waitMs); signal.addEventListener('abort', abort, { once: true }); });
      if (signal.aborted) { this.stopEntry(e, 'disconnected'); throw new HTTPException(409); }
      if (await this.allowed(owner) !== true || this.closed) { this.stopEntry(e, 'revoked'); throw new HTTPException(403); }
      const start = Math.max(e.offset, cursor), data = e.text.slice(start - e.offset, start - e.offset + 32768);
      return { data, cursor: start + data.length, more: start + data.length < e.offset + e.text.length, truncated: cursor < e.offset, running: e.ended === undefined, reason: e.reason ?? null };
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); e.wake = undefined; e.polling = false; }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.controller?.abort(); clearInterval(this.timer);
    for (const e of this.entries.values()) this.stopEntry(e, 'shutdown');
    return this.closing = (async () => {
      while (this.pending.size) await Promise.allSettled([...this.pending]);
      await Promise.all([...this.entries.values()].map(entry => entry.exited));
      this.entries.clear();
    })();
  }
}
