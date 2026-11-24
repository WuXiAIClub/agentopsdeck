import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { discoverScriptTests, selectScriptTests, scriptTestArguments } from './run-script-tests.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-script-manifest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('script discovery includes every nested mjs test and ignores source/build non-tests', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'lib'));
  for (const file of ['z.test.mjs', 'a.test.mjs', 'lib/nested.test.mjs', 'ordinary.mjs', 'stale.test.js'])
    await writeFile(join(root, file), '');
  assert.deepEqual(await discoverScriptTests(root), ['a.test.mjs', join('lib', 'nested.test.mjs'), 'z.test.mjs']);
});

test('empty and linked script trees cannot be counted as full coverage', async t => {
  const root = await fixture(t);
  await assert.rejects(discoverScriptTests(root), /No script tests/);
  const target = join(root, 'target'); await mkdir(target);
  await symlink(target, join(root, 'linked'), 'junction');
  await assert.rejects(discoverScriptTests(root), /refuses symbolic links/);
});

test('targeted script selections reject wildcards, flags, traversal and missing paths', () => {
  const files = ['a.test.mjs', 'lib/b.test.mjs'];
  assert.deepEqual(selectScriptTests(files), files);
  assert.deepEqual(selectScriptTests(files, ['lib/b.test.mjs', 'lib/b.test.mjs']), ['lib/b.test.mjs']);
  for (const requested of [['*.test.mjs'], ['../a.test.mjs'], ['--test-only'], ['missing.test.mjs'], null])
    assert.throws(() => selectScriptTests(files, requested), /exact discovered/);
});

test('script command always loads TypeScript from a URL and bounds test concurrency', () => {
  const loader = resolve('fixture with spaces', '#loader.mjs'), file = resolve('a.test.mjs');
  assert.deepEqual(scriptTestArguments(loader, [file]), [
    '--import', pathToFileURL(loader).href, '--test', '--test-reporter=tap', '--test-concurrency=1', file,
  ]);
  assert.throws(() => scriptTestArguments('tsx', [file]), /absolute workspace loader/);
  for (const files of [[], [file, file], ['relative.test.mjs']])
    assert.throws(() => scriptTestArguments(loader, files), /unique absolute test manifest/);
});
