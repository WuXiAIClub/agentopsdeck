import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { Worker } from 'node:worker_threads';
import { AuthPersistenceError } from './private-store.js';
import type { SqlitePasskeys } from './sqlite-passkeys.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { observeReadonlyOwner, type ReadonlyOwnerFailureCode } from '../storage/readonly-owner-observation.js';
import { createReadonlyWorkerStop } from '../storage/readonly-worker-stop.js';
import { createReadonlyFailureReceiver } from '../storage/readonly-failure-relay.js';

export type AuthDisplayConfig = { file: string; dev: number; ino: number };
type Kind = 'status' | 'list';
type Results = { status: ReturnType<SqlitePasskeys['status']>; list: ReturnType<SqlitePasskeys['list']> };
type Waiter = { kind: Kind; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
function validResult(kind: Kind, value: unknown): boolean {
  if (kind === 'status') {
    const r = value as Results['status'] | null;
    return !!r && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).length === 2
      && Number.isSafeInteger(r.count) && r.count >= 0 && r.count <= 1024 && r.available === (r.count > 0);
  }
  // Legacy display fields have no stricter import contract. Validate the DTO
  // envelope without silently inventing limits for labels/timestamps/transports.
  return Array.isArray(value) && value.length <= 1024 && value.every(r => r && typeof r === 'object'
    && !Array.isArray(r) && typeof r.id === 'string' && /^[a-f0-9]{24}$/.test(r.id)
    && ['id', 'label', 'transports', 'createdAt'].every(key => Object.hasOwn(r, key))
    && Object.keys(r).every(key => ['id', 'label', 'transports', 'createdAt', 'lastUsedAt'].includes(key)));
}

/** A bounded read-only display connection, never a second writer or an
 * authorization cache. It cannot query sessions, issue credentials, mutate
 * counters, accept SQL/callbacks or decide admission. An uncertain read retires
 * this observer, not the original writer. Close waits for its confirmed exit.
 * No read is replayed or silently retried on the main thread. */
