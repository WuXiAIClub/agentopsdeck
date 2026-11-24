import assert from 'node:assert/strict';
import test from 'node:test';
import { boundNotebookPosition, clearCachedNotebookDocuments, NotebookController, NotebookRegistry, NOTEBOOK_MAX_CHARS, prependNotebookReading, readCachedNotebookDocument, type NotebookDocument, writeCachedNotebookDocument } from './session-notebook.js';

test('reading transfer prepends inert citations without normalizing existing Markdown and saves once', async () => {
  const f = fixture(), original = '# Original\n\n- [x] Keep **formatting**  \n\n';
  f.update({ text: original }); await f.controller.load();
  const source = '```\n<img src="https://forbidden.example">\n[link](javascript:alert(1))';
  assert.equal(f.controller.prependReading(source), 'applied');
  assert.equal(f.controller.get().text, prependNotebookReading(original, source));
  assert.ok(f.controller.get().text.startsWith('````text\n'));
  assert.ok(f.controller.get().text.endsWith(original));
  assert.equal(f.writes(), 0, 'staging is not a save receipt');
  assert.equal(f.controller.prependReading('duplicate click'), 'busy');
  await f.controller.flush(); assert.equal(f.writes(), 1);
  assert.equal(f.remote().text, prependNotebookReading(original, source)); f.controller.leave();
});

test('reading transfer rejects dirty, unavailable, departed and oversized targets without changes', async () => {
  const f = fixture();
  assert.equal(f.controller.prependReading('reading'), 'unavailable');
  await f.controller.load();
  assert.equal(f.controller.prependReading('   '), 'unavailable');
  assert.equal(f.controller.prependReading('x'.repeat(NOTEBOOK_MAX_CHARS)), 'too-large');
  f.controller.edit('human draft');
  assert.equal(f.controller.prependReading('reading'), 'busy');
  assert.equal(f.controller.get().text, 'human draft');
  await f.controller.flush(); f.controller.leave();
  assert.equal(f.controller.prependReading('reading'), 'unavailable');
  f.controller.enter(); f.logout();
  assert.equal(f.controller.prependReading('reading'), 'unavailable');
});

test('reading transfer refuses background reads and stale revisions never overwrite another writer', async () => {
  const f = fixture(); let release!: (value: NotebookDocument) => void;
  const controller = new NotebookController({ ...f.deps, read: () => new Promise(resolve => { release = resolve; }) });
  const load = controller.load(); release(f.remote()); await load;
  const reconcile = controller.load();
  assert.equal(controller.prependReading('during read'), 'busy'); release(f.remote()); await reconcile;
  assert.equal(controller.prependReading('reading'), 'applied');
  f.update({ revision: 1, text: 'other writer' });
  const save = controller.flush(); await Promise.resolve(); await Promise.resolve();
  release(f.remote()); await save;
  assert.equal(controller.get().phase, 'conflict');
  assert.equal(controller.prependReading('another'), 'busy');
  assert.equal(f.remote().text, 'other writer');
  assert.equal(controller.get().text, prependNotebookReading('', 'reading')); controller.leave();
});

test('reading save failure retains recoverable draft and uncertain success does not duplicate it', async () => {
  const f = fixture(); await f.controller.load(); f.failWrite();
  assert.equal(f.controller.prependReading('preserved source'), 'applied'); await f.controller.flush();
  assert.equal(f.controller.get().phase, 'error'); assert.equal(f.remote().text, '');
  assert.equal(f.controller.prependReading('do not add'), 'busy');
  assert.equal(f.controller.get().text, prependNotebookReading('', 'preserved source'));
  assert.equal(f.stored.size, 1); f.controller.leave();
  const uncertain = fixture(); await uncertain.controller.load(); uncertain.loseResponse();
  uncertain.controller.prependReading('once'); await uncertain.controller.flush();
  assert.equal(uncertain.controller.get().phase, 'ready');
  assert.equal(uncertain.writes(), 1); assert.equal(uncertain.controller.dirty(), false);
  assert.equal(uncertain.remote().text, prependNotebookReading('', 'once')); uncertain.controller.leave();
});

