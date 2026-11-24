import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmodSync, lstatSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import type { Worker } from 'node:worker_threads';
import { AsyncSqliteAuthDisplay } from './async-sqlite-display.js';
import { AuthPersistenceError } from './private-store.js';
import { SqlitePasskeys } from './sqlite-passkeys.js';
import { openSqliteAuth } from './sqlite-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

const key = 'a'.repeat(24), otherKey = 'b'.repeat(24);
const credential = { id: 'Zml4dHVyZQ', publicKey: 'AQ', counter: 0, rpId: 'hub.example',
  createdAt: 1, label: '通行密钥🔑', keyIdentityHash: key };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-display-test-')), file = join(dir, 'auth.sqlite');
  const db = new DatabaseSync(file); chmodSync(file, 0o600);
  const owner = new SqlitePasskeys(db, () => key, () => 10_000, new PerformanceDiagnostics(() => {}));
  owner.importLegacy([credential], true);
  const lines: string[] = [], s = lstatSync(file);
  const display = new AsyncSqliteAuthDisplay({ file, dev: s.dev, ino: s.ino }, new PerformanceDiagnostics(line => lines.push(line)));
  t.after(async () => { await display.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const snapshot = () => JSON.stringify(db.prepare('SELECT * FROM shared_auth_credentials').all());
  return { dir, file, db, owner, display, lines, snapshot };
}
class FakeWorker extends EventEmitter {
  messages: { id: number; kind: string; key?: string }[] = [];
  terminated = 0;
  autoExit = true;
  autoClose = true;
  postMessage(message: { id: number; kind: string; key?: string }) {
    this.messages.push(message);
    if (message.kind === 'close' && this.autoClose) queueMicrotask(() => {
      this.emit('message', { id: message.id, kind: 'close', ok: true }); this.emit('exit', 0);
    });
  }
  terminate() { this.terminated++; if (this.autoExit) queueMicrotask(() => this.emit('exit', 1)); return Promise.resolve(1); }
}
function fake(t: TestContext, timeout = 1000, ready = true, clock?: () => number) {
  const worker = new FakeWorker(), lines: string[] = [];
  const display = new AsyncSqliteAuthDisplay({ file: '/unused', dev: 1, ino: 1 },
    new PerformanceDiagnostics(line => lines.push(line), clock), () => worker as unknown as Worker, timeout);
  if (ready) queueMicrotask(() => worker.emit('message', { kind: 'ready' }));
  t.after(async () => { worker.autoExit = true; worker.emit('exit', 1); await display.close(); });
  return { worker, display, lines };
}
const status = { available: true, count: 1 };
for (const ready of [false, true]) test(`diagnostic clock reentrancy retains display admission (ready=${ready})`, async t => {
  const reads: Promise<boolean>[] = [];
  const result = (work: Promise<unknown>) => work.then(() => true, () => false);
  let armed = false;
  const h = fake(t, 10_000, ready, () => {
    if (armed) {
      armed = false;
      for (let i = 0; i < 256; i++) reads.push(result(h.display.read('status', key)));
    }
    return 0;
  });
  armed = true;
  reads.push(result(h.display.read('status', key)));
  await turn();
  if (!ready) { assert.equal(h.worker.messages.length, 0); h.worker.emit('message', { kind: 'ready' }); await turn(); }
  assert.equal(h.worker.messages.length, 256);
  assert.equal(h.worker.terminated, 0);
  for (let i = 0; i < 256; i++) reply(h.worker, i);
  const results = await Promise.all(reads);
  assert.equal(results.filter(Boolean).length, 256);
  assert.equal(results.filter(value => !value).length, 1);
  const later = h.display.read('status', key); await turn(); reply(h.worker, 256);
  assert.deepEqual(await later, status);
  assert.equal(h.display.recoveryState.unavailable, false);
});
for (const ready of [false, true]) for (const trigger of ['immediate', 'clock'] as const)
  test(`original admitted display drains before ${trigger} close (ready=${ready})`, async t => {
    let armed = false, closing: Promise<void> | undefined, closed = false;
    const h = fake(t, 10_000, ready, () => {
      if (armed) { armed = false; closing = h.display.close(); }
      return 0;
    });
    armed = trigger === 'clock';
    const read = h.display.read('status', key);
    if (trigger === 'immediate') closing = h.display.close();
    await turn();
    assert.ok(closing); assert.equal(h.display.close(), closing);
    void closing.then(() => { closed = true; });
    await assert.rejects(h.display.read('status', key), AuthPersistenceError);
    if (!ready) {
      assert.equal(h.worker.messages.length, 0); assert.equal(closed, false);
      h.worker.emit('message', { kind: 'ready' }); await turn();
    }
    assert.equal(closed, false);
    assert.deepEqual(h.worker.messages.map(message => message.kind), ['status']);
    reply(h.worker); assert.deepEqual(await read, status); await closing;
    assert.equal(closed, true); assert.equal(h.worker.terminated, 0);
    assert.equal(h.display.recoveryState.exitConfirmed, true);
    assert.deepEqual(h.worker.messages.map(message => message.kind), ['status', 'close']);
    assert.ok(h.lines.some(line => { const row = JSON.parse(line); return row.step === 3 && row.settled === 1; }));
  });

function reply(worker: FakeWorker, index = 0, value: unknown = status) {
  const message = worker.messages[index]!;
  worker.emit('message', { id: message.id, kind: message.kind, ok: true, value });
}

test('real reader returns identical display DTOs without schema or row mutation', async t => {
  const h = fixture(t), before = h.snapshot(), schema = h.db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all();
  assert.deepEqual(await h.display.read('status', key), h.owner.status(key));
  assert.deepEqual(await h.display.read('list', key), h.owner.list(key));
  assert.deepEqual(await h.display.read('status', otherKey), { available: false, count: 0 });
  assert.deepEqual(await h.display.read('list', otherKey), []);
  assert.equal(h.snapshot(), before);
  assert.deepEqual(h.db.prepare('SELECT sql FROM sqlite_master ORDER BY name').all(), schema);
  assert.ok(h.lines.some(line => JSON.parse(line).operation === 'auth-display-read'));
  assert.ok(h.lines.every(line => !line.includes(h.file) && !line.includes(credential.label) && !line.includes(credential.id)));
});

test('blocked SQLite display query does not block the event loop or replay SQL', async t => {
  const h = fixture(t); await h.display.read('status', key);
  h.db.exec('BEGIN EXCLUSIVE');
  let ticked = false;
  const release = setTimeout(() => { ticked = true; h.db.exec('ROLLBACK'); }, 80);
  try { assert.deepEqual(await h.display.read('status', key), status); assert.equal(ticked, true); }
  finally { clearTimeout(release); if (h.db.isTransaction) h.db.exec('ROLLBACK'); }
});

for (const corruption of ['invalid-json', 'invalid-utf8', 'nul-id', 'blob', 'revision-text', 'revision-real', 'overflow'] as const) {
  test(`read-only worker refuses ${corruption}, retains rows and retires without sync fallback`, async t => {
    const h = fixture(t); await h.display.read('status', key);
    if (corruption === 'invalid-json') h.db.prepare('UPDATE shared_auth_credentials SET payload=?').run('{private-marker');
    if (corruption === 'invalid-utf8') {
      const bytes = Buffer.from(JSON.stringify(credential)); bytes[bytes.indexOf('AQ')] = 0xff;
      h.db.prepare('UPDATE shared_auth_credentials SET payload=CAST(? AS TEXT)').run(bytes);
    }
    if (corruption === 'nul-id') h.db.prepare('UPDATE shared_auth_credentials SET id=?').run(credential.id + '\0private-marker');
    if (corruption === 'blob') h.db.prepare('UPDATE shared_auth_credentials SET payload=?').run(Buffer.from(JSON.stringify(credential)));
    if (corruption === 'revision-text' || corruption === 'revision-real') h.db.exec(`ALTER TABLE shared_auth_credentials RENAME TO old_credentials;
      CREATE TABLE shared_auth_credentials(id TEXT PRIMARY KEY,payload TEXT NOT NULL,version);
      INSERT INTO shared_auth_credentials SELECT id,payload,CAST(version AS ${corruption === 'revision-text' ? 'TEXT' : 'REAL'}) FROM old_credentials;`);
    if (corruption === 'overflow') {
      const insert = h.db.prepare('INSERT INTO shared_auth_credentials VALUES(?,?,0)');
      h.db.exec('BEGIN');
      for (let n = 0; n < 1024; n++) { const c = { ...credential, id: `fixture-${n}` }; insert.run(c.id, JSON.stringify(c)); }
      h.db.exec('COMMIT');
    }
    const before = h.snapshot();
    await assert.rejects(h.display.read('list', key), AuthPersistenceError);
    await assert.rejects(h.display.read('status', key), AuthPersistenceError);
    await h.display.close(); assert.equal(h.snapshot(), before);
    assert.ok(h.lines.some(line => JSON.parse(line).category === 'failed'));
    assert.ok(h.lines.every(line => !line.includes('private-marker') && !line.includes(h.file)));
  });
}

test('legacy large labels remain exact, not silently rejected by new DTO validation', async t => {
  const h = fixture(t), label = '字'.repeat(100_000);
  h.db.prepare('UPDATE shared_auth_credentials SET payload=?').run(JSON.stringify({ ...credential, label }));
  assert.equal((await h.display.read('list', key))[0]!.label, label);
});
for (const fault of ['inode', 'permissions', 'sidecar'] as const) test(`private reader refuses ${fault} changes without opening a replacement`, async t => {
  const h = fixture(t); await h.display.read('status', key);
  if (fault === 'inode') { renameSync(h.file, h.file + '.original'); writeFileSync(h.file, 'replacement', { mode: 0o600 }); }
  if (fault === 'permissions') chmodSync(h.file, 0o644);
  if (fault === 'sidecar') { writeFileSync(h.file + '-journal', ''); chmodSync(h.file + '-journal', 0o644); }
  await assert.rejects(h.display.read('status', key), AuthPersistenceError);
  await h.display.close();
});

test('close freezes new admission, drains accepted work, then confirms exit', async t => {
  const h = fake(t), read = h.display.read('status', key); await turn();
  let closed = false; const close = h.display.close().then(() => { closed = true; });
  await assert.rejects(h.display.read('status', key), AuthPersistenceError);
  await turn(); assert.equal(closed, false); assert.equal(h.worker.messages.length, 1);
  reply(h.worker); assert.deepEqual(await read, status); await close;
  assert.deepEqual(h.worker.messages.map(m => m.kind), ['status', 'close']);
});

test('bounded reader refuses request 257 and never dispatches it', async t => {
  const h = fake(t), reads = Array.from({ length: 256 }, () => h.display.read('status', key));
  await assert.rejects(h.display.read('status', key), AuthPersistenceError); await turn();
  assert.equal(h.worker.messages.length, 256);
  for (let n = 0; n < 256; n++) reply(h.worker, n);
  await Promise.all(reads); await h.display.close();
  assert.ok(h.lines.some(line => JSON.parse(line).deferred === 1));
});

for (const fault of ['duplicate-ready', 'wrong-id', 'wrong-kind', 'extra-field', 'invalid-value', 'failed-result', 'error', 'exit'] as const) {
  test(`worker ${fault} rejects pending display and never retries`, async t => {
    const h = fake(t), read = h.display.read('status', key); await turn();
    const rejection = assert.rejects(read, AuthPersistenceError), m = h.worker.messages[0]!;
    if (fault === 'duplicate-ready') h.worker.emit('message', { kind: 'ready' });
    if (fault === 'wrong-id') h.worker.emit('message', { ...m, id: m.id + 1, ok: true, value: status });
    if (fault === 'wrong-kind') h.worker.emit('message', { id: m.id, kind: 'list', ok: true, value: [] });
    if (fault === 'extra-field') h.worker.emit('message', { id: m.id, kind: 'status', ok: true, value: status, secret: 'private-marker' });
    if (fault === 'invalid-value') reply(h.worker, 0, { available: true, count: 0 });
    if (fault === 'failed-result') h.worker.emit('message', { id: m.id, kind: 'status', ok: false });
    if (fault === 'error') h.worker.emit('error', Error('private-marker'));
    if (fault === 'exit') h.worker.emit('exit', 1);
    await rejection; await assert.rejects(h.display.read('status', key), AuthPersistenceError);
    await h.display.close(); assert.equal(h.worker.messages.length, 1);
    assert.ok(h.lines.every(line => !line.includes('private-marker')));
  });
}
for (const startup of [true, false]) test(`${startup ? 'startup' : 'query'} timeout retires readonly worker and logs refusal`, async t => {
  const h = fake(t, 20, !startup), keepAlive = setTimeout(() => {}, 200);
  try {
    await assert.rejects(h.display.read('status', key), AuthPersistenceError);
    await h.display.close(); assert.equal(h.worker.terminated, 1);
    assert.ok(h.lines.some(line => JSON.parse(line).category === 'failed'));
  } finally { clearTimeout(keepAlive); }
});

test('unconfirmed exit keeps the same drain pending; actual late exit automatically releases its writer', async t => {
  const h = fake(t, 20), keepAlive = setTimeout(() => {}, 200);
  h.worker.autoClose = false; h.worker.autoExit = false;
  const close = h.display.close();
  let writerClosed = false;
  const ownerClose = close.then(() => { writerClosed = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(writerClosed, false); assert.equal(h.worker.terminated, 1);
    assert.equal(h.display.close(), close);
    await assert.rejects(h.display.read('status', key), AuthPersistenceError);
    const pending = h.lines.map(line => JSON.parse(line)).find(event => event.step === 3 && event.phase === 'pending');
    assert.equal(pending?.unknown, 1); assert.equal(pending?.pending, 1);
    h.worker.emit('exit', 1); await ownerClose;
    assert.equal(writerClosed, true); assert.equal(h.display.close(), close);
    const settled = h.lines.map(line => JSON.parse(line)).find(event => event.step === 3 && event.settled === 1);
    assert.equal(settled?.instance, pending?.instance); assert.equal(settled?.sequence, pending?.sequence);
  } finally { clearTimeout(keepAlive); }
});

test('factory display is asynchronous, keeps original authority synchronous and closes both owners', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-display-factory-'));
  const store = openSqliteAuth(join(dir, 'auth.sqlite'), [], () => key);
  t.after(async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.passkeys.importLegacy([credential], true);
  assert.equal(store.passkeys.status(key) instanceof Promise, false);
  const read = store.routePasskeys.status(key); assert.ok(read instanceof Promise); await read;
  assert.deepEqual(await store.routePasskeys.list(key), store.passkeys.list(key));
  assert.equal(store.passkeys.isCredentialCurrent(store.passkeys.list(key)[0]!.id, key), true);
  await store.close(); await assert.rejects(Promise.resolve().then(() => store.routePasskeys.status(key)), AuthPersistenceError);
});

test('a later read can recover its readonly observer after confirmed exit, without replaying or replacing the writer', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-display-recover-'));
  const store = openSqliteAuth(join(dir, 'auth.sqlite'), [], () => key), original = store.passkeys.db;
  t.after(async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.passkeys.importLegacy([credential], true);
  await store.routePasskeys.status(key);
  original.prepare('UPDATE shared_auth_credentials SET payload=?').run('{damaged');
  await assert.rejects(Promise.resolve(store.routePasskeys.status(key)), AuthPersistenceError);
  original.prepare('UPDATE shared_auth_credentials SET payload=?').run(JSON.stringify(credential));
  await assert.rejects(Promise.resolve(store.routePasskeys.status(key)), AuthPersistenceError);
  await new Promise<void>(resolve => setTimeout(resolve, 1100));
  assert.deepEqual(await store.routePasskeys.status(key), status);
  assert.equal(store.passkeys.db, original);
});

for (const afterEffect of [false, true]) test(`display drain retains writer close recovery after lost ${afterEffect ? 'ACK' : 'effect'}`, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-display-close-'));
  const store = openSqliteAuth(join(dir, 'auth.sqlite'), [], () => key);
  await store.routePasskeys.status(key);
  const nativeClose = DatabaseSync.prototype.close; let calls = 0;
  const close = t.mock.method(DatabaseSync.prototype, 'close', function(this: DatabaseSync) {
    calls++; if (calls === 1 && !afterEffect) throw Error('private-marker');
    nativeClose.call(this); if (calls === 1 && afterEffect) throw Error('private-marker');
  });
  t.after(async () => { close.mock.restore(); await store.close(); rmSync(dir, { recursive: true, force: true }); });
  await assert.rejects(Promise.resolve(store.close()));
  await store.close(); await store.close();
  assert.equal(calls, afterEffect ? 1 : 2);
});

test('key rotation while a display read is pending discards the old result', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-display-key-')); let activeKey = key;
  const store = openSqliteAuth(join(dir, 'auth.sqlite'), [], () => activeKey);
  t.after(async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); });
  const read = store.routePasskeys.status(key); activeKey = otherKey;
  await assert.rejects(Promise.resolve(read), AuthPersistenceError);
  assert.deepEqual(await store.routePasskeys.status(otherKey), { available: false, count: 0 });
});
