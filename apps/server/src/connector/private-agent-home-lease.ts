import { randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, openSync, readSync,
  unlinkSync, writeSync, type Stats } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathsOverlap } from '../claude/config.js';
import { assertWindowsPrivatePath, canonicalPrivatePath } from './windows-private-worker.js';

type Runtime = 'claude-code' | 'ghcp' | 'antigravity';
const names = {
  'claude-code': { lock: '.agentopsdeck-claude-owner', binding: '.agentopsdeck-claude-binding' },
  ghcp: { lock: '.agentopsdeck-copilot-owner', binding: '.agentopsdeck-copilot-binding' },
  antigravity: { lock: '.agentopsdeck-antigravity-owner', binding: '.agentopsdeck-antigravity-binding' },
} as const;
const failed = () => new Error('Private Agent home ownership is unconfirmed; keep state and use offline recovery');
function assertNoForeignRuntime(home: string, runtime: Runtime) {
  for (const [other, files] of Object.entries(names)) {
    if (other === runtime) continue;
    for (const name of [files.lock, files.binding]) {
      try { lstatSync(join(home, name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw failed(); }
      // Includes stale, malformed and symlink markers. Never adopt another
      // runtime's HOME, even after its clean shutdown removed the owner.
      throw failed();
    }
  }
}
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const fileFlags = constants.O_NOFOLLOW | constants.O_NONBLOCK;
const validPrivateFile = (stat: Stats, path: string) => {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return false;
  if (process.platform === 'win32') { assertWindowsPrivatePath(path); return true; }
  return stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600;
};
const validHome = (stat: Stats, path: string) => {
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  if (process.platform === 'win32') { assertWindowsPrivatePath(path); return true; }
  return stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o700;
};
const syncDirectory = (fd: number) => { if (fd >= 0) fsyncSync(fd); };
const closeDirectory = (fd: number) => { if (fd >= 0) closeSync(fd); };

/** Durable cooperative ownership, NOT an OS sandbox. The caller must already
 * own the Connector DB's exclusive runtime connection. No PID/TTL takeover:
 * a dead parent does not prove that its native descendants stopped. An
 * abandoned marker blocks startup until explicit, offline recovery.
 *
 * Never opens the SQLite file: closing another fd for that inode could drop
 * process-scoped SQLite locks. Only lstat/realpath are used for DB identity.
 */
export class PrivateAgentHomeLease {
  private closed = false;
  private closing: Promise<void> | undefined;
  private constructor(private readonly home: string, private readonly homeStat: Stats,
    private readonly storeFile: string, private readonly storeStat: Stats,
    private readonly directoryFd: number, private readonly lockFd: number, private readonly lockStat: Stats,
    private readonly runtime: Runtime) {}

  static acquire(runtime: Runtime, home: string, storeFile: string, nodeId: string): PrivateAgentHomeLease {
    const { lock: lockName, binding: bindingName } = names[runtime];
    let directoryFd: number | undefined, lockFd: number | undefined;
    let ownedStat: Stats | undefined;
    try {
      if (!['linux', 'win32'].includes(process.platform) || process.platform === 'linux' && !process.getuid || !isAbsolute(home) || !isAbsolute(storeFile)
        || !canonicalPrivatePath(home) || !canonicalPrivatePath(storeFile) || pathsOverlap(home, storeFile)
        || !/^node_[a-f0-9-]{36}$/i.test(nodeId)) throw failed();
      const homeStat = lstatSync(home), dbStat = lstatSync(storeFile);
      if (!validHome(homeStat, home) || !validPrivateFile(dbStat, storeFile)) throw failed();
      // Node cannot open/fsync directory handles on Windows. File fsync and
      // durable exclusive markers remain; never silently reclaim a marker.
      directoryFd = process.platform === 'win32' ? -1 : openSync(home, constants.O_RDONLY | constants.O_DIRECTORY | fileFlags);
      if (directoryFd >= 0 && !sameFile(homeStat, fstatSync(directoryFd))) throw failed();
      assertNoForeignRuntime(home, runtime);
      // EEXIST (including incomplete or malformed records) is never reclaimed.
      lockFd = openSync(join(home, lockName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | fileFlags, 0o600);
      const lockStat = fstatSync(lockFd);
      ownedStat = lockStat;
      if (!validPrivateFile(lockStat, join(home, lockName))) throw failed();
      const marker = JSON.stringify({ format: 1, token: randomUUID(), pid: process.pid, nodeId });
      if (writeSync(lockFd, marker) !== Buffer.byteLength(marker)) throw failed();
      fsyncSync(lockFd); syncDirectory(directoryFd);
      // Both runtimes check before and after their exclusive marker. A
      // simultaneous cross-runtime acquire cannot let both pass this fence.
      assertNoForeignRuntime(home, runtime);
      // Persistent binding prevents a second Connector DB from adopting this
      // HOME after a clean stop. Rebinding/restoring must be an explicit task.
      const binding = JSON.stringify({ format: 1, nodeId, storeFile });
      const path = join(home, bindingName);
      let bindingFd: number | undefined;
      try {
        try {
          bindingFd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | fileFlags, 0o600);
          if (writeSync(bindingFd, binding) !== Buffer.byteLength(binding)) throw failed();
          fsyncSync(bindingFd); syncDirectory(directoryFd);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          bindingFd = openSync(path, constants.O_RDONLY | fileFlags);
          const before = fstatSync(bindingFd);
          if (!validPrivateFile(before, path) || before.size !== Buffer.byteLength(binding) || before.size > 8192) throw failed();
          const bytes = Buffer.alloc(before.size + 1);
          const length = readSync(bindingFd, bytes, 0, bytes.length, 0), after = fstatSync(bindingFd);
          if (length !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
            || bytes.subarray(0, length).toString('utf8') !== binding) throw failed();
        }
      } finally { if (bindingFd !== undefined) closeSync(bindingFd); }
      const lease = new PrivateAgentHomeLease(home, homeStat, storeFile, dbStat, directoryFd, lockFd, lockStat, runtime);
      lease.assertHeld(); return lease;
    } catch {
      // This acquire has not launched anything. Roll back only our own inode;
      // a crash before rollback instead leaves the durable startup fence.
      // Incomplete bindings remain for explicit inspection, never overwritten.
      if (ownedStat && directoryFd !== undefined) {
        try {
          if ((directoryFd < 0 || sameFile(lstatSync(home), fstatSync(directoryFd))) && sameFile(lstatSync(join(home, lockName)), ownedStat)) {
            unlinkSync(join(home, lockName)); syncDirectory(directoryFd);
          }
        } catch { /* retain uncertain marker */ }
      }
      if (lockFd !== undefined) closeSync(lockFd);
      if (directoryFd !== undefined) closeDirectory(directoryFd);
      throw failed();
    }
  }

  assertHeld(): void {
    try {
      if (this.closed || this.closing || !canonicalPrivatePath(this.home)) throw failed();
      assertNoForeignRuntime(this.home, this.runtime);
      const home = lstatSync(this.home), lock = lstatSync(join(this.home, names[this.runtime].lock));
      const db = lstatSync(this.storeFile);
      if (!sameFile(home, this.homeStat) || !validHome(home, this.home)
        || !canonicalPrivatePath(this.storeFile) || !sameFile(db, this.storeStat) || !validPrivateFile(db, this.storeFile)
        || !sameFile(lock, this.lockStat) || !validPrivateFile(lock, join(this.home, names[this.runtime].lock)) || !sameFile(lock, fstatSync(this.lockFd))) throw failed();
    } catch { throw failed(); }
  }

  /** One-way close: failed/unproven native cleanup retains the crash fence.
   * Caller must drain admission AND prove worker/native quiescence here. */
  releaseAfter(cleanup: () => Promise<void>): Promise<void> {
    const lockName = names[this.runtime].lock;
    if (this.closing) return this.closing;
    let held = true;
    try { this.assertHeld(); } catch { held = false; }
    this.closing = Promise.resolve().then(async () => {
      try {
        // Still clean up owned workers even if the marker has been changed.
        await cleanup();
        const lock = lstatSync(join(this.home, lockName));
        if (!held || !sameFile(lstatSync(this.home), this.homeStat)
          || !sameFile(lstatSync(this.storeFile), this.storeStat)
          || !sameFile(lock, this.lockStat) || !validPrivateFile(lock, join(this.home, lockName))) throw failed();
        unlinkSync(join(this.home, lockName)); syncDirectory(this.directoryFd);
      } catch { throw failed(); }
      finally { this.closed = true; closeSync(this.lockFd); closeDirectory(this.directoryFd); }
    });
    return this.closing;
  }
}
