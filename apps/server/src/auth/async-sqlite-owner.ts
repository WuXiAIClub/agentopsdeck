import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { types } from 'node:util';
import { safeEqual } from './access-key.js';
import { AuthPersistenceError } from './private-store.js';
import { startupDatabaseOwners } from '../storage/startup-owner.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { createOriginalWorkerStop } from '../storage/original-worker-stop.js';
import { createSqlOwnerFailureReceiver } from '../storage/sql-owner-failure-relay.js';
import { type SqliteAuthRefusal, SQLITE_AUTH_COMMAND_BYTES,
  SQLITE_AUTH_RESULT_BYTES, type SqliteAuthCommands, type SqliteAuthKind } from './sqlite-owner-domain.js';
import { standaloneAuthConfig, standaloneAuthKinds, standaloneAuthCommandStep, validStandaloneAuthInput, validStandaloneAuthOutput,
  standaloneAuthRefusal, standaloneAuthRefusalError, type StandaloneAuthKind, type StandaloneAuthOwnerConfig } from './standalone-owner-domain.js';
import type { OriginalJsonRouteCapability } from './original-json-command-domain.js';
import { AuthCurrentKeyBinding, type AuthKeyDeliveryFence, type CurrentKeyBinding } from './current-key-binding.js';
import type { LocalPreferenceInput, LocalPreferenceResult, LocalPreferenceSnapshot } from './local-preference-domain.js';
import type { ApplicationTransactionAuthEndpoint } from './application-transaction-gate.js';

export type SqliteAuthOwnerConfig = StandaloneAuthOwnerConfig;
type Kind = StandaloneAuthKind | 'close';
type Waiter = { kind: Kind; resolve(value: unknown): void; reject(error: Error): void };

/** Copy data using descriptors before serialization. Never invoke a caller's
 * getter/toJSON/then or serialize a callback. Byte/depth/shape limits apply
 * before invoking an owner; oversized old records fail rather than truncate. */
export function encodeSqliteAuthJson(value: unknown, maximum: number): string {
  let bytes = 0, nodes = 0;
  const active = new Set<object>();
  const copy = (v: unknown, depth: number): unknown => {
    if (depth > 32 || ++nodes > 16_384) throw new AuthPersistenceError();
    if (typeof v === 'string') { bytes += Buffer.byteLength(v); if (bytes > maximum) throw new AuthPersistenceError(); return v; }
    if (v === null || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)) return v;
    // Descriptor/prototype inspection is safe for plain objects, but runs
    // arbitrary traps on a Proxy (including a revoked one). Reject before any
    // inspection, including Array.isArray, for every nested input and config.
    if (!v || typeof v !== 'object' || types.isProxy(v) || active.has(v)) throw new AuthPersistenceError();
    const array = Array.isArray(v), prototype = Object.getPrototypeOf(v);
    if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) throw new AuthPersistenceError();
    const properties = Object.getOwnPropertyDescriptors(v);
    if (Reflect.ownKeys(properties).some(key => typeof key !== 'string')) throw new AuthPersistenceError();
    active.add(v);
    try {
      if (array) {
        const length = properties.length!.value as number;
        if (length > 8192 || Object.keys(properties).length !== length + 1) throw new AuthPersistenceError();
        const result: unknown[] = [];
        for (let i = 0; i < length; i++) {
          const descriptor = properties[String(i)];
          if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new AuthPersistenceError();
          result.push(copy(descriptor.value, depth + 1));
        }
        return result;
      }
      const result: Record<string, unknown> = Object.create(null);
      for (const [key, descriptor] of Object.entries(properties)) {
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new AuthPersistenceError();
        bytes += Buffer.byteLength(key); if (bytes > maximum) throw new AuthPersistenceError();
        result[key] = copy(descriptor.value, depth + 1);
      }
      return result;
    } finally { active.delete(v); }
  };
  try {
    const body = JSON.stringify(copy(value, 0));
    if (Buffer.byteLength(body) > maximum) throw new AuthPersistenceError();
    return body;
  } catch { throw new AuthPersistenceError(); }
}

