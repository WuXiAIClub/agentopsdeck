import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SessionNotebooks } from './session-notebooks.js';
import { HubStore } from './hub-store.js';
import { readNotebookSnapshot, notebookSnapshotVersions, validNotebookSnapshotRead, validNotebookSnapshot,
  NOTEBOOK_LAYOUT_PREFIX, DEFAULT_NOTEBOOK_LAYOUT_RESOURCE, type NotebookSnapshotRead } from './notebook-snapshot-read.js';
import { DeliverySnapshotReadRejected } from './delivery-reader-protocol.js';
import { notebookHash } from './notebook-operations.js';

const scope: NotebookSnapshotRead = { owner: 'alice', mode: 'hot', resourceId: 'note', after: null, query: null, includeArchive: false };
function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:'), notes = new SessionNotebooks(db); t.after(() => db.close());
  return { db, notes };
}
function fileFixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'notebook-snapshot-')), store = new HubStore(join(directory, 'hub.sqlite'), 'synthetic');
  t.after(async () => { await store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, db: (store as unknown as { db: DatabaseSync }).db };
}
test('hot/cold reads preserve Unicode, embedded NUL/BOM, tombstones and owner isolation', t => {
  const { db, notes } = fixture(t), text = '\uFEFF文😀\0tail';
  notes.save('alice', { resourceId: 'note', text, revision: 0 });
  notes.saveArchive('alice', { resourceId: 'note', text: text.repeat(2), revision: 0 });
  for (const mode of ['hot', 'cold'] as const) {
    const request = { ...scope, mode }, v = readNotebookSnapshot(db, request);
    const legacy = mode === 'hot' ? notes.get('alice', 'note') : notes.getArchive('alice', 'note');
    // node:sqlite's legacy TEXT decoder truncates at NUL. The observer must
    // preserve the entire stored payload, without rewriting the writer row.
    assert.deepEqual(v.documents[0], { ...legacy, text: mode === 'hot' ? text : text.repeat(2) });
    assert.deepEqual(v.versions, notebookSnapshotVersions(db, request)); assert.equal(validNotebookSnapshot(v, request), true);
    assert.equal(readNotebookSnapshot(db, { ...request, owner: 'bob' }).documents[0]!.text, '');
  }
  notes.save('alice', { resourceId: 'note', text: '', revision: 1 });
  assert.equal(readNotebookSnapshot(db, scope).documents[0]!.revision, 2); assert.equal(db.isTransaction, false);
});
test('search has exact legacy snippets, hot/cold limits, offsets and revisions', t => {
  const { db, notes } = fixture(t);
  notes.save('alice', { resourceId: 'note', text: '😀 needle '.repeat(40), revision: 0 });
  notes.saveArchive('alice', { resourceId: 'note', text: '文 needle '.repeat(40), revision: 0 });
  for (const includeArchive of [false, true]) {
    const read = { ...scope, mode: 'search' as const, query: 'needle', includeArchive };
    const v = readNotebookSnapshot(db, read);
    assert.deepEqual(v.search, notes.search('alice', 'note', 'needle', includeArchive)); assert.deepEqual(v.documents, []);
    assert.equal(validNotebookSnapshot(v, read), true);
    assert.equal(validNotebookSnapshot({ ...v, search: { ...v.search, results: [{ ...v.search!.results[0], start: 1 }] } }, read), false);
  }
});
test('layout pagination retains exact legacy 100 rows, cursor and same-snapshot default', t => {
  const { db, notes } = fixture(t);
  for (let i = 0; i < 103; i++) notes.save('alice', { resourceId: NOTEBOOK_LAYOUT_PREFIX + `"${String(i).padStart(3, '0')}"]`, text: '{}', revision: 0 });
  notes.save('alice', { resourceId: DEFAULT_NOTEBOOK_LAYOUT_RESOURCE, text: '{"cards":[]}', revision: 0 });
  const read = { ...scope, mode: 'layouts' as const, resourceId: null, after: '' };
  const v = readNotebookSnapshot(db, read); assert.deepEqual(v.documents, notes.listPrefix('alice', NOTEBOOK_LAYOUT_PREFIX).map(d => ({ ...d })));
  assert.deepEqual(v.defaultDocument, notes.get('alice', DEFAULT_NOTEBOOK_LAYOUT_RESOURCE));
  const after = v.documents.at(-1)!.resourceId;
  const next = readNotebookSnapshot(db, { ...read, after });
  assert.deepEqual(next.documents, notes.listPrefix('alice', NOTEBOOK_LAYOUT_PREFIX, after).map(d => ({ ...d }))); assert.equal(next.defaultDocument, null);
  assert.equal(validNotebookSnapshot({ ...v, documents: [...v.documents].reverse() }, read), false);
});
test('bounded list refuses oversized complete pages rather than returning a partial catalog', t => {
  const { db, notes } = fixture(t);
  for (let i = 0; i < 60; i++) notes.save('alice', { resourceId: NOTEBOOK_LAYOUT_PREFIX + `"${i}"]`, text: '文'.repeat(50_000), revision: 0 });
  assert.throws(() => readNotebookSnapshot(db, { ...scope, mode: 'layouts', resourceId: null, after: '' }), DeliverySnapshotReadRejected);
  assert.equal(db.isTransaction, false); assert.equal(notes.listPrefix('alice', NOTEBOOK_LAYOUT_PREFIX).length, 60);
});
test('layout order and cursor use SQLite UTF8 BINARY rather than UTF16 ordering', t => {
  const { db, notes } = fixture(t);
  const ids = ['\uE000', '😀'].map(id => NOTEBOOK_LAYOUT_PREFIX + JSON.stringify(id) + ']');
  for (const resourceId of ids) notes.save('alice', { resourceId, text: '{}', revision: 0 });
  const read = { ...scope, mode: 'layouts' as const, resourceId: null, after: '' };
  const value = readNotebookSnapshot(db, read);
  assert.deepEqual(value.documents.map(d => d.resourceId), ids);
  assert.equal(validNotebookSnapshot(value, read), true);
  const next = readNotebookSnapshot(db, { ...read, after: ids[0]! });
  assert.equal(validNotebookSnapshot(next, { ...read, after: ids[0]! }), true);
  assert.deepEqual(next.documents.map(d => d.resourceId), [ids[1]]);
});
test('search includes matches after embedded NUL without modifying persisted text', t => {
  const { db, notes } = fixture(t), text = 'before\0needle after';
  notes.save('alice', { resourceId: 'note', text, revision: 0 });
  const read = { ...scope, mode: 'search' as const, query: 'needle' };
  const value = readNotebookSnapshot(db, read);
  assert.equal(validNotebookSnapshot(value, read), true);
  assert.deepEqual(value.search!.results, [{ area: 'hot', revision: 1, start: 7, end: 13, text }]);
  assert.equal(Buffer.from(db.prepare('SELECT CAST(text AS BLOB) AS bytes FROM hub_session_notebooks').get()!.bytes as Uint8Array).toString(), text);
});
test('exact scopes reject caller extras, overlong IDs, invalid search/cursor and modes', () => {
  for (const v of [null, { ...scope, owner: '' }, { ...scope, resourceId: 'a'.repeat(8193) }, { ...scope, admin: true },
    { ...scope, includeArchive: true }, { ...scope, mode: 'search', query: ' ' }, { ...scope, mode: 'search', query: 'a'.repeat(201) },
    { ...scope, mode: 'layouts', resourceId: null, after: 'not-a-layout' }, { ...scope, mode: 'save' }]) assert.equal(validNotebookSnapshotRead(v), false);
});
test('stored wrong types, invalid UTF8 and oversized bodies reject without repairs or unfinished transactions', t => {
  const { db, notes } = fixture(t); notes.save('alice', { resourceId: 'note', text: 'original', revision: 0 });
  for (const expression of ["zeroblob(1000000)", "CAST(x'ff' AS TEXT)", "CAST(zeroblob(1000000) AS TEXT)"] ) {
    db.exec(`UPDATE hub_session_notebooks SET text=${expression}`);
    assert.throws(() => readNotebookSnapshot(db, scope), DeliverySnapshotReadRejected); assert.equal(db.isTransaction, false);
  }
  db.exec("UPDATE hub_session_notebooks SET text='original'");
  assert.equal(readNotebookSnapshot(db, scope).documents[0]!.text, 'original');
});
test('metadata SQL gates corrupt INTEGER affinity before allocating huge TEXT/BLOB values', t => {
  const { db, notes } = fixture(t); notes.save('alice', { resourceId: 'note', text: 'original', revision: 0 });
  for (const column of ['revision', 'updated_at']) {
    db.exec(`UPDATE hub_session_notebooks SET ${column}=CAST(zeroblob(1000000) AS TEXT)`);
    const row = db.prepare(`SELECT CASE WHEN typeof(${column})='integer' THEN ${column} ELSE NULL END AS bounded FROM hub_session_notebooks`).get()!;
    assert.equal(row.bounded, null);
    assert.throws(() => notebookSnapshotVersions(db, scope), DeliverySnapshotReadRejected);
    assert.throws(() => readNotebookSnapshot(db, scope), DeliverySnapshotReadRejected);
    db.exec(`UPDATE hub_session_notebooks SET ${column}=1`);
  }
  assert.equal(readNotebookSnapshot(db, scope).documents[0]!.text, 'original');
});
test('reads refuse caller transactions without committing or rolling them back', t => {
  const { db } = fixture(t); db.exec('BEGIN');
  assert.throws(() => readNotebookSnapshot(db, scope), DeliverySnapshotReadRejected); assert.equal(db.isTransaction, true); db.exec('ROLLBACK');
});
test('file-backed production reads bypass synchronous text/search methods and preserve original move/CAS receipts', async t => {
  const { store } = fileFixture(t);
  store.notebooks.save('alice', { resourceId: 'note', text: 'new old', revision: 0 });
  const move = { requestId: randomUUID(), hotRevision: 1, coldRevision: 0, direction: 'archive' as const,
    ranges: [{ start: 4, end: 7, sha256: notebookHash('old') }] };
  const receipt = store.notebooks.move('alice', 'note', move);
  for (const method of ['get', 'getArchive', 'listPrefix', 'search'] as const) t.mock.method(store.notebooks, method, () => { throw Error('main-thread body read'); });
  assert.equal((await store.notebookSnapshotAsync(scope)).documents[0]!.text, 'new ');
  assert.equal((await store.notebookSnapshotAsync({ ...scope, mode: 'cold' })).documents[0]!.text, 'old');
  assert.equal((await store.notebookSnapshotAsync({ ...scope, mode: 'search', query: 'old', includeArchive: true })).search!.results[0]!.area, 'cold');
  assert.deepEqual(store.notebooks.moveReceipt('alice', 'note', move.requestId), receipt);
});
test('bounded corrupt note refusal does not retire a healthy observer; following original read succeeds', async t => {
  const { store, db } = fileFixture(t);
  store.notebooks.save('alice', { resourceId: 'note', text: 'original', revision: 0 });
  await store.notebookSnapshotAsync(scope);
  const state = store as unknown as { deliveryReader: { recoveryState: { unavailable: boolean } } };
  const reader = state.deliveryReader;
  db.exec("UPDATE hub_session_notebooks SET text=CAST(x'ff' AS TEXT)");
  await assert.rejects(store.notebookSnapshotAsync(scope)); assert.equal(reader.recoveryState.unavailable, false);
  db.exec("UPDATE hub_session_notebooks SET text='original'");
  assert.equal((await store.notebookSnapshotAsync(scope)).documents[0]!.text, 'original'); assert.equal(state.deliveryReader, reader);
});
test('original writer version fence rejects a stale hot/cold read after a concurrent update', { timeout: 5000 }, async t => {
  const { store, db } = fileFixture(t); store.notebooks.save('alice', { resourceId: 'note', text: 'old', revision: 0 });
  await store.notebookSnapshotAsync(scope);
  const reader = (store as unknown as { deliveryReader: { notebooks: (r: NotebookSnapshotRead) => Promise<unknown> } }).deliveryReader;
  let release!: () => void, reached!: () => void; const original = reader.notebooks.bind(reader);
  const entered = new Promise<void>(done => { reached = done; });
  t.mock.method(reader, 'notebooks', async (r: NotebookSnapshotRead) => { const result = await original(r); await new Promise<void>(done => { release = done; reached(); }); return result; });
  const work = store.notebookSnapshotAsync(scope);
  await entered;
  db.exec("UPDATE hub_session_notebooks SET revision=revision+1,text='new'"); release();
  await assert.rejects(work, DeliverySnapshotReadRejected);
});
