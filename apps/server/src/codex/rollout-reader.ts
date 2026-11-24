import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { compactToolHistoryContent } from './tool-history-content.js';
import { rolloutToolOutputText, type IndexedToolOutput } from './indexed-tool-output.js';
import { TOOL_HISTORY_PREVIEW_CHARS } from '../messages/tool-summary.js';
import { RolloutProjection, RolloutProjectionBuilder } from './rollout-projection.js';
import { maxRolloutFileBytes } from './rollout-limits.js';
import { rolloutCachePolicy, type RolloutCachePolicy } from './rollout-cache-policy.js';
import { HistoryYield } from './history-yield.js';
import { RolloutLineBuffer } from './rollout-line-buffer.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

const chunkBytes = 1024 * 1024;
const maxFileBytes = maxRolloutFileBytes;
const maxLineBytes = 8 * 1024 * 1024;
const tailVerificationThresholdBytes = 16 * 1024 * 1024;
const tailVerificationWindows = [16 * 1024 * 1024, 64 * 1024 * 1024] as const;
const projectedRecordHints = ['"session_meta"', '"compacted"', '"turn_context"', '"response_item"',
  '"task_started"', '"token_count"', '"thread_settings_applied"', '"task_complete"'] as const;
// Only the legacy string adapter is capped here. Production streams leased
// disk-backed snapshots rather than allocating one history-sized string.
const maxProjectionBytes = 256 * 1024 * 1024;
type Snapshot = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
export type RolloutSourceVersion = Readonly<{ file: string; stat: Readonly<Snapshot>; complete: boolean }>;
type Cached = { stat: Snapshot; digest: string; projection: RolloutProjection; complete: boolean; touchedAt: number };
const same = (first: Snapshot, second: Snapshot) => first.dev === second.dev && first.ino === second.ino
  && first.size === second.size && first.mtimeMs === second.mtimeMs && first.ctimeMs === second.ctimeMs;
const grew = (first: Snapshot, second: Snapshot) => first.dev === second.dev && first.ino === second.ino
  && second.size > first.size && second.size <= maxFileBytes;

/** Live history can use a verified fixed prefix while the native writer appends.
 * Execution admission, terminal reconciliation and interrupted-tool recovery
 * MUST keep the default stable mode. A live prefix is not quiescence evidence.
 */
type ReadOptions = { consistency?: 'stable' | 'live-prefix' };
export class RolloutObservationPendingError extends Error {
  constructor() { super('Codex rollout read is still pending'); }
}
type InFlightRead = { promise: Promise<RolloutProjection>; consumers: number };
// Bound coordination metadata; overflow keeps the existing independent read
// path. This is not a global I/O admission limit or a queue of pending requests.
const maxSharedReads = 128;
const maxSharedConsumers = 64;

async function verifySnapshot(handle: FileHandle, before: Snapshot, expectedDigest: string, options: ReadOptions, onRead: (bytes: number) => void) {
  const after = await handle.stat();
  if (same(before, after)) return;
  if (options.consistency !== 'live-prefix' || !grew(before, after)) throw new Error('Rollout changed during read');
  // Growth alone does not prove append-only writes: compare EVERY byte in the
  // captured prefix. Never use head/tail samples or a timestamp heuristic.
  // Bound this second pass at the original EOF; do not chase a growing file.
  const buffer = Buffer.allocUnsafe(chunkBytes), digest = createHash('sha256');
  let position = 0;
  while (position < before.size) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(chunkBytes, before.size - position), position);
    if (!bytesRead) throw new Error('Rollout truncated during prefix verification');
    onRead(bytesRead);
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  const verified = await handle.stat();
  if ((!same(after, verified) && !grew(after, verified)) || digest.digest('hex') !== expectedDigest) {
    throw new Error('Rollout prefix changed during verification');
  }
}