export class AsyncSqliteAuthDisplay {
  private readonly worker: Worker;
  private readonly ready: Promise<void>;
  private readonly exited: Promise<void>;
  private readonly originalStop: ReturnType<typeof createReadonlyWorkerStop>;
  private sequence = 0;
  private failed = false;
  private failureCode: ReadonlyOwnerFailureCode | undefined;
  private closing: Promise<void> | undefined;
  private closeRequested = false;
  private readyReceived = false;
  private rejectReady: ((error: Error) => void) | undefined;
  private exitConfirmed = false;
  private closeAcknowledged = false;
  private closeId: number | undefined;
  private readonly pending = new Map<number, Waiter>();
  private readonly accepted = new Set<Promise<unknown>>();
  /** Observation only; never closes/reopens the original authorization owner. */
  get recoveryState() { return { unavailable: this.failed, exitConfirmed: this.exitConfirmed }; }
  constructor(config: AuthDisplayConfig,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics,
    launch?: () => Worker, private readonly timeoutMs = 30_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new AuthPersistenceError();
    const source = new URL(import.meta.url).pathname.endsWith('.ts');
    const entry = new URL(source ? './sqlite-display-worker.ts' : './sqlite-display-worker.js', import.meta.url);
    this.worker = launch ? launch() : new Worker(`(async () => {
      const { workerData } = require('node:worker_threads');
      if (workerData.loader) { const { tsImport } = await import(workerData.loader); await tsImport(workerData.entry, workerData.entry); }
      else await import(workerData.entry);
    })().catch(() => process.exit(1));`, { eval: true, execArgv: [], workerData: {
      ...config, entry: entry.href, loader: source ? import.meta.resolve('tsx/esm/api') : undefined,
    } });
    this.originalStop = createReadonlyWorkerStop(this.worker,
      () => observeReadonlyOwner(this.diagnostics, 'auth-display-read', 8, this.accepted.size, 9));
    this.exited = new Promise<void>(resolve => this.worker.once('exit', code => {
      this.exitConfirmed = true;
      this.originalStop.confirmExit();
      if (!this.closing || !this.closeAcknowledged || code !== 0) this.fail(3);
      observeReadonlyOwner(this.diagnostics, 'auth-display-read', 7, this.accepted.size, this.failureCode);
      resolve();
    }));
    this.ready = new Promise<void>((resolve, reject) => {
      const receiveFailure = createReadonlyFailureReceiver('auth', this.diagnostics);
      this.rejectReady = reject;
      const timer = setTimeout(() => {
        this.fail(1);
        const trace = guardedTrace(this.diagnostics, 'auth-display-read'); trace.add('step', 0);
        trace.add('timedOut', 1); trace.finish(true);
        reject(new AuthPersistenceError());
      }, timeoutMs);
      timer.unref();
      const failed = () => { clearTimeout(timer); reject(new AuthPersistenceError()); this.fail(2); };
      this.worker.once('error', failed);
      this.worker.once('exit', () => { clearTimeout(timer); reject(new AuthPersistenceError()); });
      this.worker.on('message', (message: unknown) => {
        if (receiveFailure(message)) return;
        const r = message as { kind?: unknown; id?: unknown; ok?: unknown; value?: unknown } | null;
        if (r && typeof r === 'object' && !Array.isArray(r) && r.kind === 'ready' && Object.keys(r).length === 1) {
          if (this.readyReceived || this.failed) { this.fail(4); return; }
          this.readyReceived = true; clearTimeout(timer); resolve(); return;
        }
        if (!r || typeof r !== 'object' || Array.isArray(r) || !Number.isSafeInteger(r.id)
          || Object.keys(r).some(key => !['id', 'kind', 'ok', 'value'].includes(key))) { this.fail(4); return; }
        if (this.readyReceived && !this.closeAcknowledged && r.id === this.closeId && r.kind === 'close'
          && r.ok === true && Object.keys(r).length === 3) {
          this.closeAcknowledged = true; return;
        }
        const waiter = this.pending.get(r.id as number);
        if (!waiter || waiter.kind !== r.kind || r.ok !== true || !Object.hasOwn(r, 'value')
          || !validResult(waiter.kind, r.value)) { this.fail(4); return; }
        clearTimeout(waiter.timer); this.pending.delete(r.id as number); waiter.resolve(r.value);
      });
    });
    // Lazy readers may fail before the first route awaits readiness.
    void this.ready.catch(() => {});
  }
  private fail(code: ReadonlyOwnerFailureCode) {
    if (this.failed) return;
    this.failed = true;
    this.failureCode = code;
    this.rejectReady?.(new AuthPersistenceError());
    for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new AuthPersistenceError()); }
    this.pending.clear();
    // Only a read-only computation is stopped. Never terminate the writer,
    // change a receipt or treat the timeout as proof of an uncommitted write.
    // Register failure before diagnostics can reenter. A refused stop is still
    // unknown disposal, not permission to reopen or settle the original drain.
    observeReadonlyOwner(this.diagnostics, 'auth-display-read', 6, this.accepted.size, code);
    if (!this.exitConfirmed) this.originalStop.request();
  }
  read<K extends Kind>(kind: K, key?: string): Promise<Results[K]> {
    if (this.failed || this.closeRequested || this.accepted.size >= 256 || !['status', 'list'].includes(kind)
      || (key !== undefined && (typeof key !== 'string' || !/^[a-f0-9]{24}$/.test(key)))) {
      const trace = guardedTrace(this.diagnostics, 'auth-display-read'); trace.add('deferred', 1); trace.finish(true);
      return Promise.reject(new AuthPersistenceError());
    }
    // Admission must be visible before dispatch invokes injected diagnostics.
    // Reentrant observation cannot add request 257 or hide work from close.
    const work = Promise.resolve().then(() => this.dispatch(kind, key)) as Promise<Results[K]>;
    this.accepted.add(work);
    void work.then(() => this.accepted.delete(work), () => this.accepted.delete(work));
    return work;
  }
  private async dispatch(kind: Kind, key?: string): Promise<unknown> {
    const trace = guardedTrace(this.diagnostics, 'auth-display-read');
    trace.add('step', kind === 'status' ? 1 : 2);
    const at = performance.now(); let failed = true, admitted = false;
    try {
      await this.ready;
      if (this.failed) throw new AuthPersistenceError();
      if (this.sequence === Number.MAX_SAFE_INTEGER) { this.fail(7); throw new AuthPersistenceError(); }
      const id = ++this.sequence;
      trace.add('queueMs', performance.now() - at); admitted = true;
      const result = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => { this.fail(5); trace.add('timedOut', 1); }, this.timeoutMs);
        timer.unref();
        this.pending.set(id, { kind, resolve, reject, timer });
        try { this.worker.postMessage({ id, kind, key }); } catch { this.fail(6); }
      });
      failed = false; return result;
    } finally { trace.add(admitted ? failed ? 'unknown' : 'settled' : 'deferred', 1); trace.finish(failed); }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closeRequested = true;
    // Register closure before waiting: no later route can add work to the set.
    return this.closing = Promise.resolve().then(async () => {
      await Promise.allSettled([...this.accepted]);
      const trace = guardedTrace(this.diagnostics, 'auth-display-read'); trace.add('step', 3);
      const warning = setTimeout(() => {
        this.fail(8); trace.reportPending({ pending: 1, unknown: 1 });
      }, this.timeoutMs); warning.unref();
      try {
        try { await this.ready; } catch { this.fail(2); }
        if (!this.failed && !this.exitConfirmed) {
          if (this.sequence === Number.MAX_SAFE_INTEGER) this.fail(7);
        }
        if (!this.failed && !this.exitConfirmed) {
          this.closeId = ++this.sequence;
          try { this.worker.postMessage({ id: this.closeId, kind: 'close' }); } catch { this.fail(6); }
        }
        // A deadline reports uncertainty and stops ONLY this read-only worker.
        // It must not latch a failed drain requiring an ad-hoc close retry.
        // Actual late exit settles this same original promise automatically;
        // neither terminate's return value nor time passing releases a writer.
        await this.exited;
        trace.add('settled', 1); trace.finish();
      } finally { clearTimeout(warning); }
    });
  }
}
