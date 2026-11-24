import { closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Safe to expose through the existing request error/log boundary. */
export class SessionPreferencePersistenceError extends Error {
  constructor() { super('session_preference_persistence_failed'); this.name = 'SessionPreferencePersistenceError'; }
}

/** Read before an explicit change, including after a lost write acknowledgement.
 * This is reconciliation only, never an automatic retry or native execution. */
export function currentPreferences(file: string, fallback: ReadonlySet<string>): Set<string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') throw new SessionPreferencePersistenceError();
    const values = Array.isArray(parsed) ? parsed : Object.keys(parsed);
    return new Set(values.filter((v): v is string => typeof v === 'string' && Boolean(v.trim())).map(v => v.trim()));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // A dangling link is not an absent ordinary file: never replace the link.
      try { if (lstatSync(file).isSymbolicLink()) throw new SessionPreferencePersistenceError(); }
      catch (statError) { if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw new SessionPreferencePersistenceError(); }
      return new Set(fallback);
    }
    throw new SessionPreferencePersistenceError();
  }
}

/** Single-process atomic replacement. Preserve the v2.3.7 sorted array bytes,
 * existing Unix mode and symlink destination. Flush data before rename. This is
 * not a cross-process transaction, Windows ACL copier or power-loss guarantee.
 * Any exception (including a lost rename acknowledgement) remains a failure;
 * callers must not emit success, roll back disk or automatically replay it. */
export function saveSessionPreferences(file: string, values: ReadonlySet<string>): void {
  savePreferenceText(file, JSON.stringify([...values].sort(), null, 2));
}

/** Shared atomic replacement; the caller retains its original wire format. */
function savePreferenceText(file: string, text: string): void {
  let target = file;
  let mode = 0o600;
  let temporary: string | undefined;
  let fd: number | undefined;
  let owned = false;
  try {
    try {
      const entry = lstatSync(file);
      if (entry.isSymbolicLink()) target = realpathSync(file);
      const metadata = statSync(target);
      if (!metadata.isFile() || metadata.nlink > 1) throw new SessionPreferencePersistenceError();
      mode = metadata.mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // realpath ENOENT on a dangling link must fail closed.
      try { if (lstatSync(file).isSymbolicLink()) throw new SessionPreferencePersistenceError(); }
      catch (statError) { if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError; }
    }
    mkdirSync(dirname(target), { recursive: true });
    temporary = `${target}.${randomUUID()}.tmp`;
    fd = openSync(temporary, 'wx', mode); owned = true;
    writeFileSync(fd, text, 'utf8');
    // Unix creation is affected by umask; preserve the old permission bits.
    // Do not pretend chmod can reproduce Windows ACLs.
    if (process.platform !== 'win32') fchmodSync(fd, mode);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temporary, target); owned = false;
  } catch { throw new SessionPreferencePersistenceError(); }
  finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* Preserve original failure. */ } }
    if (owned && temporary) { try { unlinkSync(temporary); } catch { /* Remove only our exclusive temporary. */ } }
  }
}

export function changeSessionPreference(values: ReadonlySet<string>, file: string | undefined, key: string, enabled: boolean): Set<string> {
  const next = file ? currentPreferences(file, values) : new Set(values);
  const changed = enabled ? !next.has(key) : next.has(key);
  if (enabled) next.add(key); else next.delete(key);
  // Preserve the previous enable operation's save behavior. A no-op disable
  // needs no write, but still reconciles an acknowledged-unknown prior save.
  if (file && (enabled || changed)) saveSessionPreferences(file, next);
  return next;
}

/** Preserve the existing object format and entry ordering for title/thinking
 * overrides. Reread before an explicit save after an unknown rename ACK; do not
 * replay the previous change or publish memory until replacement succeeds. */
export function changeSessionOverride<T extends string | undefined>(values: ReadonlyMap<string, T>, file: string | undefined, key: string, value: T | null,
  preserveEmpty = false): Map<string, T> {
  let next = new Map(values);
  if (file) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SessionPreferencePersistenceError();
      next = new Map(Object.entries(parsed).filter((entry): entry is [string, string] =>
        typeof entry[1] === 'string' && (preserveEmpty || Boolean(entry[1].trim()))).map(([k, v]) => [k, v.trim() as T]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new SessionPreferencePersistenceError();
      try { if (lstatSync(file).isSymbolicLink()) throw new SessionPreferencePersistenceError(); }
      catch (statError) { if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw new SessionPreferencePersistenceError(); }
    }
  }
  if (value === null) next.delete(key); else next.set(key, value);
  if (file) savePreferenceText(file, JSON.stringify(Object.fromEntries(next), null, 2));
  return next;
}
