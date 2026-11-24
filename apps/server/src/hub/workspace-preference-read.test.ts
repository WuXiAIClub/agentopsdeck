import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWorkspacePreferences, validWorkspacePreferences, WORKSPACE_PREFERENCE_BYTES } from './workspace-preference-read.js';
import { DeliverySnapshotReadRejected } from './delivery-reader-protocol.js';
import { AsyncHubDeliveryReader } from './async-delivery-reader.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { HubStore } from './hub-store.js';

const empty = { revision: 0, groups: [], sessions: {} };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'workspace-read-')), file = join(root, 'hub.sqlite');
  const store = new HubStore(file, 'synthetic');
  const db = (store as unknown as { db: DatabaseSync }).db;
  t.after(async () => { await store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, db, file };
}

test('workspace snapshot preserves legacy display JSON and owner isolation without normalization', t => {
  const { db } = fixture(t);
  const document = { groups: [{ id: 'g', name: ' Legacy ' }], sessions: { 'codex:a': { color: '#ABCDEF', groupId: 'g' } } };
  db.prepare('INSERT INTO hub_workspace_preferences VALUES(?,?,?)').run('alice', 3, JSON.stringify(document));
  assert.deepEqual(readWorkspacePreferences(db, 'alice'), { ...document, revision: 3 });
  assert.deepEqual(readWorkspacePreferences(db, 'bob'), empty);
  assert.equal(db.isTransaction, false);
});

test('full legal 5000-session Unicode preferences are not truncated', t => {
  const { store, db } = fixture(t);
  const sessions = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`codex:会话-${i}`, { tags: ['审查'] }]));
  const saved = store.workspace.save('alice', { ...empty, sessions })!;
  assert.deepEqual(readWorkspacePreferences(db, 'alice'), saved);
  assert.equal(Object.keys(saved.sessions).length, 5000);
});

for (const [name, revision, document] of [
  ['invalid UTF8', 1, Buffer.from([255])], ['BLOB', 1, Buffer.from('{"groups":[],"sessions":{}}')],
  ['trailing NUL', 1, '{"groups":[],"sessions":{}}\0'], ['malformed JSON', 1, '{'],
  ['shape', 1, '{"groups":[],"sessions":{},"credential":"private"}'],
  ['zero revision', 0, '{"groups":[],"sessions":{}}'],
  ['unsafe revision', Number.MAX_SAFE_INTEGER, '{"groups":[],"sessions":{}}'],
  ['oversize', 1, ' '.repeat(WORKSPACE_PREFERENCE_BYTES + 1)],
] as const) test(`workspace ${name} refuses the whole read and preserves stored fact`, t => {
  const { db } = fixture(t);
  const query = name === 'invalid UTF8' ? 'INSERT INTO hub_workspace_preferences VALUES(?,?,CAST(? AS TEXT))'
    : 'INSERT INTO hub_workspace_preferences VALUES(?,?,?)';
  db.prepare(query).run('alice', revision, document);
  const before = db.prepare('SELECT revision,hex(document) AS bytes FROM hub_workspace_preferences').get();
  assert.throws(() => readWorkspacePreferences(db, 'alice'), DeliverySnapshotReadRejected);
  assert.deepEqual(db.prepare('SELECT revision,hex(document) AS bytes FROM hub_workspace_preferences').get(), before);
  assert.equal(db.isTransaction, false);
  db.prepare('UPDATE hub_workspace_preferences SET revision=1,document=?').run('{"groups":[],"sessions":{}}');
  assert.deepEqual(readWorkspacePreferences(db, 'alice'), { ...empty, revision: 1 });
});

test('workspace wire validation rejects unknown fields, forbidden session keys and excessive counts', () => {
  assert.equal(validWorkspacePreferences(empty), true);
  assert.equal(validWorkspacePreferences({ ...empty, credential: 'private' }), false);
  assert.equal(validWorkspacePreferences({ ...empty, sessions: JSON.parse('{"__proto__":{}}') }), false);
  assert.equal(validWorkspacePreferences({ ...empty, sessions: Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [`s${i}`, {}])) }), false);
});

class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; read?: unknown }[] = [];
  postMessage(message: { id: number; kind: string; read?: unknown }) { this.messages.push(message); }
  terminate() { queueMicrotask(() => this.emit('exit', 1)); return Promise.resolve(1); }
  reply(index: number, value?: unknown, ok = true) {
    const m = this.messages[index]!;
    this.emit('message', { id: m.id, kind: m.kind, ok, ...(ok ? { value } : {}) });
  }
}
function fake(t: TestContext) {
  const worker = new FakeWorker();
  const reader = new AsyncHubDeliveryReader({ file: '/unused', dev: 1, ino: 1 }, new PerformanceDiagnostics(() => {}), () => worker as unknown as Worker);
  t.after(async () => { worker.emit('exit', 1); await reader.close(); });
  return { worker, reader };
}

