import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export class AuthPersistenceError extends Error {
  constructor() {
    // Safe for an HTTP response/audit record: never expose paths or contents.
    super('auth_persistence_failed');
    this.name = 'AuthPersistenceError';
  }
}

/** A stale JSON owner must neither authorize from old memory nor overwrite a
 * newer revocation. This is a fail-closed single-owner guard, not shared auth
 * storage: a changed file requires reopening the owner. Upgraded writers use
 * a short exclusive directory lock; crash locks are never stolen by PID/age. */
export class PrivateAuthStoreGuard {
  private revision: string;
  constructor(private readonly file: string) { this.revision = this.readRevision(); }
  private readRevision(): string {
    try {
      const stat = lstatSync(this.file, { bigint: true });
      if (!stat.isFile()) throw new AuthPersistenceError();
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
      throw new AuthPersistenceError();
    }
  }
  current(): boolean { try { return this.readRevision() === this.revision; } catch { return false; } }
  check() { if (!this.current()) throw new AuthPersistenceError(); }
  write(value: unknown) {
    const lock = `${this.file}.writer-lock`;
    let owned = false;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      mkdirSync(lock, { mode: 0o700 }); owned = true;
      this.check();
      writePrivateAuthStore(this.file, value);
      this.revision = this.readRevision();
    } catch { throw new AuthPersistenceError(); }
    finally { if (owned) { try { rmdirSync(lock); } catch { /* Do not remove anything recursively or steal another lock. */ } } }
  }
}

/** Single-process atomic replacement. The caller publishes memory only on success.
 * File data is flushed before rename; this is not a cross-process transaction or
 * a guarantee against filesystem/directory loss after sudden power failure. */
export function writePrivateAuthStore(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  let owned = false;
  try {
    const text = JSON.stringify(value, null, 2) + '\n';
    mkdirSync(dirname(file), { recursive: true });
    fd = openSync(temporary, 'wx', 0o600);
    owned = true;
    writeFileSync(fd, text, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, file);
    owned = false;
  } catch {
    throw new AuthPersistenceError();
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* Retain the original error. */ } }
    if (owned) { try { unlinkSync(temporary); } catch { /* Never remove an unowned file. */ } }
  }
}
