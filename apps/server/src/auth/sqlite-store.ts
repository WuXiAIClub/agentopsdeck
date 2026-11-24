import { constants, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { AuthPersistenceError } from './private-store.js';
import { SqlitePasskeys } from './sqlite-passkeys.js';
import { startupDatabaseOwners } from '../storage/startup-owner.js';
import { connectionRecoverySnapshot, requireConnectionReady } from '../storage/connection-recovery.js';
import { AsyncSqliteAuthDisplay } from './async-sqlite-display.js';
import type { AuthPasskeyStore } from './route-persistence.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';
import { synchronousSqliteIdentity } from './synchronous-sqlite-value.js';
import { assertPrivateSqlitePath } from '../storage/private-sqlite-path.js';
import { reportSqliteAuthOwnerFailure } from './sqlite-owner-diagnostics.js';

/** Opt-in, same-host store. The private directory is an operator-owned security
 * boundary; POSIX owner/mode or Windows native SID/ACL checks are mandatory.
 * Never silently dual-write/import a live JSON store. Offline migration must move
 * the old files out of the configured paths before the new runtime is enabled. */
export function openSqliteAuth(file: string, legacyFiles: string[], currentKey: () => string | undefined) {
  let db: DatabaseSync | undefined;
  try {
    if (legacyFiles.some(path => existsSync(path))) throw new AuthPersistenceError();
    const absolute = resolve(file), dir = dirname(absolute);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    assertPrivateSqlitePath(dir, true);
    const check = (path: string) => {
      try {
        return assertPrivateSqlitePath(path);
      } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    };
    if (!check(absolute)) {
      try { closeSync(openSync(absolute, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    }
    const before = check(absolute)!;
    for (const suffix of ['-wal', '-shm', '-journal']) check(absolute + suffix);
    db = startupDatabaseOwners.open(absolute);
    const after = check(absolute)!;
    if (before.ino !== after.ino || before.dev !== after.dev) throw new AuthPersistenceError();
    db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA journal_size_limit=4194304');
    const passkeys = new SqlitePasskeys(db, currentKey);
    for (const suffix of ['-wal', '-shm', '-journal']) check(absolute + suffix);
    let display: AsyncSqliteAuthDisplay | undefined, closing = false, closeWork: Promise<void> | undefined;
    let failedDisplay: AsyncSqliteAuthDisplay | undefined, retryAt = 0;
    const guard = () => { if (closing) throw new AuthPersistenceError(); requireConnectionReady(db!); };
    const observeFailure = () => {
      if (display?.recoveryState.unavailable && failedDisplay !== display) {
        failedDisplay = display; retryAt = performance.now() + 1000;
      }
    };
    const read = async <K extends 'status' | 'list'>(kind: K, key?: string) => {
      // These are local identity reads, not commands in the read-only worker.
      // Keep the original writer fence even when the caller catches this async
      // route rejection inside an enclosing synchronous transaction.
      let step = 8; // Initial identity=8, post-query=9, post-observer-drain=10.
      try {
        guard(); const identity = synchronousSqliteIdentity(db!, currentKey); let recovered = false;
        observeFailure();
        if (display?.recoveryState.unavailable) {
          // A distinct later display request may start a new read-only observer
          // only after the old worker's confirmed exit and a bounded cooldown.
          // Never retry the failed query, reopen the writer, or repair records.
          if (!display.recoveryState.exitConfirmed || performance.now() < retryAt) throw new AuthPersistenceError();
          const previous = display; await previous.close(); step = 10; guard();
          if (synchronousSqliteIdentity(db!, currentKey) !== identity) throw new AuthPersistenceError();
          if (display === previous) { display = undefined; recovered = true; }
        }
        display ??= new AsyncSqliteAuthDisplay({ file: absolute, dev: after.dev, ino: after.ino });
        const result = await display.read(kind, key);
        step = 9; guard(); if (synchronousSqliteIdentity(db!, currentKey) !== identity) throw new AuthPersistenceError();
        if (recovered) {
          const trace = performanceDiagnostics.start('auth-display-read'); trace.add('step', 4);
          trace.add('recovered', 1); trace.finish();
        }
        return result;
      } catch {
        // Failure-only numeric observation. It cannot authorize another read,
        // clear an original writer fence, expose callback errors or replay SQL.
        try {
          const trace = performanceDiagnostics.start('auth-display-read'); trace.add('step', step);
          trace.add('unknown', Number(connectionRecoverySnapshot(db!).state === 'close-required')); trace.finish(true);
        } catch { /* Logging never changes the original refusal. */ }
        observeFailure(); throw new AuthPersistenceError();
      }
    };
    const routePasskeys: AuthPasskeyStore = {
      status: key => read('status', key), list: key => read('list', key),
      registrationOptions: (...args) => { guard(); return passkeys.registrationOptions(...args); },
      verifyRegistration: (...args) => { guard(); return passkeys.verifyRegistration(...args); },
      authenticationOptions: (...args) => { guard(); return passkeys.authenticationOptions(...args); },
      verifyAuthentication: (...args) => { guard(); return passkeys.verifyAuthentication(...args); },
      revoke: (...args) => { guard(); return passkeys.revoke(...args); },
    };
    // The sole-owner facade remembers confirmed closure, and retains the
    // exact handle for retry after failure. Do not pre-latch a failed close.
    return { passkeys, routePasskeys, sessions: passkeys.sessions, close: (): void | Promise<void> => {
      closing = true;
      if (!display) return db!.close();
      if (!closeWork) {
        closeWork = display.close().then(() => { db!.close(); });
        void closeWork.catch(() => { closeWork = undefined; });
      }
      return closeWork;
    } };
  } catch (error) {
    reportSqliteAuthOwnerFailure('open', error);
    if (db) startupDatabaseOwners.abandon(db);
    throw new AuthPersistenceError();
  }
}
