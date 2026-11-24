import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { HTTPException } from 'hono/http-exception';
import type { RemoteCommand, RemoteDevice, RemoteOutcome, RemoteSnapshot } from '@agentopsdeck/shared';
import { remoteCatalogKey } from '@agentopsdeck/shared';

export class RemoteError extends HTTPException {
  constructor(status: 404 | 409 | 429, readonly code: string) {
    super(status, { message: code, res: Response.json({ error: code }, { status, headers: { 'Cache-Control': 'no-store' } }) });
  }
}
type Pending = { command: RemoteCommand; expires: number; delivered: boolean; resolve: (value: RemoteOutcome) => void };
type Device = { user: string; hash: Buffer; view: RemoteDevice; wake?: (() => void) | undefined; pending?: Pending | undefined;
  receipts: Map<string, { signature: string; result: RemoteOutcome }>; calls: number[]; polling: boolean };
type Authorize = () => boolean | Promise<boolean>;
const hash = (token: string) => createHash('sha256').update(token).digest();
/** Bounded, memory-only mailbox. Restart, disable, expiry and credential revocation never replay an input. */
export class WorkspaceRemote {
  private readonly devices = new Map<string, Device>();
  private readonly cleanup: ReturnType<typeof setInterval>;
  private closed = false;
  private closing?: Promise<void>;
  private readonly work = new Set<Promise<void>>();
  constructor(private readonly now = Date.now, private readonly leaseMs = 60_000, private readonly commandMs = 8000) {
    this.cleanup = setInterval(() => this.expire(), 5000); this.cleanup.unref();
  }
  private expire() { for (const [id, device] of this.devices) if (device.view.expiresAt <= this.now()) this.remove(device.user, id); }
  private get(user: string, id: string) {
    if (this.closed) throw new RemoteError(404, 'remote_unavailable');
    const device = this.devices.get(id);
    if (!device || device.user !== user) throw new RemoteError(404, 'remote_unavailable');
    if (device.view.expiresAt <= this.now()) { this.remove(user, id); throw new RemoteError(404, 'remote_unavailable'); }
    return device;
  }
  private host(user: string, id: string, token: string) {
    const device = this.get(user, id);
    if (!token || !timingSafeEqual(device.hash, hash(token))) throw new RemoteError(404, 'remote_unavailable');
    return device;
  }
  list(user: string) { this.expire(); return [...this.devices.values()].filter(d => d.user === user).map(d => structuredClone(d.view)); }
  create(user: string, snapshot: RemoteSnapshot) {
    if (this.closed) throw new RemoteError(404, 'remote_unavailable');
    this.expire();
    if (this.devices.size >= 128 || this.list(user).length >= 4) throw new RemoteError(429, 'remote_device_limit');
    const id = randomUUID(), token = randomBytes(32).toString('base64url');
    const view = { ...structuredClone(snapshot), id, revision: 1, sequence: 0, expiresAt: this.now() + this.leaseMs };
    this.devices.set(id, { user, hash: hash(token), view, receipts: new Map(), calls: [], polling: false });
    return { device: structuredClone(view), hostToken: token };
  }
  update(user: string, id: string, token: string, snapshot: RemoteSnapshot) {
    const device = this.host(user, id, token);
    // Focus changes do not invalidate the target catalog; identity/title changes do.
    if (remoteCatalogKey(device.view) !== remoteCatalogKey(snapshot)) {
      device.view = { ...structuredClone(snapshot), id, revision: device.view.revision + 1, sequence: device.view.sequence, expiresAt: device.view.expiresAt };
    } else { device.view.active = snapshot.active; device.view.targets = structuredClone(snapshot.targets); }
    return structuredClone(device.view);
  }
  /** Retain the original work before invoking code that may reenter close(). */
  private track<T>(run: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const retained = new Promise<void>(resolve => { release = resolve; });
    this.work.add(retained);
    const finish = () => { this.work.delete(retained); release(); };
    try { return run().then(value => { finish(); return value; }, error => { finish(); throw error; }); }
    catch (error) { finish(); return Promise.reject(error); }
  }
  private authorized(authorize: Authorize): boolean | Promise<boolean> {
    try {
      const value = authorize();
      return typeof value === 'boolean' ? value : Promise.resolve(value).then(result => result === true, () => false);
    } catch { return false; }
  }
  /** Single-flight periodic check. A stopped watcher still retains its original
   * pending owner call; it cannot schedule again or change a settled outcome. */
  private watch(authorize: Authorize, interval: number, denied: () => void) {
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const schedule = () => { timer = setTimeout(() => {
      if (stopped || this.closed) return;
      void this.track(async () => {
        const allowed = await this.authorized(authorize);
        if (stopped || this.closed) return;
        if (!allowed) { stopped = true; denied(); } else schedule();
      });
    }, interval); };
    schedule();
    return () => { stopped = true; clearTimeout(timer); };
  }
  poll(user: string, id: string, token: string, signal: AbortSignal, authorize: Authorize, waitMs = 25_000) {
    return this.track(() => this.pollOriginal(user, id, token, signal, authorize, waitMs));
  }
  private async pollOriginal(user: string, id: string, token: string, signal: AbortSignal, authorize: Authorize, waitMs: number) {
    const started = this.now();
    const device = this.host(user, id, token);
    if (device.polling) throw new RemoteError(409, 'remote_already_connected');
    device.polling = true;
    let timeout: ReturnType<typeof setTimeout> | undefined, stopWatch: (() => void) | undefined;
    let wake = () => {};
    const abort = () => wake();
    try {
      const initial = this.authorized(authorize);
      if (signal.aborted || !(typeof initial === 'boolean' ? initial : await initial) || this.closed || this.devices.get(id) !== device) {
        this.remove(user, id); throw new RemoteError(404, 'remote_unavailable');
      }
      device.view.expiresAt = this.now() + this.leaseMs;
      if (!device.pending || device.pending.delivered) await new Promise<void>(resolve => {
        wake = resolve; device.wake = resolve;
        timeout = setTimeout(resolve, waitMs);
        stopWatch = this.watch(authorize, 1000, () => { this.remove(user, id); resolve(); });
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) resolve();
      });
      stopWatch?.();
      if (signal.aborted || this.closed || this.devices.get(id) !== device) {
        this.remove(user, id); throw new RemoteError(404, 'remote_unavailable');
      }
      const final = this.authorized(authorize);
      if (!(typeof final === 'boolean' ? final : await final) || signal.aborted || this.closed || this.devices.get(id) !== device) {
        this.remove(user, id); throw new RemoteError(404, 'remote_unavailable');
      }
      if (device.pending && !device.pending.delivered) {
        const validForMs = device.pending.expires - this.now();
        if (validForMs <= 0) { device.pending.resolve('unknown'); return null; }
        device.pending.delivered = true;
        return { ...structuredClone(device.pending.command), validForMs, waitedMs: Math.max(0, this.now() - started) };
      }
      return null;
    } finally {
      clearTimeout(timeout); stopWatch?.(); signal.removeEventListener('abort', abort); device.wake = undefined; device.polling = false;
    }
  }
  command(user: string, id: string, command: RemoteCommand, signal: AbortSignal, authorize: Authorize) {
    // Copy before the first permission await; later caller mutation cannot
    // retarget admitted native input or its idempotency fingerprint.
    const copied = structuredClone(command);
    return this.track(() => this.commandOriginal(user, id, copied, signal, authorize));
  }
  private async commandOriginal(user: string, id: string, command: RemoteCommand, signal: AbortSignal, authorize: Authorize) {
    const device = this.get(user, id), signature = hash(JSON.stringify(command)).toString('hex');
    const allowed = this.authorized(authorize);
    if (!(typeof allowed === 'boolean' ? allowed : await allowed) || signal.aborted || this.get(user, id) !== device) throw new RemoteError(404, 'remote_unavailable');
    const receipt = device.receipts.get(command.id);
    if (receipt) { if (receipt.signature !== signature) throw new RemoteError(409, 'remote_command_conflict'); return receipt.result; }
    if (command.sequence !== device.view.sequence + 1) throw new RemoteError(409, 'remote_sequence_changed');
    if (device.pending || !device.polling) throw new RemoteError(409, 'remote_busy_or_offline');
    if (command.revision !== device.view.revision || !device.view.targets.some(t => t.id === command.target)) throw new RemoteError(409, 'remote_view_changed');
    if (command.action === 'send' && !device.view.targets.some(t => t.id === command.target && t.kind === 'session')) throw new RemoteError(409, 'remote_not_a_session');
    device.calls = device.calls.filter(t => t > this.now() - 60_000);
    if (device.calls.length >= 90) throw new RemoteError(429, 'remote_rate_limit');
    device.calls.push(this.now());
    device.view.sequence = command.sequence;
    let finish = (_: RemoteOutcome) => {};
    const abort = () => finish('unknown');
    const result = new Promise<RemoteOutcome>(resolve => { finish = resolve; });
    const pending: Pending = { command: structuredClone(command), expires: this.now() + this.commandMs, delivered: false, resolve: finish };
    device.pending = pending;
    device.wake?.();
    const timer = setTimeout(() => finish('unknown'), this.commandMs);
    const stopWatch = this.watch(authorize, 250, () => finish('unknown'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) finish('unknown');
    try {
      const outcome = await result;
      device.receipts.set(command.id, { signature, result: outcome });
      while (device.receipts.size > 64) device.receipts.delete(device.receipts.keys().next().value!);
      return outcome;
    } finally { clearTimeout(timer); stopWatch(); signal.removeEventListener('abort', abort); if (device.pending === pending) device.pending = undefined; }
  }
  acknowledge(user: string, id: string, token: string, commandId: string, result: RemoteOutcome) {
    const device = this.host(user, id, token);
    if (device.pending?.command.id !== commandId || !device.pending.delivered || device.pending.expires <= this.now()) throw new RemoteError(409, 'remote_command_expired');
    device.pending.resolve(result);
  }
  remove(user: string, id: string) {
    const device = this.devices.get(id);
    if (!device || device.user !== user) return;
    this.devices.delete(id); device.pending?.resolve('unknown'); device.wake?.();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    clearInterval(this.cleanup);
    for (const [id, device] of this.devices) this.remove(device.user, id);
    this.closing = (async () => { while (this.work.size) await Promise.all([...this.work]); })();
    return this.closing;
  }
}
