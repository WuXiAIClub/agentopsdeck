import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertNoAdjacentJavaScript } from './source-shadow-guard.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-source-shadow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'nested'));
  return root;
}

for (const suffix of ['ts', 'tsx']) test(`nested old JS cannot shadow ${suffix}, and rejection preserves both files`, async t => {
  const root = await fixture(t), directory = join(root, 'nested');
  await writeFile(join(directory, 'module.' + suffix), 'current source');
  await writeFile(join(directory, 'module.js'), 'old output');
  await assert.rejects(assertNoAdjacentJavaScript(root), /Adjacent JavaScript shadows TypeScript source/);
  assert.equal(await readFile(join(directory, 'module.' + suffix), 'utf8'), 'current source');
  assert.equal(await readFile(join(directory, 'module.js'), 'utf8'), 'old output');
});

test('clean TS, explicit runtime mjs and independent JS remain valid', async t => {
  const root = await fixture(t);
  for (const name of ['module.ts', 'module.mjs', 'runtime.js', 'nested/other.tsx']) await writeFile(join(root, name), '');
  await assertNoAdjacentJavaScript(root);
});

test('linked trees cannot hide source shadows outside the frozen root', async t => {
  const root = await fixture(t);
  await symlink(join(root, 'nested'), join(root, 'alias'), 'dir');
  await assert.rejects(assertNoAdjacentJavaScript(root), /refuses symbolic links/);
});
