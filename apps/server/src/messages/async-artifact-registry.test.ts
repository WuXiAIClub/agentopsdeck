import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs, { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncArtifactRegistry } from './async-artifact-registry.js';
import { ArtifactRegistry, type ArtifactRecord } from './artifact-receiver.js';

const record = (id: number): ArtifactRecord => ({ id: id.toString(16).padStart(24, '0'), path: `/isolated/original-${id}`,
  name: `original-${id}.txt`, mimeType: 'text/plain', size: 123, mtimeMs: id, createdAt: id });
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'async-artifacts-')), file = join(root, 'index.json');
  t.after(() => rm(root, { recursive: true, force: true })); return { root, file };
}
test('async index serializes original writes and restarts with the legacy wire, preserving immutable callers', async t => {
  const { file } = await fixture(t), legacy = new ArtifactRegistry(file); legacy.upsert(record(1));
  const owner = await AsyncArtifactRegistry.open(file), original = record(2);
  const saved = owner.upsert(original); original.path = '/mutated-after-admission';
  await Promise.all([saved, ...Array.from({ length: 30 }, (_, i) => owner.upsert(record(i + 3)))]);
  const observed = owner.get(record(2).id)!; observed.path = '/mutated-read';
  assert.equal(owner.get(record(2).id)!.path, record(2).path);
  await owner.close(); await assert.rejects(owner.upsert(record(50)));
  const restarted = await AsyncArtifactRegistry.open(file);
  for (let i = 1; i <= 32; i++) assert.deepEqual(restarted.get(record(i).id), record(i));
  assert.deepEqual(new ArtifactRegistry(file).get(record(2).id), record(2));
  await restarted.close();
});
test('index close retains exact original rename ACK and publishes no record before atomic commit', async t => {
  const { file, root } = await fixture(t), owner = await AsyncArtifactRegistry.open(file);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), reached = new Promise<void>(resolve => { entered = resolve; });
  const original = fs.rename;
  const mocked = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === file) { entered(); await held; } return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const pending = owner.upsert(record(1)); await reached;
    assert.equal(owner.get(record(1).id), undefined);
    let drained = false; const closing = owner.close().then(() => { drained = true; });
    await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(drained, false);
    await assert.rejects(owner.upsert(record(2)));
    release(); await pending; await closing;
    assert.deepEqual(owner.get(record(1).id), record(1)); assert.deepEqual(await readdir(root), ['index.json']);
  } finally { release(); mocked.mock.restore(); syncBuiltinESMExports(); }
});
test('failed atomic replacement preserves original index, never publishes or replays uncertain write', async t => {
  const { file, root } = await fixture(t), owner = await AsyncArtifactRegistry.open(file);
  await owner.upsert(record(1)); const before = await readFile(file, 'utf8'); let calls = 0;
  const original = fs.rename;
  const mocked = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === file) { calls++; throw Error('isolated private disk error'); } return original(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(owner.upsert(record(2)), /^Error: Artifact index unavailable$/);
    assert.equal(owner.get(record(2).id), undefined); await assert.rejects(owner.upsert(record(3)));
    await assert.rejects(owner.close()); assert.equal(calls, 1);
    assert.equal(await readFile(file, 'utf8'), before); assert.deepEqual(await readdir(root), ['index.json']);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  const reopened = await AsyncArtifactRegistry.open(file); assert.deepEqual(reopened.get(record(1).id), record(1)); await reopened.close();
});
test('corrupt original artifact index is not erased or silently rewritten during asynchronous startup', async t => {
  const { file } = await fixture(t); await writeFile(file, '{original-corrupt');
  await assert.rejects(AsyncArtifactRegistry.open(file), /^Error: Artifact index unavailable$/);
  assert.equal(await readFile(file, 'utf8'), '{original-corrupt');
});
