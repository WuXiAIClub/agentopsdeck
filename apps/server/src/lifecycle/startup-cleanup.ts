import { createShutdownCleanup, type ShutdownCleanup } from './shutdown-cleanup.js';
import { StorageConnectionUnavailable } from '../storage/connection-recovery.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';

type CleanupOwner = { close: ShutdownCleanup; nextAttempt: number; attempting: boolean; observation?: Promise<void> };
export type StartupOwnership = {
  drains: (() => void | Promise<void>)[];
  cleanups: (() => void | Promise<void>)[];
  failed: boolean;
};

/** A synchronous failed application constructor cannot return its resource
 * owners. Retain exact cleanup callbacks until drain/cleanup ACK, and fence new
 * construction while any result is unknown. No automatic construction replay,
 * timer-based unlock or re-running a failed drain. This is process-startup-only;
 * already returned applications are never selected or closed by this registry.
 */
export class StartupApplicationCleanup {
  private readonly pending = new Set<CleanupOwner>();
  constructor(private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics,
    private readonly clock: () => number = () => performance.now()) {}

  assertAvailable(): void {
    this.retryKnownCleanup();
    if (this.pending.size) throw new StorageConnectionUnavailable();
  }

  snapshot() {
    const owners = [...this.pending].map(owner => ({ ...owner.close.snapshot(), observing: owner.attempting }));
    return Object.freeze({ pending: owners.filter(owner => owner.observing || owner.state !== 'closed').length,
      retryable: owners.filter(owner => !owner.observing && !owner.active && owner.state === 'cleanup-required').length });
  }

  /** Process shutdown may retry only original cleanup, never construction or a
   * failed drain. Await the current attempts rather than falsely ACKing them. */
  closeRetainedOwners(): Promise<void> {
    this.retryKnownCleanup();
    return this.waitForCurrentCleanup();
  }

  private retryKnownCleanup(): void {
    for (const owner of this.pending) {
      // Include admission clocks and final diagnostics in the retained attempt.
      // Neither callback may recurse into another retry or release this owner.
      if (owner.attempting) continue;
      const snapshot = owner.close.snapshot();
      if (snapshot.state === 'closed') { this.pending.delete(owner); continue; }
      // Only unacknowledged cleanup can be retried, not a failed/pending drain.
      if (!snapshot.active && snapshot.state === 'cleanup-required') this.attempt(owner, true);
    }
  }

  /** Observe the already running attempts, without retry, timeout or release.
   * A still-unknown result fails closed; this does not prove business recovery.
   */
  async waitForCurrentCleanup(): Promise<void> {
    await Promise.all([...this.pending].map(owner => owner.observation ?? Promise.reject(new StorageConnectionUnavailable())));
    if (this.pending.size) throw new StorageConnectionUnavailable();
  }

  abandon(drains: readonly (() => void | Promise<void>)[], cleanups: readonly (() => void | Promise<void>)[]): void {
    if (!drains.length && !cleanups.length) return;
    const drainSteps = [...drains];
    const close = createShutdownCleanup(async () => {
      // Invoke every stop/drain before yielding, even if an earlier one throws.
      const results = await Promise.allSettled(drainSteps.map(step => {
        try { return Promise.resolve(step()); } catch (error) { return Promise.reject(error); }
      }));
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    }, [...cleanups].reverse(), this.diagnostics, { stopAfterFailure: true });
    const owner: CleanupOwner = { close, nextAttempt: -Infinity, attempting: false };
    this.pending.add(owner); // Fence reentry before starting any stop/log callback.
    this.attempt(owner);
  }

  private attempt(owner: CleanupOwner, retry = false): void {
    if (owner.attempting) return;
    owner.attempting = true;
    let settleObservation!: () => void;
    // Publish before every observable callback, not just before native close.
    owner.observation = new Promise<void>(resolve => { settleObservation = resolve; });
    let now: number | undefined;
    try { const sample = this.clock(); if (Number.isFinite(sample)) now = sample; }
    catch { /* A broken clock cannot strand the initial original drain. */ }
    if (retry && (now === undefined || now < owner.nextAttempt)) {
      owner.attempting = false; settleObservation(); return;
    }
    if (now !== undefined) owner.nextAttempt = now + 1000;
    const trace = guardedTrace(this.diagnostics, 'storage-startup-cleanup');
    // The returned close promise owns all failure state and exact callbacks.
    // Secondary cleanup errors never replace the original construction error.
    const observe = (acknowledged: boolean) => {
      const closed = acknowledged && owner.close.snapshot().state === 'closed';
      try { trace.add(closed ? 'settled' : 'unknown', 1); trace.finish(!closed); }
      finally {
        // Finish/sink reentry still sees the original retained owner. Only then
        // can a later independent construction observe successful closure.
        if (closed) this.pending.delete(owner);
        owner.attempting = false; settleObservation();
      }
    };
    void owner.close().then(() => observe(true), () => observe(false));
  }
}

export const startupApplicationCleanup = new StartupApplicationCleanup();
