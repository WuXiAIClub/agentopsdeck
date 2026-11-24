import { constants } from 'node:fs';
import { lstat, open, mkdir, rename, link, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalPrivatePath } from './windows-private-worker.js';
import { syncWorkspaceDirectory as syncDirectory, normalizeWorkspaceFileRoot } from './workspace-file-platform.js';
import { validBoardUuid } from '@agentopsdeck/shared';
import { asyncVolumeAdmission } from '../storage/async-volume-admission.js';

export type FileWriteOutcome = 'saved' | 'conflict' | 'uncertain';
export type FileWriteCodec = {
  name: 'tasks.json' | 'card.json'; maxBytes: number;
  parse: (bytes: Uint8Array) => { hash: string } | undefined;
};
type Identity = { dev: number; ino: number };
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
async function directory(path: string) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !canonicalPrivatePath(path)
    || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) throw new Error('Unsafe file directory');
  return stat;
}

/** Account retained evidence, not max-document-size for every tiny edit. Scan
 * again before each new intent: an old same-UID open fd can still grow a captured
 * inode. This bounds our writes, not an OS quota/security sandbox. Never deletes
 * or follows retained artifacts, including uncertain/crashed candidates. */
export async function retainedWorkspaceFileBytes(root: string, bindingId: string, limit: number): Promise<number> {
  if (normalizeWorkspaceFileRoot(root) !== root || !validBoardUuid(bindingId)) throw Error('Invalid directory');
  const rootStat = await directory(root), folder = join(root, bindingId), folderStat = await directory(folder);
  const entries = await readdir(folder, { withFileTypes: true });
  let total = 0, count = 0;
  for (const entry of entries) {
    if (!entry.name.startsWith('.write-')) continue;
    if (!validBoardUuid(entry.name.slice(7)) || ++count > 1024) throw Error('Invalid write evidence');
    const staging = join(folder, entry.name), identity = await directory(staging);
    for (const file of await readdir(staging)) {
      if (file !== 'original' && file !== 'candidate') throw Error('Unexpected write evidence');
      const stat = await lstat(join(staging, file));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink < 1 || stat.nlink > 2
        || process.getuid && stat.uid !== process.getuid()) throw Error('Unsafe write evidence');
      total += stat.size;
      if (!Number.isSafeInteger(total) || total > limit) return limit + 1;
    }
    if (!same(identity, await directory(staging))) throw Error('Evidence changed');
  }
  if (!same(rootStat, await directory(root)) || !same(folderStat, await directory(folder))) throw Error('Directory changed');
  return total;
}
async function read(path: string, codec: FileWriteCodec) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > codec.maxBytes
      || (process.getuid && before.uid !== process.getuid())) throw new Error('Unsafe file');
    const bytes = Buffer.alloc(codec.maxBytes + 1); let length = 0;
    while (length < bytes.length) {
      const chunk = await handle.read(bytes, length, bytes.length - length, length);
      if (!chunk.bytesRead) break;
      length += chunk.bytesRead;
    }
    const after = await handle.stat(), named = await lstat(path);
    if (!same(before, named) || named.isSymbolicLink() || after.nlink !== 1 || length !== after.size
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('File changed');
    const value = codec.parse(bytes.subarray(0, length));
    if (!value) throw new Error('Invalid file');
    return value;
  } finally { await handle.close(); }
}

/** Caller MUST persist a unique, bounded intent before invoking this once.
 * Capturing instead of overwriting preserves arbitrary external writers' data.
 * No automatic retries or cleanup of uncertain/captured files. */
export async function writeWorkspaceFile(input: {
  root: string; bindingId: string; mutationId: string; expectedHash: string;
  text: string; codec: FileWriteCodec; authorized: () => void | Promise<void>;
  /** Deterministic race/fault injection for isolated tests. Never from HTTP. */
  checkpoint?: (stage: 'prepared' | 'captured' | 'installed') => Promise<void>;
}): Promise<FileWriteOutcome> {
  const { root, bindingId, mutationId, expectedHash, text, codec, authorized } = input;
  if (normalizeWorkspaceFileRoot(root) !== root
    || !validBoardUuid(bindingId) || !validBoardUuid(mutationId) || !/^[a-f0-9]{64}$/.test(expectedHash)
    || Buffer.byteLength(text) > codec.maxBytes || !codec.parse(Buffer.from(text))) throw new Error('Invalid write');
  const folder = join(root, bindingId), target = join(folder, codec.name);
  const staging = join(folder, `.write-${mutationId}`), original = join(staging, 'original'), candidate = join(staging, 'candidate');
  try {
    const rootStat = await directory(root), folderStat = await directory(folder);
    const guard = async () => {
      await authorized();
      if (!same(rootStat, await directory(root)) || !same(folderStat, await directory(folder))) throw new Error('Directory changed');
      await authorized();
    };
    await guard();
    if ((await read(target, codec)).hash !== expectedHash) return 'conflict';
    await guard();
    // The unique intent is already durable. Admission only budgets the physical
    // candidate + metadata; it never replaces that receipt or replays the write.
    return await asyncVolumeAdmission.run(root, 'durable', Buffer.byteLength(text) + 65536, async () => {
    await guard();
    // Exclusive mkdir also prevents a duplicate/restarted intent from replaying.
    await mkdir(staging, { mode: 0o700 });
    const stagingStat = await directory(staging);
    const handle = await open(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await syncDirectory(staging);
    await input.checkpoint?.('prepared');
    await guard();
    if (!same(stagingStat, await directory(staging))) throw new Error('Staging changed');
    await rename(target, original);
    await syncDirectory(staging); await syncDirectory(folder);
    await input.checkpoint?.('captured');
    await guard();
    if ((await read(original, codec)).hash !== expectedHash) {
      // Restore only if the Agent did not create a replacement. Never overwrite.
      await guard();
      try { await link(original, target); await unlink(original); await syncDirectory(folder); } catch { /* Both versions retained. */ }
      return 'conflict';
    }
    await guard();
    if (!same(stagingStat, await directory(staging))) throw new Error('Staging changed');
    // Verify candidate identity/content too; the same-UID runtime is not a sandbox.
    if ((await read(candidate, codec)).hash !== codec.parse(Buffer.from(text))!.hash) throw new Error('Candidate changed');
    await guard();
    try { await link(candidate, target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'conflict'; throw error; }
    await unlink(candidate); await syncDirectory(staging); await syncDirectory(folder);
    await input.checkpoint?.('installed');
    await guard();
    if ((await read(target, codec)).hash !== codec.parse(Buffer.from(text))!.hash
      || (await read(original, codec)).hash !== expectedHash) return 'conflict';
    return 'saved' as const;
    });
  } catch {
    // Restoring an old file after revocation or a crash would itself be an
    // unauthorized/uncertain write. Keep captured data for explicit recovery.
    return 'uncertain';
  }
}
