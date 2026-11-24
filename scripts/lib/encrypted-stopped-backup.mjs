import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readdir, readlink, realpath, rename, rm, statfs } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';

const magic = Buffer.from('AGENTOPSDECK-BACKUP1');
const digest = value => createHash('sha256').update(value).digest('hex');
const headerSize = magic.length + 12;

async function syncFile(file) {
  const handle = await open(file, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
  const parent = await open(dirname(file), 'r');
  try { await parent.sync(); } finally { await parent.close(); }
}

export async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function treeInventory(root) {
  const entries = [];
  async function visit(file, relative) {
    const info = await lstat(file), mode = info.mode & 0o7777;
    if (info.isSymbolicLink()) entries.push({ path: relative, type: 'link', mode, target: await readlink(file) });
    else if (info.isSocket()) entries.push({ path: relative, type: 'socket', omitted: true });
    else if (info.isDirectory()) {
      entries.push({ path: relative, type: 'directory', mode });
      for (const name of (await readdir(file)).sort()) await visit(join(file, name), relative ? relative + '/' + name : name);
    } else {
      assert.ok(info.isFile(), 'Unsupported backup entry');
      entries.push({ path: relative, type: 'file', mode, bytes: info.size, sha256: await fileHash(file) });
    }
  }
  await visit(root, '');
  return entries;
}

async function tar(args, consume) {
  const child = spawn('/usr/bin/tar', args, { stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? accept() : reject(Error('Backup tar failed: ' + (signal ?? code))));
  });
  void exited.catch(() => {});
  const timer = setTimeout(() => child.kill('SIGKILL'), 900_000);
  try { if (consume) await consume(child.stdout); await exited; }
  catch (error) { child.kill('SIGKILL'); await exited.catch(() => {}); throw error; }
  finally { clearTimeout(timer); }
}

function encryption(key) {
  assert.ok(Buffer.isBuffer(key) && key.length === 32, 'A private 256-bit backup key is required');
  const header = Buffer.concat([magic, randomBytes(12)]);
  const cipher = createCipheriv('aes-256-gcm', key, header.subarray(magic.length));
  cipher.setAAD(header);
  return { header, cipher };
}

export async function encryptTree(source, destination, key) {
  const { header, cipher } = encryption(key);
  const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  await tar(['--acls', '--xattrs', '-czpf', '-', '-C', dirname(source), '--', basename(source)], input =>
    pipeline(input, cipher, async function* (chunks) {
      yield header;
      for await (const chunk of chunks) yield chunk;
      yield cipher.getAuthTag();
    }, output));
  await syncFile(destination);
}

export async function decryptArchive(source, destination, key) {
  assert.ok(Buffer.isBuffer(key) && key.length === 32);
  const input = await open(source, 'r');
  let owned = false;
  try {
    const info = await input.stat(), header = Buffer.alloc(headerSize), tag = Buffer.alloc(16);
    assert.ok(info.isFile() && info.size > headerSize + 16);
    assert.equal((await input.read(header, 0, header.length, 0)).bytesRead, header.length);
    assert.ok(header.subarray(0, magic.length).equals(magic), 'Invalid encrypted backup header');
    assert.equal((await input.read(tag, 0, 16, info.size - 16)).bytesRead, 16);
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(magic.length));
    decipher.setAAD(header); decipher.setAuthTag(tag);
    const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
    output.once('open', () => { owned = true; });
    await pipeline(createReadStream(source, { start: headerSize, end: info.size - 17 }), decipher, output);
    await syncFile(destination);
  } catch (error) { if (owned) await rm(destination, { force: true }); throw error; }
  finally { await input.close(); }
}