test('background reconciliation keeps the editor enabled and preserves typing during the read', async () => {
  const f = fixture();
  let release: ((value: NotebookDocument) => void) | undefined;
  const controller = new NotebookController({ ...f.deps, read: () => release
    ? new Promise<NotebookDocument>(resolve => { release = resolve; }) : f.deps.read() });
  await controller.load();
  release = () => {};
  const pending = controller.load();
  assert.notEqual(controller.get().phase, 'loading', 'background reads must not disable contenteditable');
  controller.edit('typed during remote check');
  release!(f.remote()); await pending;
  assert.equal(controller.get().text, 'typed during remote check');
  assert.notEqual(controller.get().phase, 'loading');
  await controller.flush(); assert.equal(f.remote().text, 'typed during remote check');
  assert.equal(f.writes(), 1); controller.leave();
});

test('cold archive has its own 100k budget, recovers drafts and reconciles unknown writes without replay', async () => {
  const f = fixture(), controller = new NotebookController({ ...f.deps, maxChars: 100_000 });
  await controller.load();
  const text = '文'.repeat(100_000);
  controller.edit(text); assert.equal(controller.get().text, text);
  controller.edit(text + 'x'); assert.equal(controller.get().text, text, 'oversized edit is refused without truncation');
  controller.leave();
  const recovered = new NotebookController({ ...f.deps, maxChars: 100_000 });
  await recovered.load(); assert.equal(recovered.get().text, text);
  f.loseResponse(); await recovered.flush(); await recovered.retry();
  assert.equal(f.remote().text, text); assert.equal(f.writes(), 1); assert.equal(recovered.dirty(), false);
  recovered.leave();
  const hot = fixture(); await hot.controller.load();
  hot.controller.edit('文'.repeat(50_000)); assert.equal(hot.controller.get().text.length, 50_000);
  hot.controller.edit(text); assert.equal(hot.controller.get().text.length, 50_000);
  hot.controller.leave();
});

function fixture() {
  let remote: NotebookDocument = { resourceId: 'node-session', revision: 0, text: '', updatedAt: null };
  let current = true, offline = false, loseResponse = false, failWrite = false, writes = 0;
  const stored = new Map<string, string>();
  const deps = { key: 'scoped-session', current: () => current,
    storage: () => ({ getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); }, removeItem: (key: string) => { stored.delete(key); } }),
    read: async () => { if (offline) throw Error('offline'); return { ...remote }; },
    write: async (value: Pick<NotebookDocument, 'resourceId' | 'text' | 'revision'>) => {
      writes++; if (offline || failWrite) throw Error('offline'); if (value.revision !== remote.revision) throw Error('conflict');
      remote = { ...value, revision: value.revision + 1, updatedAt: 1 };
      if (loseResponse) throw Error('response lost'); return remote;
    } };
  return { controller: new NotebookController(deps), deps, stored, remote: () => remote, writes: () => writes,
    update: (value: Partial<NotebookDocument>) => { remote = { ...remote, ...value }; },
    offline: () => { offline = true; }, online: () => { offline = false; }, logout: () => { current = false; },
    loseResponse: () => { loseResponse = true; }, failWrite: () => { failWrite = true; } };
}

test('authentication pause rejects a late read after same-account resume and revalidates once', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), registry = new NotebookRegistry(() => true);
  let release!: (document: NotebookDocument) => void, reads = 0;
  const controller = registry.get('note', { ...f.deps, read: () => ++reads === 1
    ? new Promise(resolve => { release = resolve; }) : Promise.resolve({ ...f.remote(), text: 'fresh after unlock', revision: 2 }) });
  const leave = registry.retain('note', controller);
  registry.resume(); // initial mount is not an extra load
  const loading = controller.load();
  registry.suspend(); registry.flush(); registry.resume();
  assert.equal(reads, 1, 'resume waits for the old operation to settle');
  const observed: string[] = []; controller.subscribe(() => observed.push(controller.get().text));
  release({ ...f.remote(), text: 'stale before lock', revision: 1 }); await loading;
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(reads, 2); assert.equal(controller.get().text, 'fresh after unlock');
  assert.equal(observed.includes('stale before lock'), false); assert.equal(f.writes(), 0);
  registry.resume(); assert.equal(reads, 2); leave();
});

