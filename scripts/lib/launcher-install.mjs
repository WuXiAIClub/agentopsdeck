import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, open, rename, unlink, lstat } from 'node:fs/promises';
import { dirname } from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
// Caller must own the maintenance fence and prove the service stopped.
export async function installLauncher(target, source, expected, desired) {
  const metadata = await lstat(target);
  assert.ok(metadata.isFile() && !metadata.isSymbolicLink(), 'Launcher must be a regular file');
  const bytes = await readFile(source);
  assert.equal(hash(bytes), desired, 'Staged launcher changed');
  assert.equal(hash(await readFile(target)), expected, 'Installed launcher changed');
  const temp = target + '.' + randomUUID() + '.pending';
  let created = false;
  try {
    const file = await open(temp, 'wx', 0o600); created = true;
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    assert.equal(hash(await readFile(target)), expected, 'Launcher changed during installation');
    await rename(temp, target); created = false;
    const directory = await open(dirname(target), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    assert.equal(hash(await readFile(target)), desired);
  } finally {
    if (created) await unlink(temp);
  }
}
