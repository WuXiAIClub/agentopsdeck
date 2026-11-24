import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, open, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

type DirectoryIdentity = { directory: string; info: BigIntStats };

function sameIdentity(left: BigIntStats, right: BigIntStats) {
  return left.dev === right.dev && left.ino === right.ino;
}

export function mediaFileVersion(info: BigIntStats) {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.nlink].join(':');
}

function owned(info: BigIntStats) {
  return typeof process.getuid === 'function' && info.uid === BigInt(process.getuid());
}

function requirePosix() {
  if (process.platform === 'win32' || !constants.O_NOFOLLOW || typeof process.getuid !== 'function') {
    throw new Error('Private media requires verified POSIX ownership and no-follow support');
  }
}

async function directoryIdentities(directory: string, create = false) {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  const identities: DirectoryIdentity[] = [];
  let current = root;
  for (const segment of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (create) {
      await mkdir(current, { mode: 0o700 }).catch(error => {
        if (error.code !== 'EEXIST') throw error;
      });
    }
    const info = await lstat(current, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Media directory must not contain links');
    identities.push({ directory: current, info });
  }
  if (!identities.length) throw new Error('Media directory must not be a filesystem root');
  return identities;
}

async function verifyDirectories(identities: DirectoryIdentity[]) {
  for (const { directory, info } of identities) {
    const current = await lstat(directory, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(info, current)) {
      throw new Error('Media parent directory changed');
    }
  }
}

export async function openPrivateMediaDirectory(directory: string) {
  requirePosix();
  const identities = await directoryIdentities(directory, true);
  const target = identities.at(-1)!;
  if (!owned(target.info) || (target.info.mode & 0o777n) !== 0o700n) {
    throw new Error('Media directory must be owned by this user with mode 0700');
  }
  const handle = await open(target.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat({ bigint: true });
    if (!sameIdentity(info, target.info)) throw new Error('Media directory changed');
    await verifyDirectories(identities);
    const verifyPrivateDirectory = async () => {
      await verifyDirectories(identities);
      const current = await handle.stat({ bigint: true });
      if (!owned(current) || (current.mode & 0o777n) !== 0o700n) throw new Error('Media directory privacy changed');
    };
    return {
      async write(filename: string, content: Buffer) {
        if (!filename || filename !== path.basename(filename) || filename === '.' || filename === '..') throw new Error('Invalid media filename');
        await verifyPrivateDirectory();
        const filePath = path.join(target.directory, filename);
        const pinnedPath = process.platform === 'linux' ? `/proc/self/fd/${handle.fd}/${filename}` : filePath;
        const file = await open(pinnedPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          const before = await file.stat({ bigint: true });
          if (!before.isFile() || !owned(before) || before.nlink !== 1n || (before.mode & 0o777n) !== 0o600n) {
            throw new Error('Media file must be private, owned and singly linked');
          }
          await verifyPrivateDirectory();
          if (!sameIdentity(before, await lstat(filePath, { bigint: true }))) throw new Error('Media file changed');
          await file.writeFile(content);
          const after = await file.stat({ bigint: true });
          const current = await lstat(filePath, { bigint: true });
          await verifyPrivateDirectory();
          if (!sameIdentity(before, current) || after.nlink !== 1n || !owned(after)
            || (after.mode & 0o777n) !== 0o600n || after.size !== BigInt(content.length)) throw new Error('Media file changed');
          return filePath;
        } finally { await file.close(); }
      },
      close: () => handle.close(),
    };
  } catch (error) { await handle.close(); throw error; }
}

export async function openBoundedMediaFile(filePath: string, allowedDirs: string[], maxBytes: number) {
  requirePosix();
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !path.isAbsolute(filePath)) throw new Error('Invalid media read limit or path');
  const resolved = await realpath(filePath);
  if (resolved !== path.resolve(filePath) || !allowedDirs.some(directory => {
    const relative = path.relative(directory, resolved);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  })) throw new Error('Media path is outside its allowed directories or is linked');
  const identities = await directoryIdentities(path.dirname(resolved));
  const authorized = await lstat(resolved, { bigint: true });
  if (!authorized.isFile() || authorized.nlink !== 1n || !owned(authorized)
    || authorized.size <= 0n || authorized.size > BigInt(maxBytes)) throw new Error('Invalid media file');
  const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const verify = async () => {
    await verifyDirectories(identities);
    const current = await lstat(resolved, { bigint: true });
    const pinned = await handle.stat({ bigint: true });
    if (!current.isFile() || !pinned.isFile() || !owned(pinned) || pinned.nlink !== 1n
      || mediaFileVersion(current) !== mediaFileVersion(authorized)
      || mediaFileVersion(pinned) !== mediaFileVersion(authorized)) throw new Error('Media file changed');
  };
  try {
    await verify();
    return { filePath: resolved, info: authorized, verify,
      read: async () => {
        const content = await boundedRead(handle, maxBytes);
        await verify();
        if (BigInt(content.length) !== authorized.size) throw new Error('Media file changed');
        return content;
      },
      close: () => handle.close(),
    };
  } catch (error) { await handle.close(); throw error; }
}

async function boundedRead(handle: FileHandle, maxBytes: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
    if (!bytesRead) return Buffer.concat(chunks, total);
    total += bytesRead;
    if (total > maxBytes) throw new Error('Media file exceeds read limit');
    chunks.push(chunk.subarray(0, bytesRead));
  }
  throw new Error('Media file exceeds read limit');
}