test('uncertain pre-lock save is reconciled after unlock without replay or erasing a newer draft', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), registry = new NotebookRegistry(() => true);
  let release!: (document: NotebookDocument) => void, writes = 0;
  const controller = registry.get('note', { ...f.deps, write: async value => {
    writes++; f.update({ ...value, revision: value.revision + 1 });
    return new Promise(resolve => { release = resolve; });
  } });
  const leave = registry.retain('note', controller);
  await controller.load(); controller.edit('sent before lock'); const saving = controller.flush();
  controller.edit('newer local draft'); registry.suspend();
  context.mock.timers.tick(5000); registry.flush(); registry.retry();
  assert.equal(writes, 1); registry.resume();
  release(f.remote()); await saving;
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(controller.get().phase, 'conflict');
  assert.equal(controller.get().text, 'newer local draft');
  assert.equal(controller.get().remote?.text, 'sent before lock');
  assert.ok(f.stored.get(f.deps.key)?.includes('newer local draft'));
  context.mock.timers.tick(120_000); assert.equal(writes, 1, 'never replay uncertain PUT');
  controller.resolve(false); leave();
});

test('a failed old request cannot change resumed state or schedule retries after last close', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), registry = new NotebookRegistry(() => true);
  let reject!: (error: Error) => void, reads = 0;
  const controller = registry.get('note', { ...f.deps, read: () => { reads++; return new Promise((_, fail) => { reject = fail; }); } });
  const leave = registry.retain('note', controller), pending = controller.load();
  registry.suspend(); registry.resume(); leave(); reject(Error('late network failure')); await pending;
  for (let i = 0; i < 8; i++) await Promise.resolve();
  context.mock.timers.tick(120_000); assert.equal(reads, 1); assert.equal(controller.get().phase, 'loading');
  assert.notEqual(registry.get('note', f.deps), controller);
});
test('notes serialize writes, clear saved draft and recover without any message API', async () => {
  const f = fixture(); await f.controller.load(); f.controller.edit('tip');
  assert.equal(f.stored.size, 1); await f.controller.flush();
  assert.equal(f.remote().text, 'tip'); assert.equal(f.stored.size, 0); assert.equal(f.writes(), 1);
  f.controller.edit(''); await f.controller.flush(); assert.equal(f.remote().revision, 2); f.controller.leave();
});

test('floating and docked views share one writer; closing either does not stop the remaining view', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(), registry = new NotebookRegistry(f.deps.current);
  const floating = registry.get('content', f.deps), docked = registry.get('content', f.deps);
  assert.equal(floating, docked);
  const leaveFloating = registry.retain('content', floating), leaveDocked = registry.retain('content', docked);
  await floating.load(); floating.edit('from floating');
  assert.equal(docked.get().text, 'from floating'); leaveFloating(); leaveFloating();
  docked.edit('from dock'); context.mock.timers.tick(650); await docked.settled();
  assert.equal(f.remote().text, 'from dock'); assert.equal(f.writes(), 1);
  leaveDocked(); await Promise.resolve();
  assert.notEqual(registry.get('content', f.deps), docked, 'settled unused controllers are reclaimed');
});

test('reopening while the last view saves retains the writer and serializes the next revision', async () => {
  const f = fixture(), registry = new NotebookRegistry(f.deps.current);
  let release!: (value: NotebookDocument) => void, calls = 0;
  const deps = { ...f.deps, write: async (value: Pick<NotebookDocument, 'text' | 'revision' | 'resourceId'>) => {
    if (++calls === 1) return new Promise<NotebookDocument>(resolve => { release = resolve; });
    assert.equal(value.revision, 1); assert.equal(value.text, 'second');
    return { ...value, revision: 2, updatedAt: 2 };
  } };
  const first = registry.get('note', deps), leave = registry.retain('note', first);
  await first.load(); first.edit('first'); leave();
  const next = registry.get('note', deps), leaveNext = registry.retain('note', next);
  assert.equal(first, next); next.edit('second');
  release({ resourceId: 'node-session', revision: 1, text: 'first', updatedAt: 1 }); await next.settled();
  assert.equal(next.get().text, 'second'); await next.flush(); assert.equal(calls, 2); assert.equal(f.stored.size, 0);
  leaveNext();
});

test('resource and authenticated registries never share controllers or late results', async () => {
  const f = fixture(), a = new NotebookRegistry(f.deps.current), b = new NotebookRegistry(() => true);
  const first = a.get('note', f.deps), other = a.get('layout', f.deps), account = b.get('note', f.deps);
  assert.notEqual(first, other); assert.notEqual(first, account);
  const leave = a.retain('note', first); await first.load(); first.edit('private'); f.logout();
  leave(); await first.settled(); assert.equal(f.writes(), 0); assert.equal(f.stored.size, 1);
});

