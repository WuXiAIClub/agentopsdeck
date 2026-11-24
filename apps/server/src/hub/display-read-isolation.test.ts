import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { Worker } from 'node:worker_threads';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AsyncHubDeliveryReader } from './async-delivery-reader.js';
import { DeliverySnapshotReadRejected, isDeliverySnapshotReadRejected } from './delivery-reader-protocol.js';
import { readSessionPreferences } from './preference-read.js';
import { readUsers } from './user-read.js';
import { reportHubReadFailure } from './read-failure-diagnostics.js';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const request = { owner: 'default', domains: [['node', 'current']] as [string, string][] };
const empty = { reset: false, cursor: undefined, events: [] };
const member = { id: 'default', label: 'Default', createdAt: 1, updatedAt: 2 };

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-display-isolation-')), file = join(dir, 'hub.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE hub_events(id TEXT PRIMARY KEY,owner_user_id TEXT,connection_id TEXT,stream_domain TEXT,payload_json TEXT);
    CREATE TABLE session_preferences(user_id TEXT,session_id TEXT,hidden INTEGER,archived INTEGER,pinned INTEGER);
    CREATE TABLE users(id TEXT PRIMARY KEY,label TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE hub_user_usage(user_id TEXT PRIMARY KEY,last_login_at INTEGER,last_active_at INTEGER);
    INSERT INTO session_preferences VALUES('default','session',1,0,NULL),('other','safe',0,1,0);
    INSERT INTO users VALUES('default','Default',1,2),('other','Other',3,4)`);
  const lines: string[] = [], diagnostics = new PerformanceDiagnostics(line => lines.push(line));
  const stat = lstatSync(file), reader = new AsyncHubDeliveryReader({ file, dev: stat.dev, ino: stat.ino }, diagnostics);
  t.after(async () => { await reader.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const facts = () => JSON.stringify({ preferences: db.prepare('SELECT hex(session_id),hidden,archived,pinned FROM session_preferences').all(),
    users: db.prepare('SELECT hex(id),hex(label),created_at,updated_at FROM users').all(),
    events: db.prepare('SELECT * FROM hub_events').all() });
  return { db, reader, diagnostics, lines, facts };
}

for (const literal of ["CAST(x'ff' AS TEXT)", "'a'||char(0)||'b'", "x'6162'", "''", "'a'||char(10)||'b'", "printf('%05000d',0)"]) {
  test(`invalid preference ID ${literal} refuses only display, keeps chat and recovers fresh`, async t => {
    const h = fixture(t); h.db.exec(`UPDATE session_preferences SET session_id=${literal} WHERE user_id='default'`);
    const before = h.facts(), failed = h.reader.preferences('default'), page = h.reader.read(request);
    await assert.rejects(failed, isDeliverySnapshotReadRejected);
    assert.deepEqual(await page, empty); assert.deepEqual(h.reader.recoveryState, { unavailable: false, exitConfirmed: false });
    assert.equal(h.facts(), before, 'read refusal never repairs or drops user data');
    assert.deepEqual(await h.reader.preferences('other'), [['safe', { hidden: false, archived: true, pinned: false }]]);
    h.db.exec("UPDATE session_preferences SET session_id='session' WHERE user_id='default'");
    assert.deepEqual(await h.reader.preferences('default'), [['session', { hidden: true, archived: false }]]);
    const log = h.diagnostics.snapshot().events.find(row => row.operation === 'hub-preference-read' && row.deferred === 1)!;
    assert.equal(log.settled, 1); assert.equal(log.unknown, undefined);
    assert.equal(h.lines.some(line => line.includes('readonly-sql-owner-failure')), false);
    assert.equal(h.lines.some(line => line.includes('session') || line.includes('default')), false);
  });
}

for (const literal of ['2', '-1', '1.5', "'invalid'"]) test(`invalid preference flag ${literal} does not return defaults or retire chat`, async t => {
  const h = fixture(t); h.db.exec(`UPDATE session_preferences SET hidden=${literal} WHERE user_id='default'`);
  await assert.rejects(h.reader.preferences('default'), isDeliverySnapshotReadRejected);
  assert.deepEqual(await h.reader.read(request), empty); assert.equal(h.reader.recoveryState.unavailable, false);
});

test('duplicate preference identity fails complete snapshot while same reader remains usable', async t => {
  const h = fixture(t); h.db.exec("INSERT INTO session_preferences VALUES('default','session',0,0,0)");
  await assert.rejects(h.reader.preferences('default'), isDeliverySnapshotReadRejected);
  assert.deepEqual(await h.reader.read(request), empty);
  h.db.exec('DELETE FROM session_preferences WHERE rowid=(SELECT max(rowid) FROM session_preferences)');
  assert.equal((await h.reader.preferences('default')).length, 1);
});

for (const [column, literal] of [['label', "CAST(x'ff' AS TEXT)"], ['label', "'a'||char(0)||'b'"],
  ['label', "x'6162'"], ['label', "printf('%05000d',0)"], ['created_at', '-1'], ['updated_at', '1.5']] as const) {
  test(`invalid users ${column} ${literal} stays local to display and recovers without replacing reader`, async t => {
    const h = fixture(t); h.db.exec(`UPDATE users SET ${column}=${literal} WHERE id='other'`);
    const before = h.facts(), failed = h.reader.users({ owner: 'default', admin: true }), page = h.reader.read(request);
    await assert.rejects(failed, isDeliverySnapshotReadRejected); assert.deepEqual(await page, empty);
    assert.equal(h.facts(), before); assert.deepEqual(h.reader.recoveryState, { unavailable: false, exitConfirmed: false });
    assert.deepEqual(await h.reader.users({ owner: 'default', admin: false }), [member]);
    h.db.exec("UPDATE users SET label='Other',created_at=3,updated_at=4 WHERE id='other'");
    assert.equal((await h.reader.users({ owner: 'default', admin: true })).length, 2);
    const log = h.diagnostics.snapshot().events.find(row => row.operation === 'hub-users-read' && row.deferred === 1)!;
    assert.equal(log.settled, 1); assert.equal(log.unknown, undefined);
    assert.equal(h.lines.some(line => line.includes('readonly-sql-owner-failure')), false);
  });
}

for (const kind of ['users', 'preferences'] as const) test(`${kind} complete byte-budget refusal keeps chat and recovers in the same worker`, async t => {
  const h = fixture(t);
  const sequence = 'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2200)';
  h.db.exec(kind === 'users'
    ? `${sequence} INSERT INTO users SELECT 'budget-'||x,printf('%04000d',x),1,2 FROM n`
    : `${sequence} INSERT INTO session_preferences SELECT 'default',printf('%04000d',x),1,0,NULL FROM n`);
  const read = () => kind === 'users' ? h.reader.users({ owner: 'default', admin: true }) : h.reader.preferences('default');
  const refused = read(), chat = h.reader.read(request);
  await assert.rejects(refused, isDeliverySnapshotReadRejected);
  assert.deepEqual(await chat, empty);
  assert.deepEqual(h.reader.recoveryState, { unavailable: false, exitConfirmed: false });
  h.db.exec(kind === 'users' ? "DELETE FROM users WHERE id LIKE 'budget-%'"
    : "DELETE FROM session_preferences WHERE user_id='default' AND length(session_id)=4000");
  assert.equal((await read()).length, kind === 'users' ? 2 : 1);
  assert.equal(h.lines.some(line => line.includes('readonly-sql-owner-failure')), false);
});

for (const table of ['users', 'session_preferences']) test(`${table} SQL failure still retires original physical reader`, async t => {
  const h = fixture(t); h.db.exec(`DROP TABLE ${table}`);
  await assert.rejects(table === 'users' ? h.reader.users({ owner: 'default', admin: true }) : h.reader.preferences('default'));
  assert.equal(h.reader.recoveryState.unavailable, true);
  await assert.rejects(h.reader.read(request)); await h.reader.close();
  assert.equal(h.reader.recoveryState.exitConfirmed, true);
  assert.equal(h.lines.some(line => line.includes('readonly-sql-owner-failure')), true);
});

class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string }[] = [];
  terminated = 0;
  postMessage(message: { id: number; kind: string }) {
    this.messages.push(message);
    if (message.kind === 'close') queueMicrotask(() => {
      this.emit('message', { id: message.id, kind: 'close', ok: true }); this.emit('exit', 0);
    });
  }
  terminate() { this.terminated++; queueMicrotask(() => this.emit('exit', 1)); return Promise.resolve(1); }
}
function fake(t: TestContext) {
  const worker = new FakeWorker(), reader = new AsyncHubDeliveryReader({ file: '/unused', dev: 1, ino: 1 },
    new PerformanceDiagnostics(() => {}), () => worker as unknown as Worker);
  queueMicrotask(() => worker.emit('message', { kind: 'ready' }));
  t.after(async () => { worker.emit('exit', 1); await reader.close(); });
  return { worker, reader };
}
for (const kind of ['preferences', 'users'] as const) test(`${kind} refusal restores four-slot admission and close drains exact originals`, async t => {
  const h = fake(t), read = () => kind === 'users' ? h.reader.users({ owner: 'default', admin: true }) : h.reader.preferences('default');
  const reads = Array.from({ length: 4 }, () => read()), rejected = Promise.all(reads.map(p => assert.rejects(p, isDeliverySnapshotReadRejected)));
  await assert.rejects(read()); await turn(); assert.equal(h.worker.messages.length, 4);
  h.worker.messages.forEach(sent => h.worker.emit('message', { id: sent.id, kind, ok: false })); await rejected;
  const next = read(); await turn(); assert.equal(h.worker.messages.length, 5);
  const closing = h.reader.close(); assert.equal(h.worker.messages.some(sent => sent.kind === 'close'), false);
  h.worker.emit('message', { id: h.worker.messages[4]!.id, kind, ok: true,
    value: kind === 'users' ? [{ ...member, usage: { lastLoginAt: null, lastActiveAt: null } }] : [] });
  await next; await closing; assert.equal(h.worker.terminated, 0);
});

for (const kind of ['preferences', 'users', 'page'] as const) for (const malformed of ['value', 'wrong-kind', 'unknown-id'] as const) {
  test(`${kind} ${malformed} refusal remains protocol failure, not a soft display error`, async t => {
    const h = fake(t), p = kind === 'users' ? h.reader.users({ owner: 'default', admin: true })
      : kind === 'preferences' ? h.reader.preferences('default') : h.reader.read(request);
    const rejected = assert.rejects(p); await turn();
    const sent = h.worker.messages[0]!;
    h.worker.emit('message', { id: malformed === 'unknown-id' ? sent.id + 100 : sent.id,
      kind: malformed === 'wrong-kind' ? 'revisions' : kind, ok: false, ...(malformed === 'value' ? { value: undefined } : {}) });
    await rejected; assert.equal(h.reader.recoveryState.unavailable, true);
  });
}

test('page cannot send a soft refusal even with an exact envelope', async t => {
  const h = fake(t), p = h.reader.read(request), rejected = assert.rejects(p); await turn();
  h.worker.emit('message', { ...h.worker.messages[0]!, ok: false });
  await rejected; assert.equal(h.reader.recoveryState.unavailable, true);
});

test('completed-refusal branding never examines hostile exceptions and cannot be forged by prototype', () => {
  let inspected = 0;
  const hostile = new Proxy({}, { getPrototypeOf() { inspected++; throw Error('PRIVATE'); },
    get() { inspected++; throw Error('PRIVATE'); }, getOwnPropertyDescriptor() { inspected++; throw Error('PRIVATE'); } });
  const diagnostics = new PerformanceDiagnostics(() => {});
  assert.equal(isDeliverySnapshotReadRejected(hostile), false);
  assert.equal(isDeliverySnapshotReadRejected(Object.create(DeliverySnapshotReadRejected.prototype)), false);
  assert.equal(isDeliverySnapshotReadRejected(new DeliverySnapshotReadRejected()), true);
  reportHubReadFailure('hub-users-read', hostile, diagnostics);
  assert.equal(inspected, 0); assert.equal(diagnostics.snapshot().events[0]!.settled, undefined);
});

for (const kind of ['users', 'preferences'] as const) test(`${kind} local metadata refusal has settled/deferred logs without SQL fault or leaked values`, () => {
  const db = new DatabaseSync(':memory:'), diagnostics = new PerformanceDiagnostics(() => {});
  db.exec("CREATE TABLE session_preferences(user_id,session_id,hidden,archived,pinned); INSERT INTO session_preferences VALUES('default',x'ff',1,0,NULL); CREATE TABLE users(id,label,created_at,updated_at); INSERT INTO users VALUES('default',x'ff',1,2); CREATE TABLE hub_user_usage(user_id,last_login_at,last_active_at)");
  try {
    assert.throws(() => kind === 'users' ? readUsers(db, { owner: 'default', admin: false }, diagnostics)
      : readSessionPreferences(db, 'default', diagnostics), isDeliverySnapshotReadRejected);
    const log = diagnostics.snapshot().events[0]!;
    assert.equal(log.deferred, 1); assert.equal(log.settled, 1);
    assert.equal(log.unknown, undefined); assert.equal(log.sqlErrorCode, undefined); assert.equal(log.classificationUnknown, undefined);
  } finally { db.close(); }
});
