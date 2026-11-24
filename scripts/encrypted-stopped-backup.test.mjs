import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { lstat, mkdtemp, mkdir, open, readFile, readdir, rm, statfs, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { encryptTree, decryptArchive, treeInventory, encryptedStoppedBackup } from './lib/encrypted-stopped-backup.mjs';

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-encrypted-backup-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'); await mkdir(source, { mode: 0o700 });
  await writeFile(join(source, 'private.txt'), 'synthetic-private-content', { mode: 0o600 });
  return { root, source, key: randomBytes(32), archive: join(root, 'archive.enc'), tar: join(root, 'restore.tar.gz') };
}

function syntheticCapacity(context, capacities) {
  const calls = [];
  const capacity = context.mock.method(fs.promises, 'statfs', async folder => {
    assert.ok(capacities.has(folder), 'Unexpected capacity probe');
    calls.push(folder);
    return { bavail: capacities.get(folder), bsize: 1 };
  });
  syncBuiltinESMExports();
  context.after(() => { capacity.mock.restore(); syncBuiltinESMExports(); });
  return calls;
}

test('authenticated encrypted archive restores exact private bytes and modes', async context => {
  const value = await fixture(context);
  await encryptTree(value.source, value.archive, value.key);
  assert.equal((await readFile(value.archive)).includes(Buffer.from('synthetic-private-content')), false);
  await decryptArchive(value.archive, value.tar, value.key);
  const restored = join(value.root, 'restored'); await mkdir(restored);
  assert.equal(spawnSync('/usr/bin/tar', ['-xzpf', value.tar, '-C', restored]).status, 0);
  assert.deepEqual(await treeInventory(join(restored, 'source')), await treeInventory(value.source));
  await assert.rejects(encryptTree(value.source, value.archive, value.key));
});

for (const mutation of ['key', 'ciphertext', 'tag', 'header', 'truncate']) test('backup rejects ' + mutation + ' before extraction', async context => {
  const value = await fixture(context);
  await encryptTree(value.source, value.archive, value.key);
  if (mutation !== 'key') {
    const handle = await open(value.archive, 'r+');
    try {
      const info = await handle.stat();
      if (mutation === 'truncate') await handle.truncate(info.size - 17);
      else {
        const offset = mutation === 'header' ? 0 : mutation === 'tag' ? info.size - 1 : 40;
        const byte = Buffer.alloc(1); await handle.read(byte, 0, 1, offset);
        byte[0] ^= 1; await handle.write(byte, 0, 1, offset);
      }
    } finally { await handle.close(); }
  }
  await assert.rejects(decryptArchive(value.archive, value.tar, mutation === 'key' ? randomBytes(32) : value.key));
  await assert.rejects(readFile(value.tar), { code: 'ENOENT' });
});

test('refuses same-device backup without stopping or touching sources', async context => {
  const value = await fixture(context); let stopped = 0;
  await assert.rejects(encryptedStoppedBackup({ roots: [value.source], directory: join(value.root, 'remote'),
    restoreDirectory: join(value.root, 'restore'), key: value.key,
    verifyStopped: async () => { stopped++; }, verifyWriters: async () => {} }), /different devices/);
  assert.equal(stopped, 0);
});

