import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, win32 } from 'node:path';
import { AuthPersistenceError } from './private-store.js';

type Identity = { path: string; inode?: string };
type Reservation = { file: string; identity: Identity };
const matches = (a: Identity, b: Identity) => a.path === b.path
  || a.inode !== undefined && a.inode === b.inode;

/** Parent-process worker admission only. No SQLite descriptor, OS lock, SQL,
 * read-only observer or timeout-based replacement. The original worker's
 * real exit is the only release authority after successful construction.
 * This does not turn legacy synchronous multi-connection auth into a sole
 * writer, or provide inter-process ownership. Application activation still
 * requires replacing the complete synchronous owner, never layering on it. */
export class AuthWorkerReservations {
  private readonly active = new Set<Reservation>();
  private observing = false;
  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  private identity(file: string): Identity {
    // openSqliteAuth resolves every configured name to a private file. Even
    // ':memory:' is a filename here, not SQLite's separate in-memory handle.
    const absolute = resolve(file);
    try {
      const physical = realpathSync(absolute), info = statSync(physical, { bigint: true });
      return { path: this.pathKey(physical), inode: `${info.dev}:${info.ino}` };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new AuthPersistenceError();
      // The secure original factory may create a missing private directory.
      // Canonicalize the nearest existing ancestor without creating anything.
      let ancestor = dirname(absolute), tail = basename(absolute);
      for (;;) {
        try { return { path: this.pathKey(join(realpathSync(ancestor), tail)) }; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor)
            throw new AuthPersistenceError();
          tail = join(basename(ancestor), tail); ancestor = dirname(ancestor);
        }
      }
    }
  }
  private pathKey(path: string) { return this.platform === 'win32' ? win32.normalize(path).toLowerCase() : path; }

  acquire(file: string, observeRefusal: () => void): () => void {
    let identity: Identity;
    try {
      file = resolve(file);
      identity = this.identity(file);
      for (const owner of this.active) {
        if (matches(owner.identity, identity)) throw new AuthPersistenceError();
        // Preserve the original pathname fence and learn the inode once the
        // worker creates the file. A new hard link cannot bypass admission.
        if (owner.identity.inode === undefined) {
          const physical = this.identity(owner.file);
          if (physical.inode !== undefined) owner.identity.inode = physical.inode;
          if (matches(physical, identity)) throw new AuthPersistenceError();
          if (matches(owner.identity, identity)) throw new AuthPersistenceError();
        }
      }
    } catch {
      // The original entry remains registered through diagnostic reentrancy.
      // Never print a private path or recursively observe the same refusal.
      if (!this.observing) {
        this.observing = true;
        try { observeRefusal(); } catch { /* Observation is not admission. */ }
        finally { this.observing = false; }
      }
      throw new AuthPersistenceError();
    }
    const entry = { file, identity };
    this.active.add(entry);
    let released = false;
    return () => { if (!released) { released = true; this.active.delete(entry); } };
  }
}
export const authWorkerReservations = new AuthWorkerReservations();
