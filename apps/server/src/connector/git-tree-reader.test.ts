import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitTreeReader } from './git-tree-reader.js';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
async function fixture(fn: (reader: GitTreeReader, dir: string, revoke: () => void) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'agentopsdeck-git-tree-')); let epoch = 'one';
  const reader = new GitTreeReader((owner, ref) => owner === 'alice' && ref === 'repo' ? epoch : undefined);
  try { await mkdir(join(dir, 'root')); await reader.register('alice', 'repo', 'one', join(dir, 'root')); await fn(reader, dir, () => { epoch = 'two'; }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
test('registered read-only root lists opaque tokens, no absolute paths or previews', async () => fixture(async (reader, dir) => {
  await mkdir(join(dir, 'root', '.git')); await mkdir(join(dir, 'root', 'src')); await writeFile(join(dir, 'root', 'src', 'a.ts'), 'PRIVATE_BODY');
  const root = await reader.list('alice', 'repo'); assert.equal(root.gitStatus, 'unsupported');
  assert.equal(root.entries.find(e => e.name === '.git')!.kind, 'unsupported');
  const src = root.entries.find(e => e.name === 'src')!;
  const nested = await reader.list('alice', 'repo', src.pathToken); assert.equal(nested.entries[0]!.name, 'a.ts');
  assert.equal(nested.entries[0]!.previewCapability, true); assert.ok(!JSON.stringify(nested).includes(dir)); assert.ok(!JSON.stringify(nested).includes('PRIVATE_BODY'));
}));
test('symlink and directory replacement cannot escape descriptor-anchored root', async () => fixture(async (reader, dir) => {
  await mkdir(join(dir, 'outside')); await writeFile(join(dir, 'outside', 'PRIVATE'), 'secret');
  await symlink(join(dir, 'outside'), join(dir, 'root', 'link')); await mkdir(join(dir, 'root', 'child'));
  const root = await reader.list('alice', 'repo'); const link = root.entries.find(e => e.name === 'link')!, child = root.entries.find(e => e.name === 'child')!;
  assert.equal(link.kind, 'symlink'); await assert.rejects(reader.list('alice', 'repo', link.pathToken), /path/);
  await rename(join(dir, 'root', 'child'), join(dir, 'saved-child')); await symlink(join(dir, 'outside'), join(dir, 'root', 'child'));
  await assert.rejects(reader.list('alice', 'repo', child.pathToken));
}));
test('pagination is bounded and changed directory returns stale instead of mixing snapshots', async () => fixture(async (reader, dir) => {
  await writeFile(join(dir, 'root', 'a'), ''); await writeFile(join(dir, 'root', 'b'), '');
  const first = await reader.list('alice', 'repo', undefined, undefined, 1); assert.equal(first.entries.length, 1); assert.ok(first.nextCursor);
  const second = await reader.list('alice', 'repo', undefined, first.nextCursor!, 1); assert.equal(second.entries[0]!.name, 'b');
  await writeFile(join(dir, 'root', 'c'), ''); await assert.rejects(reader.list('alice', 'repo', undefined, first.nextCursor!, 1), /stale/);
  await assert.rejects(reader.list('alice', 'repo', undefined, undefined, 201), /limit/);
}));
test('cross-owner, forged path, revoked registration and replaced root fail closed', async () => fixture(async (reader, dir, revoke) => {
  await assert.rejects(reader.list('bob', 'repo'), /forbidden/); await assert.rejects(reader.list('alice', 'repo', '../../outside'), /path/);
  await rename(join(dir, 'root'), join(dir, 'old-root')); await mkdir(join(dir, 'root'));
  await assert.rejects(reader.list('alice', 'repo'), /root-replaced/); revoke(); await assert.rejects(reader.list('alice', 'repo'), /forbidden/);
}));
test('explicit preview returns bounded plain UTF-8 and exact byte hash, never paths', async () => fixture(async (reader, dir) => {
  const body = '<img src="https://invalid.example/image">\n中文\ttext';
  await writeFile(join(dir, 'root', 'a.txt'), body);
  const page = await reader.list('alice', 'repo'), token = page.entries[0]!.pathToken;
  assert.ok(!JSON.stringify(page).includes(body));
  const preview = await reader.preview('alice', 'repo', token);
  assert.equal(preview.text, body); assert.equal(preview.bytes, Buffer.byteLength(body));
  assert.equal(preview.contentHash, createHash('sha256').update(body).digest('hex'));
  assert.ok(!JSON.stringify(preview).includes(dir));
  await assert.rejects(reader.preview('bob', 'repo', token));
  await assert.rejects(reader.preview('alice', 'repo', '../../outside'));
}));
test('preview rejects binary, invalid UTF-8, excessive size and non-file tokens', async () => fixture(async (reader, dir) => {
  await writeFile(join(dir, 'root', 'binary'), Buffer.from([0, 1]));
  await writeFile(join(dir, 'root', 'invalid'), Buffer.from([0xff]));
  await writeFile(join(dir, 'root', 'large'), Buffer.alloc(128 * 1024 + 1, 65));
  await mkdir(join(dir, 'root', 'folder'));
  for (const entry of (await reader.list('alice', 'repo')).entries) await assert.rejects(reader.preview('alice', 'repo', entry.pathToken));
}));
test('preview rejects replacement symlink and FIFO without blocking, and revoked authority', async () => fixture(async (reader, dir, revoke) => {
  const path = join(dir, 'root', 'file'); await writeFile(path, 'body');
  const token = (await reader.list('alice', 'repo')).entries[0]!.pathToken;
  await rename(path, join(dir, 'saved')); await symlink(join(dir, 'saved'), path);
  await assert.rejects(reader.preview('alice', 'repo', token)); await rm(path);
  await promisify(execFile)('mkfifo', [path]);
  await assert.rejects(reader.preview('alice', 'repo', token), /unsupported/);
  revoke(); await assert.rejects(reader.preview('alice', 'repo', token), /forbidden/);
}));