test('full stopped backup verifies twelve restored roots and keeps only ciphertext on the archive device', { skip: process.platform !== 'linux' }, async context => {
  const value = await fixture(context);
  const device = (await lstat(value.root)).dev;
  let archiveParent;
  for (const parent of ['/dev/shm', fileURLToPath(new URL('..', import.meta.url))]) {
    const capacity = await statfs(parent, { bigint: true });
    if ((await lstat(parent)).dev !== device && capacity.bavail * capacity.bsize > 16n * 1024n ** 2n) {
      archiveParent = parent; break;
    }
  }
  assert.ok(archiveParent, 'Integration fixture needs a distinct archive filesystem with 16MiB for synthetic archives');
  const remote = await mkdtemp(join(archiveParent, 'agentopsdeck-backup-test-'));
  context.after(() => rm(remote, { recursive: true, force: true }));
  const roots = [value.source];
  for (let index = 1; index < 12; index++) {
    const root = join(value.root, 'source-' + index); await mkdir(root, { mode: 0o700 });
    await writeFile(join(root, 'data'), 'synthetic-' + index, { mode: 0o600 }); roots.push(root);
  }
  const db = new DatabaseSync(join(value.source, 'synthetic.sqlite'));
  db.exec('CREATE TABLE synthetic (id INTEGER); INSERT INTO synthetic VALUES (1)'); db.close();
  await symlink('private.txt', join(value.source, 'link'));
  // Docker's /dev/shm is usually 64 MiB. The tiny synthetic trees still use
  // real cross-device encryption/restore, but do not require the production
  // 1 GiB spare-space budget on that fixture device. Test the unchanged
  // production capacity refusals separately below; never lower its reserve.
  const capacityCalls = syntheticCapacity(context, new Map([
    [remote, 2 * 1024 ** 3], [value.root, 2 * 1024 ** 3],
  ]));
  let stopped = 0, writers = 0;
  const result = await encryptedStoppedBackup({ roots, directory: join(remote, 'encrypted'),
    restoreDirectory: join(value.root, 'restores'), key: value.key,
    verifyStopped: async () => { stopped++; }, verifyWriters: async () => { writers++; }, metadata: { synthetic: true } });
  assert.equal(result.passed, true); assert.equal(result.archives.length, 12);
  assert.deepEqual(capacityCalls, [remote, value.root]);
  assert.equal(result.archives.reduce((sum, record) => sum + record.databases, 0), 1);
  assert.ok(stopped >= 26 && writers === stopped);
  for (const name of await readdir(join(remote, 'encrypted'))) {
    assert.ok(name.endsWith('.enc'));
    assert.equal((await readFile(join(remote, 'encrypted', name))).includes(Buffer.from('synthetic-private-content')), false);
  }
  const decoded = join(value.root, 'manifest-decoded.json');
  await decryptArchive(join(remote, 'encrypted', 'manifest-final.enc'), decoded, value.key);
  assert.deepEqual(JSON.parse(await readFile(decoded, 'utf8')), result);
});

for (const device of ['archive', 'restore']) test('insufficient ' + device + ' capacity rejects before backup writes', async context => {
  const value = await fixture(context), remote = await mkdtemp('/dev/shm/agentopsdeck-backup-capacity-');
  context.after(() => rm(remote, { recursive: true, force: true }));
  syntheticCapacity(context, new Map([
    [remote, (device === 'archive' ? 1 : 2) * 1024 ** 3],
    [value.root, (device === 'restore' ? 1 : 2) * 1024 ** 3],
  ]));
  await assert.rejects(encryptedStoppedBackup({ roots: [value.source], directory: join(remote, 'encrypted'),
    restoreDirectory: join(value.root, 'restores'), key: value.key,
    verifyStopped: async () => {}, verifyWriters: async () => {} }),
  device === 'archive' ? /Insufficient encrypted archive capacity/ : /Insufficient private full-restore capacity/);
  assert.deepEqual(await readdir(remote), []);
  await assert.rejects(lstat(join(value.root, 'restores')), { code: 'ENOENT' });
  assert.equal(await readFile(join(value.source, 'private.txt'), 'utf8'), 'synthetic-private-content');
});

test('failed stopped/writer proof cannot produce a backup', async context => {
  const value = await fixture(context), remote = await mkdtemp('/dev/shm/agentopsdeck-backup-refusal-');
  context.after(() => rm(remote, { recursive: true, force: true }));
  await assert.rejects(encryptedStoppedBackup({ roots: [value.source], directory: join(remote, 'encrypted'),
    restoreDirectory: join(value.root, 'restores'), key: value.key,
    verifyStopped: async () => { throw Error('not stopped'); }, verifyWriters: async () => {} }), /not stopped/);
  assert.deepEqual(await readdir(remote), []);
});
