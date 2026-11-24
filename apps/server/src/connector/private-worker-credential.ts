import { constants } from 'node:fs';
import { open, lstat } from 'node:fs/promises';
import { assertWindowsPrivatePath, canonicalPrivatePath } from './windows-private-worker.js';

/** Child-only credential access. Never call from HTTP/configuration code.
 * Reject aliases, special files, changing files and non-private permissions.
 * Errors deliberately contain neither the path nor credential contents. */
export async function readPrivateWorkerCredential(path: string): Promise<string> {
  const denied = () => new Error('Private worker credential could not be verified');
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let buffer: Buffer | undefined;
  try {
    if (!['linux', 'win32'].includes(process.platform) || process.platform === 'linux' && process.getuid?.() === undefined
      || !canonicalPrivatePath(path)) throw denied();
    const pathStat = await lstat(path);
    if (pathStat.isSymbolicLink()) throw denied();
    if (process.platform === 'win32') assertWindowsPrivatePath(path);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== pathStat.dev || before.ino !== pathStat.ino || before.nlink !== 1
      || process.platform === 'linux' && (before.uid !== process.getuid!() || (before.mode & 0o777) !== 0o600)
      || before.size < 1 || before.size > 16384) throw denied();
    buffer = Buffer.alloc(16385);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    if (process.platform === 'win32') assertWindowsPrivatePath(path);
    if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs) throw denied();
    const key = buffer.subarray(0, bytesRead).toString('utf8').trim();
    if (!key || /\s|[\x00-\x1f\x7f]/.test(key) || key.includes('\ufffd')) throw denied();
    return key;
  } catch { throw denied(); }
  finally { buffer?.fill(0); await handle?.close(); }
}
