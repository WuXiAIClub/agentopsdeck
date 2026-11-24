import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWorkspaceLayout, validWorkspaceLayout } from './workspace-layout-read.js';
import { type LayoutKind } from './workspace-layouts.js';
import { HubStore } from './hub-store.js';
import { AsyncHubDeliveryReader } from './async-delivery-reader.js';
import { DeliverySnapshotReadRejected } from './delivery-reader-protocol.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const empty = { revision: 0, content: null };
const content = (kind: LayoutKind, active: string | null = null) => {
  const entry = { id: kind === 'current' ? 'current' : 'saved-id', name: kind === 'current' ? 'Current' : ' 中文 Layout ',
    workspace: { version: 2, panes: [], floating: [], dock: null, active }, collapsedKeys: [] };
  return JSON.stringify(kind === 'saved' ? [entry] : entry, null, 2);
};
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'layout-read-')), file = join(root, 'hub.sqlite');
  const store = new HubStore(file, 'synthetic');
  const db = (store as unknown as { db: DatabaseSync }).db;
  t.after(async () => { await store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, db, file };
}
for (const kind of ['current', 'saved'] as const) {
  test(`${kind} preserves original Unicode/whitespace content and owner isolation`, t => {
    const { db } = fixture(t), value = { revision: 3, content: content(kind) };
    db.prepare('INSERT INTO hub_workspace_layouts VALUES(?,?,?,?)').run('alice', kind, value.revision, value.content);
    assert.deepEqual(readWorkspaceLayout(db, 'alice', kind), value);
    assert.deepEqual(readWorkspaceLayout(db, 'bob', kind), empty);
    assert.equal(db.isTransaction, false);
    assert.equal(validWorkspaceLayout({ ...value, credential: 'private' }, kind), false);
    assert.equal(validWorkspaceLayout({ revision: 0, content: value.content }, kind), false);
    assert.equal(validWorkspaceLayout({ revision: 1, content: null }, kind), false);
  });
  for (const [name, revision, document] of [
    ['invalid UTF8', 1, Buffer.from([255])], ['BLOB', 1, Buffer.from(content(kind))],
    ['trailing NUL', 1, content(kind) + '\0'], ['malformed JSON', 1, '{'],
    ['wrong collection', 1, content(kind === 'current' ? 'saved' : 'current')],
    ['oversized', 1, ' '.repeat(kind === 'current' ? 65_537 : 1_048_577)],
    ['zero revision', 0, content(kind)], ['unsafe revision', Number.MAX_SAFE_INTEGER, content(kind)],
  ] as const) test(`${kind} rejects ${name} without altering stored bytes`, t => {
    const { db } = fixture(t);
    const stored = name === 'invalid UTF8' ? 'CAST(? AS TEXT)' : '?';
    db.prepare(`INSERT INTO hub_workspace_layouts VALUES(?,?,?,${stored})`).run('alice', kind, revision, document);
    const before = db.prepare('SELECT revision,hex(content) AS bytes,typeof(content) AS type FROM hub_workspace_layouts').get();
    assert.throws(() => readWorkspaceLayout(db, 'alice', kind), DeliverySnapshotReadRejected);
    assert.deepEqual(db.prepare('SELECT revision,hex(content) AS bytes,typeof(content) AS type FROM hub_workspace_layouts').get(), before);
  });
  test(`${kind} actual file-backed read avoids main content SQL, retains CAS and survives reopen`, async t => {
    const { store, db, file } = fixture(t);
    const saved = { ...store.layouts.save('alice', kind, { revision: 0, content: content(kind) })! };
    const mock = t.mock.method(db, 'prepare', function(this: DatabaseSync, sql: string) {
      assert.doesNotMatch(sql, /SELECT[^;]*\bcontent\b/i);
      return DatabaseSync.prototype.prepare.call(this, sql);
    });
    const getMock = t.mock.method(store.layouts, 'get', () => { throw Error('sync layout forbidden'); });
    assert.deepEqual(await store.workspaceLayoutAsync('alice', kind), saved);
    mock.mock.restore(); getMock.mock.restore();
    assert.deepEqual({ ...store.layouts.save('alice', kind, { revision: 0, content: saved.content! }) }, saved, 'lost reply reconciles without revision change');
    assert.equal(store.layouts.save('alice', kind, { revision: 0, content: content(kind, 'changed') }), undefined);
    await store.close();
    const reopened = new HubStore(file, 'synthetic');
    try { assert.deepEqual(await reopened.workspaceLayoutAsync('alice', kind), saved); }
    finally { await reopened.close(); }
  });
  test(`${kind} maximum legal byte snapshot is complete, never a truncated prefix`, async t => {
    const { store } = fixture(t);
    const original = content(kind), limit = kind === 'current' ? 65_536 : 1_048_576;
    const value = original + ' '.repeat(limit - Buffer.byteLength(original));
    assert.equal(Buffer.byteLength(value), limit);
    assert.ok(store.layouts.save('alice', kind, { revision: 0, content: value }));
    assert.deepEqual(await store.workspaceLayoutAsync('alice', kind), { revision: 1, content: value });
  });
  test(`${kind} rejects stale revision then reads current state`, async t => {
    const { store } = fixture(t), original = store.workspaceLayoutRevision.bind(store);
    let calls = 0;
    t.mock.method(store, 'workspaceLayoutRevision', (owner: string, collection: LayoutKind) => {
      if (++calls === 2) store.layouts.save(owner, collection, { revision: 0, content: content(collection) });
      return original(owner, collection);
    });
    await assert.rejects(store.workspaceLayoutAsync('alice', kind), DeliverySnapshotReadRejected);
    assert.deepEqual(await store.workspaceLayoutAsync('alice', kind), { revision: 1, content: content(kind) });
  });
  test(`${kind} damaged snapshot recovers on the same reader after original CAS repair`, async t => {
    const { store, db } = fixture(t);
    db.prepare('INSERT INTO hub_workspace_layouts VALUES(?,?,?,?)').run('alice', kind, 1, '{');
    await assert.rejects(store.workspaceLayoutAsync('alice', kind));
    const reader = (store as unknown as { deliveryReader: unknown }).deliveryReader;
    const saved = { ...store.layouts.save('alice', kind, { revision: 1, content: content(kind) })! };
    assert.deepEqual(await store.workspaceLayoutAsync('alice', kind), saved);
    assert.equal((store as unknown as { deliveryReader: unknown }).deliveryReader, reader);
  });
}
test('open transaction, invalid collection and closed writer cannot fall back to synchronous content', async t => {
  const { store, db } = fixture(t);
  db.exec('BEGIN'); await assert.rejects(store.workspaceLayoutAsync('alice', 'current')); db.exec('ROLLBACK');
  await assert.rejects(store.workspaceLayoutAsync('alice', 'private' as LayoutKind));
  assert.deepEqual(await store.workspaceLayoutAsync('alice', 'current'), empty);
  await store.close(); await assert.rejects(store.workspaceLayoutAsync('alice', 'saved'));
});