function project(line: string, index?: { raw: Buffer; offset: number; stat: Snapshot }): string {
  if (!line.includes('\\u')) {
    let matched = false;
    for (const hint of projectedRecordHints) {
      if (line.includes(hint)) { matched = true; break; }
    }
    if (!matched) return '';
  }
  let row: any;
  try { row = JSON.parse(line); } catch { return ''; }
  const payload = row?.payload;
  if (row?.type === 'session_meta' || row?.type === 'compacted') return JSON.stringify({ type: row.type }) + '\n';
  // Model history also accepts legacy payload-tagged records. Streaming must
  // retain those facts, not silently narrow the existing reader's input forms.
  if (row?.type === 'turn_context' || payload?.type === 'turn_context') return JSON.stringify({ type: row.type, payload: { type: payload?.type, turn_id: payload?.turn_id, model: payload?.model } }) + '\n';
  if (row?.type === 'event_msg' || ['task_started', 'token_count', 'thread_settings_applied', 'task_complete'].includes(payload?.type)) {
    if (!['task_started', 'token_count', 'thread_settings_applied', 'task_complete'].includes(payload?.type)) return '';
    return JSON.stringify({ type: row.type, payload: { type: payload.type, turn_id: payload.turn_id,
      info: payload.info, thread_settings: payload.thread_settings, error: payload.error } }) + '\n';
  }
  if (row?.type !== 'response_item') return '';
  const result: Record<string, unknown> = { type: payload?.type, id: payload?.id, call_id: payload?.call_id };
  if (['custom_tool_call', 'function_call'].includes(payload?.type)) {
    Object.assign(result, { name: payload.name, status: payload.status, input: payload.input, arguments: payload.arguments });
  } else if (['custom_tool_call_output', 'function_call_output'].includes(payload?.type)) {
    const output = compactToolHistoryContent(payload.output);
    const text = index && typeof payload.call_id === 'string' ? rolloutToolOutputText(output) : undefined;
    // Thousands of ordinary 2–10KiB outputs dominate real long sessions too.
    // Index once the body exceeds twice the UI preview budget, leaving room
    // for reference metadata without inflating genuinely small records.
    if (index && text && text.length > TOOL_HISTORY_PREVIEW_CHARS * 2) {
      let lines = 1;
      for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) lines++;
      const detail: IndexedToolOutput = { preview: text.slice(0, TOOL_HISTORY_PREVIEW_CHARS), lines, reference: {
        offset: index.offset, bytes: index.raw.length, digest: createHash('sha256').update(index.raw).digest('hex'),
        dev: index.stat.dev, ino: index.stat.ino, callId: payload.call_id,
      } };
      result.agentopsdeckIndexedOutput = detail;
      // Preserve EXACTLY the execution guard's full-output predicate, not a
      // preview heuristic (leading whitespace can exceed the preview budget).
      // Output presence remains present even for non-string native outputs.
      result.output = typeof output === 'string' && /^\s*aborted by user(?:\s|$)/i.test(output) ? 'aborted by user' : null;
    } else result.output = output;
  }
  else if (payload?.type === 'message' && payload.role === 'assistant') {
    result.role = payload.role;
    result.content = Array.isArray(payload.content) ? payload.content.map((part: any) => ({ text: part?.text })) : [];
  }
  return JSON.stringify({ type: row.type, timestamp: row.timestamp, payload: result }) + '\n';
}

export class CodexRolloutReader {
  private readonly sourceVersions = new WeakMap<RolloutProjection, RolloutSourceVersion>();
  private cache = new Map<string, Cached>();
  private inFlight = new Map<string, InFlightRead>();
  // Sharing metadata does not cover opening/stat'ing descriptors or the
  // independent overflow path. Retain every admitted original read for close.
  private activeReads = new Set<Promise<RolloutProjection>>();
  // Retain the ORIGINAL read plus abandoned lease disposal after timeout.
  private snapshotWaits = new Map<Promise<unknown>, { file: string; expired: boolean }>();
  private closing: Promise<void> | undefined;
  private cleanupFailed = false;
  private cleanupFailure: unknown;
  private closed = false;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private idleCleanup: Promise<void> | undefined;
  private readonly policy: RolloutCachePolicy;
  private readonly maxConcurrentScans: number;
  private activeScans = 0;
  private scanWaiters: Array<() => void> = [];
  private readonly now: () => number;
  private counters = { hits: 0, misses: 0, evictions: 0, sourceBytesRead: 0, coalescedReads: 0, idleCleanupFailures: 0,
    prefixVerificationBytes: 0, prefixVerificationMs: 0, projectionRecords: 0, projectionMs: 0,
    snapshotVerificationBytes: 0, snapshotVerificationMs: 0 };
  private readonly recordRead = (bytes: number) => { this.counters.sourceBytesRead += bytes; };

  constructor(private readonly options: { indexToolOutputs?: boolean; projectionMemoryBytes?: number;
    maxConcurrentScans?: number;
    cachePolicy?: Partial<RolloutCachePolicy>; now?: () => number; diagnostics?: PerformanceDiagnostics;
    /** Internal benchmark/reference switch, not a deployment setting. */
    shareConcurrentReads?: boolean } = {}) {
    this.policy = rolloutCachePolicy(options.cachePolicy);
    this.maxConcurrentScans = options.maxConcurrentScans !== undefined
      ? Math.max(1, Math.floor(options.maxConcurrentScans))
      : Infinity;
    // Cache age is elapsed time, independent of wall-clock corrections.
    this.now = options.now ?? (() => performance.now());
  }

  /** Content-free, pull-only diagnostics. Budgets cover retained cache ownership,
   * not active leased snapshots, builder buffers or native history files. */
  cacheStats() {
    let memoryBytes = 0, diskBytes = 0;
    for (const entry of this.cache.values()) {
      memoryBytes += entry.projection.memoryBytes;
      diskBytes += entry.projection.bytes - entry.projection.memoryBytes;
    }
    return { ...this.counters, inFlightReads: this.inFlight.size, activeReadOperations: this.activeReads.size,
      activeScans: this.activeScans, queuedScans: this.scanWaiters.length,
      pendingSnapshotWaits: this.snapshotWaits.size,
      cleanupFailed: this.cleanupFailed,
      entries: this.cache.size, memoryBytes, diskBytes,
      idleExpiryScheduled: !!this.idleTimer, policy: { ...this.policy } };
  }

  sourceVersion(snapshot: RolloutProjection): RolloutSourceVersion | undefined {
    return this.sourceVersions.get(snapshot);
  }

