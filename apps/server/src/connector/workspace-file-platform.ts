import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

/** Operator paths, never browser filenames. Windows drive-relative/device/ADS
 * aliases are not dedicated directories. Do not interpret a Windows path with
 * the Hub host's POSIX rules: this runs on the owning Connector. */
export function normalizeWorkspaceFileRoot(input: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (!input || input.length > 512 || /[\u0000-\u001f\u007f]/.test(input)) return;
  const path = platform === 'win32' ? win32 : posix;
  if (platform === 'win32') {
    const windows = input.replace(/\//g, '\\');
    if (!/^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+\\)/i.test(windows) || /^\\\\[?.]\\/.test(windows)) return;
    if (/[<>:"|?*]/.test(windows.replace(/^[a-z]:/i, ''))) return;
    const parts = windows.slice(path.parse(windows).root.length).split('\\');
    if (parts.some(part => !part || /[<>:"|?*]/.test(part) || /[. ]$/.test(part)
      || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) return;
    const normalized = path.normalize(windows);
    if (normalized !== windows || path.resolve(normalized, '..') === normalized) return;
    return normalized;
  }
  if (!path.isAbsolute(input) || path.resolve(input) !== input || path.resolve(input, '..') === input) return;
  return input;
}

/** Node cannot open/fsync a directory on Windows. File data is still fsynced,
 * captured originals retained and installation remains exclusive hard-link CAS.
 * Do not swallow POSIX fsync errors or replace this with unlink+rename. Windows
 * power-loss directory-entry durability is not the POSIX guarantee. */
export async function syncWorkspaceDirectory(path: string, platform: NodeJS.Platform = process.platform,
  openDirectory: typeof open = open): Promise<void> {
  if (platform === 'win32') return;
  const handle = await openDirectory(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
