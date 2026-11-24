import { types } from 'node:util';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

// Ingress backpressure drains at half these bounds. Keep the hard veto small:
// a larger queue hides a stalled physical observer rather than settling it.
const MAX_PENDING = 128;
const MAX_BYTES = 8 * 1024 * 1024;
// Unknown methods are effects, not implicitly safe reads. An exact interrupt
// retains its original run/connection proof and must remain usable for recovery.
const UNFENCED_METHODS = new Set(['initialize', 'thread/loaded/list', 'thread/read', 'thread/list',
  'thread/backgroundTerminals/list', 'thread/goal/get', 'skills/list', 'model/list', 'turn/interrupt', 'thread/unsubscribe']);
export const codexRpcNeedsObservationBarrier = (method: string) => !UNFENCED_METHODS.has(method);

/** Owns physical notification/connection settlement, not native execution.
 * Ingress invalidation stays synchronous in the producer. SQL transactions
 * stay inside the supplied observer; neither callbacks nor authorization
 * snapshots cross a worker boundary here. */
export class CodexNativeObservations {
  private tail: Promise<void> | undefined;
  private pending = 0;
  private bytes = 0;
  private failed = false;
  private closed = false;
  private closing: Promise<void> | undefined;
  private ingress = 0;
  private textTail: { key: string; append(text: string, bytes: number, maxChars?: number): number } | undefined;

  constructor(private readonly options: { unavailable(): void; diagnostics?: PerformanceDiagnostics }) {
    if (typeof options.unavailable !== 'function') throw new TypeError('Codex observation veto required');
  }

  status() { return { pending: this.pending, bytes: this.bytes, failed: this.failed, closed: this.closed }; }

  holdIngress(): () => void {
    this.ingress++;
    let released = false;
    return () => { if (!released) { released = true; this.ingress--; } };
  }

  pressure(): Promise<void> | undefined {
    return this.pending >= MAX_PENDING / 2 || this.bytes >= MAX_BYTES / 2 ? this.drain() : undefined;
  }

  /** Original synchronous handlers still run immediately if the lane is idle.
   * Async handlers and reentrant ingress are serialized behind the physical
   * result, never behind an HTTP waiter or a timeout wrapper. */
  accept(work: () => unknown, bytes: number, step: 1 | 2): boolean {
    this.textTail = undefined;
    return this.enqueue(work, () => bytes, step);
  }

  acceptText(key: string, text: string, bytes: number, work: (text: string) => unknown, maxChars?: number): boolean {
    if (this.closed || this.failed) return false;
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_BYTES - this.bytes) {
      this.unavailable(3); return false;
    }
    if (this.textTail?.key === key) {
      const deltaBytes = this.textTail.append(text, bytes, maxChars);
      if (deltaBytes > MAX_BYTES - this.bytes) {
        this.unavailable(3); return false;
      }
      this.bytes += deltaBytes;
      return true;
    }
    let combined = maxChars && text.length > maxChars ? text.slice(-maxChars) : text;
    let ownedBytes = bytes;
    const batch = {
      key,
      append(delta: string, size: number, cap?: number) {
        if (cap && cap > 0) {
          combined = delta.length >= cap ? delta.slice(-cap) : `${combined}${delta}`.slice(-cap);
          const nextBytes = Math.min(ownedBytes + size, Buffer.byteLength(combined) + 512);
          const diff = nextBytes - ownedBytes;
          ownedBytes = nextBytes;
          return diff;
        }
        combined += delta;
        ownedBytes += size;
        return size;
      },
    };
    this.textTail = batch;
    return this.enqueue(() => {
      if (this.textTail === batch) this.textTail = undefined;
      return work(combined);
    }, () => ownedBytes, 1);
  }

  private enqueue(work: () => unknown, retainedBytes: () => number, step: 1 | 2): boolean {
    const bytes = retainedBytes();
    if (this.closed || this.failed) return false;
    if (!Number.isSafeInteger(bytes) || bytes < 0 || this.pending >= MAX_PENDING || bytes > MAX_BYTES - this.bytes) {
      this.unavailable(3); return false;
    }
    const previous = this.tail;
    let complete!: () => void;
    const task = new Promise<void>(resolve => { complete = resolve; });
    this.tail = task;
    this.pending++; this.bytes += bytes;
    const run = () => {
      const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'codex-native-observation');
      trace.add('step', step); trace.add('pending', this.pending); trace.add('sourceBytes', retainedBytes());
      let settled = false;
      const finish = (failed: boolean) => {
        if (settled) return;
        settled = true;
        if (failed) this.unavailable(step);
        this.pending--; this.bytes -= retainedBytes();
        if (this.tail === task) this.tail = undefined;
        trace.finish(failed);
        complete();
      };
      // Already accepted, not-yet-started observations cannot mutate authority
      // after a sibling failed. The original in-flight Promise still drains.
      if (this.failed) { finish(true); return; }
      try {
        const result = work();
        if (types.isPromise(result)) {
          // Physical ownership cannot depend on an overridden public .then.
          void Promise.prototype.then.call(result, () => finish(false), () => finish(true));
          return;
        }
        if (result !== null && (typeof result === 'object' || typeof result === 'function')) {
          const then = (result as { then?: unknown }).then;
          if (typeof then === 'function') {
            // Read then once and assimilate even foreign thenables. Both
            // rejection and a throwing getter stay in this owner's lane.
            const physical = new Promise<unknown>((resolve, reject) => { then.call(result, resolve, reject); });
            void physical.then(() => finish(false), () => finish(true));
            return;
          }
        }
        finish(false);
      } catch { finish(true); }
    };
    if (previous) void previous.then(run);
    else run();
    return true;
  }

  /** Latches only a local veto. Never retires a durable unknown or replays work. */
  unavailable(step: 1 | 2 | 3) {
    if (this.failed) return;
    this.failed = true;
    this.textTail = undefined;
    const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'codex-native-observation');
    trace.add('step', step); trace.add('pending', this.pending); trace.add('sourceBytes', this.bytes); trace.finish(true);
    try { this.options.unavailable(); } catch { /* The local veto remains latched. */ }
  }

  drain(): Promise<void> { return this.tail ?? Promise.resolve(); }

  assertEffectAllowed() {
    if (this.closed || this.failed || this.pending || this.ingress) throw new Error('Codex observations unavailable or pending');
  }

  /** Finite snapshot: a continuously running Goal cannot keep extending the
   * wait. If more observations arrived, refuse this effect instead. */
  async beforeEffect() {
    if (this.closed || this.failed) this.assertEffectAllowed();
    await this.drain();
    this.assertEffectAllowed();
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.textTail = undefined;
      this.closing = this.drain();
    }
    return this.closing;
  }
}
