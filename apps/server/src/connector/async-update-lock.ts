import { Worker } from 'node:worker_threads';
import { types } from 'node:util';
import { createOriginalWorkerStop } from '../storage/original-worker-stop.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

export class UpdateLockBusy extends Error { constructor() { super('connector update lock busy'); } }
export interface OriginalUpdateLockOwner {
  acquire(): Promise<void>;
  retire(): void;
  waitForExit(): Promise<void>;
  readonly exitConfirmed: boolean;
  assertHeld(): void;
}
/** Actual original worker exit, never a close message/ACK or terminate Promise,
 * is physical lock-release evidence. Retirement cannot acquire/replay updates. */
export class AsyncUpdateLockOwner implements OriginalUpdateLockOwner {
  private readonly worker: Worker;
  private readonly stop: ReturnType<typeof createOriginalWorkerStop>;
  private readonly acquired: Promise<void>;
  private readonly exited: Promise<void>;
  private resolveAcquire!: () => void;
  private rejectAcquire!: (error: Error) => void;
  private resolveExit!: () => void;
  private ready = false;
  private failed = false;
  private retiring = false;
  private physicalExit = false;
  private force: ReturnType<typeof setTimeout> | undefined;
  private startup: ReturnType<typeof setTimeout> | undefined;
  constructor(file: string, diagnostics: PerformanceDiagnostics = performanceDiagnostics, launch?: () => Worker,
    private readonly startupMs = 30_000) {
    if (!Number.isSafeInteger(startupMs) || startupMs < 1 || startupMs > 2_147_483_647) throw Error('connector update lock owner unavailable');
    const trace = guardedTrace(diagnostics, 'update-lock-cleanup');
    trace.add('step', 4);
    this.acquired = new Promise((resolve, reject) => { this.resolveAcquire = resolve; this.rejectAcquire = reject; });
    void this.acquired.catch(() => {});
    this.exited = new Promise(resolve => { this.resolveExit = resolve; });
    // tsImport can attach a namespace query to nested source imports.
    const source = new URL(import.meta.url).pathname.endsWith('.ts');
    const entry = new URL(source ? './update-lock-worker.ts' : './update-lock-worker.js', import.meta.url);
    this.worker = launch ? launch() : new Worker(`(async () => {
      const { workerData } = require('node:worker_threads');
      if (workerData.loader) { const { tsImport } = await import(workerData.loader); await tsImport(workerData.entry, workerData.entry); }
      else await import(workerData.entry);
    })().catch(() => process.exit(1));`, { eval: true, execArgv: [], workerData: {
      file, entry: entry.href, loader: source ? import.meta.resolve('tsx/esm/api') : undefined,
    } });
    this.stop = createOriginalWorkerStop(this.worker, () => { trace.reportPending({ pending: 1, unknown: 1, step: 5 }); });
    const fail = (busy = false) => {
      if (!this.failed) {
        this.failed = true;
        clearTimeout(this.startup); this.startup = undefined;
        this.rejectAcquire(busy ? new UpdateLockBusy() : Error('connector update lock owner unavailable'));
      }
      this.retire();
    };
    this.worker.on('message', (value: unknown) => {
      const v = value as { kind?: unknown; busy?: unknown };
      if (!v || typeof v !== 'object' || Array.isArray(v)) { fail(); return; }
      if (v.kind === 'acquired' && Object.keys(v).length === 1 && !this.ready && !this.failed && !this.retiring) {
        this.ready = true; clearTimeout(this.startup); this.startup = undefined; this.resolveAcquire(); return;
      }
      if (v.kind === 'failed' && Object.keys(v).length === 2 && typeof v.busy === 'boolean' && !this.ready) { fail(v.busy); return; }
      fail();
    });
    this.worker.on('error', () => fail());
    this.worker.once('exit', code => {
      this.physicalExit = true; clearTimeout(this.force); this.force = undefined;
      clearTimeout(this.startup); this.startup = undefined;
      this.stop.confirmExit();
      if (!this.ready) this.rejectAcquire(Error('connector update lock owner unavailable'));
      trace.add('step', 6); trace.add('settled', 1); trace.finish(this.failed || code !== 0);
      this.resolveExit();
    });
    // Acquisition has not admitted a business body. A missing readiness ACK
    // becomes explicit unknown and retires only this original worker; the path
    // group remains fenced until its physical exit is observed.
    this.startup = setTimeout(() => { trace.reportPending({ pending: 1, unknown: 1, step: 4 }); fail(); }, startupMs);
    this.startup.unref();
  }
  acquire() { return this.acquired; }
  get exitConfirmed() { return this.physicalExit; }
  assertHeld() {
    if (!this.ready || this.failed || this.retiring || this.physicalExit) throw Error('connector update lock owner unavailable');
  }
  retire() {
    if (this.retiring || this.physicalExit) return;
    this.retiring = true;
    try { this.worker.postMessage('close'); }
    catch { this.stop.request(); }
    // A deadline requests physical retirement only; it never releases a path.
    this.force = setTimeout(() => { this.force = undefined; this.stop.request(); }, 1000);
    this.force.unref();
  }
  waitForExit() { return this.exited; }
}

