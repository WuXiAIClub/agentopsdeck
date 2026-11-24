import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { DeckStore } from './deck-store.js';

const kinds = [
  { option: 'hiddenSessionsFile', set: 'hideSession', unset: 'unhideSession', has: 'isSessionHidden' },
  { option: 'archivedSessionsFile', set: 'archiveSession', unset: 'unarchiveSession', has: 'isSessionArchived' },
  { option: 'pinnedSessionsFile', set: 'pinSession', unset: 'unpinSession', has: 'isSessionPinned' },
] as const;
function fixture(t: TestContext, kind: typeof kinds[number], initial = ['old']) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'agentopsdeck-preference-persist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'preference.json');
  fs.writeFileSync(file, JSON.stringify(initial, null, 2), { mode: 0o640 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o640);
  const store = new DeckStore({ [kind.option]: file });
  store.upsertSession({ sessionKey: 'new', agentId: 'codex', title: 'New', status: 'idle' });
  return { dir, file, store, bytes: fs.readFileSync(file, 'utf8'), revision: store.latestEventId() };
}
function fault(t: TestContext, method: 'writeFileSync' | 'openSync' | 'fsyncSync' | 'closeSync' | 'renameSync' | 'fchmodSync' | 'mkdirSync', after = false) {
  const original = fs[method];
  let first = true;
  const mocked = t.mock.method(fs, method, (...args: unknown[]) => {
    if (!first) return (original as (...args: unknown[]) => unknown)(...args);
    first = false;
    if (after) (original as (...args: unknown[]) => unknown)(...args);
    if (method === 'writeFileSync') fs.writeFileSync(args[0] as number, 'partial private path');
    throw Object.assign(new Error('ENOSPC confidential location'), { code: 'ENOSPC' });
  });
  syncBuiltinESMExports();
  const restore = () => { mocked.mock.restore(); syncBuiltinESMExports(); };
  t.after(restore);
  return restore;
}
for (const kind of kinds) {
  for (const method of ['writeFileSync', 'openSync', 'fsyncSync', 'closeSync', 'renameSync', 'mkdirSync', ...(process.platform === 'win32' ? [] : ['fchmodSync' as const])] as const) {
    test(`${kind.option}: failed ${method} preserves saved bytes, memory and event revision`, t => {
      const f = fixture(t, kind); const restore = fault(t, method);
      assert.throws(() => f.store[kind.set]('new'));
      restore();
      assert.equal(f.store[kind.has]('new'), false);
      assert.equal(f.store[kind.has]('old'), true);
      assert.equal(fs.readFileSync(f.file, 'utf8'), f.bytes);
      assert.equal(f.store.latestEventId(), f.revision);
      assert.deepEqual(fs.readdirSync(f.dir), ['preference.json']);
    });
  }
  test(`${kind.option}: failed removal does not publish false success`, t => {
    const f = fixture(t, kind, ['new', 'old']); const restore = fault(t, 'writeFileSync');
    assert.throws(() => f.store[kind.unset]('new'));
    restore();
    assert.equal(f.store[kind.has]('new'), true);
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.bytes);
    assert.equal(f.store.latestEventId(), f.revision);
  });
  test(`${kind.option}: saved format, permissions and reopen remain compatible`, t => {
    const f = fixture(t, kind); f.store[kind.set]('new');
    assert.equal(fs.readFileSync(f.file, 'utf8'), JSON.stringify(['new', 'old'], null, 2));
    if (process.platform !== 'win32') assert.equal(fs.statSync(f.file).mode & 0o777, 0o640);
    assert.equal(new DeckStore({ [kind.option]: f.file })[kind.has]('new'), true);
    f.store[kind.unset]('new');
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), ['old']);
  });
  test(`${kind.option}: existing symlink remains a symlink and target is updated`, t => {
    const f = fixture(t, kind);
    const alias = join(f.dir, 'alias.json');
    fs.symlinkSync('preference.json', alias);
    const store = new DeckStore({ [kind.option]: alias });
    store[kind.set]('new');
    assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), ['new', 'old']);
  });
  test(`${kind.option}: lost rename acknowledgement never reports success; next explicit change reads persisted state`, t => {
    const f = fixture(t, kind); const restore = fault(t, 'renameSync', true);
    assert.throws(() => f.store[kind.set]('new'));
    restore();
    assert.equal(f.store.latestEventId(), f.revision);
    assert.equal(new DeckStore({ [kind.option]: f.file })[kind.has]('new'), true);
    f.store[kind.set]('third');
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), ['new', 'old', 'third']);
  });
  test(`${kind.option}: malformed durable state refuses overwrite instead of discarding saved preferences`, t => {
    const f = fixture(t, kind); fs.writeFileSync(f.file, '{broken');
    assert.throws(() => f.store[kind.set]('new'));
    assert.equal(fs.readFileSync(f.file, 'utf8'), '{broken');
    assert.equal(f.store[kind.has]('new'), false);
    assert.equal(f.store.latestEventId(), f.revision);
  });
  test(`${kind.option}: configured missing file supports first save with existing wire format`, t => {
    const f = fixture(t, kind); fs.unlinkSync(f.file);
    const store = new DeckStore({ [kind.option]: f.file });
    store[kind.set]('new');
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), ['new']);
  });
  test(`${kind.option}: legacy object representation remains readable and converts to sorted array`, t => {
    const f = fixture(t, kind); fs.writeFileSync(f.file, JSON.stringify({ old: true, legacy: false }));
    f.store[kind.set]('new');
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), ['legacy', 'new', 'old']);
  });
  test(`${kind.option}: dangling link refuses a save without replacing the link`, t => {
    const f = fixture(t, kind); const alias = join(f.dir, 'dangling.json');
    fs.symlinkSync('missing.json', alias);
    const store = new DeckStore({ [kind.option]: alias });
    assert.throws(() => store[kind.set]('new'));
    assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
    assert.equal(fs.existsSync(join(f.dir, 'missing.json')), false);
  });
  test(`${kind.option}: hard-linked file is refused rather than silently separating saved identities`, t => {
    const f = fixture(t, kind); fs.linkSync(f.file, join(f.dir, 'other-link.json'));
    assert.throws(() => f.store[kind.set]('new'));
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.bytes);
    assert.equal(f.store[kind.has]('new'), false);
  });
  test(`${kind.option}: append failure after save remains unknown without rollback or native replay`, t => {
    const f = fixture(t, kind);
    const store = new DeckStore({ [kind.option]: f.file, eventLog: {
      append: () => { throw new Error('lost event acknowledgement'); }, appendBatch: () => {},
      latestEventId: () => 'original', hasEvent: () => false, getEventsSince: () => [],
    } });
    // Establish the summary before the fallible preference event append.
    assert.throws(() => store.upsertSession({ sessionKey: 'new', agentId: 'codex', title: 'New', status: 'idle' }));
    assert.throws(() => store[kind.set]('new'));
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), ['new', 'old']);
    assert.equal(new DeckStore({ [kind.option]: f.file })[kind.has]('new'), true);
  });
}
