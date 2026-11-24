import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { openSqliteAuth } from './sqlite-store.js';
import { AuthPersistenceError } from './private-store.js';
import { performanceDiagnostics, PerformanceDiagnostics } from '../diagnostics/performance.js';
import { connectionRecoverySnapshot, StorageConnectionUnavailable } from '../storage/connection-recovery.js';
import { observedTransaction } from '../storage/observed-transaction.js';

const key = 'a'.repeat(24), otherKey = 'b'.repeat(24);
const host = { skip: !process.getuid };
function fixture(t: TestContext, currentKey: () => unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-display-key-')), file = join(dir, 'auth.sqlite');
  const logs: Record<string, unknown>[] = [];
  const diagnostics = new PerformanceDiagnostics(line => logs.push(JSON.parse(line)));
  t.mock.method(performanceDiagnostics, 'start', diagnostics.start.bind(diagnostics));
  const store = openSqliteAuth(file, [], currentKey as () => string | undefined), original = store.passkeys.db;
  t.after(async () => { await store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, original, logs, file };
}
async function emptyAudit(h: ReturnType<typeof fixture>) {
  await h.store.close();
  // The original writer is CLOSED before this independent test-only read.
  const read = new DatabaseSync(h.file, { readOnly: true });
  try { assert.equal(read.prepare('SELECT count(*) n FROM shared_auth_audit').get()!.n, 0); }
  finally { read.close(); }
}

test('display rejects recognizable async identity without dispatch and preserves the original reusable writer', host, async t => {
  let starts = 0;
  const h = fixture(t, async () => { starts++; return key; });
  await assert.rejects(Promise.resolve(h.store.routePasskeys.status(key)), AuthPersistenceError);
  assert.equal(starts, 0); assert.equal(connectionRecoverySnapshot(h.original).state, 'ready');
  assert.equal(observedTransaction(h.original, 'auth-passkey-change', () => 42), 42);
  assert.ok(h.logs.some(row => row.operation === 'auth-display-read' && row.step === 8 && row.category === 'failed'));
  assert.ok(!h.logs.some(row => row.operation === 'auth-display-read' && row.step === 1));
});

test('display fences escaped native Promise identity and original cached SQL before any late continuation', host, async t => {
  let release!: () => void, escaped!: Promise<string>, insert!: ReturnType<DatabaseSync['prepare']>, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = fixture(t, () => { calls++; escaped = gate.then(() => { insert.run('late', 'late', 10); return key; }); return escaped; });
  insert = h.original.prepare('INSERT INTO shared_auth_audit(kind,identity,at) VALUES(?,?,?)');
  try {
    await assert.rejects(Promise.resolve(h.store.routePasskeys.status(key)), AuthPersistenceError);
    assert.equal(calls, 1); assert.equal(connectionRecoverySnapshot(h.original).state, 'close-required');
    assert.throws(() => insert.run('new', 'new', 10), StorageConnectionUnavailable);
    release(); await assert.rejects(escaped, StorageConnectionUnavailable);
    await assert.rejects(Promise.resolve(h.store.routePasskeys.list(key)), AuthPersistenceError); assert.equal(calls, 1);
    assert.ok(h.logs.some(row => row.operation === 'auth-display-read' && row.step === 8 && row.unknown === 1));
    await emptyAudit(h);
  } finally { release(); }
});

test('display rejects invalid scalar and hostile object identities without getters, coercion or reader launch', host, async t => {
  let invoked = 0, value: unknown;
  const hostile = { get then() { invoked++; throw Error('PRIVATE display then'); },
    toString() { invoked++; throw Error('PRIVATE display string'); }, toJSON() { invoked++; throw Error('PRIVATE display json'); } };
  const proxy = new Proxy({}, { get() { invoked++; throw Error('PRIVATE display proxy'); } });
  const h = fixture(t, () => value);
  for (value of [hostile, proxy, '', 'invalid', null, 1, true]) {
    await assert.rejects(Promise.resolve(h.store.routePasskeys.status(key)), AuthPersistenceError);
    assert.equal(invoked, 0); assert.equal(connectionRecoverySnapshot(h.original).state, 'ready');
  }
  assert.ok(!h.logs.some(row => row.operation === 'auth-display-read' && row.step === 1));
  assert.doesNotMatch(JSON.stringify(h.logs), /PRIVATE display/);
});

test('literal and legacy undefined display identity retain status/list and the original writer', host, async t => {
  let value: string | undefined = key;
  const h = fixture(t, () => value);
  for (value of [key, undefined]) {
    assert.deepEqual(await h.store.routePasskeys.status(value), { available: false, count: 0 });
    assert.deepEqual(await h.store.routePasskeys.list(value), []);
    assert.equal(connectionRecoverySnapshot(h.original).state, 'ready'); assert.equal(h.store.passkeys.db, h.original);
  }
});

test('display refuses identity changed after await without replay and a distinct later read remains usable', host, async t => {
  let calls = 0, rotated = false;
  const h = fixture(t, () => { calls++; return calls === 1 || rotated ? key : otherKey; });
  await assert.rejects(Promise.resolve(h.store.routePasskeys.status(key)), AuthPersistenceError); assert.equal(calls, 2);
  assert.equal(connectionRecoverySnapshot(h.original).state, 'ready');
  assert.ok(h.logs.some(row => row.operation === 'auth-display-read' && row.step === 9 && row.category === 'failed'));
  rotated = true;
  assert.deepEqual(await h.store.routePasskeys.status(key), { available: false, count: 0 });
  assert.equal(calls, 4); assert.equal(h.store.passkeys.db, h.original);
});

test('post-query escaped identity is fenced before its delayed SQL and is logged at the final read phase', host, async t => {
  let calls = 0, release!: () => void, escaped!: Promise<string>, insert!: ReturnType<DatabaseSync['prepare']>;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = fixture(t, () => {
    if (++calls === 1) return key;
    escaped = gate.then(() => { insert.run('late', 'late', 10); return key; }); return escaped;
  });
  insert = h.original.prepare('INSERT INTO shared_auth_audit(kind,identity,at) VALUES(?,?,?)');
  try {
    await assert.rejects(Promise.resolve(h.store.routePasskeys.status(key)), AuthPersistenceError);
    assert.equal(calls, 2); assert.equal(connectionRecoverySnapshot(h.original).state, 'close-required');
    release(); await assert.rejects(escaped, StorageConnectionUnavailable);
    assert.ok(h.logs.some(row => row.operation === 'auth-display-read' && row.step === 9 && row.unknown === 1));
    await emptyAudit(h);
  } finally { release(); }
});

test('a caught display rejection latches escaped work on the enclosing original transaction and rolls back its writes', host, async t => {
  const h = fixture(t, () => Promise.resolve(key));
  let read!: Promise<unknown>;
  assert.throws(() => observedTransaction(h.original, 'auth-passkey-change', () => {
    read = Promise.resolve(h.store.routePasskeys.status(key)); void read.catch(() => {});
    h.original.prepare('INSERT INTO shared_auth_audit(kind,identity,at) VALUES(?,?,?)').run('original', 'original', 10);
    return 42;
  }));
  await assert.rejects(read, AuthPersistenceError);
  assert.equal(connectionRecoverySnapshot(h.original).state, 'close-required'); assert.equal(h.original.isTransaction, false);
  assert.ok(h.logs.some(row => row.operation === 'auth-passkey-change' && row.unknown === 1));
  await emptyAudit(h);
});
