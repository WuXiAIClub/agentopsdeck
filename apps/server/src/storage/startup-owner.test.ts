import test from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HubStore } from '../hub/hub-store.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { openSqliteAuth } from '../auth/sqlite-store.js';
import { AuthPersistenceError } from '../auth/private-store.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { StartupDatabaseOwners, startupDatabaseOwners } from './startup-owner.js';
import { connectionRecoverySnapshot, StorageConnectionUnavailable } from './connection-recovery.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-startup-owner-')), file = join(root, 'state.sqlite');
  const logs: Record<string, unknown>[] = [];
  let now = 0, opens = 0;
  const owners = new StartupDatabaseOwners(new PerformanceDiagnostics(line => logs.push(JSON.parse(line)), () => now),
    () => now, path => { opens++; return new DatabaseSync(path); });
  return { root, file, logs, owners, opens: () => opens, tick: () => { now += 1000; }, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

for (const kind of ['hub', 'connector'] as const) test(`${kind} construction failure closes its sole connection and preserves the original error`, () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-construction-fault-')), file = join(root, 'state.sqlite');
  const original = Error('private-construction-fault'), prototype = (kind === 'hub' ? HubStore : ConnectorUserStore).prototype as any;
  const migrate = prototype.migrate, close = DatabaseSync.prototype.close;
  let raw: DatabaseSync | undefined, closes = 0;
  prototype.migrate = function() { this.db.exec('BEGIN IMMEDIATE; CREATE TABLE unfinished(value); INSERT INTO unfinished VALUES(1)'); throw original; };
  DatabaseSync.prototype.close = function() { raw = this; closes++; return close.call(this); };
  try {
    assert.throws(() => kind === 'hub' ? new HubStore(file, 'synthetic') : new ConnectorUserStore(file, undefined, { runtimeOwner: true }), error => error === original);
    assert.equal(closes, 1);
    assert.equal(raw?.isOpen, false);
    prototype.migrate = migrate; DatabaseSync.prototype.close = close;
    const store = kind === 'hub' ? new HubStore(file, 'synthetic') : new ConnectorUserStore(file, undefined, { runtimeOwner: true });
    try { assert.equal((store as any).db.prepare("SELECT name FROM sqlite_master WHERE name='unfinished'").get(), undefined); }
    finally { store.close(); }
  } finally {
    prototype.migrate = migrate; DatabaseSync.prototype.close = close;
    if (raw?.isOpen) raw.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed close remains on the exact handle, fences SQL and reopening, then recovers only cleanup', () => {
  const f = fixture(), db = f.owners.open(f.file), close = db.close.bind(db);
  // Test injection is below the facade; override the native prototype so the
  // owner still sees the original receiver and native isOpen closure proof.
  const native = DatabaseSync.prototype.close;
  let broken = true, attempts = 0, raw: DatabaseSync | undefined;
  DatabaseSync.prototype.close = function() { raw = this; attempts++; if (broken) throw Error('private-close-fault'); return native.call(this); };
  try {
    db.exec('BEGIN IMMEDIATE; CREATE TABLE unfinished(value)');
    f.owners.abandon(db);
    assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
    assert.throws(() => db.prepare('SELECT 1'), StorageConnectionUnavailable);
    assert.throws(() => f.owners.open(f.file), StorageConnectionUnavailable);
    assert.equal(attempts, 1); assert.equal(f.opens(), 1);
    f.tick(); assert.throws(() => f.owners.open(f.file), StorageConnectionUnavailable);
    assert.equal(attempts, 2); assert.equal(f.opens(), 1);
    broken = false; f.tick();
    const replacement = f.owners.open(f.file);
    try {
      assert.equal(attempts, 3); assert.equal(f.opens(), 2); assert.equal(raw?.isOpen, false);
      assert.equal(replacement.prepare("SELECT name FROM sqlite_master WHERE name='unfinished'").get(), undefined);
      assert.equal(connectionRecoverySnapshot(db).state, 'closed');
      f.owners.abandon(db); assert.equal(attempts, 3);
      assert.doesNotMatch(JSON.stringify(f.logs), /private|state\.sqlite|unfinished|BEGIN|SELECT/);
      assert.ok(f.logs.some(row => row.operation === 'storage-startup-cleanup' && row.unknown === 1));
      assert.ok(f.logs.some(row => row.operation === 'storage-startup-cleanup' && row.settled === 1));
    } finally { replacement.close(); }
  } finally { DatabaseSync.prototype.close = native; close(); f.dispose(); }
});

test('lost close acknowledgement uses original closed proof, not another connection or replay', () => {
  const f = fixture(), db = f.owners.open(f.file), native = DatabaseSync.prototype.close;
  let attempts = 0;
  DatabaseSync.prototype.close = function() { attempts++; native.call(this); throw Error('private-lost-close-ack'); };
  try {
    f.owners.abandon(db);
    assert.equal(connectionRecoverySnapshot(db).state, 'closed');
    assert.equal(attempts, 1);
    DatabaseSync.prototype.close = native;
    const replacement = f.owners.open(f.file);
    replacement.close(); assert.equal(f.opens(), 2); assert.equal(attempts, 1);
  } finally { DatabaseSync.prototype.close = native; db.close(); f.dispose(); }
});

test('existing and initially missing file aliases cannot bypass the failed owner', { skip: process.platform === 'win32' }, () => {
  const f = fixture();
  symlinkSync(f.root, join(f.root, 'alias'), 'dir');
  const db = f.owners.open(join(f.root, 'alias', 'state.sqlite')), native = DatabaseSync.prototype.close;
  DatabaseSync.prototype.close = function() { throw Error('private-close-fault'); };
  try {
    f.owners.abandon(db);
    assert.throws(() => f.owners.open(f.file), StorageConnectionUnavailable);
    assert.throws(() => f.owners.open(join(f.root, 'alias', 'state.sqlite')), StorageConnectionUnavailable);
    assert.equal(f.opens(), 1);
  } finally { DatabaseSync.prototype.close = native; f.tick(); f.owners.abandon(db); f.dispose(); }
});

test('reentrant cleanup cannot acquire a replacement while the original close is executing', () => {
  const f = fixture(), db = f.owners.open(f.file), native = DatabaseSync.prototype.close;
  DatabaseSync.prototype.close = function() {
    assert.throws(() => f.owners.open(f.file), StorageConnectionUnavailable);
    assert.equal(f.opens(), 1);
    return native.call(this);
  };
  try { f.owners.abandon(db); assert.equal(connectionRecoverySnapshot(db).state, 'closed'); }
  finally { DatabaseSync.prototype.close = native; db.close(); f.dispose(); }
});

test('hard-link aliases cannot open over a failed physical owner', () => {
  const f = fixture(), db = f.owners.open(f.file), alias = join(f.root, 'other-name.sqlite'), native = DatabaseSync.prototype.close;
  linkSync(f.file, alias);
  DatabaseSync.prototype.close = function() { throw Error('private-close-fault'); };
  try {
    f.owners.abandon(db);
    assert.throws(() => f.owners.open(alias), StorageConnectionUnavailable);
    assert.equal(f.opens(), 1);
  } finally { DatabaseSync.prototype.close = native; f.tick(); f.owners.abandon(db); f.dispose(); }
});

for (const kind of ['hub', 'connector'] as const) test(`${kind} failed startup preserves original error when close fails and retries only original cleanup`, () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-construction-close-')), file = join(root, 'state.sqlite');
  const original = Error('private-construction-fault'), prototype = (kind === 'hub' ? HubStore : ConnectorUserStore).prototype as any;
  const migrate = prototype.migrate, native = DatabaseSync.prototype.close, clock = (startupDatabaseOwners as any).clock;
  let now = 0, raw: DatabaseSync | undefined, closes = 0, bodies = 0, broken = true;
  (startupDatabaseOwners as any).clock = () => now;
  prototype.migrate = function() { bodies++; this.db.exec('BEGIN IMMEDIATE; CREATE TABLE unfinished(value)'); throw original; };
  DatabaseSync.prototype.close = function() { raw = this; closes++; if (broken) throw Error('private-close-fault'); return native.call(this); };
  const construct = () => kind === 'hub' ? new HubStore(file, 'synthetic') : new ConnectorUserStore(file, undefined, { runtimeOwner: true });
  try {
    assert.throws(construct, error => error === original);
    assert.equal(closes, 1); assert.equal(raw?.isOpen, true);
    assert.throws(construct, StorageConnectionUnavailable);
    assert.equal(closes, 1); assert.equal(bodies, 1, 'failed constructor body was not replayed');
    prototype.migrate = migrate; broken = false; now += 1000;
    const store = construct();
    try {
      assert.equal(closes, 2); assert.equal(raw?.isOpen, false);
      assert.equal(bodies, 1); assert.equal((store as any).db.prepare("SELECT name FROM sqlite_master WHERE name='unfinished'").get(), undefined);
    } finally { store.close(); }
  } finally {
    DatabaseSync.prototype.close = native; prototype.migrate = migrate; (startupDatabaseOwners as any).clock = clock;
    if (raw?.isOpen) raw.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('auth failed initialization sanitizes errors and retains its original owner until confirmed close', { skip: !process.getuid }, () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-auth-startup-')), file = join(root, 'auth.sqlite');
  const nativeExec = DatabaseSync.prototype.exec, nativeClose = DatabaseSync.prototype.close;
  const clock = (startupDatabaseOwners as any).clock;
  let now = 0, broken = true, closes = 0, bodies = 0, raw: DatabaseSync | undefined;
  (startupDatabaseOwners as any).clock = () => now;
  DatabaseSync.prototype.exec = function(sql) {
    if (sql.includes('CREATE TABLE IF NOT EXISTS shared_auth_credentials')) {
      bodies++;
      nativeExec.call(this, 'BEGIN IMMEDIATE; CREATE TABLE unfinished(value)');
      throw Error('private-auth-startup-fault');
    }
    return nativeExec.call(this, sql);
  };
  DatabaseSync.prototype.close = function() { raw = this; closes++; if (broken) throw Error('private-auth-close-fault'); return nativeClose.call(this); };
  const construct = () => openSqliteAuth(file, [], () => undefined);
  try {
    assert.throws(construct, AuthPersistenceError);
    assert.equal(closes, 1); assert.equal(raw?.isOpen, true);
    assert.throws(construct, AuthPersistenceError);
    assert.equal(closes, 1); assert.equal(bodies, 1);
    DatabaseSync.prototype.exec = nativeExec; broken = false; now += 1000;
    const store = construct();
    try {
      assert.equal(closes, 2); assert.equal(raw?.isOpen, false); assert.equal(bodies, 1);
      assert.deepEqual(store.passkeys.status(), { available: false, count: 0 });
      assert.equal(store.passkeys.db.prepare("SELECT name FROM sqlite_master WHERE name='unfinished'").get(), undefined);
    } finally { store.close(); }
  } finally {
    DatabaseSync.prototype.exec = nativeExec; DatabaseSync.prototype.close = nativeClose;
    (startupDatabaseOwners as any).clock = clock;
    if (raw?.isOpen) raw.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('unknown memory owners are bounded and never evicted to admit another connection', () => {
  const f = fixture(), handles: DatabaseSync[] = [], native = DatabaseSync.prototype.close;
  DatabaseSync.prototype.close = function() { throw Error('private-close-fault'); };
  try {
    for (let index = 0; index < 128; index++) { const db = f.owners.open(':memory:'); handles.push(db); f.owners.abandon(db); }
    assert.throws(() => f.owners.open(':memory:'), StorageConnectionUnavailable);
    assert.equal(f.opens(), 128);
    DatabaseSync.prototype.close = native; f.tick();
    f.owners.abandon(handles[0]!);
    const replacement = f.owners.open(':memory:');
    replacement.close(); assert.equal(f.opens(), 129);
  } finally {
    DatabaseSync.prototype.close = native; f.tick();
    for (const db of handles) f.owners.abandon(db);
    f.dispose();
  }
});

test('diagnostic reentrancy cannot create another replacement during cleanup acquisition', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-diagnostic-reentry-')), file = join(root, 'state.sqlite');
  const native = DatabaseSync.prototype.close;
  let now = 0, broken = true, opens = 0, inner: DatabaseSync | undefined, outer: DatabaseSync | undefined, rejected = false;
  const owners = new StartupDatabaseOwners(new PerformanceDiagnostics(line => {
    const event = JSON.parse(line);
    if (event.operation !== 'storage-startup-cleanup' || event.settled !== 1) return;
    try { inner = owners.open(file); } catch (error) { rejected = error instanceof StorageConnectionUnavailable; }
  }, () => now), () => now, path => { opens++; return new DatabaseSync(path); });
  const db = owners.open(file);
  DatabaseSync.prototype.close = function() { if (broken) throw Error('private-close-fault'); return native.call(this); };
  try {
    owners.abandon(db); now += 1000; broken = false;
    outer = owners.open(file);
    assert.equal(rejected, true); assert.equal(opens, 2);
  } finally {
    DatabaseSync.prototype.close = native;
    inner?.close(); outer?.close(); db.close(); rmSync(root, { recursive: true, force: true });
  }
});
