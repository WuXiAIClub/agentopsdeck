import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCompletionSummary, validCompletionSummaryRead, validCompletionSummaryRows } from './completion-summary-read.js';
import { CompletionUnreadStore } from './completion-unread-store.js';
import { HubStore } from './hub-store.js';
import { AsyncHubDeliveryReader } from './async-delivery-reader.js';
import { DeliverySnapshotReadRejected } from './delivery-reader-protocol.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
const a = 'a'.repeat(64), b = 'b'.repeat(64), generation = randomUUID();
const read = { owner: 'alice', targets: [a] };
const row = { target: a, generation, latestSequence: 1, readThrough: 0, unread: true, coverage: 'observed' as const };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE completion_targets(owner TEXT,target TEXT,generation TEXT,latest INTEGER,read_through INTEGER,gap INTEGER,PRIMARY KEY(owner,target))');
  db.prepare('INSERT INTO completion_targets VALUES(?,?,?,?,?,?)').run('alice', a, generation, 1, 0, 0);
  t.after(() => db.close()); return db;
}
test('legacy absent table is empty without schema initialization or witness writes', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  assert.deepEqual(readCompletionSummary(db, read), []);
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'completion_%'").get()!.n, 0);
  assert.equal(db.isTransaction, false);
});
test('requested order, duplicate keys, owner isolation and coverage preserve old summary wire', t => {
  const db = fixture(t);
  db.prepare('INSERT INTO completion_targets VALUES(?,?,?,?,?,?)').run('alice', b, randomUUID(), 4, 4, 1);
  db.prepare('INSERT INTO completion_targets VALUES(?,?,?,?,?,?)').run('bob', a, randomUUID(), 8, 7, 0);
  const store = new CompletionUnreadStore(db);
  const request = { owner: 'alice', targets: [b, a, b] };
  assert.deepEqual(readCompletionSummary(db, request), store.summary('alice', request.targets));
  assert.deepEqual(readCompletionSummary(db, { owner: 'missing', targets: [a] }), []);
  assert.equal(db.isTransaction, false);
});
for (const [name, column, value, cast] of [
  ['bad UTF8', 'generation', Buffer.from([255]), true], ['BLOB', 'generation', Buffer.from(generation), false],
  ['NUL suffix', 'generation', generation + '\0', false], ['too large', 'generation', 'x'.repeat(200_000), false],
  ['invalid generation', 'generation', 'x'.repeat(36), false], ['negative latest', 'latest', -1, false],
  ['unsafe latest', 'latest', BigInt('9223372036854775807'), false], ['fractional latest', 'latest', 1.5, false],
  ['invalid read through', 'read_through', 2, false], ['bad gap', 'gap', 2, false],
] as const) test(`whole summary rejects ${name}, leaves original bytes and transaction intact`, t => {
  const db = fixture(t);
  db.prepare(`UPDATE completion_targets SET ${column}=${cast ? 'CAST(? AS TEXT)' : '?'}`).run(value);
  const before = db.prepare('SELECT hex(generation) AS bytes,CAST(latest AS TEXT) AS latest,read_through,gap FROM completion_targets').get();
  assert.throws(() => readCompletionSummary(db, read), DeliverySnapshotReadRejected);
  assert.equal(db.isTransaction, false);
  assert.deepEqual(db.prepare('SELECT hex(generation) AS bytes,CAST(latest AS TEXT) AS latest,read_through,gap FROM completion_targets').get(), before);
});
test('snapshot cannot enter an outer transaction, commit or release it', t => {
  const db = fixture(t); db.exec('BEGIN');
  assert.throws(() => readCompletionSummary(db, read), DeliverySnapshotReadRejected);
  assert.equal(db.isTransaction, true); db.exec('ROLLBACK');
  assert.deepEqual(readCompletionSummary(db, read), [row]);
});
test('duplicate corrupt schema is bounded and not partial success', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE completion_targets(owner,target,generation,latest,read_through,gap)');
  const insert = db.prepare('INSERT INTO completion_targets VALUES(?,?,?,?,?,?)');
  for (let i = 0; i < 400; i++) insert.run('alice', a, generation, 1, 0, 0);
  const prepare = db.prepare.bind(db);
  t.mock.method(db, 'prepare', (sql: string) => {
    if (/FROM completion_targets/i.test(sql)) assert.match(sql, /LIMIT 257/);
    return prepare(sql);
  });
  assert.throws(() => readCompletionSummary(db, read), DeliverySnapshotReadRejected);
});
test('cleanup failure is not a bounded-refusal packet or permission to reuse owner', t => {
  const db = fixture(t), cleanup = Error('private rollback failure');
  db.exec("UPDATE completion_targets SET generation='broken'");
  const exec = db.exec.bind(db);
  const mock = t.mock.method(db, 'exec', (sql: string) => { if (sql === 'ROLLBACK') throw cleanup; return exec(sql); });
  assert.throws(() => readCompletionSummary(db, read), error => error === cleanup);
  assert.equal(db.isTransaction, true); mock.mock.restore(); db.exec('ROLLBACK');
});
test('protocol bounds, correlation, order and exact fields cannot widen requested targets', () => {
  assert.equal(validCompletionSummaryRead({ ...read, credential: 'private' }), false);
  assert.equal(validCompletionSummaryRead({ owner: 'alice\0', targets: [a] }), false);
  assert.equal(validCompletionSummaryRead({ ...read, targets: Array(257).fill(a) }), false);
  assert.equal(validCompletionSummaryRead({ ...read, targets: ['invalid'] }), false);
  assert.equal(validCompletionSummaryRows([row], read), true);
  assert.equal(validCompletionSummaryRows([{ ...row, target: b }], read), false);
  assert.equal(validCompletionSummaryRows([row, row], read), false);
  assert.equal(validCompletionSummaryRows([{ ...row, credential: 'private' }], read), false);
  assert.equal(validCompletionSummaryRows([{ ...row, unread: false }], read), false);
  assert.equal(validCompletionSummaryRows([{ ...row, target: b }, row], { ...read, targets: [a, b] }), false);
});
test('file-backed summary avoids original-thread content SQL; original observation and ACK remain durable on reopen', async t => {
  const root = mkdtempSync(join(tmpdir(), 'completion-summary-')), file = join(root, 'hub.sqlite');
  let store = new HubStore(file, 'synthetic');
  t.after(async () => { await store.close(); rmSync(root, { recursive: true, force: true }); });
  store.completions.baseline('alice', a, 'epoch', 10);
  store.completions.record({ owner: 'alice', target: a, epoch: 'epoch', turnId: 'turn', sourceCursor: 11, provenance: 'live-successful-message' });
  const expected = store.completions.summary('alice', [a]);
  const db = (store as unknown as { db: DatabaseSync }).db;
  const mock = t.mock.method(db, 'prepare', function(this: DatabaseSync, sql: string) {
    assert.doesNotMatch(sql, /FROM completion_targets/i); return DatabaseSync.prototype.prepare.call(this, sql);
  });
  const sync = t.mock.method(store.completions, 'summary', () => { throw Error('sync summary forbidden'); });
  assert.deepEqual(await store.completionSummaryAsync('alice', [a]), expected);
  mock.mock.restore(); sync.mock.restore();
  const observation = store.completions.observe('alice', a), requestId = randomUUID();
  assert.equal(store.completions.markRead('alice', a, requestId, observation.token, 1), 1);
  assert.equal(store.completions.markRead('alice', a, requestId, observation.token, 1), 1);
  assert.equal((await store.completionSummaryAsync('alice', [a]))[0]!.unread, false);
  await store.close(); store = new HubStore(file, 'synthetic');
  const reopened = await store.completionSummaryAsync('alice', [a]);
  assert.equal(reopened[0]!.unread, false); assert.equal(reopened[0]!.readThrough, 1); assert.equal(reopened[0]!.coverage, 'gap');
});
test('real readonly owner refuses corruption, then reuses the same healthy owner after original-writer repair', async t => {
  const root = mkdtempSync(join(tmpdir(), 'completion-summary-repair-'));
  const store = new HubStore(join(root, 'hub.sqlite'), 'synthetic');
  t.after(async () => { await store.close(); rmSync(root, { recursive: true, force: true }); });
  store.completions.baseline('alice', a, 'epoch', 10);
  const db = (store as unknown as { db: DatabaseSync }).db;
  const original = db.prepare('SELECT generation FROM completion_targets').get()!.generation!;
  db.exec("UPDATE completion_targets SET generation='bad'");
  await assert.rejects(store.completionSummaryAsync('alice', [a]));
  const owner = (store as unknown as { deliveryReader: AsyncHubDeliveryReader }).deliveryReader;
  assert.equal(owner.recoveryState.unavailable, false);
  db.prepare('UPDATE completion_targets SET generation=?').run(original);
  assert.equal((await store.completionSummaryAsync('alice', [a])).length, 1);
  assert.equal((store as unknown as { deliveryReader: AsyncHubDeliveryReader }).deliveryReader, owner);
  db.exec('BEGIN'); await assert.rejects(store.completionSummaryAsync('alice', [a])); db.exec('ROLLBACK');
  await store.close(); await assert.rejects(store.completionSummaryAsync('alice', [a]));
});
test('store owns targets before awaiting the previous physical read-owner retirement', async t => {
  const root = mkdtempSync(join(tmpdir(), 'completion-summary-retirement-'));
  const store = new HubStore(join(root, 'hub.sqlite'), 'synthetic');
  t.after(async () => { await store.close(); rmSync(root, { recursive: true, force: true }); });
  store.completions.baseline('alice', a, 'epoch', 10);
  store.completions.baseline('alice', b, 'epoch', 10);
  let release!: () => void, retired = false;
  const previous = { recoveryState: { unavailable: true, exitConfirmed: true }, close: () =>
    new Promise<void>(resolve => { retired = true; release = resolve; }) } as unknown as AsyncHubDeliveryReader;
  const state = store as unknown as { deliveryReader: AsyncHubDeliveryReader; failedDeliveryReader: AsyncHubDeliveryReader; deliveryRetryAt: number };
  state.deliveryReader = previous; state.failedDeliveryReader = previous; state.deliveryRetryAt = 0;
  const targets = [a], pending = store.completionSummaryAsync('alice', targets);
  assert.equal(retired, true); targets[0] = b; targets.push(b); release();
  const rows = await pending;
  assert.deepEqual(rows.map(row => row.target), [a]);
  assert.notEqual(state.deliveryReader, previous);
});
class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; read?: unknown }[] = [];
  postMessage(message: { id: number; kind: string; read?: unknown }) { this.messages.push(message); }
  terminate() { return Promise.resolve(1); }
  reply(index: number, value: unknown) { const sent = this.messages[index]!; this.emit('message', { id: sent.id, kind: sent.kind, ok: true, value }); }
}
function fake(t: TestContext) {
  const worker = new FakeWorker(), logs: string[] = [];
  const reader = new AsyncHubDeliveryReader({ file: 'synthetic', dev: 1, ino: 1 },
    new PerformanceDiagnostics(line => logs.push(line)), () => worker as unknown as Worker);
  t.after(async () => { worker.emit('exit', 1); await reader.close(); });
  return { reader, worker, logs };
}
test('caller mutation after admission cannot widen the owned target snapshot', async t => {
  const { reader, worker } = fake(t), targets = [a];
  const work = reader.completions('alice', targets); targets.push(b);
  worker.emit('message', { kind: 'ready' }); await turn();
  assert.deepEqual(worker.messages[0]!.read, read); worker.reply(0, [row]); await work;
});
test('completion summaries share four original slots and contain safe operation logs, no owner or targets', async t => {
  const { reader, worker, logs } = fake(t);
  const works = [reader.completions('alice', [a]), reader.layout('alice', 'current'), reader.workspace('alice'), reader.completions('alice', [])];
  await assert.rejects(reader.completions('alice', [b]));
  worker.emit('message', { kind: 'ready' }); await turn();
  worker.reply(0, [row]); worker.reply(1, { revision: 0, content: null });
  worker.reply(2, { revision: 0, groups: [], sessions: {} }); worker.reply(3, []); await Promise.all(works);
  assert.ok(logs.some(line => line.includes('hub-completion-summary-read')));
  assert.ok(logs.every(line => !line.includes('alice') && !line.includes(a) && !line.includes(generation)));
});
test('bounded refusal keeps owner; wrong target success retires it rather than becoming empty unread', async t => {
  const { reader, worker } = fake(t); worker.emit('message', { kind: 'ready' });
  const first = reader.completions('alice', [a]), rejected = assert.rejects(first, DeliverySnapshotReadRejected); await turn();
  worker.emit('message', { id: worker.messages[0]!.id, kind: 'completions', ok: false }); await rejected;
  assert.equal(reader.recoveryState.unavailable, false);
  const next = reader.completions('alice', [a]), failed = assert.rejects(next); await turn();
  worker.reply(1, [{ ...row, target: b }]); await failed;
  assert.equal(reader.recoveryState.unavailable, true);
});
test('close drains original summary, then requires close ACK and physical exit', async t => {
  const { reader, worker } = fake(t); worker.emit('message', { kind: 'ready' });
  const original = reader.completions('alice', [a]); await turn();
  let closed = false; const close = reader.close().then(() => { closed = true; }); await turn();
  assert.equal(worker.messages.length, 1); await assert.rejects(reader.completions('alice', []));
  worker.reply(0, [row]); await original; await turn();
  const last = worker.messages[1]!; worker.emit('message', { id: last.id, kind: 'close', ok: true });
  await turn(); assert.equal(closed, false); worker.emit('exit', 0); await close;
});
