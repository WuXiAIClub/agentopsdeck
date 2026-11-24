import { lstatSync, realpathSync, type Stats } from 'node:fs';
import { canonicalPrivatePath, PRIVATE_ACL_SCRIPT, windowsPrivateControl } from '../connector/windows-private-worker.js';

// One native ACL subprocess per snapshot, not one process per DB/sidecar.
// Paths are environment data, never interpolated into executable script text.
export const PRIVATE_SQLITE_ACL_BATCH_SCRIPT = `
$paths=ConvertFrom-Json -InputObject $env:AOD_PRIVATE_SQLITE_PATHS
foreach ($path in $paths) {
  $env:AOD_PRIVATE_PATH=$path
  ${PRIVATE_ACL_SCRIPT}
}`;

type PrivatePath = { file: string; directory?: boolean };

/** Stat shape is necessary, not sufficient on Windows: ACL/reparse and
 * canonical path verification MUST also succeed before the path is usable. */
export function privateSqliteStatIsValid(stat: Stats, directory: boolean, platform: string, uid?: number): boolean {
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) return false;
  if (platform === 'win32') return true;
  return Number.isSafeInteger(uid) && stat.uid === uid && (stat.mode & 0o077) === 0;
}

/** Trusted local-host boundary. Do not treat chmod bits as Windows ACLs, nor
 * fall back to weaker checks if the native verifier is unavailable. */
export function assertPrivateSqlitePath(file: string, directory = false): Stats {
  return assertPrivateSqlitePaths([{ file, directory }])[0]!;
}

export function assertPrivateSqlitePaths(paths: readonly PrivatePath[]): Stats[] {
  // Exactly a parent, DB and three optional SQLite sidecars. No unbounded
  // subprocess argument/environment or caller-provided control statements.
  if (!paths.length || paths.length > 5 || paths.some(p => typeof p.file !== 'string'
    || !p.file || p.file.includes('\0') || p.file.length > 4096)) throw Error('Private SQLite path unavailable');
  const uid = process.getuid?.();
  const before = paths.map(({ file, directory = false }) => {
    const stat = lstatSync(file);
    if (!privateSqliteStatIsValid(stat, directory, process.platform, uid)) throw Error('Private SQLite path unavailable');
    if (process.platform === 'win32' ? !canonicalPrivatePath(file) : directory && realpathSync(file) !== file) {
      throw Error('Private SQLite path unavailable');
    }
    return stat;
  });
  if (process.platform === 'win32') {
    const result = windowsPrivateControl(PRIVATE_SQLITE_ACL_BATCH_SCRIPT,
      { AOD_PRIVATE_SQLITE_PATHS: JSON.stringify(paths.map(p => p.file)) });
    if (result !== 'private'.repeat(paths.length)) throw Error('Private SQLite path unavailable');
    // The ACL subprocess observes the named path. Pin it to the same inode
    // before returning to the original open/read owner, not a replacement.
    const after = paths.map(({ file, directory = false }, index) => {
      const stat = lstatSync(file), original = before[index]!;
      if (!privateSqliteStatIsValid(stat, directory, process.platform, uid)
        || original.dev !== stat.dev || original.ino !== stat.ino || !canonicalPrivatePath(file)) {
        throw Error('Private SQLite path unavailable');
      }
      return stat;
    });
    return after;
  }
  return before;
}
