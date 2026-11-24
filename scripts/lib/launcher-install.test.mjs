import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, readdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { installLauncher } from './launcher-install.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-launcher-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'live.mjs'), source = join(root, 'next.mjs');
  await writeFile(target, 'before'); await writeFile(source, 'after');
  return { root, target, source };
}
test('atomic launcher replacement, private mode and exact restore', async t => {
  const {root, target, source} = await fixture(t);
  await installLauncher(target, source, hash('before'), hash('after'));
  assert.equal(await readFile(target, 'utf8'), 'after');
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  await writeFile(source, 'before');
  await installLauncher(target, source, hash('after'), hash('before'));
  assert.equal(await readFile(target, 'utf8'), 'before');
  assert.deepEqual((await readdir(root)).sort(), ['live.mjs', 'next.mjs']);
});
for (const field of ['expected', 'desired']) test('rejects changed ' + field + ' without replacing target', async t => {
  const {target, source} = await fixture(t);
  await assert.rejects(installLauncher(target, source, hash(field === 'expected' ? 'wrong' : 'before'), hash(field === 'desired' ? 'wrong' : 'after')));
  assert.equal(await readFile(target, 'utf8'), 'before');
});
test('rejects symlink targets', async t => {
  const {root, target, source} = await fixture(t);
  const link = join(root, 'link'); await symlink(target, link);
  await assert.rejects(installLauncher(link, source, hash('before'), hash('after')));
  assert.equal(await readFile(target, 'utf8'), 'before');
});