class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; read?: unknown }[] = [];
  postMessage(message: { id: number; kind: string; read?: unknown }) { this.messages.push(message); }
  terminate() { return Promise.resolve(1); }
  reply(index: number, value: unknown) { const message = this.messages[index]!; this.emit('message', { id: message.id, kind: message.kind, ok: true, value }); }
}
function fake(t: TestContext) {
  const worker = new FakeWorker(), lines: string[] = [];
  const diagnostics = new PerformanceDiagnostics(line => lines.push(line));
  const reader = new AsyncHubDeliveryReader({ file: 'synthetic', dev: 1, ino: 1 }, diagnostics, () => worker as unknown as Worker);
  t.after(async () => { worker.emit('exit', 1); await reader.close(); });
  return { worker, reader, lines };
}
test('layout snapshots share the four-slot budget with preferences, users and revisions', async t => {
  const { reader, worker, lines } = fake(t);
  const reads = [reader.layout('alice', 'current'), reader.layout('alice', 'saved'), reader.workspace('alice'), reader.revisions('alice')];
  await assert.rejects(reader.layout('alice', 'saved'));
  assert.equal(worker.messages.length, 0);
  worker.emit('message', { kind: 'ready' }); await turn();
  assert.deepEqual(worker.messages.map(m => m.kind), ['layout-current', 'layout-saved', 'workspace', 'revisions']);
  worker.reply(0, empty); worker.reply(1, empty); worker.reply(2, { revision: 0, groups: [], sessions: {} });
  // Settle the final request through the original bounded-refusal protocol.
  worker.emit('message', { id: worker.messages[3]!.id, kind: 'revisions', ok: false });
  await Promise.all([reads[0], reads[1], reads[2], assert.rejects(reads[3]!)]);
  assert.ok(lines.some(line => line.includes('hub-workspace-layout-read')));
  assert.ok(lines.every(line => !line.includes('alice')));
});
test('bounded layout refusal retains owner and a later read succeeds', async t => {
  const { reader, worker } = fake(t); worker.emit('message', { kind: 'ready' });
  const read = reader.layout('alice', 'current'), refused = assert.rejects(read, DeliverySnapshotReadRejected); await turn();
  worker.emit('message', { id: worker.messages[0]!.id, kind: 'layout-current', ok: false }); await refused;
  const retry = reader.layout('alice', 'saved'); await turn(); worker.reply(1, empty); assert.deepEqual(await retry, empty);
  assert.equal(reader.recoveryState.unavailable, false);
});
test('close retains original layout request until reply, close ACK and actual exit', async t => {
  const { reader, worker } = fake(t); worker.emit('message', { kind: 'ready' });
  const read = reader.layout('alice', 'current'); await turn();
  let closed = false; const close = reader.close().then(() => { closed = true; }); await turn();
  await assert.rejects(reader.layout('alice', 'saved')); assert.equal(closed, false); assert.equal(worker.messages.length, 1);
  worker.reply(0, empty); await read; await turn();
  const last = worker.messages[1]!; worker.emit('message', { id: last.id, kind: 'close', ok: true });
  await turn(); assert.equal(closed, false); worker.emit('exit', 0); await close; assert.equal(closed, true);
});
test('wrong collection success or extra fields retires owner, not empty-layout fallback', async t => {
  const { reader, worker } = fake(t); worker.emit('message', { kind: 'ready' });
  const read = reader.layout('alice', 'current'), rejected = assert.rejects(read); await turn();
  worker.reply(0, { revision: 1, content: content('saved') }); await rejected;
  await assert.rejects(reader.layout('alice', 'current'));
  assert.equal(validWorkspaceLayout({ ...empty, extra: true }, 'current'), false);
});
