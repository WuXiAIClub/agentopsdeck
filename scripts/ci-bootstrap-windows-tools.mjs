import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyIntegrity } from './ci-bootstrap-pnpm.mjs';
import { boundedArchiveTransfer } from './bounded-archive-transfer.mjs';

// Derived from the complete official archive after its published SHA-256 passed.
export const ZIG_REFERENCE = Object.freeze({
  archiveSha256: '24aeeec8af16c381934a6cd7d95c807a8cb2cf7df9fa40d359aa884195c4716c',
  compilerSha256: '9df4f1d2eaa7c6ee7649d0e13853ad40deed5d94e643e9ff2a2bab52ffd9feee',
  libFiles: 14669,
  libManifestSha256: 'c18f0d0a2eb947ae6c81d0de4a96e18295c2eaa6a80fd7ab27e661a957771166',
});
export const TOOL_ARCHIVES = Object.freeze([
  Object.freeze({ name: '@zigc/linux-x64', version: '0.14.1',
    url: 'https://registry.npmjs.org/@zigc/linux-x64/-/linux-x64-0.14.1.tgz',
    integrity: 'sha512-CfmTVxFykxf3ZjBKzFLlXvm5jX/Ru1PTFgja6UBWd6zeZ/Lu+otladqp8RelBATv8gqpDqM37XnOvQW/2Ye+fw==' }),
  Object.freeze({ name: '@zigc/lib', version: '0.14.1',
    url: 'https://registry.npmjs.org/@zigc/lib/-/lib-0.14.1.tgz',
    integrity: 'sha512-N1yHP572u2DAFnl+KHAoLotlAOGnfTuv9FN0pU396x9Tqv60TYw5tdNtIFva5ZcryRxLZyZ/t1xaLyHGnCloqg==' }),
  Object.freeze({ name: '@esbuild/linux-x64', version: '0.28.2',
    url: 'https://registry.npmjs.org/@esbuild/linux-x64/-/linux-x64-0.28.2.tgz',
    integrity: 'sha512-4xTZr1FUmSoQW4XIWmit3tzQrUTZM+N3P0XV8xROKYF50XfI7xeO90+1bZvNwxIufQ9hDQVRJH5YhgPVF8A/HQ==' }),
]);
export function toolDownloadArguments(pin, file) {
  return ['--fail', '--location', '--silent', '--show-error', '--connect-timeout', '15',
    '--max-time', '180', '--continue-at', '-', '--output', file, pin.url];
}
export async function downloadToolArchive(pin, file, transfer = args =>
  boundedArchiveTransfer(args, file, 128 * 1024 * 1024)) {
  await writeFile(file, '', { flag: 'wx', mode: 0o600 });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await transfer(toolDownloadArguments(pin, file));
    const bytes = (await lstat(file)).size;
    assert.ok(bytes <= 128 * 1024 * 1024, 'Tool archive exceeds its bound');
    if (result.error || result.signal || ![0, 28].includes(result.status)) {
      throw new Error(`Immutable tool download failed: exit=${result.status}, signal=${result.signal}`, { cause: result.error });
    }
    if (result.status === 0) return;
    if (attempt === 3) throw new Error(`Immutable tool download exhausted its bounded resume attempts at ${bytes} bytes`);
    console.warn(`Read-only tool archive timed out at ${bytes} bytes; resuming the same immutable URL (attempt ${attempt + 1}/3).`);
  }
}
export async function fileSha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function treeIdentity(root, ignored = []) {
  assert.ok((await lstat(root)).isDirectory(), 'Tool library must be a real directory');
  const files = [];
  const visit = async (directory, relative = '') => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert.ok(entry.isDirectory() || entry.isFile(), 'Tool library refuses links and special files');
      if (!relative && ignored.includes(entry.name)) continue;
      const file = join(directory, entry.name), path = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory()) await visit(file, path);
      else files.push({ path, bytes: (await lstat(file)).size, sha256: await fileSha256(file) });
      assert.ok(files.length <= 20_000, 'Tool library exceeds its file bound');
    }
  };
  await visit(root);
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { files: files.length, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}
export function validateArchiveEntries(names, types) {
  const entries = names.trim().split('\n');
  assert.ok(entries.length > 0 && entries.length <= 20_000 && new Set(entries).size === entries.length);
  for (const entry of entries) {
    assert.ok(entry.startsWith('package/') && !/[\\\x00-\x1f\x7f]/.test(entry)
      && !entry.split('/').includes('..'), 'Tool archive path is not a package-relative path');
  }
  const entriesWithTypes = types.trim().split('\n');
  assert.equal(entriesWithTypes.length, entries.length, 'Tool archive listings differ');
  assert.ok(entriesWithTypes.every(line => /^[-d]/.test(line)), 'Tool archives refuse links and special files');
}
export async function bootstrapWindowsTools(root = resolve('.ci-tools')) {
  assert.equal(process.platform, 'linux', 'Windows cross-build bootstrap requires Linux');
  assert.equal(process.arch, 'x64', 'Windows cross-build bootstrap requires x64');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'windows-bootstrap-'));
  const run = (command, args, capture = false) => {
    const result = spawnSync(command, args, { stdio: capture ? 'pipe' : 'inherit',
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 600_000 });
    if (result.error || result.signal || result.status !== 0) {
      throw new Error(`Windows tool bootstrap failed: ${command}, exit=${result.status}, signal=${result.signal}`, { cause: result.error });
    }
    return result.stdout;
  };
  try {
    const packages = [];
    for (const [index, pin] of TOOL_ARCHIVES.entries()) {
      const archive = join(directory, `${index}.tgz`), extracted = join(directory, String(index));
      await downloadToolArchive(pin, archive);
      verifyIntegrity(await readFile(archive), pin.integrity);
      validateArchiveEntries(run('tar', ['-tzf', archive], true), run('tar', ['-tvzf', archive], true));
      await mkdir(extracted);
      run('tar', ['-xzf', archive, '--strip-components=1', '--no-same-owner', '-C', extracted]);
      const identity = JSON.parse(await readFile(join(extracted, 'package.json'), 'utf8'));
      assert.equal(identity.name, pin.name); assert.equal(identity.version, pin.version);
      packages.push(extracted);
    }
    assert.equal(await fileSha256(join(packages[0], 'bin/zig')), ZIG_REFERENCE.compilerSha256, 'Compiler differs from official Zig');
    assert.deepEqual(await treeIdentity(packages[1], ['package.json', 'README.md']),
      { files: ZIG_REFERENCE.libFiles, sha256: ZIG_REFERENCE.libManifestSha256 }, 'Library differs from official Zig');
    const zig = join(root, 'zig-x86_64-linux-0.14.1');
    await mkdir(zig);
    await rename(join(packages[0], 'bin/zig'), join(zig, 'zig'));
    await unlink(join(packages[1], 'package.json')); await unlink(join(packages[1], 'README.md'));
    await rename(packages[1], join(zig, 'lib'));
    const esbuild = join(root, 'esbuild/node_modules/@esbuild/linux-x64');
    await mkdir(join(root, 'esbuild/node_modules/@esbuild'), { recursive: true });
    await mkdir(esbuild);
    await rename(packages[2], esbuild);
    await chmod(join(zig, 'zig'), 0o755); await chmod(join(esbuild, 'bin/esbuild'), 0o755);
    console.log('Zig 0.14.1 compiler and all 14669 library files equal the verified official archive; esbuild 0.28.2 integrity verified. No package scripts executed.');
  } finally { await rm(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await bootstrapWindowsTools();
