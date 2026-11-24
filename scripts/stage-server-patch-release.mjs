import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, cp, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCandidateRelease } from './stage-candidate-release.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (root, path) => path === root || path.startsWith(root + sep);

/** Stage explicitly reviewed compiled modules, retaining every other byte of a
 * pinned release. Does not deploy, change the active pointer, or delete files.
 */
export async function stageServerPatchRelease({ previous, expectedManifest, buildRoot, destination, patches }) {
  for (const path of [previous, buildRoot, destination]) assert.ok(isAbsolute(path), 'Absolute paths required');
  previous = await realpath(previous); buildRoot = await realpath(buildRoot);
  destination = join(await realpath(dirname(resolve(destination))), resolve(destination).split(sep).at(-1));
  for (const source of [previous, buildRoot]) {
    assert.ok(!within(source, destination) && !within(destination, source), 'Source and destination must be disjoint');
  }
  assert.ok(Array.isArray(patches) && patches.length > 0 && patches.length <= 16, 'Explicit bounded patch list required');
  assert.equal(new Set(patches.map(patch => patch.path)).size, patches.length, 'Duplicate patch');
  assert.equal((await verifyCandidateRelease(previous)).manifestSha256, expectedManifest, 'Previous release changed');
  const original = JSON.parse(await readFile(join(previous, 'candidate-manifest.json'), 'utf8'));
  const buffers = new Map();
  for (const patch of patches) {
    assert.match(patch.path, /^apps\/server\/dist\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.js$/);
    const exists = original.files.some(file => file.path === patch.path);
    assert.ok(patch.add === true ? !exists : exists,
      'New modules require explicit add:true; existing modules must be replacements');
    assert.match(patch.sha256, /^[a-f0-9]{64}$/);
    const path = await realpath(join(buildRoot, patch.path));
    assert.equal(path, join(buildRoot, patch.path), 'Patch must not use symlinks');
    const bytes = await readFile(path);
    assert.equal(sha256(bytes), patch.sha256, 'Build module changed');
    buffers.set(patch.path, bytes);
  }
  await mkdir(destination); // Never overwrite an earlier candidate.
  for (const entry of await readdir(previous)) {
    if (entry !== 'candidate-manifest.json') await cp(join(previous, entry), join(destination, entry),
      { recursive: true, force: false, errorOnExist: true });
  }
  for (const [path, bytes] of buffers) {
    const adding = patches.find(patch => patch.path === path).add === true;
    const modes = [];
    try {
      if (adding) {
        // Published releases have frozen directories. Temporarily make only
        // this new candidate's required ancestors writable; never the source.
        let parent = destination;
        for (const component of path.split('/').slice(0, -1)) {
          parent = join(parent, component);
          let info;
          try { info = await lstat(parent); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (info) {
            assert.ok(info.isDirectory() && !info.isSymbolicLink());
            const mode = info.mode & 0o777;
            modes.push([parent, mode]);
            await chmod(parent, mode | 0o700);
          } else await mkdir(parent, { mode: 0o700 });
        }
      } else await chmod(join(destination, path), 0o644);
      await writeFile(join(destination, path), bytes, adding ? { flag: 'wx' } : undefined);
      await chmod(join(destination, path), 0o444);
    } finally {
      for (const [parent, mode] of modes.reverse()) await chmod(parent, mode);
    }
  }
  const files = original.files.map(file => buffers.has(file.path)
    ? { path: file.path, bytes: buffers.get(file.path).length, sha256: sha256(buffers.get(file.path)) } : file);
  for (const patch of patches.filter(patch => patch.add === true)) {
    const bytes = buffers.get(patch.path);
    files.push({ path: patch.path, bytes: bytes.length, sha256: sha256(bytes) });
  }
  // Match the verifier's directory-first recursive ordering, including names
  // where punctuation sorts differently from a flat full-path comparison.
  files.sort((a, b) => {
    const left = a.path.split('/'), right = b.path.split('/');
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
      const order = left[index].localeCompare(right[index]);
      if (order) return order;
    }
    return left.length - right.length;
  });
  await writeFile(join(destination, 'candidate-manifest.json'), JSON.stringify({ ...original, status: 'staged-unverified', files }, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
  assert.equal((await verifyCandidateRelease(previous)).manifestSha256, expectedManifest, 'Previous release changed during staging');
  const result = await verifyCandidateRelease(destination); // Also checks exact inventory, not just listed files.
  return { destination, previous, previousManifest: expectedManifest, changed: patches.map(patch => patch.path), ...result };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3, 'Usage: node scripts/stage-server-patch-release.mjs NON_SECRET_PATCH_SPEC');
  console.log(JSON.stringify(await stageServerPatchRelease(JSON.parse(await readFile(process.argv[2], 'utf8')))));
}