  sourceUnchanged(version: RolloutSourceVersion, timeoutMs: number): Promise<boolean> {
    return this.observeWithin(version.file, timeoutMs, async () => {
      if (!version.complete) return false;
      const handle = await open(version.file, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => undefined);
      if (!handle) return false;
      try {
        const current = await handle.stat();
        return !this.closed && current.isFile() && same(version.stat, current);
      } finally { await this.cleanup(handle.close()); }
    }, async () => {});
  }

  private rememberSource(snapshot: RolloutProjection, version: RolloutSourceVersion): RolloutProjection {
    this.sourceVersions.set(snapshot, version);
    return snapshot;
  }

  private retainCleanupFailure(error: unknown) {
    if (!this.cleanupFailed) { this.cleanupFailed = true; this.cleanupFailure = error; }
  }

  private async cleanup<T>(original: Promise<T>): Promise<T> {
    try { return await original; }
    catch (error) { this.retainCleanupFailure(error); throw error; }
  }

  /** One unref'ed deadline per reader, not a filesystem scan or polling loop.
   * Hits can postpone expiry; the existing earlier deadline simply rechecks age.
   * No timer when empty, closed, or already releasing expired ownership. */
  private scheduleIdleExpiry() {
    if (this.closed || !this.cache.size) {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
      return;
    }
    if (this.idleTimer || this.idleCleanup) return;
    let deadline = Infinity;
    for (const entry of this.cache.values()) deadline = Math.min(deadline, entry.touchedAt + this.policy.maxIdleMs);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      this.idleCleanup = Promise.resolve().then(async () => {
        if (!this.closed) await this.trimCache();
      }).catch(() => {
        // Background disposal must not crash the Connector or leak a rejected
        // promise. Report a content-free diagnostic, never a native file path.
        this.counters.idleCleanupFailures++;
      }).finally(() => {
        this.idleCleanup = undefined;
        this.scheduleIdleExpiry();
      });
    }, Math.max(1, Math.ceil(deadline - this.now())));
    this.idleTimer.unref();
  }

  /** Cold eviction releases only cache ownership, never native history.
   * Active consumers own leases and stay readable after cache eviction. */
  private async trimCache() {
    const now = this.now();
    const { memoryBytes, diskBytes } = this.cacheStats();
    let memory = memoryBytes, disk = diskBytes;
    const retired: RolloutProjection[] = [];
    for (const [key, entry] of this.cache) {
      if (now - entry.touchedAt < this.policy.maxIdleMs && memory <= this.policy.maxMemoryBytes
        && disk <= this.policy.maxDiskBytes && this.cache.size <= this.policy.maxEntries) continue;
      // Remove synchronously before asynchronous close; another read must not
      // acquire an entry whose lease has already been retired.
      this.cache.delete(key); this.counters.evictions++;
      memory -= entry.projection.memoryBytes; disk -= entry.projection.bytes - entry.projection.memoryBytes;
      retired.push(entry.projection);
    }
    this.scheduleIdleExpiry();
    const results = await Promise.allSettled(retired.map(projection => this.cleanup(projection.dispose())));
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  /** Compatibility helper for bounded callers/tests. Production uses snapshots,
   * so the legacy string budget is no longer a history-read admission limit. */
  async read(value: unknown, options: ReadOptions = {}): Promise<string> {
    const projection = await this.readSnapshot(value, options);
    try {
      if (projection.bytes > maxProjectionBytes) throw Error('Rollout string projection budget exceeded; use readSnapshot');
      const rows: string[] = [];
      for await (const line of projection) rows.push(line + '\n');
      return rows.join('');
    } finally { await projection.dispose(); }
  }

  async validate(value: unknown, options: ReadOptions = {}) {
    const projection = await this.readSnapshot(value, options);
    await this.cleanup(projection.dispose());
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.scheduleIdleExpiry();
    while (this.scanWaiters.length) {
      this.activeScans++;
      this.scanWaiters.shift()!();
    }
    // Publish the original close before any diagnostic sink or cleanup can
    // reenter it. An elapsed deadline is never descriptor settlement proof.
    this.closing = Promise.resolve().then(async () => {
      const trace = (this.options.diagnostics ?? performanceDiagnostics).start('rollout-reader-close');
      trace.add('pending', this.activeReads.size);
      trace.reportPending({ pending: this.activeReads.size, records: this.cache.size });
      let failed = true;
      try {
        // Read failures are reported to their own callers. Still wait for ALL
        // read finally blocks, including duplicate handles and failed opens.
        await this.drainOriginalWaits();
        await this.idleCleanup;
        const entries = [...this.cache.values()]; this.cache.clear();
        const results = await Promise.allSettled(entries.map(entry => this.cleanup(entry.projection.dispose())));
        // Already delivered leases can retire while close is awaiting earlier
        // IO or cache cleanup. They are original ownership, not new admission;
        // drain the live registry again rather than trusting the first snapshot.
        await this.drainOriginalWaits();
        const failure = results.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        if (this.cleanupFailed) throw this.cleanupFailure;
        trace.add('settled', 1); failed = false;
      } finally { if (failed) trace.add('unknown', 1); trace.finish(failed); }
    });
    return this.closing;
  }

  private async drainOriginalWaits() {
    while (this.activeReads.size || this.snapshotWaits.size) {
      await Promise.allSettled([...this.activeReads, ...this.snapshotWaits.keys()]);
    }
  }

  readSnapshot(value: unknown, options: ReadOptions = {}): Promise<RolloutProjection> {
    if (this.closed) return Promise.reject(Error('Codex rollout reader closed'));
    // Register before invoking fallible/reentrant clocks, cache cleanup or IO.
    const original = Promise.resolve().then(() => this.readSnapshotOriginal(value, options));
    this.activeReads.add(original);
    const forget = () => { this.activeReads.delete(original); };
    original.then(forget, forget);
    return original;
  }

  /** Bound only the consumer wait, not original IO. Preserve healthy concurrent
   * reads; suppress retries only while an expired original for this path is
   * pending. Dispose a late undelivered lease before retirement.
   * No cancellation, reread, or execution unlock. Iterating a delivered
   * projection remains caller-owned and is not bounded by this method. */
  readSnapshotWithin(value: unknown, options: ReadOptions = {}, timeoutMs = 30_000): Promise<RolloutProjection> {
    return this.observeWithin(value, timeoutMs, () => this.readSnapshot(value, options),
      projection => this.cleanup(projection.dispose()));
  }

  /** Read and compute a pure projection under ONE observation budget. The
   * callback must not publish state or release execution protection. A timely
   * result transfers its original lease; an expired original retains its lease
   * through callback settlement and cleanup, without racing active iteration.
   * Further uses of a delivered lease remain caller-owned. */
  readProjectedSnapshotWithin<T>(value: unknown, options: ReadOptions, timeoutMs: number,
    project: (snapshot: RolloutProjection) => Promise<T>): Promise<{ snapshot: RolloutProjection; value: T }> {
    return this.observeWithin(value, timeoutMs, async expired => {
      const snapshot = await this.readSnapshot(value, options);
      try {
        // A read which arrived after its consumer deadline must not start new
        // optional enrichment work. Its lease still needs original cleanup.
        if (expired()) throw new RolloutObservationPendingError();
        return { snapshot, value: await project(snapshot) };
      } catch (error) {
        // Preserve the original projection failure even if disposal also
        // fails. cleanup() retains that second failure for reader.close().
        try { await this.cleanup(snapshot.dispose()); } catch { /* Retained. */ }
        throw error;
      }
    }, result => this.cleanup(result.snapshot.dispose()));
  }

  /** Observe a further pure read-only use of an already delivered lease.
   * Acquisition runs only after admission; the caller transfers ownership there.
   * Rejection before acquisition leaves the lease with the caller. Once acquired,
   * timeout retains original use and cleanup; timely success transfers it back.
   * The callback must check expiry around awaits and never publish/unlock. */
  observeLeasedProjectionWithin<T>(value: unknown, timeoutMs: number,
    acquire: () => RolloutProjection,
    project: (snapshot: RolloutProjection, expired: () => boolean) => Promise<T>): Promise<{ snapshot: RolloutProjection; value: T }> {
    return this.observeWithin(value, timeoutMs, async expired => {
      const snapshot = acquire();
      try {
        if (expired()) throw new RolloutObservationPendingError();
        return { snapshot, value: await project(snapshot, expired) };
      } catch (error) {
        try { await this.cleanup(snapshot.dispose()); } catch { /* Retained independently. */ }
        throw error;
      }
    }, result => this.cleanup(result.snapshot.dispose()));
  }

  /** Read-only proof which owns the entire original snapshot lifecycle. Unlike
   * the lease-transfer helpers, only the pure value is returned, AFTER original
   * disposal settles. The callback must not publish state; it must check the
   * expiration guard before starting additional native reads. A deadline does
   * not dispose an active iterator or permit a replacement proof for this path.
   * Failed proof and failed cleanup retain their independent original causes. */
  projectAndDisposeSnapshotWithin<T>(value: unknown, options: ReadOptions, timeoutMs: number,
    project: (snapshot: RolloutProjection, expired: () => boolean) => Promise<T>): Promise<T> {
    return this.observeWithin(value, timeoutMs, async expired => {
      const snapshot = await this.readSnapshot(value, options);
      let result: T;
      try {
        if (expired()) throw new RolloutObservationPendingError();
        result = await project(snapshot, expired);
      } catch (error) {
        try { await this.cleanup(snapshot.dispose()); } catch { /* Retained independently. */ }
        throw error;
      }
      await this.cleanup(snapshot.dispose());
      return result;
    }, async () => {});
  }

  /** Bounded tail verification for interrupted-dispatch / terminal cleanup
   * proofs on large uncached rollouts (> 16 MiB). Automatically falls back to
   * full snapshot verification whenever any target turn's start boundary is
   * not proven inside the tail window or when readSnapshot is customized. */
  projectTurnsAndDisposeWithin<T>(value: unknown, turnIds: readonly string[], timeoutMs: number,
    projectCallback: (snapshot: RolloutProjection, expired: () => boolean) => Promise<T>): Promise<T> {
    if (this.readSnapshot !== CodexRolloutReader.prototype.readSnapshot) {
      return this.projectAndDisposeSnapshotWithin(value, {}, timeoutMs, projectCallback);
    }
    return this.observeWithin(value, timeoutMs, async expired => {
      const snapshot = await this.readTurnTailOrFullSnapshot(value, turnIds);
      let result: T;
      try {
        if (expired()) throw new RolloutObservationPendingError();
        result = await projectCallback(snapshot, expired);
      } catch (error) {
        try { await this.cleanup(snapshot.dispose()); } catch { /* Retained independently. */ }
        throw error;
      }
      await this.cleanup(snapshot.dispose());
      return result;
    }, async () => {});
  }

  /** Validation owns its projection, so its deadline includes disposal too. */
  validateWithin(value: unknown, timeoutMs = 30_000, options: ReadOptions = {}): Promise<void> {
    return this.observeWithin(value, timeoutMs, () => this.validate(value, options), async () => {});
  }

  /** Retire an already delivered, no-longer-used lease under the remaining
   * caller budget. This is mandatory original cleanup, NOT new read admission.
   * Keep it in the same owner registry so timeout blocks replacement reads and
   * reader.close waits for the actual disposal, not just this observer. */
  disposeSnapshotWithin(value: unknown, snapshot: RolloutProjection, timeoutMs: number): Promise<void> {
    return this.observeWithin(value, timeoutMs, () => this.cleanup(snapshot.dispose()), async () => {}, true);
  }

  private observeWithin<T>(value: unknown, timeoutMs: number, read: (expired: () => boolean) => Promise<T>, disposeLate: (value: T) => Promise<void>, retiringLease = false): Promise<T> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
      return Promise.reject(Error('Invalid rollout observation deadline'));
    }
    if (this.closed && !retiringLease) return Promise.reject(Error('Codex rollout reader closed'));
    const file = typeof value === 'string' ? value.trim() : '';
    // An existing lease must still retire if read admission has since closed or
    // filled. No iterator/proof runs in this cleanup-only branch; the resource
    // was already admitted. Its retained wait also blocks further new reads.
    if (!retiringLease && ([...this.snapshotWaits.values()].some(wait => wait.file === file && wait.expired)
      || this.snapshotWaits.size >= 64)) {
      this.observeSnapshotWait(1, 'deferred');
      return Promise.reject(new RolloutObservationPendingError());
    }
    const wait = { file, expired: false };
    // Reserve before IO or a fallible/reentrant diagnostic sink.
    const original = Promise.resolve().then(async () => {
      let result: T;
      try { result = await read(() => wait.expired); }
      catch (error) {
        if (wait.expired) this.observeSnapshotWait(retiringLease ? 4 : 2, 'unknown');
        throw error;
      }
      if (!wait.expired) return result;
      try { await disposeLate(result); }
      catch (error) { this.observeSnapshotWait(retiringLease ? 4 : 2, 'unknown'); throw error; }
      this.observeSnapshotWait(retiringLease ? 4 : 2, 'settled');
      throw new RolloutObservationPendingError();
    });
    this.snapshotWaits.set(original, wait);
    const retire = () => { this.snapshotWaits.delete(original); };
    void original.then(retire, retire);
    return Promise.resolve().then(async () => {
      const trace = (this.options.diagnostics ?? performanceDiagnostics).start('rollout-snapshot-wait');
      trace.add('step', retiringLease ? 3 : 1); trace.add('pending', this.snapshotWaits.size);
      let timer: ReturnType<typeof setTimeout> | undefined, failed = true;
      try {
        const result = await Promise.race([original, new Promise<never>((_, reject) => {
          timer = setTimeout(() => { wait.expired = true; trace.add('timedOut', 1); reject(new RolloutObservationPendingError()); }, timeoutMs);
        })]);
        trace.add('settled', 1); failed = false; return result;
      } catch (error) { if (!wait.expired) trace.add('unknown', 1); throw error; }
      finally { clearTimeout(timer); trace.finish(failed); }
    });
  }

  private acquireScanSlot(): Promise<() => void> {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const next = this.scanWaiters.shift();
      if (next) next();
      else this.activeScans = Math.max(0, this.activeScans - 1);
    };
    if (this.closed || this.activeScans < this.maxConcurrentScans) {
      this.activeScans++;
      return Promise.resolve(release);
    }
    return new Promise<() => void>(resolve => {
      this.scanWaiters.push(() => resolve(release));
    });
  }

  private observeSnapshotWait(step: number, outcome: 'deferred' | 'unknown' | 'settled') {
    try {
      const trace = (this.options.diagnostics ?? performanceDiagnostics).start('rollout-snapshot-wait');
      trace.add('step', step); trace.add('pending', this.snapshotWaits.size); trace.add(outcome, 1);
      trace.finish(outcome !== 'settled');
    } catch { /* Observation never retires the original IO or its lease. */ }
  }

  private readTurnTailOrFullSnapshot(value: unknown, turnIds: readonly string[]): Promise<RolloutProjection> {
    if (this.closed) return Promise.reject(Error('Codex rollout reader closed'));
    const original = Promise.resolve().then(() => this.readTurnTailOrFullSnapshotOriginal(value, turnIds));
    this.activeReads.add(original);
    const forget = () => { this.activeReads.delete(original); };
    original.then(forget, forget);
    return original;
  }

  private async readTurnTailOrFullSnapshotOriginal(value: unknown, turnIds: readonly string[]): Promise<RolloutProjection> {
    if (this.closed) throw Error('Codex rollout reader closed');
    if (typeof value !== 'string' || !value.trim()) return new RolloutProjection([]);
    const file = value.trim();
    const targetIds = [...new Set(turnIds.map(id => id.trim()).filter(Boolean))];
    let handle: FileHandle | undefined = await open(file, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => {
      throw new Error('Codex rollout unavailable');
    });
    let before: Snapshot;
    try {
      const stat = await handle.stat();
      if (this.closed) throw Error('Codex rollout reader closed');
      if (!stat.isFile() || stat.size > maxFileBytes) throw new Error('Invalid rollout file or scan budget exceeded');
      before = stat;
    } catch (error) {
      await this.cleanup(handle.close());
      throw new Error(`Codex rollout unavailable: ${error instanceof Error ? error.message : 'read failed'}`);
    }
    const cached = this.cache.get(file);
    if (before.size <= tailVerificationThresholdBytes || (cached && same(before, cached.stat))) {
      await this.cleanup(handle.close());
      return this.readSnapshotOriginal(value, {});
    }
    let releaseScan: (() => void) | undefined;
    try {
      releaseScan = await this.acquireScanSlot();
      if (this.closed) throw Error('Codex rollout reader closed');
      const rechecked = this.cache.get(file);
      if (rechecked && same(before, rechecked.stat)) {
        releaseScan(); releaseScan = undefined;
        const closedHandle = handle; handle = undefined;
        await this.cleanup(closedHandle.close());
        return this.readSnapshotOriginal(value, {});
      }
      const buffer = Buffer.allocUnsafe(chunkBytes);
      for (const windowBytes of tailVerificationWindows) {
        if (windowBytes >= before.size) break;
        const tailProjection = await this.tryReadVerifiedTailWindow(handle, before, buffer, before.size - windowBytes, targetIds);
        if (tailProjection) {
          releaseScan(); releaseScan = undefined;
          const closedHandle = handle; handle = undefined;
          await this.cleanup(closedHandle.close()).catch(async error => {
            await this.cleanup(tailProjection.dispose()).catch(() => {});
            throw error;
          });
          return tailProjection;
        }
      }
    } finally {
      releaseScan?.();
      if (handle) await this.cleanup(handle.close());
    }
    return this.readSnapshotOriginal(value, {});
  }

  private async tryReadVerifiedTailWindow(handle: FileHandle, before: Snapshot, buffer: Buffer,
    startOffset: number, targetIds: readonly string[]): Promise<RolloutProjection | undefined> {
    const builder = new RolloutProjectionBuilder(this.options.projectionMemoryBytes);
    let result: RolloutProjection | undefined;
    try {
      const lines = new RolloutLineBuffer(maxLineBytes);
      const fairness = new HistoryYield();
      let position = startOffset;
      let discardedPartialHead = false;
      let sawSessionMeta = false;
      let sawPriorTurnRecord = false;
      const seenTurnIds = new Set<string>();
      const provenStartIds = new Set<string>();
      const targetSet = new Set(targetIds);
      const inspectRecord = async (raw: Buffer) => {
        if (raw.length > maxLineBytes) throw new Error('Rollout record budget exceeded');
        if (!discardedPartialHead) {
          discardedPartialHead = true;
          return;
        }
        const pause = fairness.checkpoint(raw.length);
        if (pause) await pause;
        if (!targetSet.size) return;
        const line = raw.toString('utf8');
        const projected = project(line);
        if (!projected) return;
        let parsed: any;
        try { parsed = JSON.parse(projected); } catch { return; }
        if (parsed?.type === 'session_meta') sawSessionMeta = true;
        const payload = parsed?.payload;
        const turnId = typeof payload?.turn_id === 'string' ? payload.turn_id.trim() : '';
        if (turnId) {
          if (!seenTurnIds.has(turnId)) {
            if (targetSet.has(turnId) && (sawSessionMeta || sawPriorTurnRecord || (parsed?.type === 'event_msg' && payload?.type === 'task_started'))) {
              provenStartIds.add(turnId);
            }
            seenTurnIds.add(turnId);
          } else if (targetSet.has(turnId) && parsed?.type === 'event_msg' && payload?.type === 'task_started') {
            provenStartIds.add(turnId);
          }
          sawPriorTurnRecord = true;
        }
        await builder.add(projected);
      };
      while (position < before.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(chunkBytes, before.size - position), position);
        if (!bytesRead) return undefined;
        this.recordRead(bytesRead);
        position += bytesRead;
        for (const raw of lines.push(buffer.subarray(0, bytesRead))) {
          await inspectRecord(raw);
        }
      }
      if (!discardedPartialHead || lines.finish().length > 0) return undefined;
      const after = await handle.stat();
      if (!same(before, after)) return undefined;
      for (const id of targetIds) {
        if (!provenStartIds.has(id)) return undefined;
      }
      result = await builder.finish();
      const returned = result;
      result = undefined;
      return returned;
    } finally {
      await this.cleanup(builder.abort());
      if (result) await this.cleanup(result.dispose());
    }
  }

  private async readSnapshotOriginal(value: unknown, options: ReadOptions): Promise<RolloutProjection> {
    if (this.closed) throw Error('Codex rollout reader closed');
    if (typeof value !== 'string' || !value.trim()) return new RolloutProjection([]);
    await this.trimCache();
    if (this.closed) throw Error('Codex rollout reader closed');
    const file = value.trim();
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => {
      throw new Error('Codex rollout unavailable');
    });
    let before: Snapshot;
    try {
      const stat = await handle.stat();
      if (this.closed) throw Error('Codex rollout reader closed');
      if (!stat.isFile() || stat.size > maxFileBytes) throw new Error('Invalid rollout file or scan budget exceeded');
      before = stat;
    } catch (error) {
      await this.cleanup(handle.close());
      throw new Error(`Codex rollout unavailable: ${error instanceof Error ? error.message : 'read failed'}`);
    }
    if (this.options.shareConcurrentReads === false) return this.readOpened(file, handle, before, options);
    // Each caller opens/stats the actual path. Never merge a replacement,
    // truncation, newly appended revision, or stable read with a live prefix.
    // No auth result is shared here: authorization stays in the caller/routes.
    const mode = options.consistency === 'live-prefix' ? 'live-prefix' : 'stable';
    const key = JSON.stringify([file, mode, before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs]);
    let shared = this.inFlight.get(key);
    if (shared && shared.consumers < maxSharedConsumers) {
      shared.consumers++;
      this.counters.coalescedReads++;
    } else if (!shared && this.inFlight.size < maxSharedReads) {
      shared = { promise: this.readOpened(file, handle, before, { consistency: mode }), consumers: 1 };
      this.inFlight.set(key, shared);
      // Remove settled work before allowing later callers to join. Keeping a
      // completed result here would bypass future native snapshot validation.
      const tracked = shared;
      const forget = () => { if (this.inFlight.get(key) === tracked) this.inFlight.delete(key); };
      shared.promise.then(forget, forget);
      return this.consumeShared(shared);
    } else {
      return this.readOpened(file, handle, before, { consistency: mode });
    }
    // Register the consumer before awaiting close; the producer may finish
    // while this duplicate descriptor is being closed.
    return this.consumeShared(shared, handle);
  }

  private async consumeShared(shared: InFlightRead, duplicateHandle?: FileHandle): Promise<RolloutProjection> {
    let projection: RolloutProjection | undefined;
    try {
      // Attach to the producer immediately, including when descriptor close is
      // slow/fails, so a rejected shared scan never becomes unhandled.
      const results = await Promise.allSettled([shared.promise, duplicateHandle ? this.cleanup(duplicateHandle.close()) : undefined]);
      if (results[0].status === 'rejected') throw results[0].reason;
      projection = results[0].value;
      if (results[1].status === 'rejected') throw results[1].reason;
      if (this.closed) throw Error('Codex rollout reader closed');
      const lease = projection.fork(), version = this.sourceVersions.get(projection);
      return version ? this.rememberSource(lease, version) : lease;
    } finally {
      shared.consumers--;
      if (!shared.consumers && projection) await this.cleanup(projection.dispose());
    }
  }

  private async readOpened(file: string, handle: FileHandle, before: Snapshot, options: ReadOptions): Promise<RolloutProjection> {
    const trace = (this.options.diagnostics ?? performanceDiagnostics).start('rollout-read');
    trace.add('fileBytes', before.size); trace.add('livePrefix', Number(options.consistency === 'live-prefix'));
    let failed = true;
    let projectedRecords = 0, projectionMs = 0;
    // Local metrics, not differences of process counters: overlapping reads
    // must not charge another session's bytes or verification time to this one.
    const read = (bytes: number) => { this.recordRead(bytes); trace.add('sourceBytes', bytes); };
    const verify = async (digest: string) => {
      const at = performance.now();
      try { await verifySnapshot(handle, before, digest, options, bytes => {
        read(bytes); this.counters.snapshotVerificationBytes += bytes; trace.add('snapshotBytes', bytes);
      }); }
      finally {
        const elapsed = performance.now() - at;
        this.counters.snapshotVerificationMs += elapsed; trace.add('snapshotVerificationMs', elapsed);
      }
    };
    let prefix: RolloutProjection | undefined;
    let result: RolloutProjection | undefined;
    let returned: RolloutProjection | undefined;
    let observedCache: Cached | undefined;
    let releaseScan: (() => void) | undefined;
    const builder = new RolloutProjectionBuilder(this.options.projectionMemoryBytes);
    try {
      releaseScan = await this.acquireScanSlot();
      if (this.closed) throw Error('Codex rollout reader closed');
      const cached = this.cache.get(file);
      observedCache = cached;
      if (cached) prefix = cached.projection.fork();
      if (cached && same(before, cached.stat)) {
        trace.add('cacheHit', 1);
        await verify(cached.digest);
        if (this.closed) throw Error('Codex rollout reader closed');
        // An overlapping refresh may have replaced the entry while checking.
        this.counters.hits++;
        if (this.cache.get(file) === cached) { cached.touchedAt = this.now(); this.cache.delete(file); this.cache.set(file, cached); }
        returned = this.rememberSource(prefix!.fork(), Object.freeze({ file, stat: Object.freeze({
          dev: before.dev, ino: before.ino, size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs,
        }), complete: cached.complete }));
        failed = false; return returned;
      }
      this.counters.misses++;
      const buffer = Buffer.allocUnsafe(chunkBytes);
      const digest = createHash('sha256');
      let position = 0;
      let reusePrefix = false;
      if (cached?.complete && before.dev === cached.stat.dev && before.ino === cached.stat.ino && before.size > cached.stat.size) {
        const verificationStarted = performance.now();
        try {
          while (position < cached.stat.size) {
            const { bytesRead } = await handle.read(buffer, 0, Math.min(chunkBytes, cached.stat.size - position), position);
            if (!bytesRead) throw new Error('Rollout truncated during read');
            read(bytesRead); trace.add('prefixBytes', bytesRead);
            this.counters.prefixVerificationBytes += bytesRead;
            digest.update(buffer.subarray(0, bytesRead));
            position += bytesRead;
          }
          if (digest.copy().digest('hex') === cached.digest) {
            reusePrefix = true; trace.add('reusedPrefix', 1);
          } else {
            throw new Error('Rollout prefix changed; retry with a fresh snapshot');
          }
        } finally {
          const elapsed = performance.now() - verificationStarted;
          this.counters.prefixVerificationMs += elapsed; trace.add('prefixVerificationMs', elapsed);
        }
      }
      const lines = new RolloutLineBuffer(maxLineBytes);
      let lineOffset = position;
      let complete = true;
      const fairness = new HistoryYield();
      const retain = async (raw: Buffer) => {
        if (raw.length > maxLineBytes) throw new Error('Rollout record budget exceeded');
        const pause = fairness.checkpoint(raw.length);
        if (pause) await pause;
        const started = performance.now();
        let projected: string;
        try { projected = project(raw.toString('utf8'), this.options.indexToolOutputs ? { raw, offset: lineOffset, stat: before } : undefined); }
        finally {
          const elapsed = performance.now() - started;
          this.counters.projectionRecords++; this.counters.projectionMs += elapsed;
          projectedRecords++; projectionMs += elapsed;
        }
        await builder.add(projected);
      };
      while (position < before.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(chunkBytes, before.size - position), position);
        if (!bytesRead) throw new Error('Rollout truncated during read');
        read(bytesRead);
        const chunk = buffer.subarray(0, bytesRead);
        digest.update(chunk);
        position += bytesRead;
        // Keep byte positions exact across UTF-8 boundaries, CRLF and even an
        // invalid UTF-8 record. References address original bytes, not a
        // re-encoded JavaScript string.
        for (const raw of lines.push(chunk)) {
          await retain(raw);
          lineOffset += raw.length + 1;
        }
      }
      const pending = lines.finish();
      if (pending.length) { await retain(pending); complete = false; }
      const hash = digest.digest('hex');
      await verify(hash);
      result = await builder.finish();
      if (reusePrefix && prefix) {
        const tail = result; result = prefix.append(tail); await tail.dispose();
      }
      // Bound segment metadata after many tiny appends without rewriting the
      // projected prefix on every poll. Compaction is asynchronous and bounded.
      if (result.segments > 64) {
        const compact = new RolloutProjectionBuilder(this.options.projectionMemoryBytes);
        try {
          for await (const line of result) await compact.add(line + '\n');
          const previous = result; result = await compact.finish(); await previous.dispose();
        } finally { await compact.abort(); }
      }
      if (this.closed) throw Error('Codex rollout reader closed');
      const previous = this.cache.get(file); this.cache.delete(file);
      this.cache.set(file, { stat: before, digest: hash, projection: result.fork(), complete, touchedAt: this.now() });
      if (previous) await this.cleanup(previous.projection.dispose());
      await this.trimCache();
      returned = this.rememberSource(result, Object.freeze({ file, stat: Object.freeze({
        dev: before.dev, ino: before.ino, size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs,
      }), complete }));
      result = undefined; failed = false; return returned;
    } catch (error) {
      // A failed overlapping read must not evict a newer verified snapshot.
      if (this.cache.get(file) === observedCache) {
        this.cache.delete(file);
        this.scheduleIdleExpiry();
        if (observedCache) await this.cleanup(observedCache.projection.dispose());
      }
      throw new Error(`Codex rollout unavailable: ${error instanceof Error ? error.message : 'read failed'}`);
    } finally {
      releaseScan?.();
      try {
        const results = await Promise.allSettled([this.cleanup(handle.close()), this.cleanup(builder.abort()),
          prefix ? this.cleanup(prefix.dispose()) : undefined, result ? this.cleanup(result.dispose()) : undefined]);
        const failure = results.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') {
          // A finally failure prevents delivery of the returned snapshot. Its
          // lease still belongs here, not to a caller that never receives it.
          // Preserve the original cleanup error, after retiring that lease.
          if (returned) await this.cleanup(returned.dispose()).catch(() => {});
          throw failure.reason;
        }
      }
      catch (error) { failed = true; throw error; }
      finally {
        if (projectedRecords) { trace.add('records', projectedRecords); trace.add('projectionMs', projectionMs); }
        trace.finish(failed);
      }
    }
  }
}
