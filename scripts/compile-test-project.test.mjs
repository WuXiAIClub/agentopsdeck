import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { emitProjectInChild, freshCompilerOptions } from './compile-test-project.mjs';

async function fixture(t, source) {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-compiler space-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'ESNext', rootDir: 'src', types: [], skipLibCheck: true,
  }, include: ['src'] }));
  await writeFile(join(root, 'src', 'example.ts'), source);
  return { root, output: join(root, 'compiled output') };
}

test('compiler has exited and emitted the requested project before returning', async t => {
  const f = await fixture(t, 'export const result: number = 7;');
  const receipt = emitProjectInChild(f.root, f.output);
  assert.equal(receipt.code, 0); assert.equal(receipt.signal, null);
  assert.notEqual(receipt.pid, process.pid);
  assert.throws(() => process.kill(receipt.pid, 0), { code: 'ESRCH' });
  assert.match(await readFile(join(f.output, 'example.js'), 'utf8'), /result = 7/);
});

test('real compiler failure prevents the next stage and cannot reuse stale output', async t => {
  const f = await fixture(t, 'export const result: number = "invalid";');
  let dispatched = false;
  assert.throws(() => { emitProjectInChild(f.root, f.output); dispatched = true; }, /Compiler child failed/);
  assert.equal(dispatched, false);
  await assert.rejects(access(join(f.output, 'example.js')), { code: 'ENOENT' });
});

test('compiler rejects ambiguous paths and never mutates caller options', () => {
  assert.throws(() => emitProjectInChild('relative', '/unused'), /absolute/);
  assert.throws(() => emitProjectInChild('/unused', '/unused', 'relative'), /declaration/);
  assert.throws(() => emitProjectInChild('/unused', '/unused', undefined, 'yes'), /policy/);
  const parsed = { options: { incremental: true, composite: true, noEmit: true,
    tsBuildInfoFile: '/old/build', paths: { '@agentopsdeck/shared': ['old'], other: ['kept'] } } };
  const original = structuredClone(parsed);
  const options = freshCompilerOptions(parsed, '/fresh', '/shared/index.d.ts');
  assert.deepEqual(parsed, original);
  assert.equal(options.noEmitOnError, true); assert.equal(options.incremental, false);
  assert.equal(options.composite, false); assert.equal(options.noEmit, false);
  assert.equal(Object.hasOwn(options, 'tsBuildInfoFile'), false);
  assert.deepEqual(options.paths, { '@agentopsdeck/shared': ['/shared/index.d.ts'], other: ['kept'] });
});
