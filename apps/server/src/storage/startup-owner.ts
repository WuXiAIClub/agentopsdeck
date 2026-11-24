import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, win32 } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { connectionRecoverySnapshot, recoverableConnection, retireConnection, StorageConnectionUnavailable } from './connection-recovery.js';

type OwnerKey = { path: string | symbol; inode?: string; lexical?: string };
type PendingOwner = { db: DatabaseSync; key: OwnerKey; closing: boolean; nextAttempt: number };
const sameOwner = (first: OwnerKey, second: OwnerKey) => first.path === second.path
  || (first.lexical !== undefined && first.lexical === second.lexical)
  || (first.inode !== undefined && first.inode === second.inode);

/** Conservative acquisition identity only, not a file name to open. Windows
 * aliases must be fenced even before SQLite creates the file/inode. Folding
 * can refuse distinct files on case-sensitive Windows volumes; it must never
 * authorize a second owner. This policy is not an ACL or native host proof. */
export function startupOwnerPathKey(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return path;
  const normalized = win32.normalize(path).toLowerCase();
  // Ordinary and extended drive/UNC spellings can identify the same file
  // before an inode exists. Fold only the reservation key, never the path
  // passed to SQLite. Do not flatten volume/device namespaces.
  if (normalized.startsWith("\\\\?\\") && /^[a-z]:\\/.test(normalized.slice(4))) return normalized.slice(4);
  if (normalized.startsWith("\\\\?\\unc\\") && /^[^\\]+\\[^\\]+(?:\\|$)/.test(normalized.slice(8))) {
    return '\\\\' + normalized.slice(8);
  }
  return normalized;
}

/** Failed construction has no returned owner to close. Retain its exact handle
 * until closure is confirmed, instead of reopening a second owner over a leaked
 * transaction/EXCLUSIVE lock. This is synchronous startup cleanup, not async SQL.
 * Only a later construction request can retry cleanup, never the original body.
 * A clock permits another close attempt; it never proves closure or unlocks.
 */
export class StartupDatabaseOwners {
  private readonly keys = new WeakMap<DatabaseSync, OwnerKey>();
  private readonly pending = new Set<PendingOwner>();
  private readonly live = new Map<DatabaseSync, OwnerKey>();
  private readonly exclusive = new Set<{ key: OwnerKey; file: string }>();
  private readonly acquiring = new Set<{ key: OwnerKey; file: string }>();
  private observingRefusal = false;
  constructor(private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics,
    private readonly clock: () => number = () => performance.now(),
    private readonly create: (file: string) => DatabaseSync = file => new DatabaseSync(file),
    private readonly platform: NodeJS.Platform = process.platform) {}

