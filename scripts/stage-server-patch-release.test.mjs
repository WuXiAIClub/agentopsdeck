import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { stageServerPatchRelease } from './stage-server-patch-release.mjs';

test('server patch pins individual modules and preserves all unrelated release bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-server-patch-'));
  t.after(async () => {
    // Only thaw this test's disposable directories; never follow fixture symlinks.
    const thaw = async directory => {
      await chmod(directory, 0o700);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) await thaw(join(directory, entry.name));
      }
    };
    await thaw(root);
    await rm(root, { recursive: true, force: true });
  });
  const previous = join(root, 'previous'), buildRoot = join(root, 'build'), destination = join(root, 'candidate');
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const entries = [['apps/server/dist/index.js', 'old'], ['apps/server/dist/unrelated.js', 'keep'], ['apps/web/dist/index.html', 'web']];
  for (const [path, text] of entries) {
    await mkdir(join(previous, path, '..'), { recursive: true });
    await writeFile(join(previous, path), text);
  }
  const manifest = JSON.stringify({ format: 1, entrypoint: 'apps/server/dist/index.js', files: entries.map(([path, text]) => ({ path, bytes: text.length, sha256: digest(text) })) });
  await writeFile(join(previous, 'candidate-manifest.json'), manifest);
  await mkdir(join(buildRoot, 'apps/server/dist'), { recursive: true });
  await writeFile(join(buildRoot, 'apps/server/dist/index.js'), 'fixed');
  await writeFile(join(buildRoot, 'apps/server/dist/unrelated.js'), 'unreviewed');
  const spec = { previous, buildRoot, destination, expectedManifest: digest(manifest), patches: [{ path: entries[0][0], sha256: digest('fixed') }] };
  await assert.rejects(stageServerPatchRelease({ ...spec, expectedManifest: '0'.repeat(64) }), /Previous release changed/);
  await assert.rejects(stageServerPatchRelease({ ...spec, patches: [{ ...spec.patches[0], sha256: '0'.repeat(64) }] }), /Build module changed/);
  await assert.rejects(stageServerPatchRelease({ ...spec, patches: [{ path: 'apps/server/dist/../index.js', sha256: digest('fixed') }] }));
  for (const patches of [[], Array(17).fill(spec.patches[0]), [spec.patches[0], spec.patches[0]],
    [{ path: 'apps/server/dist/new-module.js', sha256: digest('fixed') }],
    [{ path: 'apps/web/dist/index.html', sha256: digest('fixed') }]]) {
    await assert.rejects(stageServerPatchRelease({ ...spec, patches }));
  }
  for (const unsafeDestination of [previous, buildRoot, join(previous, 'nested'), join(buildRoot, 'nested'), 'relative']) {
    await assert.rejects(stageServerPatchRelease({ ...spec, destination: unsafeDestination }));
  }
  const linkedBuild = join(root, 'linked-build');
  await mkdir(join(linkedBuild, 'apps/server/dist'), { recursive: true });
  await symlink(join(buildRoot, entries[0][0]), join(linkedBuild, entries[0][0]));
  await assert.rejects(stageServerPatchRelease({ ...spec, buildRoot: linkedBuild }), /symlinks/);
  const result = await stageServerPatchRelease(spec);
  assert.deepEqual(result.changed, [entries[0][0]]);
  assert.equal(await readFile(join(destination, entries[0][0]), 'utf8'), 'fixed');
  for (const [path, text] of entries.slice(1)) assert.equal(await readFile(join(destination, path), 'utf8'), text);
  assert.equal(await readFile(join(previous, entries[0][0]), 'utf8'), 'old');
  await assert.rejects(stageServerPatchRelease(spec), /EEXIST/);
  await writeFile(join(buildRoot, 'apps/server/dist/new-module.js'), 'new');
  await assert.rejects(stageServerPatchRelease({ ...spec, patches: [{ ...spec.patches[0], add: true }] }), /explicit add/);
  const added = await stageServerPatchRelease({ ...spec, destination: join(root, 'with-addition'), patches: [
    ...spec.patches, { path: 'apps/server/dist/new-module.js', sha256: digest('new'), add: true },
  ] });
  assert.equal(await readFile(join(added.destination, 'apps/server/dist/new-module.js'), 'utf8'), 'new');
  assert.equal(await readFile(join(added.destination, 'apps/server/dist/unrelated.js'), 'utf8'), 'keep');
  const directories = ['apps', 'apps/server', 'apps/server/dist', 'apps/web', 'apps/web/dist'];
  for (const dir of directories) await chmod(join(previous, dir), 0o555);
  await mkdir(join(buildRoot, 'apps/server/dist/child'), { recursive: true });
  await writeFile(join(buildRoot, 'apps/server/dist/child/helper.js'), 'nested');
  const frozen = await stageServerPatchRelease({ ...spec, destination: join(root, 'from-frozen'), patches: [
    ...spec.patches,
    { path: 'apps/server/dist/new-module.js', sha256: digest('new'), add: true },
    { path: 'apps/server/dist/child/helper.js', sha256: digest('nested'), add: true },
  ] });
  for (const dir of directories) {
    assert.equal((await stat(join(previous, dir))).mode & 0o777, 0o555, 'Source stays frozen');
    assert.equal((await stat(join(frozen.destination, dir))).mode & 0o777, 0o555, 'Candidate permissions restored');
  }
  assert.equal(await readFile(join(frozen.destination, 'apps/server/dist/child/helper.js'), 'utf8'), 'nested');
  assert.equal(await readFile(join(frozen.destination, 'apps/server/dist/new-module.js'), 'utf8'), 'new');
  assert.equal(await readFile(join(previous, entries[0][0]), 'utf8'), 'old');
});