/** Complete standalone original Auth owner (SQLite or JSON, fixed Key or no
 * Key). Format/configuration is pinned for this owner's lifetime. Not yet wired into the
 * application: ALL authority callers must become awaited before activation.
 * Never instantiate next to a live synchronous auth owner for the same file.
 * Warnings do not release slots, cancel writes or retry commands. */
export class AsyncSqliteAuthOwner {
  readonly currentKeyBinding: AuthKeyDeliveryFence;
  private readonly keyBinding: AuthCurrentKeyBinding;
  readonly originalJson: OriginalJsonRouteCapability | undefined;
  private readonly worker: Worker;
  private readonly ready: Promise<void>;
  private readonly exited: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readyReceived = false;
  private sequence = 0;
  private failed = false;
  private failureCode: number | undefined;
  private closing = false;
  private closeWork: Promise<void> | undefined;
  private retirementWork: Promise<void> | undefined;
  private closeAcknowledged = false;
  private exitConfirmed = false;
  private startupWarning: ReturnType<typeof setTimeout> | undefined;
  private readonly originalStop: ReturnType<typeof createOriginalWorkerStop>;
  private acceptedBytes = 0;
  private readonly accessKeyDigest: string | undefined;
  private readonly localPreferencesEnabled: boolean;
  private readonly pending = new Map<number, Waiter>();
  private readonly accepted = new Set<Promise<unknown>>();
  private readonly receiveFailure: ReturnType<typeof createSqlOwnerFailureReceiver>;
  constructor(config: SqliteAuthOwnerConfig, private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics,
    launch?: () => Worker, private readonly warningMs = 30_000, transactionPeer?: ApplicationTransactionAuthEndpoint) {
    if (launch && transactionPeer) throw new AuthPersistenceError();
    this.receiveFailure = createSqlOwnerFailureReceiver('auth', diagnostics);
    if (!Number.isSafeInteger(warningMs) || warningMs < 1 || warningMs > 2_147_483_647) throw new AuthPersistenceError();
    this.keyBinding = new AuthCurrentKeyBinding(diagnostics, warningMs);
    this.currentKeyBinding = Object.freeze({ capture: () => this.keyBinding.capture(),
      assertCurrent: (epoch: number) => this.keyBinding.assertCurrent(epoch) });
    const copied = standaloneAuthConfig(JSON.parse(encodeSqliteAuthJson(config, SQLITE_AUTH_COMMAND_BYTES)));
    // Pin both admission and worker I/O to the constructor's cwd. The worker
    // starts asynchronously and cannot inherit a later process.chdir target.
    if (copied.kind === 'json') {
      copied.passkeysFile = resolve(copied.passkeysFile); copied.sessionsFile = resolve(copied.sessionsFile);
      this.originalJson = Object.freeze({
        session: input => this.submit('originalJsonSession', input) as Promise<boolean>,
        authorized: input => this.submit('originalJsonAuthorized', input) as Promise<boolean>,
      });
    } else {
      copied.file = resolve(copied.file);
      copied.legacyFiles = copied.legacyFiles.map(file => file ? resolve(file) : file);
    }
    this.accessKeyDigest = copied.accessKeyDigest;
    this.localPreferencesEnabled = copied.legacyPreferences !== undefined;
    if (copied.legacyPreferences) {
      for (const field of ['hidden', 'archived', 'pinned'] as const) copied.legacyPreferences[field] = resolve(copied.legacyPreferences[field]);
    }
    const source = new URL(import.meta.url).pathname.endsWith('.ts');
    const entry = new URL(source ? './sqlite-owner-worker.ts' : './sqlite-owner-worker.js', import.meta.url);
    const releases: (() => void)[] = [];
    const releaseOwner = () => { for (const release of releases) release(); };
    try {
      for (const file of copied.kind === 'json' ? [copied.passkeysFile, copied.sessionsFile] : [copied.file]) {
        releases.push(startupDatabaseOwners.reserveExclusive(file));
      }
      if (copied.legacyPreferences) for (const file of Object.values(copied.legacyPreferences)) {
        releases.push(startupDatabaseOwners.reserveExclusive(file));
      }
    } catch { releaseOwner(); this.observeAdmissionRefusal(); throw new AuthPersistenceError(); }
    try {
      this.worker = launch ? launch() : new Worker(`(async () => {
      const { workerData } = require('node:worker_threads');
      if (workerData.loader) { const { tsImport } = await import(workerData.loader); await tsImport(workerData.entry, workerData.entry); }
      else await import(workerData.entry);
    })().catch(() => process.exit(1));`, { eval: true, execArgv: [], workerData: {
      ...copied, entry: entry.href, loader: source ? import.meta.resolve('tsx/esm/api') : undefined,
      ...(transactionPeer ? { applicationTransactionPort: transactionPeer.data, applicationTransactionLifetime: transactionPeer.lifetime } : {}),
      }, ...(transactionPeer ? { transferList: [transactionPeer.data, transactionPeer.lifetime] } : {}) });
    } catch {
      // A throwing native constructor did not return a worker. After a worker
      // exists, ONLY its real exit may release the original reservation.
      releaseOwner(); throw new AuthPersistenceError();
    }
    this.originalStop = createOriginalWorkerStop(this.worker, () => this.observeOwner(4, 9));
    this.ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    void this.ready.catch(() => {});
    this.exited = new Promise<void>(resolve => this.worker.once('exit', code => {
      this.exitConfirmed = true;
      if (transactionPeer) transactionPeer.retire(releaseOwner); else releaseOwner();
      this.originalStop.confirmExit();
      if (!this.closing || !this.closeAcknowledged || code !== 0) this.fail(3);
      this.observeOwner(2, this.failureCode); resolve();
    }));
    this.worker.on('error', () => this.fail(2));
    this.worker.on('message', (message: unknown) => this.receive(message));
    this.startupWarning = setTimeout(() => this.observeOwner(0), warningMs); this.startupWarning.unref();
  }
  private observeAdmissionRefusal() {
    try {
      const trace = this.diagnostics.start('auth-sqlite-owner');
      trace.add('step', 7); trace.add('deferred', 1); trace.finish(true);
    } catch { /* Observation cannot admit or retire a database owner. */ }
  }
  snapshot() {
    return { scope: 'process' as const, pending: this.pending.size, accepted: this.accepted.size,
      acceptedBytes: this.acceptedBytes, ready: this.readyReceived, unavailable: this.failed,
      closing: this.closing, closeAcknowledged: this.closeAcknowledged, ownerExitConfirmed: this.exitConfirmed };
  }
  open() { return this.ready; }
  /** Match the adapter to THIS original fixed-key owner, using the full private
   * digest, not its truncated public audit identity. No SQL dispatch or key
   * change. A refusal does not retire the correctly configured original owner. */
  assertAccessKeyBinding(digest: string | undefined): void {
    if ((digest === undefined && this.accessKeyDigest === undefined
      || typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest) && this.accessKeyDigest !== undefined
      && safeEqual(digest, this.accessKeyDigest)) && !this.failed && !this.closing && !this.exitConfirmed) return;
    try {
      const trace = this.diagnostics.start('auth-sqlite-owner');
      trace.add('step', 6); trace.add('deferred', 1); trace.add('pending', this.accepted.size); trace.finish(true);
    } catch { /* A diagnostic cannot authorize a mismatched adapter. */ }
    throw new AuthPersistenceError();
  }
  private observeOwner(step: number, cause?: number) {
    try {
      const trace = this.diagnostics.start('auth-sqlite-owner'); trace.add('step', step);
      trace.add('pending', step === 5 ? Math.max(this.pending.size, this.accepted.size) : this.pending.size);
      if (cause !== undefined) trace.add('ownerFailureCode', cause);
      if (step !== 2 && step !== 3) trace.add('unknown', 1);
      trace.finish(cause !== undefined);
    } catch { /* Logs cannot authorize mutation, release or reopen. */ }
  }
  private fail(cause: number) {
    if (this.failed) return;
    this.failed = true; this.failureCode = cause;
    clearTimeout(this.startupWarning);
    this.rejectReady(new AuthPersistenceError());
    for (const waiter of this.pending.values()) waiter.reject(new AuthPersistenceError());
    this.pending.clear();
    this.observeOwner(1, cause);
    // No timed writer replacement, termination, reconnect or body replay.
  }
  private receive(message: unknown) {
    if (this.receiveFailure(message)) return;
    if (this.failed) return;
    const r = message as { kind?: Kind | 'ready'; id?: number; ok?: boolean; body?: string; refusal?: number; retryAfterSeconds?: number } | null;
    if (!r || typeof r !== 'object' || Array.isArray(r)) { this.fail(4); return; }
    if (!this.readyReceived) {
      if (r.kind !== 'ready' || Object.keys(r).length !== 1) { this.fail(4); return; }
      this.readyReceived = true; clearTimeout(this.startupWarning); this.resolveReady(); this.observeOwner(3); return;
    }
    const waiter = Number.isSafeInteger(r.id) ? this.pending.get(r.id!) : undefined;
    const keys = r.ok ? ['id', 'kind', 'ok', 'body'] : Object.hasOwn(r, 'refusal')
      ? ['id', 'kind', 'ok', 'refusal', 'retryAfterSeconds'] : ['id', 'kind', 'ok'];
    if (!waiter || r.kind !== waiter.kind || typeof r.ok !== 'boolean'
      || Object.keys(r).length !== keys.length || !Object.keys(r).every(key => keys.includes(key))) { this.fail(4); return; }
    if (!r.ok) {
      const refusal = Object.hasOwn(r, 'refusal') ? standaloneAuthRefusalError(waiter.kind, r as unknown as SqliteAuthRefusal) : undefined;
      if (Object.hasOwn(r, 'refusal') && !refusal) { this.fail(4); return; }
      this.pending.delete(r.id!); waiter.reject(refusal ?? new AuthPersistenceError());
      if (waiter.kind === 'close') this.fail(10);
      return;
    }
    let value: unknown;
    try {
      if (typeof r.body !== 'string' || Buffer.byteLength(r.body) > SQLITE_AUTH_RESULT_BYTES) throw new AuthPersistenceError();
      value = JSON.parse(r.body);
      if (waiter.kind === 'close' ? value !== null : !validStandaloneAuthOutput(waiter.kind, value)) throw new AuthPersistenceError();
    } catch { this.fail(4); return; }
    this.pending.delete(r.id!);
    if (waiter.kind === 'close') this.closeAcknowledged = true;
    waiter.resolve(value);
  }
  private async send(kind: Kind, body: string): Promise<unknown> {
    await this.ready;
    // Admission was already reserved by command(). Closing cannot turn an
    // accepted, startup-waiting original command into a new refusal.
    if (this.failed || this.exitConfirmed) throw new AuthPersistenceError();
    if (this.sequence === Number.MAX_SAFE_INTEGER) { this.fail(7); throw new AuthPersistenceError(); }
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { kind, resolve, reject });
      try { this.worker.postMessage({ id, kind, body }); } catch { this.fail(6); }
    });
  }
  command<K extends SqliteAuthKind>(kind: K, input: SqliteAuthCommands[K]['input']): Promise<SqliteAuthCommands[K]['output']> {
    return this.submit(kind, input) as Promise<SqliteAuthCommands[K]['output']>;
  }
  updateCurrentKeyIdentity(keyIdentityHash?: string): Promise<void> {
    if (this.closing || this.failed || this.exitConfirmed) return Promise.reject(new AuthPersistenceError());
    return this.keyBinding.update(keyIdentityHash, [...this.accepted], input =>
      this.submit('currentKeyBinding', input, true) as Promise<CurrentKeyBinding>);
  }
  localPreference(input: LocalPreferenceInput): Promise<LocalPreferenceResult> {
    return this.submit('localPreference', input) as Promise<LocalPreferenceResult>;
  }
  localPreferenceSnapshot(): Promise<LocalPreferenceSnapshot> {
    return this.submit('localPreferenceSnapshot', {}) as Promise<LocalPreferenceSnapshot>;
  }
  private submit(kind: StandaloneAuthKind, input: unknown, bindingUpdate = false): Promise<unknown> {
    let body: string;
    let epoch: number | undefined;
    let refusal: Error | undefined;
    try {
      if (!bindingUpdate) {
        epoch = this.keyBinding.capture();
        if (kind === 'currentKeyBinding') throw new AuthPersistenceError();
      }
      // Reject known exhaustion before inspecting caller-owned descriptors.
      // The post-copy check still accounts for the complete copied byte size.
      if (this.closing && !bindingUpdate || this.failed || this.exitConfirmed || this.accepted.size >= 256
        || this.acceptedBytes >= 32 * SQLITE_AUTH_COMMAND_BYTES
        || !standaloneAuthKinds.includes(kind)
        || (kind === 'localPreference' || kind === 'localPreferenceSnapshot') && !this.localPreferencesEnabled
        || (kind === 'originalJsonSession' || kind === 'originalJsonAuthorized') && !this.originalJson) throw new AuthPersistenceError();
      body = encodeSqliteAuthJson(input, SQLITE_AUTH_COMMAND_BYTES);
      if (!validStandaloneAuthInput(kind, JSON.parse(body), this.originalJson !== undefined)) {
        // Browser credential shape errors are not database outages. Encoding
        // hazards/getters, lifecycle faults and capacity remain storage-port
        // refusals; only parsed verification DTO validation gets fixed 400.
        refusal = standaloneAuthRefusalError(kind, { refusal: 5, retryAfterSeconds: 0 });
        throw new AuthPersistenceError();
      }
      // Keep the original lifecycle/capacity fence at the reservation boundary
      // as well; copying input never authorizes dispatch into a closing owner.
      if (this.closing && !bindingUpdate || this.failed || this.exitConfirmed || this.accepted.size >= 256
        || this.acceptedBytes + Buffer.byteLength(body) > 32 * SQLITE_AUTH_COMMAND_BYTES) throw new AuthPersistenceError();
    } catch {
      // No dispatch occurred: capacity/closing/invalid input is a refusal,
      // not an unknown SQL write. Log only the fixed command number (0 for an
      // unknown name), never input, paths, token, exception text or getters.
      this.observeCommand(() => {
        const trace = this.diagnostics.start('auth-sqlite-command');
        trace.add('step', standaloneAuthCommandStep(kind)); trace.add('deferred', 1);
        trace.add('pending', this.accepted.size); trace.finish(true);
      });
      return Promise.reject(refusal ?? new AuthPersistenceError());
    }
    const size = Buffer.byteLength(body);
    this.acceptedBytes += size;
    // Reserve BOTH count and bytes before any diagnostic clock/sink can
    // reenter command() or close(). Start dispatch in the next microtask so
    // close snapshots include this original startup-waiting command too.
    const work = Promise.resolve().then(async () => {
      // Log boundaries only; never tokens, origins, IDs, SQL or error text.
      let trace: ReturnType<PerformanceDiagnostics['start']> | undefined;
      this.observeCommand(() => { trace = this.diagnostics.start('auth-sqlite-command'); });
      this.observeCommand(() => { trace?.add('step', standaloneAuthCommandStep(kind)); trace?.add('admitted', 1); });
      const warning = setTimeout(() => this.observeCommand(() => { trace?.reportPending({ pending: 1 }); }), this.warningMs); warning.unref();
      let failed = true;
      try {
        const value = await this.send(kind, body);
        if (epoch !== undefined) this.keyBinding.assertCurrent(epoch);
        failed = false; this.observeCommand(() => { trace?.add('settled', 1); });
        return value;
      } catch (error) {
        this.observeCommand(() => { trace?.add(standaloneAuthRefusal(kind, error) ? 'deferred' : 'unknown', 1); });
        throw error;
      } finally { clearTimeout(warning); this.observeCommand(() => { trace?.finish(failed); }); }
    });
    this.accepted.add(work);
    const release = () => { this.accepted.delete(work); this.acceptedBytes -= size; };
    void work.then(release, release);
    return work;
  }
  private observeCommand(action: () => void) {
    try { action(); } catch { /* Observation cannot dispatch, settle, release or replay the original command. */ }
  }
  close(): Promise<void> {
    if (this.closeWork) return this.closeWork;
    this.closing = true; // Freeze admission synchronously, before the first await.
    this.closeWork = (async () => {
      // Cover the whole original close, including an accepted command stuck
      // before its ACK or even before worker startup. Observation only; never
      // cancel, release or replay that command to make shutdown look complete.
      const warning = setTimeout(() => this.observeOwner(5), this.warningMs); warning.unref();
      try {
        await Promise.allSettled([...this.accepted, ...(this.keyBinding.pending ? [this.keyBinding.pending] : [])]);
        let failure = this.failed;
        if (!failure) {
          try { await this.send('close', '{}'); } catch { failure = true; }
        }
        // Cleanup only, after all original caller promises have settled. A
        // failed close dispatch/ACK needs the same cleanup as an earlier
        // transport failure. Never resend SQL, replace the owner or grant
        // business success from a physical termination request.
        if (failure || this.failed) this.requestOriginalStop();
        await this.exited;
        if (failure || this.failed || !this.closeAcknowledged) throw new AuthPersistenceError();
      } finally { clearTimeout(warning); }
    })();
    void this.closeWork.catch(() => {});
    return this.closeWork;
  }
  private requestOriginalStop() {
    if (this.exitConfirmed || !this.closing || !this.failed) return;
    this.originalStop.request();
  }
  /** Shutdown-only physical proof. NOT a successful SQL close, command receipt,
   * COMMIT claim, authorization decision or permission to replay business work. */
  async closeForShutdown(): Promise<void> {
    try { await this.close(); }
    catch {
      if (!this.closing || !this.exitConfirmed || this.pending.size || this.accepted.size || this.acceptedBytes) throw new AuthPersistenceError();
    }
  }

  /** Explicit shutdown-only retirement of THIS original owner, including a
   * stuck startup/command/close. Never called by a timeout or ordinary command
   * refusal. Freeze admission before yielding; retain the original close's
   * rejection and classify unacknowledged business work as unknown. This is
   * physical cleanup, NOT COMMIT/rollback proof, cancellation, permission to
   * retry, a successful SQL close or automatic replacement/reopen. Native SQL
   * can delay terminate: only the worker's real exit satisfies this promise. */
  retireForShutdown(): Promise<void> {
    if (this.retirementWork) return this.retirementWork;
    this.closing = true;
    // Reserve ownership before diagnostics can synchronously reenter us. Fail
    // the original transport waiters, not the original worker's SQL outcome.
    this.retirementWork = Promise.resolve().then(() => {
      if (!this.exitConfirmed) this.fail(11);
      return this.closeForShutdown();
    });
    void this.retirementWork.catch(() => {});
    return this.retirementWork;
  }
}