  private key(file: string): OwnerKey {
    if (file === ':memory:') return { path: Symbol('private-memory-owner') };
    const lexical = startupOwnerPathKey(resolve(file), this.platform);
    try {
      const path = realpathSync(file), identity = statSync(path, { bigint: true });
      return { path: startupOwnerPathKey(path, this.platform), inode: `${identity.dev}:${identity.ino}`, lexical };
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const absolute = resolve(file);
      let ancestor = dirname(absolute);
      const missing = [basename(absolute)];
      for (;;) {
        try { return { path: startupOwnerPathKey(join(realpathSync(ancestor), ...missing), this.platform), lexical }; }
        catch (failure) {
          if ((failure as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) throw failure;
          missing.unshift(basename(ancestor)); ancestor = dirname(ancestor);
        }
      }
    }
  }
  private checkAcquiring(key: OwnerKey): void {
    for (const active of this.acquiring) {
      if (sameOwner(active.key, key)) this.refuse(1);
      if (active.key.inode === undefined && active.file !== ':memory:') {
        try { const inode = this.key(active.file).inode; if (inode !== undefined) active.key.inode = inode; } catch { this.refuse(1); }
        if (sameOwner(active.key, key)) this.refuse(1);
      }
    }
  }
  private checkExclusive(key: OwnerKey): void {
    for (const owner of this.exclusive) {
      // Retain the original pathname fence and any learned inode even when the
      // pathname is replaced. A clock, close ACK or terminate promise is not exit.
      if (owner.key.inode === undefined && owner.file !== ':memory:') {
        try { const inode = this.key(owner.file).inode; if (inode !== undefined) owner.key.inode = inode; } catch { this.refuse(5); }
      }
      if (sameOwner(owner.key, key)) this.refuse(5);
    }
  }
  private cleanupMatching(key: OwnerKey): void {
    const matching = () => [...this.pending].filter(owner => sameOwner(owner.key, key)
      || (typeof owner.key.path === 'string' && owner.key.inode === undefined));
    for (const owner of matching()) {
      if (owner.closing) this.refuse(2);
      this.cleanup(owner);
    }
    if (matching().length) this.refuse(3);
  }
  /** In-process mixed-owner admission only, not an interprocess file lock.
   * Legacy synchronous connections may coexist; an async worker must own the
   * file exclusively until its original native exit is confirmed by its caller. */
  reserveExclusive(file: string): () => void {
    file = file === ':memory:' ? file : resolve(file);
    const key = this.key(file);
    this.checkAcquiring(key);
    const acquisition = { key, file };
    this.acquiring.add(acquisition);
    try {
      this.checkExclusive(key);
      this.cleanupMatching(key);
      for (const [db, ownerKey] of this.live) {
        if (connectionRecoverySnapshot(db).state === 'closed') { this.live.delete(db); continue; }
        if (sameOwner(ownerKey, key) || (typeof ownerKey.path === 'string' && ownerKey.inode === undefined)) this.refuse(6);
      }
      const owner = { key, file };
      this.exclusive.add(owner);
      return () => { this.exclusive.delete(owner); };
    } finally { this.acquiring.delete(acquisition); }
  }
  open(file: string): DatabaseSync {
    file = file === ':memory:' ? file : resolve(file);
    const key = this.key(file);
    // Diagnostic callbacks are not acquisition authority. Keep this fence
    // through cleanup's final observation and creation, not merely native close.
    this.checkAcquiring(key);
    const acquisition = { key, file };
    this.acquiring.add(acquisition);
    try {
      // If post-create identity failed, the retained handle may belong to ANY
      // physical alias. Refreshing its old pathname cannot prove that handle's
      // identity (the file may have been replaced). Only original native close
      // can settle it; meanwhile conservatively fence every file acquisition.
      // Private :memory: symbols never alias a filesystem owner.
      this.checkExclusive(key);
      this.cleanupMatching(key);
      for (const [db] of this.live) if (connectionRecoverySnapshot(db).state === 'closed') this.live.delete(db);
      // Bound further acquisition, never evict a still-open failed owner.
      if (this.pending.size >= 128) this.refuse(4);
      const db = recoverableConnection(this.create(file), this.diagnostics, this.clock);
      this.keys.set(db, key);
      this.live.set(db, key);
      // Files first created by SQLite acquire their physical identity here. stat
      // does not open/close an extra descriptor which could release POSIX locks.
      try { const inode = this.key(file).inode; if (inode !== undefined) key.inode = inode; }
      catch (error) { this.abandon(db); throw error; }
      return db;
    } finally { this.acquiring.delete(acquisition); }
  }
  private refuse(step: 1 | 2 | 3 | 4 | 5 | 6): never {
    // Both the sink and diagnostic clock can reenter acquisition. Preserve
    // the existing fence, and never recursively observe the same refusal.
    if (!this.observingRefusal) {
      this.observingRefusal = true;
      try {
        const trace = this.diagnostics.start(step >= 5 ? 'storage-startup-admission' : 'storage-startup-owner');
        trace.add('step', step); trace.add('deferred', 1);
        trace.add('pending', this.pending.size); trace.add('unknown', 1);
        trace.finish(true);
      } catch { /* Observation cannot release or authorize an owner. */ }
      finally { this.observingRefusal = false; }
    }
    throw new StorageConnectionUnavailable();
  }
  abandon(db: DatabaseSync): void {
    const key = this.keys.get(db);
    if (key === undefined) throw Error('Startup cleanup requires its original owner');
    if (connectionRecoverySnapshot(db).state === 'closed') return;
    let owner = [...this.pending].find(entry => entry.db === db);
    if (!owner) { owner = { db, key, closing: false, nextAttempt: -Infinity }; this.pending.add(owner); }
    // A failed constructor cannot retain SQL admission just because its clock
    // throws or returns an unusable sample. Keep the original close-only fence.
    retireConnection(db);
    this.cleanup(owner);
  }
  private cleanup(owner: PendingOwner): void {
    if (owner.closing) return;
    owner.closing = true;
    try {
      let now: unknown;
      try { now = this.clock(); } catch { /* Observation failure is not closure authority. */ }
      if (typeof now !== 'number' || !Number.isFinite(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - 1000) {
        const trace = guardedTrace(this.diagnostics, 'storage-startup-cleanup');
        trace.add('deferred', 1); trace.add('classificationUnknown', 1); trace.add('unknown', 1);
        trace.finish(true);
        return;
      }
      if (now < owner.nextAttempt) return;
      owner.nextAttempt = now + 1000;
      const trace = guardedTrace(this.diagnostics, 'storage-startup-cleanup');
      let failed = true;
      try {
        try { owner.db.close(); }
        catch { /* Preserve the original construction failure, not close text. */ }
        if (connectionRecoverySnapshot(owner.db).state !== 'closed') { trace.add('unknown', 1); return; }
        this.pending.delete(owner);
        trace.add('settled', 1); failed = false;
      } finally { trace.finish(failed); }
    } finally { owner.closing = false; }
  }
}

export const startupDatabaseOwners = new StartupDatabaseOwners();
