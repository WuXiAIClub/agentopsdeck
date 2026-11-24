import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { lstatSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { Worker } from 'node:worker_threads';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { readUsers } from './user-read.js';
import { AsyncHubDeliveryReader } from './async-delivery-reader.js';
import { HubStore } from './hub-store.js';
import { validUserRead, validUserRows, USER_ROW_LIMIT, type UserRead } from './delivery-reader-protocol.js';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const user = { id: 'default', label: '默认账户', createdAt: 1, updatedAt: 2 };
const admin = { ...user, usage: { lastLoginAt: null, lastActiveAt: null } };
function dbFixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,label TEXT,created_at INTEGER,updated_at INTEGER); CREATE TABLE hub_user_usage(user_id TEXT PRIMARY KEY,last_login_at INTEGER,last_active_at INTEGER)');
  db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(user.id, user.label, 1, 2);
  db.prepare('INSERT INTO users VALUES(?,?,?,?)').run('other', 'Alpha', 3, 4);
  db.prepare('INSERT INTO hub_user_usage VALUES(?,?,?)').run('other', 5, 6);
  t.after(() => db.close()); return db;
}
class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; read?: unknown }[] = [];
  autoExit = true;
  postMessage(message: { id: number; kind: string; read?: unknown }) {
    this.messages.push(message);
    if (message.kind === 'close') queueMicrotask(() => {
      this.emit('message', { id: message.id, kind: 'close', ok: true }); this.emit('exit', 0);
    });
  }
  terminate() { if (this.autoExit) queueMicrotask(() => this.emit('exit', 1)); return Promise.resolve(1); }
  reply(index: number, value: unknown) {
    const sent = this.messages[index]!;
    this.emit('message', { id: sent.id, kind: sent.kind, ok: true, value });
  }
}
function fake(t: TestContext, ready = true) {
  const worker = new FakeWorker(), diagnostics = new PerformanceDiagnostics(() => {});
  const reader = new AsyncHubDeliveryReader({ file: '/unused', dev: 1, ino: 1 }, diagnostics, () => worker as unknown as Worker);
  if (ready) queueMicrotask(() => worker.emit('message', { kind: 'ready' }));
  t.after(async () => { worker.emit('exit', 1); await reader.close(); });
  return { reader, worker, diagnostics };
}

test('single display snapshot preserves ordering and optional admin usage without admitting authority', t => {
  const db = dbFixture(t);
  assert.deepEqual(readUsers(db, { owner: 'default', admin: true }), [admin,
    { id: 'other', label: 'Alpha', createdAt: 3, updatedAt: 4, usage: { lastLoginAt: 5, lastActiveAt: 6 } }]);
  assert.deepEqual(readUsers(db, { owner: 'default', admin: false }), [user]);
  assert.deepEqual(readUsers(db, { owner: 'absent', admin: false }), []);
  db.exec("UPDATE users SET label=x'ff' WHERE id='other'");
  assert.deepEqual(readUsers(db, { owner: 'default', admin: false }), [user], 'SQL scopes before decoding other accounts');
  assert.throws(() => readUsers(db, { owner: 'default', admin: true }));
});

for (const [column, literal] of [ ['id', "CAST(x'ff' AS TEXT)"], ['id', "'a'||char(0)||'b'"],
  ['id', "x'6162'"], ['label', "CAST(x'ff' AS TEXT)"], ['label', "'a'||char(0)||'b'"],
  ['created_at', '-1'], ['updated_at', '1.5'] ] as const) {
  test(`display refuses corrupt ${column} ${literal} without editing facts`, t => {
    const db = dbFixture(t); db.exec(`UPDATE users SET ${column}=${literal} WHERE id='other'`);
    const before = JSON.stringify(db.prepare('SELECT hex(id),hex(label),created_at,updated_at FROM users').all());
    assert.throws(() => readUsers(db, { owner: 'default', admin: true }));
    assert.equal(JSON.stringify(db.prepare('SELECT hex(id),hex(label),created_at,updated_at FROM users').all()), before);
    assert.equal(db.prepare('SELECT count(*) AS n FROM users').get()!.n, 2, 'failure releases statement');
  });
}

for (const bound of ['rows', 'bytes'] as const) test(`display ${bound} overflow refuses the complete snapshot`, t => {
  const db = dbFixture(t), insert = db.prepare('INSERT INTO users VALUES(?,?,1,2)');
  db.exec('BEGIN');
  for (let i = 0; i < (bound === 'rows' ? USER_ROW_LIMIT : 2200); i++) insert.run('u'+i, bound === 'bytes' ? 'x'.repeat(4096) : 'x');
  db.exec('COMMIT');
  assert.throws(() => readUsers(db, { owner: 'default', admin: true }));
  assert.deepEqual(readUsers(db, { owner: 'default', admin: false }), [user]);
});