/** All original owners are quiescent before calling run. A bounded wait may
 * return unknown to the caller but retains the whole canonical path group.
 * Recovery observes/retires original workers only, never reruns the body. */
export class AsyncUpdateLockCleanup {
  private active: Promise<boolean> | undefined;
  private released = false;
  private releaseUnknown = false;
  constructor(private readonly owners: readonly OriginalUpdateLockOwner[], private readonly release: () => void,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics, private readonly waitMs = 2000) {}
  run(): Promise<boolean> {
    if (this.released) return Promise.resolve(true);
    if (this.active) return this.active;
    // Publish before callbacks, clocks or logging can reenter.
    let settle!: (value: boolean) => void;
    const flight = new Promise<boolean>(resolve => { settle = resolve; });
    this.active = flight;
    const finish = (value: boolean) => {
      // Clear before delivery: the awaiting caller may immediately observe new
      // physical exit evidence and request recovery of the same original group.
      if (this.active === flight) this.active = undefined;
      settle(value);
    };
    void this.execute().then(finish, () => finish(false));
    return flight;
  }
  private async execute(): Promise<boolean> {
    const trace = guardedTrace(this.diagnostics, 'update-lock-cleanup');
    trace.add('step', 5);
    let failed = false;
    const waits: Promise<void>[] = [];
    for (const owner of this.owners) {
      // Recovery revisits only unresolved original owners. A physical exit is
      // final evidence; invoking an already retired owner again adds no proof
      // and can reenter caller cleanup with stale ownership.
      try { if (!owner.exitConfirmed) { owner.retire(); waits.push(owner.waitForExit()); } }
      catch { failed = true; }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all(waits).catch(() => { failed = true; }),
        new Promise<void>(resolve => { timer = setTimeout(resolve, this.waitMs); })]);
      // Even a fulfilled forged/lost close result is not exit evidence.
      const pending = this.owners.filter(owner => !owner.exitConfirmed).length;
      if (pending || this.releaseUnknown) failed = true;
      if (!failed) {
        if (types.isAsyncFunction(this.release)) this.releaseUnknown = true;
        else {
          try {
            const result: unknown = this.release();
            this.released = result === undefined;
            this.releaseUnknown = !this.released;
            if (types.isPromise(result)) void Promise.prototype.then.call(result, () => {}, () => {});
          } catch { this.releaseUnknown = true; }
        }
        if (this.releaseUnknown) failed = true;
      }
      trace.add('pending', pending + Number(!this.released));
      if (failed) trace.add('unknown', 1); else trace.add('settled', 1);
      trace.finish(failed); return !failed;
    } finally { clearTimeout(timer); }
  }
}

export class AsyncUpdateLockRecovery {
  private readonly pending = new Map<string, { cleanup: AsyncUpdateLockCleanup; nextAttempt: number }>();
  constructor(private readonly clock: () => number = () => performance.now()) {}
  hasPending() { return this.pending.size > 0; }
  retain(keys: readonly string[], cleanup: AsyncUpdateLockCleanup) {
    const entry = { cleanup, nextAttempt: this.clock() + 1000 };
    for (const key of keys) this.pending.set(key, entry);
  }
  async recover(key: string): Promise<boolean> {
    const entry = this.pending.get(key);
    if (!entry) return true;
    const now = this.clock();
    if (now < entry.nextAttempt) return false;
    entry.nextAttempt = now + 1000;
    if (!await entry.cleanup.run()) return false;
    for (const [path, value] of this.pending) if (value === entry) this.pending.delete(path);
    return true;
  }
}
