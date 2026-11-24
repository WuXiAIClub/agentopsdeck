import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import fsPromises, { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { syncUpdateJournal, writeUpdateJournal } from './update-journal.js';

async function fixture(context: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'agentopsdeck-update-journal-'));
  const directory = join(root, 'state');
  await mkdir(directory);
  const file = join(directory, 'update.json');
  await writeFile(file, 'original');
  context.after(async () => {
    context.mock.restoreAll(); syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  });
  return { root, directory, file };
}

for (const point of ['mkdir', 'open', 'write', 'close'] as const) {
  test(`journal owner loss after ${point} await preserves the original journal and never renames`, async context => {
    const setup = await fixture(context);
    let held = true, renames = 0;
    const assertOwner = () => { if (!held) throw Error('original lock owner unavailable'); };
    const originalMkdir = fsPromises.mkdir, originalOpen = fsPromises.open;
    context.mock.method(fsPromises, 'mkdir', async (...args: Parameters<typeof originalMkdir>) => {
      const value = await originalMkdir(...args);
      if (point === 'mkdir') held = false;
      return value;
    });
    context.mock.method(fsPromises, 'open', async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      if (point === 'open') held = false;
      const write = handle.writeFile.bind(handle), close = handle.close.bind(handle);
      context.mock.method(handle, 'writeFile', async (...values: Parameters<typeof write>) => {
        const value = await write(...values);
        if (point === 'write') held = false;
        return value;
      });
      context.mock.method(handle, 'close', async () => {
        await close();
        if (point === 'close') held = false;
      });
      return handle;
    });
    context.mock.method(fsPromises, 'rename', async () => { renames++; assert.fail('stale writer renamed journal'); });
    syncBuiltinESMExports();
    await assert.rejects(writeUpdateJournal(setup.file, 'stale replacement', assertOwner), /original lock owner unavailable/);
    assert.equal(renames, 0);
    assert.equal(await readFile(setup.file, 'utf8'), 'original');
    assert.deepEqual(await readdir(setup.directory), ['update.json']);
  });
}

test('update journal synchronizes private data before replacement and ancestors before acknowledgement', async context => {
  const setup = await fixture(context);
  const originalOpen = fsPromises.open, originalRename = fsPromises.rename;
  const events: string[] = [];
  context.mock.method(fsPromises, 'open', async (...args: Parameters<typeof originalOpen>) => {
    const file = String(args[0]);
    const handle = await originalOpen(...args);
    const originalSync = handle.sync.bind(handle), originalClose = handle.close.bind(handle);
    if (file.startsWith(`${setup.file}.tmp-`)) {
      assert.equal(args[1], 'wx');
      assert.equal((await handle.stat()).mode & 0o777, 0o600);
    } else assert.equal(args[1], constants.O_RDONLY | constants.O_DIRECTORY);
    context.mock.method(handle, 'sync', async () => { events.push(`sync:${file}`); await originalSync(); });
    context.mock.method(handle, 'close', async () => { await originalClose(); events.push(`close:${file}`); });
    return handle;
  });
  context.mock.method(fsPromises, 'rename', async (...args: Parameters<typeof originalRename>) => {
    assert.equal(await readFile(setup.file, 'utf8'), 'original');
    events.push('rename');
    return originalRename(...args);
  });
  syncBuiltinESMExports();
  await writeUpdateJournal(setup.file, 'replacement');
  assert.match(events[0]!, /^sync:.*update.json.tmp-/);
  assert.equal(events[1], events[0]!.replace('sync:', 'close:'));
  assert.equal(events[2], 'rename');
  let directory = setup.directory;
  const expected = events.slice(0, 3);
  while (true) {
    expected.push(`sync:${directory}`, `close:${directory}`);
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  assert.deepEqual(events, expected);
  assert.equal(await readFile(setup.file, 'utf8'), 'replacement');
  assert.equal((await stat(setup.file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(setup.directory), ['update.json']);
});

for (const point of ['file-open', 'file-write', 'file-sync', 'file-close', 'rename', 'directory-open', 'directory-sync', 'directory-close', 'ancestor-sync'] as const) {
  test(`update journal ${point} failure never acknowledges and closes all opened handles`, async context => {
    const setup = await fixture(context);
    const originalOpen = fsPromises.open, originalRename = fsPromises.rename;
    const handles = new Set<Awaited<ReturnType<typeof originalOpen>>>();
    let failed = false;
    const fail = () => { failed = true; throw new Error('synthetic durability failure'); };
    context.mock.method(fsPromises, 'open', async (...args: Parameters<typeof originalOpen>) => {
      const file = String(args[0]);
      const temporary = file.startsWith(`${setup.file}.tmp-`);
      if (!failed && ((temporary && point === 'file-open') || (file === setup.directory && point === 'directory-open'))) fail();
      const handle = await originalOpen(...args);
      handles.add(handle);
      const originalWrite = handle.writeFile.bind(handle), originalSync = handle.sync.bind(handle), originalClose = handle.close.bind(handle);
      context.mock.method(handle, 'writeFile', async (...values: Parameters<typeof originalWrite>) => {
        if (!failed && temporary && point === 'file-write') fail();
        return originalWrite(...values);
      });
      context.mock.method(handle, 'sync', async () => {
        if (!failed && ((temporary && point === 'file-sync') || (file === setup.directory && point === 'directory-sync')
          || (file === setup.root && point === 'ancestor-sync'))) fail();
        return originalSync();
      });
      context.mock.method(handle, 'close', async () => {
        await originalClose(); handles.delete(handle);
        if (!failed && ((temporary && point === 'file-close') || (file === setup.directory && point === 'directory-close'))) fail();
      });
      return handle;
    });
    context.mock.method(fsPromises, 'rename', async (...args: Parameters<typeof originalRename>) => {
      if (!failed && point === 'rename') fail();
      return originalRename(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(writeUpdateJournal(setup.file, 'replacement'), /synthetic durability failure/);
    assert.equal(failed, true);
    assert.equal(handles.size, 0);
    const replaced = point.startsWith('directory-') || point === 'ancestor-sync';
    assert.equal(await readFile(setup.file, 'utf8'), replaced ? 'replacement' : 'original');
    assert.deepEqual(await readdir(setup.directory), ['update.json']);
    await syncUpdateJournal(setup.file);
    assert.equal(handles.size, 0);
    assert.equal(await readFile(setup.file, 'utf8'), replaced ? 'replacement' : 'original');
  });
}

test('journal recovery refuses non-files and symlinks without replacing their evidence', async context => {
  const setup = await fixture(context);
  const alias = join(setup.directory, 'alias');
  await symlink(setup.file, alias);
  await assert.rejects(syncUpdateJournal(alias), { code: 'ELOOP' });
  await assert.rejects(syncUpdateJournal(setup.directory), /not a regular file/);
  assert.equal(await readFile(setup.file, 'utf8'), 'original');
});

test('journal write creates nested state directories and recovery does not rewrite content', async context => {
  const setup = await fixture(context);
  const file = join(setup.root, 'new', 'nested', 'update.json');
  await writeUpdateJournal(file, 'original identity');
  const before = await stat(file);
  await syncUpdateJournal(file);
  const after = await stat(file);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(await readFile(file, 'utf8'), 'original identity');
});