test('user protocol refuses SQL, extra fields, duplicates, invalid times and widened member replies', () => {
  assert.equal(validUserRead({ owner: 'default', admin: false }), true);
  for (const read of [{ owner: '', admin: false }, { owner: 'default', admin: 1 },
    { owner: 'default', admin: false, sql: 'SELECT' }, { owner: 'a\0b', admin: true }]) assert.equal(validUserRead(read), false);
  const scope = { owner: 'default', admin: false };
  for (const rows of [[{ ...user, id: 'other' }], [admin], [user, user], [{ ...user, createdAt: NaN }],
    [{ ...user, updatedAt: Number.MAX_SAFE_INTEGER + 1 }], [{ ...user, secret: 'private' }]]) assert.equal(validUserRows(rows, scope), false);
  assert.equal(validUserRows([user], scope), true);
  assert.equal(validUserRows([user], { owner: 'default', admin: true }), false);
  assert.equal(validUserRows([{ ...admin, usage: { lastLoginAt: -1, lastActiveAt: null } }]), false);
});

test('users and preferences share four original snapshot slots without consuming page capacity', async t => {
  const { reader, worker } = fake(t, false);
  const pending = [reader.users({ owner: 'default', admin: true }), reader.preferences('default'),
    reader.users({ owner: 'default', admin: true }), reader.preferences('default')];
  await assert.rejects(reader.users({ owner: 'default', admin: true }));
  await assert.rejects(reader.preferences('default'));
  const page = reader.read({ owner: 'default', domains: [] });
  worker.emit('message', { kind: 'ready' }); await turn();
  for (let i = 0; i < 4; i++) worker.reply(i, []);
  worker.reply(4, { reset: false, cursor: undefined, events: [] });
  await Promise.all([...pending, page]);
  const next = reader.users({ owner: 'default', admin: false }); await turn(); worker.reply(5, [user]);
  assert.deepEqual(await next, [user]); assert.equal(reader.recoveryState.unavailable, false);
});

test('original user scope is captured before readiness and checked against replies', async t => {
  const { reader, worker } = fake(t, false), scope = { owner: 'default', admin: false };
  const pending = reader.users(scope); scope.owner = 'other'; scope.admin = true;
  worker.emit('message', { kind: 'ready' }); await turn();
  assert.deepEqual(worker.messages[0]!.read, { owner: 'default', admin: false });
  worker.reply(0, [user]); assert.deepEqual(await pending, [user]);
});

for (const widened of [[admin], [{ ...user, id: 'other' }]]) test('malformed widened user reply fences original observer', async t => {
  const { reader, worker } = fake(t);
  const pending = reader.users({ owner: 'default', admin: false }); await turn(); worker.reply(0, widened);
  await assert.rejects(pending); assert.equal(reader.recoveryState.unavailable, true);
});

test('user scope inspection cannot admit a read after reentrant close', async t => {
  const { reader, worker } = fake(t); let closed: Promise<void> | undefined;
  const scope = { get owner() { closed ??= reader.close(); return 'default'; }, admin: false };
  await assert.rejects(reader.users(scope)); await closed;
  assert.equal(worker.messages.filter(m => m.kind === 'users').length, 0);
});

test('real file-backed user display does not call main-thread SQL and survives same-data restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-user-read-')), file = join(dir, 'hub.sqlite');
  let store = new HubStore(file, 'synthetic');
  t.after(async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); });
  const other = store.createUser('Display-only');
  const db = (store as unknown as { db: DatabaseSync }).db, prepare = db.prepare;
  db.prepare = () => { throw Error('main-thread SQL must not be used'); };
  try {
    const rows = await store.listUsersAsync('default', true);
    assert.equal(rows.length, 2); assert.equal(rows[1]!.id, other.id);
    assert.deepEqual(await store.listUsersAsync(other.id, false), [other]);
  } finally { db.prepare = prepare; }
  await store.close(); await assert.rejects(store.listUsersAsync('default', true));
  store = new HubStore(file, 'synthetic'); assert.deepEqual(await store.listUsersAsync(other.id, false), [other]);
  assert.ok(lstatSync(file).isFile());
});

test('user observer failure cannot replace original reader before actual exit and cooldown', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-users-recovery-')), store = new HubStore(join(dir, 'hub.sqlite'), 'synthetic');
  const h = fake(t); h.worker.autoExit = false;
  const internals = store as unknown as { deliveryReader: AsyncHubDeliveryReader; deliveryRetryAt: number };
  internals.deliveryReader = h.reader;
  t.after(async () => { h.worker.emit('exit', 1); await store.close(); rmSync(dir, { recursive: true, force: true }); });
  const pending = store.listUsersAsync('default', false); await turn(); h.worker.reply(0, [admin]); await assert.rejects(pending);
  internals.deliveryRetryAt = 0; await assert.rejects(store.listUsersAsync('default', false));
  assert.equal(internals.deliveryReader, h.reader);
  h.worker.emit('exit', 1); internals.deliveryRetryAt = performance.now() + 10_000;
  await assert.rejects(store.listUsersAsync('default', false));
  internals.deliveryRetryAt = 0;
  assert.equal((await store.listUsersAsync('default', false))[0]!.id, 'default');
  assert.notEqual(internals.deliveryReader, h.reader);
});

test('users finishing after owner close cannot publish a stale snapshot', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-users-close-')), store = new HubStore(join(dir, 'hub.sqlite'), 'synthetic');
  const h = fake(t); (store as unknown as { deliveryReader: AsyncHubDeliveryReader }).deliveryReader = h.reader;
  t.after(async () => { h.worker.emit('exit', 1); await store.close(); rmSync(dir, { recursive: true, force: true }); });
  const pending = store.listUsersAsync('default', false); await turn();
  const closing = store.close(); h.worker.reply(0, [user]); await assert.rejects(pending); await closing;
});
