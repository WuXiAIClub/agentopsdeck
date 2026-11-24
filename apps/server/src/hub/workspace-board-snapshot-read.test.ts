import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOARD_MAX_BODY_BYTES, summarizeBoard, type BoardDocument } from '@agentopsdeck/shared';
import { readWorkspaceBoard, validWorkspaceBoardRead, validWorkspaceBoardResult, type WorkspaceBoardRead } from './workspace-board-snapshot-read.js';
import { WorkspaceBoards } from './workspace-boards.js';
import { HubStore } from './hub-store.js';
import { AsyncHubDeliveryReader } from './async-delivery-reader.js';
import { DeliverySnapshotReadRejected } from './delivery-reader-protocol.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const read: WorkspaceBoardRead = { owner: 'alice', mode: 'document', resourceId: 'default' };
const content = { title: ' 中文 board ', tasks: [{ id: '00000000-0000-4000-8000-000000000001', title: 'Old task', detail: 'Long session\0😀', status: 'doing' as const,
  tags: ['tag'], priority: 'high' as const, dueDate: '0001-01-01' }] };
const empty: BoardDocument = { resourceId: 'default', title: 'Task board', tasks: [], revision: 0, updatedAt: null };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:'), boards = new WorkspaceBoards(db);
  t.after(() => db.close());
  boards.save('alice', 'default', { ...content, revision: 0, mutationId: randomUUID() });
  return { db, boards };
}
test('all three display modes preserve wire content, optional task fields and owner isolation', t => {
  const { db, boards } = fixture(t);
  assert.deepEqual(readWorkspaceBoard(db, read), boards.get('alice', 'default'));
  assert.deepEqual(readWorkspaceBoard(db, { ...read, mode: 'summary' }), boards.summary('alice', 'default'));
  assert.deepEqual(readWorkspaceBoard(db, { ...read, mode: 'list', resourceId: null }), boards.list('alice'));
  assert.deepEqual(readWorkspaceBoard(db, { ...read, owner: 'bob' }), empty);
  assert.deepEqual(readWorkspaceBoard(db, { owner: 'bob', mode: 'list', resourceId: null }), [summarizeBoard(empty)]);
  assert.equal(db.isTransaction, false);
});
test('catalog streams the complete 64-board quota with synthetic default and original ordering', t => {
  const { db, boards } = fixture(t);
  db.exec('DELETE FROM hub_workspace_boards');
  for (let i = 0; i < 64; i++) boards.save('alice', randomUUID(), { ...content, revision: 0, mutationId: randomUUID() });
  const value = readWorkspaceBoard(db, { ...read, mode: 'list', resourceId: null });
  assert.deepEqual(value, boards.list('alice')); assert.equal((value as unknown[]).length, 65);
  assert.doesNotMatch(JSON.stringify(value), /Long session|"tasks"|"detail"/);
});
for (const [name, column, value, cast] of [
  ['invalid UTF8', 'content', Buffer.from([255]), true], ['BLOB', 'content', Buffer.from(JSON.stringify(content)), false],
  ['trailing NUL', 'content', JSON.stringify(content) + '\0', false], ['invalid JSON', 'content', '{', false],
  ['oversized', 'content', ' '.repeat(BOARD_MAX_BODY_BYTES + 1), false],
  ['extra fields', 'content', JSON.stringify({ ...content, credential: 'private' }), false],
  ['bad task', 'content', JSON.stringify({ ...content, tasks: [{ ...content.tasks[0], status: 'bad' }] }), false],
  ['zero revision', 'revision', 0, false], ['unsafe revision', 'revision', Number.MAX_SAFE_INTEGER, false],
  ['negative timestamp', 'updated_at', -1, false], ['fractional timestamp', 'updated_at', 1.5, false],
] as const) test(`all read modes reject ${name}, never repair or publish partial content`, t => {
  const { db } = fixture(t);
  db.prepare(`UPDATE hub_workspace_boards SET ${column}=${cast ? 'CAST(? AS TEXT)' : '?'}`).run(value);
  const before = db.prepare('SELECT hex(content) AS content,revision,updated_at FROM hub_workspace_boards').get();
  for (const mode of ['document', 'summary', 'list'] as const) {
    assert.throws(() => readWorkspaceBoard(db, { ...read, mode, resourceId: mode === 'list' ? null : 'default' }), DeliverySnapshotReadRejected);
    assert.equal(db.isTransaction, false);
  }
  assert.deepEqual(db.prepare('SELECT hex(content) AS content,revision,updated_at FROM hub_workspace_boards').get(), before);
});
test('maximum legal stored byte snapshot is complete; no normalized task content', t => {
  const { db, boards } = fixture(t), raw = JSON.stringify(content);
  db.prepare('UPDATE hub_workspace_boards SET content=?').run(raw + ' '.repeat(BOARD_MAX_BODY_BYTES - Buffer.byteLength(raw)));
  assert.deepEqual(readWorkspaceBoard(db, read), boards.get('alice', 'default'));
});
test('invalid scope and outer transaction refusal cannot settle or release the caller transaction', t => {
  const { db } = fixture(t); db.exec('BEGIN');
  assert.throws(() => readWorkspaceBoard(db, read), DeliverySnapshotReadRejected);
  assert.equal(db.isTransaction, true); db.exec('ROLLBACK');
  for (const bad of [{ ...read, owner: 'alice\0' }, { ...read, resourceId: 'bad' }, { ...read, mode: 'list' }])
    assert.throws(() => readWorkspaceBoard(db, bad as WorkspaceBoardRead), DeliverySnapshotReadRejected);
});
test('rollback failure stays a physical owner failure, not a completed bounded refusal', t => {
  const { db } = fixture(t), original = db.exec.bind(db), failure = Error('private cleanup failure');
  db.exec("UPDATE hub_workspace_boards SET content='broken'");
  const mock = t.mock.method(db, 'exec', (sql: string) => { if (sql === 'ROLLBACK') throw failure; return original(sql); });
  assert.throws(() => readWorkspaceBoard(db, read), error => error === failure);
  assert.equal(db.isTransaction, true); mock.mock.restore(); db.exec('ROLLBACK');
});
test('corrupt duplicate schema refuses a whole single read and a whole catalog at bounded limits', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE hub_workspace_boards(user_id,resource_id,content,revision,updated_at)');
  const insert = db.prepare('INSERT INTO hub_workspace_boards VALUES(?,?,?,?,?)');
  for (let i = 0; i < 100; i++) insert.run('alice', 'default', JSON.stringify(content), 1, 1);
  assert.throws(() => readWorkspaceBoard(db, read), DeliverySnapshotReadRejected);
  assert.throws(() => readWorkspaceBoard(db, { ...read, mode: 'list', resourceId: null }), DeliverySnapshotReadRejected);
});
test('protocol refuses widening, wrong reply scope, extra fields, wrong counts and duplicate catalog rows', () => {
  const d = { ...empty, ...content, revision: 1, updatedAt: 1 }, s = summarizeBoard(d);
  assert.equal(validWorkspaceBoardRead({ ...read, credential: 'secret' }), false);
  assert.equal(validWorkspaceBoardResult(d, read), true);
  assert.equal(validWorkspaceBoardResult({ ...d, resourceId: randomUUID() }, read), false);
  assert.equal(validWorkspaceBoardResult({ ...d, credential: 'secret' }, read), false);
  assert.equal(validWorkspaceBoardResult({ ...s, tasks: [] }, { ...read, mode: 'summary' }), false);
  assert.equal(validWorkspaceBoardResult({ ...s, counts: { todo: 0, doing: 201, done: 0 } }, { ...read, mode: 'summary' }), false);
  assert.equal(validWorkspaceBoardResult([s, s], { ...read, mode: 'list', resourceId: null }), false);
});
function fileFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'board-read-')), file = join(root, 'hub.sqlite'), store = new HubStore(file, 'synthetic');
  t.after(async () => { await store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, file, db: (store as unknown as { db: DatabaseSync }).db };
}
test('actual file-backed three-mode chain avoids main-thread body SQL and preserves durable CAS/receipt across reopen', async t => {
  const { store, db, file } = fileFixture(t), input = { ...content, revision: 0, mutationId: randomUUID() };
  const expected = store.boards.save('alice', 'default', input);
  assert.equal(expected.status, 'saved');
  const mock = t.mock.method(db, 'prepare', function(this: DatabaseSync, sql: string) {
    assert.doesNotMatch(sql, /SELECT[^;]*\bcontent\b/i); return DatabaseSync.prototype.prepare.call(this, sql);
  });
  const sync = ['get', 'list', 'summary'].map(key => t.mock.method(store.boards, key as 'get', () => { throw Error('sync board body forbidden'); }));
  for (const mode of ['document', 'summary', 'list'] as const) {
    const value = await store.workspaceBoardAsync({ ...read, mode, resourceId: mode === 'list' ? null : 'default' });
    assert.ok(validWorkspaceBoardResult(value, { ...read, mode, resourceId: mode === 'list' ? null : 'default' }));
  }
  mock.mock.restore(); for (const m of sync) m.mock.restore();
  assert.deepEqual(store.boards.save('alice', 'default', input), expected);
  assert.equal(store.boards.save('alice', 'default', { ...input, mutationId: randomUUID() }).status, 'conflict');
  await store.close(); const reopened = new HubStore(file, 'synthetic');
  try { assert.deepEqual(await reopened.workspaceBoardAsync(read), expected.status === 'saved' ? expected.document : null); }
  finally { await reopened.close(); }
});
test('damaged display does not retire a healthy observer; original writer repair makes next read usable', async t => {
  const { store, db } = fileFixture(t);
  store.boards.save('alice', 'default', { ...content, revision: 0, mutationId: randomUUID() });
  db.exec("UPDATE hub_workspace_boards SET content='broken'");
  await assert.rejects(store.workspaceBoardAsync(read));
  const previous = (store as unknown as { deliveryReader: unknown }).deliveryReader;
  // Isolated original connection repairs fixture bytes; the reader cannot.
  db.prepare('UPDATE hub_workspace_boards SET content=?').run(JSON.stringify(content));
  const saved = store.boards.save('alice', 'default', { ...content, revision: 1, mutationId: randomUUID() });
  assert.equal(saved.status, 'saved');
  assert.deepEqual(await store.workspaceBoardAsync(read), saved.status === 'saved' ? saved.document : null);
  assert.equal((store as unknown as { deliveryReader: unknown }).deliveryReader, previous);
});
test('original-writer metadata fence rejects oversized noninteger columns before JS allocation in all three modes', async t => {
  const { store, db } = fileFixture(t);
  store.boards.save('alice', 'default', { ...content, revision: 0, mutationId: randomUUID() });
  let rejectedColumn: 'revision' | 'updatedAt' = 'revision', inspected = 0;
  const mock = t.mock.method(db, 'prepare', function(this: DatabaseSync, sql: string) {
    assert.doesNotMatch(sql, /SELECT[^;]*\bcontent\b/i);
    const statement = DatabaseSync.prototype.prepare.call(this, sql), all = statement.all.bind(statement);
    t.mock.method(statement, 'all', (...args: Parameters<typeof statement.all>) => {
      const rows = all(...args);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]![rejectedColumn], null, 'invalid SQL column must not cross the metadata boundary');
      inspected++;
      return rows;
    });
    return statement;
  });
  for (const column of ['revision', 'updated_at'] as const) {
    db.exec('UPDATE hub_workspace_boards SET revision=1,updated_at=1');
    // Isolated corruption: INTEGER affinity permits both enormous TEXT and BLOB.
    db.exec(`UPDATE hub_workspace_boards SET ${column}=${column === 'revision' ? 'CAST(zeroblob(2097152) AS TEXT)' : 'zeroblob(2097152)'}`);
    rejectedColumn = column === 'revision' ? 'revision' : 'updatedAt';
    for (const mode of ['document', 'summary', 'list'] as const)
      await assert.rejects(store.workspaceBoardAsync({ ...read, mode, resourceId: mode === 'list' ? null : 'default' }), DeliverySnapshotReadRejected);
  }
  assert.equal(inspected, 6); mock.mock.restore();
  assert.equal(db.prepare('SELECT length(updated_at) AS bytes FROM hub_workspace_boards').get()!.bytes, 2097152);
  db.exec('UPDATE hub_workspace_boards SET revision=1,updated_at=1');
  assert.deepEqual(await store.workspaceBoardAsync(read), store.boards.get('alice', 'default'));
});
test('writer revision change across awaited display refuses old snapshot; no automatic read replay', async t => {
  const { store } = fileFixture(t), original = store.workspaceBoardReadVersion.bind(store);
  let calls = 0;
  t.mock.method(store, 'workspaceBoardReadVersion', (request: WorkspaceBoardRead) => {
    if (++calls === 2) store.boards.save('alice', 'default', { ...content, revision: 0, mutationId: randomUUID() });
    return original(request);
  });
  await assert.rejects(store.workspaceBoardAsync(read), DeliverySnapshotReadRejected);
  assert.equal(calls, 2); assert.equal((await store.workspaceBoardAsync(read) as BoardDocument).revision, 1);
});
test('caller cannot widen scope while original failed reader close is awaited for recovery', async t => {
  const { store } = fileFixture(t);
  const saved = store.boards.save('alice', 'default', { ...content, revision: 0, mutationId: randomUUID() });
  let release!: () => void, closes = 0;
  const previous = { recoveryState: { unavailable: true, exitConfirmed: true }, close: () => {
    closes++; return new Promise<void>(done => { release = done; });
  } };
  const state = store as unknown as { deliveryReader?: typeof previous; failedDeliveryReader?: typeof previous; deliveryRetryAt: number };
  state.deliveryReader = previous; state.failedDeliveryReader = previous; state.deliveryRetryAt = 0;
  const request = { ...read }, result = store.workspaceBoardAsync(request);
  assert.equal(closes, 1); request.owner = 'bob'; request.resourceId = randomUUID(); request.mode = 'list';
  release(); assert.deepEqual(await result, saved.status === 'saved' ? saved.document : null);
  assert.equal(closes, 1);
});
test('open transaction, extra request fields and closed writer refuse without sync body fallback', async t => {
  const { store, db } = fileFixture(t);
  const mock = t.mock.method(db, 'prepare', function(this: DatabaseSync, sql: string) {
    assert.doesNotMatch(sql, /SELECT[^;]*\bcontent\b/i); return DatabaseSync.prototype.prepare.call(this, sql);
  });
  db.exec('BEGIN'); await assert.rejects(store.workspaceBoardAsync(read));
  assert.equal(db.isTransaction, true); db.exec('ROLLBACK');
  await assert.rejects(store.workspaceBoardAsync({ ...read, credential: 'private' } as WorkspaceBoardRead));
  assert.deepEqual(await store.workspaceBoardAsync(read), empty);
  mock.mock.restore(); await store.close(); await assert.rejects(store.workspaceBoardAsync(read));
});
test('real file-backed catalog reaches full quota and refuses overflow without partial publication', async t => {
  const { store, db } = fileFixture(t), scope: WorkspaceBoardRead = { ...read, mode: 'list', resourceId: null };
  for (let i = 0; i < 64; i++) store.boards.save('alice', randomUUID(), { ...content, revision: 0, mutationId: randomUUID() });
  assert.deepEqual(await store.workspaceBoardAsync(scope), store.boards.list('alice'));
  db.prepare('INSERT INTO hub_workspace_boards VALUES(?,?,?,?,?)').run('alice', randomUUID(), JSON.stringify(content), 1, 1);
  await assert.rejects(store.workspaceBoardAsync(scope));
  assert.equal(db.prepare('SELECT count(*) AS n FROM hub_workspace_boards').get()!.n, 65);
});
class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; read?: WorkspaceBoardRead }[] = [];
  postMessage(message: { id: number; kind: string; read?: WorkspaceBoardRead }) { this.messages.push(message); }
  terminate() { return Promise.resolve(1); }
}
function fake(t: TestContext) {
  const worker = new FakeWorker(), lines: string[] = [], diagnostics = new PerformanceDiagnostics(line => lines.push(line));
  const reader = new AsyncHubDeliveryReader({ file: 'synthetic', dev: 1, ino: 1 }, diagnostics, () => worker as unknown as Worker);
  t.after(async () => { worker.emit('exit', 1); await reader.close(); });
  return { worker, reader, lines };
}
test('request scope is copied before readiness; wrong successful owner reply retires observer', async t => {
  const { worker, reader } = fake(t), scope = { ...read }, pending = reader.boards(scope);
  scope.owner = 'bob'; scope.resourceId = randomUUID(); worker.emit('message', { kind: 'ready' }); await turn();
  assert.deepEqual(worker.messages[0]!.read, read);
  const message = worker.messages[0]!;
  worker.emit('message', { id: message.id, kind: 'boards', ok: true, value: { ...empty, resourceId: scope.resourceId } });
  await assert.rejects(pending); assert.equal(reader.recoveryState.unavailable, true);
});
test('board reads share four original snapshot slots; bounded refusal retains healthy owner and returns only its own slot', async t => {
  const { worker, reader, lines } = fake(t);
  const pending = [reader.boards(read), reader.boards({ ...read, mode: 'summary' }), reader.preferences('alice'), reader.users({ owner: 'alice', admin: false })];
  const results = Promise.allSettled(pending);
  await assert.rejects(reader.boards(read)); assert.equal(worker.messages.length, 0);
  worker.emit('message', { kind: 'ready' }); await turn();
  const first = worker.messages[0]!;
  worker.emit('message', { id: first.id, kind: first.kind, ok: false }); await turn();
  assert.equal(reader.recoveryState.unavailable, false);
  const next = reader.boards(read); await turn();
  const last = worker.messages.at(-1)!;
  worker.emit('message', { id: last.id, kind: last.kind, ok: true, value: empty });
  assert.deepEqual(await next, empty);
  worker.emit('exit', 1); await results;
  assert.ok(lines.some(line => line.includes('hub-workspace-board-read')));
  assert.doesNotMatch(lines.join('\n'), /Long session|alice|synthetic|Old task/);
});