test('shared conflict and offline recovery remain one resource decision', async () => {
  const f = fixture(), registry = new NotebookRegistry(f.deps.current);
  const a = registry.get('note', f.deps), b = registry.get('note', f.deps);
  const leaveA = registry.retain('note', a), leaveB = registry.retain('note', b);
  await a.load(); f.offline(); a.edit('draft'); await a.flush();
  assert.equal(b.get().phase, 'error'); leaveA(); f.online(); f.update({ text: 'another tab', revision: 1 }); await b.retry();
  assert.equal(b.get().phase, 'conflict'); assert.equal(a.get().text, 'draft');
  b.resolve(false); assert.equal(a.get().text, 'another tab'); assert.equal(f.writes(), 1); leaveB();
});

test('the last close during a read keeps the controller until its result settles', async () => {
  const f = fixture(), registry = new NotebookRegistry(f.deps.current);
  let release!: (value: NotebookDocument) => void;
  const deps = { ...f.deps, read: () => new Promise<NotebookDocument>(resolve => { release = resolve; }) };
  const a = registry.get('note', deps), leave = registry.retain('note', a);
  const loading = a.load(); leave();
  assert.equal(registry.get('note', deps), a);
  release(f.remote()); await loading; await a.settled(); await Promise.resolve();
  assert.notEqual(registry.get('note', deps), a);
});
test('effect cleanup/reconnect keeps a single writer and page events operate on retained resources only', async () => {
  const f = fixture(), registry = new NotebookRegistry(f.deps.current);
  const a = registry.get('note', f.deps), release = registry.retain('note', a);
  await a.load(); release();
  const releaseAgain = registry.retain('note', a);
  await Promise.resolve();
  assert.equal(registry.get('note', f.deps), a);
  a.edit('page hide'); assert.equal(registry.dirty(), true);
  registry.flush(); await a.settled();
  assert.equal(f.writes(), 1); assert.equal(registry.dirty(), false);
  f.update({ revision: 2, text: 'another tab' }); registry.reconcile(); await a.settled();
  assert.equal(a.get().text, 'another tab');
  f.offline(); a.edit('offline'); await a.flush(); f.online(); registry.retry(); await a.settled(); await a.flush();
  assert.equal(f.remote().text, 'offline'); releaseAgain();
});
test('conflicting tabs require an explicit choice, never overwrite during reconcile', async () => {
  const f = fixture(); await f.controller.load(); f.controller.edit('my draft'); f.update({ text: 'another tab', revision: 1 });
  await f.controller.flush(); assert.equal(f.controller.get().phase, 'conflict'); assert.equal(f.remote().text, 'another tab');
  assert.equal(f.controller.get().text, 'my draft'); f.controller.resolve(false);
  assert.equal(f.controller.get().text, 'another tab'); assert.equal(f.stored.size, 0); f.controller.leave();
});
test('lost save response reconciles equal content without duplicate write', async () => {
  const f = fixture(); await f.controller.load(); f.loseResponse(); f.controller.edit('one'); await f.controller.flush();
  assert.equal(f.controller.get().phase, 'ready'); assert.equal(f.stored.size, 0); assert.equal(f.writes(), 1); f.controller.leave();
});
test('failed writes with healthy reads do not enter an immediate retry loop', async () => {
  const f = fixture(); await f.controller.load(); f.failWrite(); f.controller.edit('keep'); await f.controller.flush();
  assert.equal(f.controller.get().phase, 'error'); assert.equal(f.writes(), 1); assert.equal(f.stored.size, 1); f.controller.leave();
});
test('offline remount restores the draft when access returns; replacement nodes never receive it', async () => {
  const f = fixture(); await f.controller.load(); f.offline(); f.controller.edit('offline tip'); await f.controller.flush(); f.controller.leave();
  assert.equal(f.stored.size, 1); f.online();
  const next = new NotebookController(f.deps); await next.load(); assert.equal(next.get().text, 'offline tip'); await next.flush();
  assert.equal(f.remote().text, 'offline tip'); next.edit('old node tip'); f.offline(); await next.flush(); next.leave();
  f.online(); f.update({ resourceId: 'new-node-session', text: '', revision: 0 });
  const replaced = new NotebookController(f.deps); await replaced.load(); assert.equal(replaced.get().phase, 'conflict');
  replaced.resolve(true); assert.equal(replaced.get().phase, 'conflict'); assert.equal(f.remote().text, ''); replaced.leave();
});
test('account change prevents pending writes and storage failures are explicit', async () => {
  const f = fixture(); const model = new NotebookController({ ...f.deps, storage: () => { throw Error('blocked'); } });
  await model.load(); assert.equal(model.get().localUnavailable, true); model.edit('note');
  f.logout(); await model.flush(); assert.equal(f.writes(), 0); model.leave();
});
test('an unmounted writer cannot erase a newly mounted draft', async () => {
  const f = fixture(); let release!: (value: NotebookDocument) => void;
  const model = new NotebookController({ ...f.deps, write: () => new Promise(resolve => { release = resolve; }) });
  await model.load(); model.edit('first'); const saving = model.flush(); model.leave();
  f.stored.set(f.deps.key, 'newer draft'); release({ resourceId: 'node-session', revision: 1, text: 'first', updatedAt: 1 }); await saving;
  assert.equal(f.stored.get(f.deps.key), 'newer draft');
});
test('typing during a slow save retains the latest draft and writes against the returned revision', async () => {
  const f = fixture(); let release!: (value: NotebookDocument) => void;
  let calls = 0;
  const model = new NotebookController({ ...f.deps, write: value => {
    if (++calls === 1) return new Promise(resolve => { release = resolve; });
    assert.equal(value.revision, 1); assert.equal(value.text, 'second');
    return Promise.resolve({ ...value, revision: 2, updatedAt: 2 });
  } });
  await model.load(); model.edit('first'); const pending = model.flush(); model.edit('second');
  release({ resourceId: 'node-session', revision: 1, text: 'first', updatedAt: 1 }); await pending;
  assert.equal(model.get().text, 'second'); assert.equal(model.dirty(), true); await model.flush();
  assert.equal(calls, 2); assert.equal(model.dirty(), false); assert.equal(f.stored.size, 0); model.leave();
});
test('floating position remains reachable after drag, resize and mobile keyboard movement', () => {
  assert.deepEqual(boundNotebookPosition(-100, 9999, 370, 390, { left: 0, top: 0, width: 1440, height: 900 }), { x: 8, y: 502 });
  assert.deepEqual(boundNotebookPosition(9999, -100, 374, 264, { left: 0, top: 100, width: 390, height: 280 }), { x: 8, y: 108 });
});
test('offline notes periodically reconcile then save without a manual retry', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); await f.controller.load(); f.offline(); f.controller.edit('offline retry'); await f.controller.flush();
  assert.equal(f.controller.get().phase, 'error');
  f.online(); context.mock.timers.tick(5000);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.controller.get().phase, 'ready');
  context.mock.timers.tick(650); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.remote().text, 'offline retry'); assert.equal(f.writes(), 2); f.controller.leave();
});
test('periodic retries stop on conflict, departure and identity changes', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); await f.controller.load(); f.offline(); f.controller.edit('mine'); await f.controller.flush();
  f.online(); f.update({ revision: 2, text: 'other tab' }); context.mock.timers.tick(5000);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.controller.get().phase, 'conflict'); context.mock.timers.tick(120_000);
  assert.equal(f.writes(), 1); assert.equal(f.remote().text, 'other tab'); f.controller.leave();
  const g = fixture(); g.offline(); await g.controller.load(); g.controller.leave(); g.online();
  context.mock.timers.tick(120_000); await Promise.resolve(); assert.equal(g.controller.get().phase, 'error');
});