test('workspace startup admission shares four snapshot slots and bounded refusal recovers on the same owner', async t => {
  const { worker, reader } = fake(t);
  const reads = Array.from({ length: 4 }, () => reader.workspace('alice'));
  await assert.rejects(reader.workspace('alice'));
  assert.equal(worker.messages.length, 0);
  worker.emit('message', { kind: 'ready' }); await turn();
  assert.deepEqual(worker.messages.map(m => m.read), Array.from({ length: 4 }, () => ({ owner: 'alice' })));
  const refused = assert.rejects(reads[0]!, DeliverySnapshotReadRejected);
  worker.reply(0, undefined, false); await refused;
  for (let i = 1; i < 4; i++) worker.reply(i, empty);
  await Promise.all(reads.slice(1));
  const recovery = reader.workspace('alice'); await turn(); worker.reply(4, empty);
  assert.deepEqual(await recovery, empty);
});

test('workspace close retains accepted SQL until reply and requires real exit after close ACK', async t => {
  const { worker, reader } = fake(t); worker.emit('message', { kind: 'ready' });
  const read = reader.workspace('alice'); await turn();
  let closed = false; const close = reader.close().then(() => { closed = true; }); await turn();
  assert.equal(closed, false); assert.equal(worker.messages.length, 1);
  await assert.rejects(reader.workspace('bob'));
  worker.reply(0, empty); await read; await turn();
  const message = worker.messages[1]!; assert.equal(message.kind, 'close');
  worker.emit('message', { id: message.id, kind: 'close', ok: true }); await turn(); assert.equal(closed, false);
  worker.emit('exit', 0); await close; assert.equal(closed, true);
});

test('malformed workspace success packet retires owner rather than delivering an empty document', async t => {
  const { worker, reader } = fake(t); worker.emit('message', { kind: 'ready' });
  const read = reader.workspace('alice'), rejected = assert.rejects(read); await turn();
  worker.reply(0, { ...empty, credential: 'private' }); await rejected;
  await assert.rejects(reader.workspace('alice')); assert.equal(worker.messages.length, 1);
});

test('actual file-backed workspace read avoids main document SQL, preserves CAS and survives reopen', async t => {
  const { store, db, file } = fixture(t);
  const saved = store.workspace.save('alice', { ...empty, groups: [{ id: 'g', name: 'Group' }] })!;
  const mock = t.mock.method(db, 'prepare', function(this: DatabaseSync, sql: string) {
    assert.doesNotMatch(sql, /SELECT[^;]*\bdocument\b/i, 'display document must be read off main thread');
    return DatabaseSync.prototype.prepare.call(this, sql);
  });
  const getMock = t.mock.method(store.workspace, 'get', () => { throw Error('sync document forbidden'); });
  assert.deepEqual(await store.workspacePreferencesAsync('alice'), saved);
  mock.mock.restore(); getMock.mock.restore();
  assert.equal(store.workspace.save('alice', empty), undefined, 'stale creation cannot replay');
  await store.close();
  const reopened = new HubStore(file, 'synthetic');
  try { assert.deepEqual(await reopened.workspacePreferencesAsync('alice'), saved); }
  finally { await reopened.close(); }
});

test('revision changes across workspace await reject stale display and retry reads current state', async t => {
  const { store } = fixture(t);
  const original = store.workspacePreferencesRevision.bind(store);
  let calls = 0;
  t.mock.method(store, 'workspacePreferencesRevision', (owner: string) => {
    if (++calls === 2) store.workspace.save(owner, empty);
    return original(owner);
  });
  await assert.rejects(store.workspacePreferencesAsync('alice'), DeliverySnapshotReadRejected);
  assert.deepEqual(await store.workspacePreferencesAsync('alice'), { ...empty, revision: 1 });
});

test('workspace read rejects open original transaction and closed owner without SQL fallback', async t => {
  const { store, db } = fixture(t);
  db.exec('BEGIN');
  await assert.rejects(store.workspacePreferencesAsync('alice'));
  db.exec('ROLLBACK');
  assert.deepEqual(await store.workspacePreferencesAsync('alice'), empty);
  await store.close(); await assert.rejects(store.workspacePreferencesAsync('alice'));
});

test('damaged file-backed snapshot refuses without retiring reader and recovers after original CAS repair', async t => {
  const { store, db } = fixture(t);
  db.prepare('INSERT INTO hub_workspace_preferences VALUES(?,?,?)').run('alice', 1, '{');
  await assert.rejects(store.workspacePreferencesAsync('alice'));
  const reader = (store as unknown as { deliveryReader: unknown }).deliveryReader;
  const saved = store.workspace.save('alice', { ...empty, revision: 1 })!;
  assert.deepEqual(await store.workspacePreferencesAsync('alice'), saved);
  assert.equal((store as unknown as { deliveryReader: unknown }).deliveryReader, reader);
});
