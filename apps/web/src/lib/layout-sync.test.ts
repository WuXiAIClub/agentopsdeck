import test from 'node:test';
import assert from 'node:assert/strict';
import { LayoutSync, type LayoutDocument } from './layout-sync.js';
import { areCurrentLayoutsEquivalent, layoutSnapshot, reconcileCurrentLayoutConflict } from './current-layout.js';
import { emptyWorkspace, floatWorkspacePane, presetWorkspace } from './workspace-layout.js';
const settle = () => new Promise(resolve => setImmediate(resolve));
test('unavailable GET retains applied layout and pending edit, then recovers by GET before CAS', async () => {
  let unavailable = false, remote = { revision: 3, content: 'base' }, writes = 0;
  const applied: string[] = [];
  const sync = new LayoutSync('base', { current: () => true, apply: value => { applied.push(value); return true; },
    load: async () => { if (unavailable) throw Error('503'); return { ...remote }; },
    save: async value => { assert.equal(value.revision, remote.revision); writes++; remote = { revision: remote.revision + 1, content: value.content }; return { ...remote }; } });
  try {
    sync.start(); await settle(); unavailable = true; sync.edit('local draft'); sync.retry(); await settle();
    assert.equal(sync.snapshot(), 'offline'); assert.equal(writes, 0); assert.deepEqual(applied, ['base']);
    unavailable = false; sync.retry(); await settle(); assert.equal(sync.snapshot(), 'saved');
    assert.equal(writes, 1); assert.equal(remote.content, 'local draft'); assert.deepEqual(applied, ['base']);
  } finally { sync.stop(); }
});
test('save committed before stop is reconciled on resume without write replay', async () => {
  let remote: LayoutDocument = { revision: 0, content: null }, writes = 0, resolve!: (value: LayoutDocument) => void;
  const sync = new LayoutSync('local draft', { current: () => true, apply: () => true, load: async () => ({ ...remote }),
    save: value => { writes++; remote = { revision: 1, content: value.content }; return new Promise(done => { resolve = done; }); } });
  try {
    sync.start(); await settle(); assert.equal(writes, 1); sync.stop(); sync.start(); await settle();
    assert.equal(sync.snapshot(), 'saved'); assert.equal(writes, 1);
    resolve(remote); await settle(); assert.equal(sync.snapshot(), 'saved'); assert.equal(writes, 1);
  } finally { sync.stop(); }
});
test('hidden layout retries defer reads and writes without losing a pending edit', async () => {
  let visible = false, reads = 0, writes = 0;
  const sync = new LayoutSync('draft', { current: () => true, visible: () => visible, apply: () => true,
    load: async () => { reads++; return { revision: 0, content: null }; },
    save: async value => { writes++; return { revision: 1, content: value.content }; } });
  try {
    sync.start(); sync.edit('latest'); sync.retry(); await settle();
    assert.equal(reads, 0); assert.equal(writes, 0);
    visible = true; sync.retry(); await settle();
    assert.equal(reads, 1); assert.equal(writes, 1); assert.equal(sync.snapshot(), 'saved');
  } finally { sync.stop(); }
});
function fixture(initial = 'local', document: LayoutDocument = { revision: 0, content: null }) {
  let remote = document, lose = false, writes = 0, reads = 0;
  const applied: string[] = [];
  const sync = new LayoutSync(initial, { current: () => true, apply: value => { applied.push(value); return true; },
    load: async () => { reads++; return { ...remote }; }, save: async value => {
      assert.equal(value.revision, remote.revision); writes++; remote = { revision: remote.revision + 1, content: value.content };
      if (lose) { lose = false; throw Error('Lost response'); } return { ...remote };
    } });
  return { sync, applied, get writes() { return writes; }, get reads() { return reads; }, remote: (value: LayoutDocument) => { remote = value; }, lose: () => { lose = true; } };
}
test('initial account layout is restored; new account migrates local layout once', async () => {
  for (const exists of [true, false]) {
    const f = fixture('local', exists ? { revision: 3, content: 'remote' } : undefined);
    try { f.sync.start(); await settle(); assert.equal(f.sync.snapshot(), 'saved'); assert.deepEqual(f.applied, exists ? ['remote'] : []); assert.equal(f.writes, exists ? 0 : 1); }
    finally { f.sync.stop(); }
  }
});
test('lost response reconciles by read without duplicating a write', async () => {
  const f = fixture(); f.lose();
  try { f.sync.start(); await settle(); assert.equal(f.sync.snapshot(), 'offline'); f.sync.retry(); await settle(); assert.equal(f.sync.snapshot(), 'saved'); assert.equal(f.writes, 1); }
  finally { f.sync.stop(); }
});
test('concurrent changes preserve local state until explicitly resolved', async () => {
  const f = fixture('base', { revision: 1, content: 'base' });
  try {
    f.sync.start(); await settle(); f.sync.edit('mine'); f.remote({ revision: 2, content: 'theirs' }); f.sync.retry(); await settle();
    assert.equal(f.sync.snapshot(), 'conflict'); assert.equal(f.writes, 0);
    f.sync.keepLocal(); await new Promise(resolve => setTimeout(resolve, 5)); await settle();
    assert.equal(f.sync.snapshot(), 'saved'); assert.equal(f.writes, 1);
    f.remote({ revision: 4, content: 'new remote' }); f.sync.retry(); await settle(); assert.equal(f.applied.at(-1), 'new remote');
  } finally { f.sync.stop(); }
});
test('mount cleanup and restart discard a late prior read', async () => {
  const completions: ((value: LayoutDocument) => void)[] = [], applied: string[] = [];
  const sync = new LayoutSync('local', { current: () => true, load: () => new Promise(resolve => completions.push(resolve)),
    apply: value => { applied.push(value); return true; }, save: async () => { throw Error('Unexpected write'); } });
  sync.start(); sync.stop(); sync.start();
  completions[0]!({ revision: 1, content: 'stale' }); await settle(); assert.equal(applied.length, 0);
  completions[1]!({ revision: 2, content: 'fresh' }); await settle(); assert.deepEqual(applied, ['fresh']); sync.stop();
});
test('reload preserves an offline edit and detects an intervening account change', async () => {
  let pending: LayoutDocument | null | undefined;
  let remote: LayoutDocument = { revision: 1, content: 'base' };
  const deps = { current: () => true, apply: () => { throw Error('Must not overwrite unsynced local changes'); },
    pending: () => pending, checkpoint: (value: LayoutDocument | null | undefined) => { pending = value; },
    load: async () => remote, save: async () => { throw Error('Offline'); } };
  const first = new LayoutSync('base', { ...deps, apply: () => true });
  first.start(); await settle(); first.edit('local draft'); first.stop();
  assert.equal(pending?.revision, 1);
  remote = { revision: 2, content: 'other device' };
  const reloaded = new LayoutSync('local draft', deps);
  try { reloaded.start(); await settle(); assert.equal(reloaded.snapshot(), 'conflict'); }
  finally { reloaded.stop(); }
});
test('equivalent edits do not schedule cloud writes or cause false conflicts', async () => {
  let remote: LayoutDocument = { revision: 2, content: 'pane:a|active:a' };
  let writes = 0;
  const applied: string[] = [];
  const equivalent = (a: string, b: string) => a.split('|')[0] === b.split('|')[0];
  const sync = new LayoutSync('pane:a|active:a', {
    current: () => true,
    equivalent,
    debounceMs: 5,
    apply: value => { applied.push(value); return true; },
    load: async () => ({ ...remote }),
    save: async value => {
      writes++;
      remote = { revision: remote.revision + 1, content: value.content };
      return { ...remote };
    },
  });
  try {
    sync.start();
    await settle();
    assert.equal(sync.snapshot(), 'saved');
    sync.edit('pane:a|active:b');
    await new Promise(resolve => setTimeout(resolve, 15));
    await settle();
    assert.equal(writes, 0);
    assert.equal(sync.snapshot(), 'saved');
    remote = { revision: 3, content: 'pane:a|active:c' };
    sync.retry();
    await settle();
    assert.equal(sync.snapshot(), 'saved');
    assert.equal(writes, 0);
    assert.deepEqual(applied, ['pane:a|active:a']);
  } finally {
    sync.stop();
  }
});
test('merge hook auto-reconciles concurrent disjoint edits and enters conflict when merge returns null', async () => {
  let remote: LayoutDocument = { revision: 1, content: 'A,B' };
  let writes = 0;
  const applied: string[] = [];
  const sync = new LayoutSync('A,B', {
    current: () => true,
    debounceMs: 1000,
    apply: value => { applied.push(value); return true; },
    load: async () => ({ ...remote }),
    save: async value => {
      assert.equal(value.revision, remote.revision);
      writes++;
      remote = { revision: remote.revision + 1, content: value.content };
      return { ...remote };
    },
    merge: ({ local, remote: theirs, base }) => {
      if (base === 'A,B' && local === 'A,B,C' && theirs === 'A,B,D') return 'A,B,D,C';
      return null;
    },
  });
  try {
    sync.start();
    await settle();
    sync.edit('A,B,C');
    remote = { revision: 2, content: 'A,B,D' };
    sync.retry();
    await settle();
    assert.equal(sync.snapshot(), 'saved');
    assert.equal(writes, 1);
    assert.equal(remote.content, 'A,B,D,C');
    assert.deepEqual(applied, ['A,B', 'A,B,D,C']);

    sync.edit('CONFLICT_LOCAL');
    remote = { revision: 4, content: 'CONFLICT_REMOTE' };
    sync.retry();
    await settle();
    assert.equal(sync.snapshot(), 'conflict');
    assert.equal(writes, 1);
  } finally {
    sync.stop();
  }
});
test('current layout equivalence and conflict reconciliation ignore focus switches and startup races', () => {
  const wsA = presetWorkspace([
    { id: 'p1', sessionKey: 'session:1' },
    { id: 'p2', sessionKey: 'session:2' },
  ], 'columns');
  const wsFocusB = { ...wsA, active: 'p2' };
  const rawA = JSON.stringify(layoutSnapshot(wsA, new Set()));
  const rawFocusB = JSON.stringify(layoutSnapshot(wsFocusB, new Set()));
  assert.equal(areCurrentLayoutsEquivalent(rawA, rawFocusB), true);

  const wsFloated = floatWorkspacePane(wsA, 'p2', { x: 0.2, y: 0.2, width: 0.5, height: 0.5 });
  const rawFloated = JSON.stringify(layoutSnapshot(wsFloated, new Set()));
  assert.equal(areCurrentLayoutsEquivalent(rawA, rawFloated), false);

  const rawEmpty = JSON.stringify(layoutSnapshot(emptyWorkspace(), new Set()));
  assert.equal(
    reconcileCurrentLayoutConflict({ local: rawEmpty, remote: rawA, base: undefined, initialBoot: false }),
    rawA,
  );
  assert.equal(
    reconcileCurrentLayoutConflict({ local: rawFloated, remote: rawA, base: undefined, initialBoot: true }),
    rawFloated,
  );
  assert.equal(
    reconcileCurrentLayoutConflict({ local: rawFloated, remote: rawA, base: rawFocusB, initialBoot: false }),
    null,
  );
});
