import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export async function syncUpdateDirectory(directory: string, platform: NodeJS.Platform = process.platform,
  openDirectory: typeof open = open) {
  if (platform === 'win32') return;
  const handle = await openDirectory(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await handle.sync(); }
  finally { await handle.close(); }
}

export async function syncUpdateParents(file: string) {
  let directory = dirname(resolve(file));
  while (true) {
    await syncUpdateDirectory(directory);
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

export async function syncUpdateJournal(file: string) {
  const handle = await open(file, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
  try {
    const stat = await handle.stat(), named = await lstat(file);
    if (!stat.isFile() || named.isSymbolicLink() || stat.dev !== named.dev || stat.ino !== named.ino) {
      throw new Error('connector update journal is not a regular file');
    }
    await handle.sync();
  } finally { await handle.close(); }
  await syncUpdateParents(file);
}

export async function writeUpdateJournal(file: string, text: string, assertOwner: () => void = () => {}) {
  assertOwner();
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${randomUUID()}`;
  let created = false;
  try {
    assertOwner();
    const handle = await open(temporary, 'wx', 0o600);
    created = true;
    try { assertOwner(); await handle.writeFile(text); assertOwner(); await handle.sync(); }
    finally { await handle.close(); }
    assertOwner();
    await rename(temporary, file);
    created = false;
    await syncUpdateParents(file);
    assertOwner();
  } finally {
    if (created) await unlink(temporary);
  }
}
