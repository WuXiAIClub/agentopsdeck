import { types } from 'node:util';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

/** Close every exact owner before releasing same-process exclusion. An
 * uncertain close retains the whole lock group: opening a new same-process
 * descriptor could release an outstanding POSIX lock. Never unlink lock files.
 */
type LockOwner = { close(): void; readonly isOpen?: boolean };

/** These original lock callbacks are synchronous. Do not execute known async
 * replacements or read caller then/call accessors. A returned native Promise
 * is observed for rejection only, never late success or replay authority. */
function synchronousAcknowledgement(callback: () => void, receiver: unknown): boolean {
  if (types.isAsyncFunction(callback)) return false;
  const result: unknown = Reflect.apply(callback, receiver, []);
  if (result === undefined) return true;
  if (types.isPromise(result)) {
    try { void Promise.prototype.then.call(result, () => {}, () => {}); }
    catch { /* An unobservable native result remains unknown. */ }
  }
  return false;
}

export class UpdateLockCleanup {
  private readonly owners: { owner: LockOwner; closed: boolean; unknown: boolean }[];
  private active = false;
  private released = false;
  private releaseUnknown = false;
  constructor(owners: readonly LockOwner[], private readonly release: () => void,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {
    this.owners = owners.map(owner => ({ owner, closed: false, unknown: false }));
  }
  run(): boolean {
    // Install the fence before callbacks or diagnostics can reenter cleanup.
    if (this.active) return false;
    if (this.released) return true;
    this.active = true;
    const trace = this.diagnostics.start('update-lock-cleanup');
    let failed = false, uncertain = false;
    try {
      for (let index = this.owners.length - 1; index >= 0; index--) {
        const record = this.owners[index]!;
        if (record.closed) continue;
        if (record.unknown) { failed = true; trace.add('unknown', 1); continue; }
        try {
          record.closed = synchronousAcknowledgement(record.owner.close, record.owner);
          record.unknown = !record.closed;
          if (record.unknown) { failed = true; uncertain = true; trace.add('unknown', 1); }
        } catch {
          uncertain = true;
          trace.add('unknown', 1);
          // Exact private owner only. On older Node versions without isOpen,
          // absence cannot prove closure; retain and retry that original owner.
          try {
            if (!record.unknown && record.owner.isOpen === false) {
              record.closed = true; trace.add('recovered', 1);
            }
          } catch { /* An unavailable state probe is not closure evidence. */ }
          if (!record.closed) failed = true;
        }
      }
      if (!failed) {
        if (this.releaseUnknown) { failed = true; trace.add('unknown', 1); }
        else {
          // Unknown release effects cannot authorize repeating the callback.
          try {
            this.released = synchronousAcknowledgement(this.release, this);
            this.releaseUnknown = !this.released;
            if (this.released) trace.add('settled', 1);
          } catch { this.releaseUnknown = true; }
          if (this.releaseUnknown) {
            failed = true; uncertain = true; trace.add('unknown', 1);
          }
        }
      }
      trace.add('pending', this.owners.filter(record => !record.closed).length + Number(!this.released));
      // Even a subsequently proven lost ACK uses the failure log budget.
      trace.finish(failed || uncertain);
      return !failed;
    } finally { this.active = false; }
  }
}

export function closeUpdateLockOwners(owners: readonly LockOwner[], release: () => void,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics): boolean {
  return new UpdateLockCleanup(owners, release, diagnostics).run();
}

/** Retains exact owners after their original callback has quiesced. Recovery
 * retries closure only, never acquisition or the original business callback.
 * Cooldown limits retries; elapsed time alone never releases any path.
 */
export class UpdateLockRecovery {
  private readonly pending = new Map<string, { cleanup: UpdateLockCleanup; nextAttempt: number }>();
  constructor(private readonly clock: () => number = () => performance.now()) {}
  hasPending(): boolean { return this.pending.size > 0; }
  retain(keys: readonly string[], cleanup: UpdateLockCleanup): void {
    const entry = { cleanup, nextAttempt: this.clock() + 1000 };
    for (const key of keys) this.pending.set(key, entry);
  }
  recover(key: string): boolean {
    const entry = this.pending.get(key);
    if (!entry) return true;
    const now = this.clock();
    if (now < entry.nextAttempt) return false;
    entry.nextAttempt = now + 1000;
    if (!entry.cleanup.run()) return false;
    for (const [path, candidate] of this.pending) if (candidate === entry) this.pending.delete(path);
    return true;
  }
}