async function writeManifest(local, remote, manifest, key) {
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  const temporary = local + '.pending';
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, local); await syncFile(local);
  const { header, cipher } = encryption(key);
  const encrypted = Buffer.concat([header, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
  const remoteHandle = await open(remote, 'wx', 0o600);
  try { await remoteHandle.writeFile(encrypted); await remoteHandle.sync(); } finally { await remoteHandle.close(); }
  await syncFile(remote);
}

async function sqliteChecks(root, entries) {
  let checked = 0;
  for (const entry of entries.filter(value => value.type === 'file' && value.bytes >= 16)) {
    const file = join(root, entry.path), handle = await open(file, 'r'), header = Buffer.alloc(16);
    try { await handle.read(header, 0, 16, 0); } finally { await handle.close(); }
    if (!header.equals(Buffer.from('SQLite format 3\0'))) continue;
    const db = new DatabaseSync(file, { readOnly: true });
    try { assert.ok(db.prepare('PRAGMA quick_check').all().every(row => row.quick_check === 'ok')); checked++; }
    finally { db.close(); }
  }
  return checked;
}

export async function encryptedStoppedBackup({ roots, directory, restoreDirectory, key, verifyStopped, verifyWriters, metadata }) {
  assert.ok(Array.isArray(roots) && roots.length > 0 && roots.length <= 32 && new Set(roots).size === roots.length);
  assert.equal(typeof verifyStopped, 'function'); assert.equal(typeof verifyWriters, 'function');
  assert.notEqual(directory, restoreDirectory);
  for (const folder of [directory, restoreDirectory]) {
    assert.equal(resolve(folder), folder); assert.equal(await realpath(dirname(folder)), dirname(folder));
  }
  assert.notEqual((await lstat(dirname(directory))).dev, (await lstat(dirname(restoreDirectory))).dev,
    'Encrypted backup and private restore must use different devices');
  const manifest = { version: 1, encryption: 'aes-256-gcm', metadata, startedAt: new Date().toISOString(), archives: [], passed: false };
  await verifyStopped(); await verifyWriters();
  const trees = [];
  for (const source of roots) {
    assert.equal(await realpath(source), source);
    trees.push(await treeInventory(source));
  }
  const sizes = trees.map(entries => entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0));
  const total = sizes.reduce((sum, bytes) => sum + bytes, 0), largest = Math.max(...sizes);
  const remote = await statfs(dirname(directory)), local = await statfs(dirname(restoreDirectory));
  assert.ok(remote.bavail * remote.bsize > total * 1.2 + 1024 ** 3, 'Insufficient encrypted archive capacity');
  assert.ok(local.bavail * local.bsize > total * 1.2 + largest * 1.2 + 1024 ** 3, 'Insufficient private full-restore capacity');
  await mkdir(directory, { mode: 0o700 }); await mkdir(restoreDirectory, { mode: 0o700 });
  for (const [index, source] of roots.entries()) {
    await verifyStopped(); await verifyWriters();
    assert.deepEqual(await treeInventory(source), trees[index], 'Stopped tree changed before archiving');
    const archive = join(directory, index + '.enc'), restoredTar = join(restoreDirectory, index + '.tar.gz');
    await encryptTree(source, archive, key);
    const archiveSha256 = await fileHash(archive);
    await decryptArchive(archive, restoredTar, key);
    const destination = join(restoreDirectory, 'root-' + index);
    await mkdir(destination, { mode: 0o700 });
    await tar(['--acls', '--xattrs', '-xzpf', restoredTar, '-C', destination]);
    const included = trees[index].filter(entry => entry.type !== 'socket'), restored = join(destination, basename(source));
    assert.deepEqual(await treeInventory(restored), included, 'Restored bytes, modes or links differ');
    assert.deepEqual(await treeInventory(source), trees[index], 'Stopped source changed during backup');
    const databases = await sqliteChecks(restored, included);
    assert.equal(await fileHash(archive), archiveSha256, 'Encrypted archive changed during verification');
    manifest.archives.push({ source, archive, archiveSha256, restored, entries: included.length, treeSha256: digest(JSON.stringify(included)), databases });
    await rm(restoredTar);
    await writeManifest(join(restoreDirectory, 'manifest.json'), join(directory, 'manifest-' + index + '.enc'), manifest, key);
    await verifyStopped(); await verifyWriters();
  }
  for (const [index, source] of roots.entries()) assert.deepEqual(await treeInventory(source), trees[index], 'Stopped source changed after backup');
  await verifyStopped(); await verifyWriters();
  manifest.passed = true; manifest.finishedAt = new Date().toISOString();
  await writeManifest(join(restoreDirectory, 'manifest.json'), join(directory, 'manifest-final.enc'), manifest, key);
  return manifest;
}
