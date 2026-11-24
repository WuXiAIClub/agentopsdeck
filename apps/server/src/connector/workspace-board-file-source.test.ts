import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rename, symlink, link, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { BOARD_MAX_BODY_BYTES } from '@agentopsdeck/shared';
import { BoardFileSource, readBoardFile } from './workspace-board-file-source.js';
import { boardFileContext, parseBoardFile, serializeBoardFile, type BoardFileSnapshot } from './workspace-board-file-format.js';

const content = () => ({ title: '项目进度', tasks: [{ id: randomUUID(), title: 'Review', detail: '', status: 'todo' as const }] });
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-file-board-')), id = randomUUID(), directory = join(root, id);
  await mkdir(directory, { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, id, directory, path: join(directory, 'tasks.json') };
}
async function until(condition: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!condition()) { if (Date.now() >= deadline) assert.fail('File change did not arrive'); await delay(10); }
}
test('file format is versioned, strict, bounded, UTF8 and whitespace-independent', () => {
  const board = content(), serialized = serializeBoardFile(board), parsed = parseBoardFile(Buffer.from(serialized));
  assert.deepEqual(parsed?.content, board);
  assert.equal(parseBoardFile(Buffer.from(JSON.stringify(JSON.parse(serialized))))?.hash, parsed?.hash);
  for (const value of [null, [], {}, { ...board, version: 2 }, { ...board, version: 1, command: 'execute' },
    { ...board, version: 1, tasks: [board.tasks[0], board.tasks[0]] },
    { ...board, version: 1, tasks: [{ ...board.tasks[0], status: 'running' }] }]) {
    assert.equal(parseBoardFile(Buffer.from(JSON.stringify(value))), undefined);
  }
  assert.equal(parseBoardFile(Buffer.from([0xff, 0xfe])), undefined);
  assert.equal(parseBoardFile(Buffer.alloc(BOARD_MAX_BODY_BYTES + 1, 32)), undefined);
  const context = boardFileContext('/work/board/tasks.json');
  assert.match(context, /No API or credentials/); assert.match(context, /stable UUID/);
  assert.throws(() => boardFileContext('/work/\ninject'), /path/);
});
test('safe reader rejects traversal, symlinks, hard links, directories and oversized files', async t => {
  const f = await fixture(t), text = serializeBoardFile(content()), outside = join(f.root, 'other.json');
  assert.equal((await readBoardFile(f.root, '../other')).state, 'unsafe');
  assert.equal((await readBoardFile('/', f.id)).state, 'unsafe');
  assert.equal((await readBoardFile(f.root, f.id)).state, 'missing');
  await writeFile(outside, text);
  await symlink(outside, f.path);
  assert.equal((await readBoardFile(f.root, f.id)).state, 'unsafe');
  await rm(f.path); await link(outside, f.path);
  assert.equal((await readBoardFile(f.root, f.id)).state, 'unsafe');
  await rm(f.path); await mkdir(f.path);
  assert.equal((await readBoardFile(f.root, f.id)).state, 'unsafe');
  await rm(f.path, { recursive: true }); await writeFile(f.path, Buffer.alloc(BOARD_MAX_BODY_BYTES + 1));
  assert.equal((await readBoardFile(f.root, f.id)).state, 'too-large');
  await writeFile(f.path, text);
  assert.equal((await readBoardFile(f.root, f.id)).state, 'ready');
  await rename(f.directory, join(f.root, 'moved')); await symlink(join(f.root, 'moved'), f.directory);
  assert.equal((await readBoardFile(f.root, f.id)).state, 'unsafe');
});
test('watcher retains last good state, deduplicates unchanged checks, recovers and closes', async t => {
  const f = await fixture(t), board = content();
  await writeFile(f.path, serializeBoardFile(board));
  const source = new BoardFileSource(f.root, f.id, { debounceMs: 5 }), seen: BoardFileSnapshot[] = [];
  t.after(() => source.close()); source.subscribe(value => seen.push(value));
  source.subscribe(() => { throw new Error('broken observer'); });
  await source.start(); assert.equal(seen.length, 1);
  await Promise.all(Array.from({ length: 50 }, () => source.refresh())); assert.equal(seen.length, 1);
  const original = source.current().value!.hash;
  const exposed = source.current(); exposed.value!.content.title = 'mutated by observer';
  assert.equal(source.current().value!.content.title, board.title);
  await writeFile(f.path, '{"version":1');
  await until(() => source.current().state === 'invalid');
  assert.equal(source.current().value?.hash, original);
  await writeFile(join(f.directory, 'replace.json'), serializeBoardFile({ ...board, title: 'Updated' }));
  await rename(join(f.directory, 'replace.json'), f.path);
  await until(() => source.current().state === 'ready' && source.current().value?.content.title === 'Updated');
  assert.notEqual(source.current().value?.hash, original);
  await source.close(); const count = seen.length;
  await writeFile(f.path, serializeBoardFile(board)); await source.refresh();
  assert.equal(seen.length, count);
});
test('periodic reconciliation recovers missing files and replaced directories without chat reads', async t => {
  const f = await fixture(t), source = new BoardFileSource(f.root, f.id, { reconcileMs: 25, debounceMs: 0 });
  t.after(() => source.close()); await source.start();
  assert.equal(source.current().state, 'missing');
  await rename(f.directory, join(f.root, 'old')); await mkdir(f.directory, { mode: 0o700 });
  await writeFile(f.path, serializeBoardFile(content()));
  await until(() => source.current().state === 'ready');
  assert.equal(source.current().value?.content.title, '项目进度');
});
