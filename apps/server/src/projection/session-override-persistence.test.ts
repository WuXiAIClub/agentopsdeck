import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { DeckStore } from './deck-store.js';

const kinds = ['title', 'thinking'] as const;
type Kind = typeof kinds[number];
function fixture(t: TestContext, kind: Kind, initial: unknown = { old: 'high', new: 'low' }) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'agentopsdeck-override-persist-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'override.json');
  fs.writeFileSync(file, JSON.stringify(initial, null, 2), { mode: 0o640 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o640);
  const options = kind === 'title' ? { sessionTitlesFile: file } : { sessionThinkingOverridesFile: file };
  const store = new DeckStore(options);
  const row = { sessionKey: 'new', agentId: 'codex', title: 'Native', status: 'idle' as const };
  store.upsertSession(row);
  let acknowledgements = 0;
  const change = (key = 'new', clear = false) => kind === 'title'
    ? key === 'new' ? store.renameSession(key, 'high', () => acknowledgements++) : store.persistSessionTitleOverride(key, 'high')
    : store.persistSessionThinkingOverride(key, clear ? null : 'high', () => acknowledgements++);
  return { dir, file, options, store, row, change, acks: () => acknowledgements,
    bytes: fs.readFileSync(file, 'utf8'), revision: store.latestEventId(), session: store.getSession('new') };
}
function fault(t: TestContext, method: 'writeFileSync' | 'openSync' | 'fsyncSync' | 'closeSync' | 'renameSync' | 'fchmodSync' | 'mkdirSync', after = false) {
  const original = fs[method]; let first = true;
  const mocked = t.mock.method(fs, method, (...args: unknown[]) => {
    if (!first) return (original as (...args: unknown[]) => unknown)(...args);
    first = false;
    if (after) (original as (...args: unknown[]) => unknown)(...args);
    if (method === 'writeFileSync') fs.writeFileSync(args[0] as number, 'partial confidential location');
    throw Object.assign(new Error('ENOSPC confidential location'), { code: 'ENOSPC' });
  });
  syncBuiltinESMExports();
  const restore = () => { mocked.mock.restore(); syncBuiltinESMExports(); }; t.after(restore); return restore;
}
for (const kind of kinds) {
  for (const method of ['writeFileSync', 'openSync', 'fsyncSync', 'closeSync', 'renameSync', 'mkdirSync', ...(process.platform === 'win32' ? [] : ['fchmodSync' as const])] as const) {
    test(`${kind}: failed ${method} preserves disk, override memory, projection and ACK`, t => {
      const f = fixture(t, kind); const restore = fault(t, method);
      assert.throws(() => f.change(), { message: 'session_preference_persistence_failed' }); restore();
      assert.equal(fs.readFileSync(f.file, 'utf8'), f.bytes);
      assert.equal(f.store.latestEventId(), f.revision); assert.equal(f.acks(), 0);
      assert.deepEqual(f.store.getSession('new'), f.session);
      f.store.replaceSessions([f.row]);
      assert.equal(kind === 'title' ? f.store.getSession('new')?.title : f.store.getSession('new')?.thinkingLevel, 'low');
      assert.deepEqual(fs.readdirSync(f.dir), ['override.json']);
    });
  }
  test(`${kind}: lost rename ACK retains failure and next explicit change reconciles durable state`, t => {
    const f = fixture(t, kind); const restore = fault(t, 'renameSync', true);
    assert.throws(() => f.change()); restore();
    assert.equal(f.acks(), 0); assert.equal(f.store.latestEventId(), f.revision);
    const reopened = new DeckStore(f.options); reopened.upsertSession(f.row);
    assert.equal(kind === 'title' ? reopened.getSession('new')?.title : reopened.getSession('new')?.thinkingLevel, 'high');
    // Simulate a separately confirmed durable value. No automatic retry occurs.
    fs.writeFileSync(f.file, JSON.stringify({ old: 'high', new: 'high', other: 'medium' }, null, 2));
    f.change('third');
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), { old: 'high', new: 'high', other: 'medium', third: 'high' });
  });
  test(`${kind}: original JSON object bytes, mode and restart remain compatible`, t => {
    const f = fixture(t, kind); f.change(); assert.equal(f.acks(), 1);
    assert.equal(fs.readFileSync(f.file, 'utf8'), JSON.stringify({ old: 'high', new: 'high' }, null, 2));
    if (process.platform !== 'win32') assert.equal(fs.statSync(f.file).mode & 0o777, 0o640);
    const reopened = new DeckStore(f.options); reopened.upsertSession(f.row);
    assert.equal(kind === 'title' ? reopened.getSession('new')?.title : reopened.getSession('new')?.thinkingLevel, 'high');
  });
  test(`${kind}: absent ordinary file persists and reopens without altering unrelated memory entries`, t => {
    const f = fixture(t, kind); fs.unlinkSync(f.file); f.change();
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), { old: 'high', new: 'high' });
    const reopened = new DeckStore(f.options); reopened.upsertSession(f.row);
    assert.equal(kind === 'title' ? reopened.getSession('new')?.title : reopened.getSession('new')?.thinkingLevel, 'high');
  });
  test(`${kind}: dangling symbolic link is never replaced`, { skip: process.platform === 'win32' }, t => {
    const f = fixture(t, kind); fs.unlinkSync(f.file); fs.symlinkSync(join(f.dir, 'missing-target'), f.file);
    assert.throws(() => f.change(), { message: 'session_preference_persistence_failed' });
    assert.equal(fs.lstatSync(f.file).isSymbolicLink(), true);
    assert.equal(fs.existsSync(join(f.dir, 'missing-target')), false);
    assert.equal(f.acks(), 0); assert.equal(f.store.latestEventId(), f.revision);
    assert.deepEqual(f.store.getSession('new'), f.session);
  });
  for (const invalid of ['{broken', '[]', 'null', '"not an object"']) {
    test(`${kind}: malformed durable shape ${invalid} cannot be overwritten`, t => {
      const f = fixture(t, kind); fs.writeFileSync(f.file, invalid);
      assert.throws(() => f.change(), { message: 'session_preference_persistence_failed' });
      assert.equal(fs.readFileSync(f.file, 'utf8'), invalid);
      assert.equal(f.acks(), 0); assert.equal(f.store.latestEventId(), f.revision);
    });
  }
  test(`${kind}: existing symlink destination is retained`, t => {
    const f = fixture(t, kind), alias = join(f.dir, 'alias.json'); fs.symlinkSync('override.json', alias);
    const store = new DeckStore(kind === 'title' ? { sessionTitlesFile: alias } : { sessionThinkingOverridesFile: alias });
    kind === 'title' ? store.persistSessionTitleOverride('new', 'high') : store.persistSessionThinkingOverride('new', 'high');
    assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), { old: 'high', new: 'high' });
  });
  test(`${kind}: hardlink refuses changing another owner`, t => {
    const f = fixture(t, kind); fs.linkSync(f.file, join(f.dir, 'other.json'));
    assert.throws(() => f.change(), { message: 'session_preference_persistence_failed' });
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.bytes); assert.equal(f.acks(), 0);
  });
}
test('thinking reset failure retains original override and never ACKs', t => {
  const f = fixture(t, 'thinking'); const restore = fault(t, 'writeFileSync');
  assert.throws(() => f.change('new', true)); restore(); assert.equal(f.acks(), 0);
  f.store.replaceSessions([f.row]); assert.equal(f.store.getSession('new')?.thinkingLevel, 'low');
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.bytes);
});
