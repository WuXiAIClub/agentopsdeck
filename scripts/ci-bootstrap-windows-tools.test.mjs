import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TOOL_ARCHIVES, ZIG_REFERENCE, treeIdentity, validateArchiveEntries, toolDownloadArguments, downloadToolArchive } from './ci-bootstrap-windows-tools.mjs';

test('Windows tools pin immutable registry releases and independent official Zig identity', () => {
  assert.equal(ZIG_REFERENCE.archiveSha256, '24aeeec8af16c381934a6cd7d95c807a8cb2cf7df9fa40d359aa884195c4716c');
  assert.equal(ZIG_REFERENCE.compilerSha256, '9df4f1d2eaa7c6ee7649d0e13853ad40deed5d94e643e9ff2a2bab52ffd9feee');
  assert.equal(ZIG_REFERENCE.libManifestSha256, 'c18f0d0a2eb947ae6c81d0de4a96e18295c2eaa6a80fd7ab27e661a957771166');
  assert.equal(ZIG_REFERENCE.libFiles, 14669);
  assert.deepEqual(TOOL_ARCHIVES.map(pin => [pin.name, pin.version]),
    [['@zigc/linux-x64', '0.14.1'], ['@zigc/lib', '0.14.1'], ['@esbuild/linux-x64', '0.28.2']]);
  for (const pin of TOOL_ARCHIVES) {
    assert.ok(pin.url.startsWith('https://registry.npmjs.org/'));
    assert.ok(pin.url.endsWith(`-${pin.version}.tgz`));
    assert.match(pin.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
  }
});
test('tool archive validation rejects traversal, foreign prefixes, duplicate names and links', () => {
  assert.doesNotThrow(() => validateArchiveEntries('package/bin/zig\npackage/package.json\n', '-rwxr-xr-x zig\n-rw-r--r-- metadata\n'));
  for (const names of ['../outside', '/package/absolute', 'package/../outside', 'foreign/file', 'package/a\\b',
    'package/a\npackage/a', '']) assert.throws(() => validateArchiveEntries(names, '-rw-r--r-- file'));
  for (const type of ['l', 'h', 'p', 'c', 'b']) assert.throws(() => validateArchiveEntries('package/file', type + 'rwxrwxrwx file'));
});
test('immutable tool download resumes partial bytes without restarting or retrying non-transport failures', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tool-resume-')); t.after(() => rm(root, { recursive: true, force: true }));
  const pin = TOOL_ARCHIVES[0], file = join(root, 'archive.tgz'), offsets = [];
  const args = toolDownloadArguments(pin, file);
  assert.equal(args[args.indexOf('--continue-at') + 1], '-');
  assert.equal(args.includes('--retry'), false); assert.equal(args.includes('--insecure'), false);
  await downloadToolArchive(pin, file, async actual => {
    assert.deepEqual(actual, args);
    const before = await readFile(file); offsets.push(before.length);
    await writeFile(file, Buffer.concat([before, Buffer.from('abc')]));
    return { status: offsets.length === 3 ? 0 : 28, signal: null };
  });
  assert.deepEqual(offsets, [0, 3, 6]); assert.equal((await readFile(file)).toString(), 'abcabcabc');
  let attempts = 0;
  await assert.rejects(downloadToolArchive(pin, join(root, 'http-failure'), () => {
    attempts++; return { status: 22, signal: null };
  }), /Immutable tool download failed/);
  assert.equal(attempts, 1);
  attempts = 0;
  await assert.rejects(downloadToolArchive(pin, join(root, 'timeout'), () => {
    attempts++; return { status: 28, signal: null };
  }), /bounded resume attempts/);
  assert.equal(attempts, 3);
});
test('official library identity binds every relative path, byte and file count', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tool-identity-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'std')); await writeFile(join(root, 'std', 'lib.zig'), 'original');
  const original = await treeIdentity(root); assert.equal(original.files, 1);
  await writeFile(join(root, 'package.json'), 'metadata');
  assert.deepEqual(await treeIdentity(root, ['package.json']), original);
  assert.notDeepEqual(await treeIdentity(root), original);
  await writeFile(join(root, 'std', 'lib.zig'), 'changed');
  assert.notEqual((await treeIdentity(root, ['package.json'])).sha256, original.sha256);
});
test('official library identity refuses symbolic links', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'tool-link-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'original'), 'bytes'); await symlink('original', join(root, 'linked'));
  await assert.rejects(treeIdentity(root), /refuses links/);
});