test('R19: notebook controller hydrates immediately from memory cache on layout switch and revalidates in background', async () => {
  clearCachedNotebookDocuments();
  const cacheKey = 'scope-1:notebook:nb-1';
  writeCachedNotebookDocument(cacheKey, { resourceId: 'node-session', revision: 3, text: 'cached note', updatedAt: 100 });
  assert.deepEqual(readCachedNotebookDocument(cacheKey), { resourceId: 'node-session', revision: 3, text: 'cached note', updatedAt: 100 });

  const f = fixture();
  f.update({ resourceId: 'node-session', revision: 4, text: 'updated remote note', updatedAt: 200 });
  let remoteReads = 0;
  const controller = new NotebookController({
    ...f.deps,
    cacheKey,
    read: async () => {
      remoteReads += 1;
      return f.deps.read();
    },
  });

  // Immediately ready from cache before load() resolves
  assert.equal(controller.get().phase, 'ready');
  assert.equal(controller.get().text, 'cached note');
  assert.equal(controller.needsRevalidate(), true);

  await controller.load();
  assert.equal(remoteReads, 1);
  assert.equal(controller.get().text, 'updated remote note');
  assert.equal(controller.get().document?.revision, 4);
  assert.equal(controller.needsRevalidate(), false);
  controller.leave();
  clearCachedNotebookDocuments();
});
