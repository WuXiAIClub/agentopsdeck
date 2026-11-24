import test from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { connectionRecoverySnapshot, StorageConnectionUnavailable } from './connection-recovery.js';
import { StartupDatabaseOwners, startupOwnerPathKey } from './startup-owner.js';

// These tests select only the conservative Windows identity policy. They use
// disposable Linux directories/in-memory SQL, not native Windows ACL evidence.
for (const aliasKind of ['hardlink', 'unrelated'] as const) test(`lost post-create identity fences ${aliasKind} until original closure`, t => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-startup-lost-identity-'));
  const first = join(root, 'owner.db'), alias = join(root, 'other.db');
  const handles: DatabaseSync[] = [], logs: unknown[] = [];
  let opens = 0, identityFault = false, brokenClose = true, now = 0;
  const nativeStat = fs.statSync, nativeClose = DatabaseSync.prototype.close;
  t.mock.method(fs, 'statSync', (...args: Parameters<typeof fs.statSync>) => {
    if (identityFault && args[0] === first) {
      identityFault = false;
      throw Object.assign(Error('private-post-create-identity'), { code: 'EIO' });
    }
    return Reflect.apply(nativeStat, fs, args);
  });
  syncBuiltinESMExports();
  DatabaseSync.prototype.close = function () {
    if (brokenClose) throw Error('private-original-close');
    return nativeClose.call(this);
  };
  const owners = new StartupDatabaseOwners(new PerformanceDiagnostics(line => logs.push(JSON.parse(line)), () => now), () => now, file => {
    opens++;
    const db = new DatabaseSync(file); handles.push(db);
    if (opens === 1) {
      if (aliasKind === 'hardlink') linkSync(first, alias);
      identityFault = true;
    }
    return db;
  });
  try {
    assert.throws(() => owners.open(first), { code: 'EIO' });
    assert.equal(handles[0]?.isOpen, true);
    assert.throws(() => owners.open(alias), StorageConnectionUnavailable);
    assert.equal(opens, 1);
    brokenClose = false; now = 1000;
    const replacement = owners.open(alias);
    assert.equal(opens, 2); assert.equal(handles[0]?.isOpen, false);
    replacement.close();
    assert.doesNotMatch(JSON.stringify(logs), /private|owner\.db|other\.db|agentopsdeck-startup-lost/);
  } finally {
    DatabaseSync.prototype.close = nativeClose;
    t.mock.restoreAll(); syncBuiltinESMExports();
    for (const db of handles) if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [first, alias] of [
  ['C:\\State\\Owner.db', 'c:/state/owner.DB'],
  ['C:\\State\\sub\\..\\Owner.db', 'c:/state/owner.db'],
  ['\\\\Server\\Share\\State\\Owner.db', '//server/share/state/owner.DB'],
  ['\\\\?\\C:\\State\\Owner.db', '\\\\?\\c:\\state\\owner.DB'],
] as const) test(`Windows acquisition key folds case/separator aliases: ${first}`, () => {
  assert.equal(startupOwnerPathKey(first, 'win32'), startupOwnerPathKey(alias, 'win32'));
});

test('Linux acquisition identity preserves case and literal backslashes', () => {
  assert.notEqual(startupOwnerPathKey('/state/Owner.db', 'linux'), startupOwnerPathKey('/state/owner.db', 'linux'));
  assert.equal(startupOwnerPathKey('/state/Owner\\name.db', 'linux'), '/state/Owner\\name.db');
});

test('an inode created during initial acquisition fences a newly created hard-link alias', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-startup-acquiring-inode-'));
  const first = join(root, 'owner.db'), alias = join(root, 'alias.db');
  const handles: DatabaseSync[] = [];
  let opens = 0, denied = false;
  const owners = new StartupDatabaseOwners(new PerformanceDiagnostics(() => {}), () => 0, file => {
    opens++;
    const db = new DatabaseSync(file); handles.push(db);
    if (opens === 1) {
      linkSync(first, alias);
      try { owners.open(alias); } catch (error) { denied = error instanceof StorageConnectionUnavailable; }
    }
    return db;
  });
  try { owners.open(first); assert.equal(denied, true); assert.equal(opens, 1); }
  finally { for (const db of handles) if (db.isOpen) db.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const platform of ['win32', 'linux'] as const) test(`missing-file case acquisition follows ${platform} policy without changing the open path`, () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-startup-case-'));
  const first = join(root, 'Owner.db'), alias = join(root, 'owner.db');
  const handles: DatabaseSync[] = [], openedPaths: string[] = [], logs: unknown[] = [];
  let denied = false;
  const owners = new StartupDatabaseOwners(new PerformanceDiagnostics(line => logs.push(JSON.parse(line))), () => 0, path => {
    openedPaths.push(path);
    if (openedPaths.length === 1) {
      try { owners.open(alias); } catch (error) { denied = error instanceof StorageConnectionUnavailable; }
    }
    const db = new DatabaseSync(':memory:'); handles.push(db); return db;
  }, platform);
  try {
    owners.open(first);
    assert.equal(denied, platform === 'win32');
    assert.deepEqual(openedPaths, platform === 'win32' ? [first] : [first, alias]);
    assert.doesNotMatch(JSON.stringify(logs), /Owner\.db|owner\.db|agentopsdeck-startup-case/);
  } finally { for (const db of handles) db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('Windows missing-file alias cannot replace a failed original until native closure is confirmed', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-startup-case-close-'));
  const first = join(root, 'Owner.db'), alias = join(root, 'owner.db');
  const handles: DatabaseSync[] = [], openedPaths: string[] = [];
  let now = 0, broken = true, closes = 0;
  const diagnostics = new PerformanceDiagnostics(() => {}, () => now);
  const owners = new StartupDatabaseOwners(diagnostics, () => now, path => {
    openedPaths.push(path); const db = new DatabaseSync(':memory:'); handles.push(db); return db;
  }, 'win32');
  const db = owners.open(first), native = DatabaseSync.prototype.close;
  DatabaseSync.prototype.close = function () { closes++; if (broken) throw Error('private-native-close'); return native.call(this); };
  try {
    db.exec('BEGIN; CREATE TABLE private_unfinished(value)');
    owners.abandon(db);
    assert.throws(() => owners.open(alias), StorageConnectionUnavailable);
    assert.equal(closes, 1); assert.deepEqual(openedPaths, [first]);
    assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
    assert.throws(() => db.exec('COMMIT'), StorageConnectionUnavailable);
    broken = false; now = 999;
    assert.throws(() => owners.open(alias), StorageConnectionUnavailable);
    assert.equal(closes, 1);
    now = 1000;
    const replacement = owners.open(alias);
    assert.equal(closes, 2); assert.equal(connectionRecoverySnapshot(db).state, 'closed');
    assert.deepEqual(openedPaths, [first, alias]);
    assert.equal(replacement.prepare("SELECT name FROM sqlite_master WHERE name='private_unfinished'").get(), undefined);
    assert.ok(diagnostics.snapshot().events.some(row => row.operation === 'storage-startup-owner' && row.step === 3 && row.pending === 1));
    assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /private|Owner\.db|owner\.db|COMMIT|BEGIN/);
  } finally { DatabaseSync.prototype.close = native; for (const handle of handles) if (handle.isOpen) handle.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const callback of ['clock', 'sink', 'throwing-sink'] as const) test(`startup refusal stays bounded and fail-closed during diagnostic ${callback} reentrancy`, () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-startup-log-reentry-'));
  const first = join(root, 'Owner.db'), alias = join(root, 'owner.db');
  const handles: DatabaseSync[] = [];
  let armed = false, creates = 0, reentries = 0, outerDenied = false;
  let owners: StartupDatabaseOwners;
  const reenter = () => {
    if (!armed) return;
    assert.ok(++reentries <= 3, 'Observation must not recursively log its own refusal');
    assert.throws(() => owners.open(alias), StorageConnectionUnavailable);
  };
  const diagnostics = new PerformanceDiagnostics(() => {
    if (callback !== 'clock') reenter();
    if (callback === 'throwing-sink') throw Error('private-diagnostic-fault');
  }, () => { if (callback === 'clock') reenter(); return 0; });
  owners = new StartupDatabaseOwners(diagnostics, () => 0, () => {
    creates++; armed = true;
    try { owners.open(alias); } catch (error) { outerDenied = error instanceof StorageConnectionUnavailable; }
    armed = false;
    const db = new DatabaseSync(':memory:'); handles.push(db); return db;
  }, 'win32');
  try {
    owners.open(first);
    assert.equal(outerDenied, true); assert.equal(creates, 1);
    assert.equal(reentries, callback === 'clock' ? 2 : 1);
    const events = diagnostics.snapshot().events.filter(row => row.operation === 'storage-startup-owner');
    assert.equal(events.length, 1); assert.equal(events[0]?.step, 1);
    assert.equal(events[0]?.delivery, callback === 'throwing-sink' ? 'failed' : 'delivered');
    assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /private|Owner\.db|owner\.db/);
  } finally { for (const db of handles) db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('startup refusal logs do not grant acquisition while the original native close is executing', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-startup-closing-log-')), file = join(root, 'owner.db');
  const diagnostics = new PerformanceDiagnostics(() => {}, () => 0);
  let opens = 0;
  const owners = new StartupDatabaseOwners(diagnostics, () => 0, path => { opens++; return new DatabaseSync(path); });
  const db = owners.open(file), native = DatabaseSync.prototype.close;
  DatabaseSync.prototype.close = function () { assert.throws(() => owners.open(file), StorageConnectionUnavailable); return native.call(this); };
  try {
    owners.abandon(db);
    assert.equal(opens, 1); assert.equal(connectionRecoverySnapshot(db).state, 'closed');
    assert.ok(diagnostics.snapshot().events.some(row => row.operation === 'storage-startup-owner' && row.step === 2));
  } finally { DatabaseSync.prototype.close = native; db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('startup capacity refusal retains all original owners and records a sanitized diagnosis', () => {
  const handles: DatabaseSync[] = [];
  const diagnostics = new PerformanceDiagnostics(() => {}, () => 0);
  let opens = 0;
  const owners = new StartupDatabaseOwners(diagnostics, () => 0, () => { opens++; return new DatabaseSync(':memory:'); });
  const native = DatabaseSync.prototype.close;
  DatabaseSync.prototype.close = function () { throw Error('private-capacity-close'); };
  try {
    for (let index = 0; index < 128; index++) { const db = owners.open(':memory:'); handles.push(db); owners.abandon(db); }
    assert.throws(() => owners.open(':memory:'), StorageConnectionUnavailable);
    assert.equal(handles.length, 128); assert.equal(opens, 128);
    assert.ok(handles.every(db => connectionRecoverySnapshot(db).state === 'close-required'));
    assert.ok(diagnostics.snapshot().events.some(row => row.operation === 'storage-startup-owner' && row.step === 4 && row.pending === 128 && row.delivery === 'delivered'));
    assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /private-capacity-close/);
  } finally { DatabaseSync.prototype.close = native; for (const db of handles) db.close(); }
});

test('routine and failure traffic cannot consume the startup-owner lifecycle logging reserve', () => {
  const logs: { operation: string }[] = [];
  const diagnostics = new PerformanceDiagnostics(line => logs.push(JSON.parse(line)), () => 0);
  for (let index = 0; index < 100; index++) { diagnostics.start('rollout-read').finish(true); diagnostics.start('rollout-read').finish(); }
  for (const operation of ['storage-startup-owner', 'storage-startup-cleanup'] as const) {
    const trace = diagnostics.start(operation); trace.add('step', 1); trace.add('unknown', 1); trace.finish(true);
    assert.ok(logs.some(row => row.operation === operation));
    assert.ok(diagnostics.snapshot().events.some(row => row.operation === operation && row.delivery === 'delivered'));
  }
});

test('startup refusal logging reserve is bounded and reports suppression on rollover', () => {
  let now = 0;
  const logs: { operation: string; suppressed: number }[] = [];
  const diagnostics = new PerformanceDiagnostics(line => logs.push(JSON.parse(line)), () => now);
  for (let index = 0; index < 80; index++) {
    const trace = diagnostics.start('storage-startup-owner'); trace.add('unknown', 1); trace.finish(true);
  }
  assert.equal(logs.length, 60);
  assert.equal(diagnostics.snapshot().events.length, 80);
  assert.equal(diagnostics.snapshot().events.filter(row => row.delivery === 'rate-limited').length, 20);
  now = 60_000;
  diagnostics.start('storage-startup-owner').finish(true);
  assert.equal(logs.length, 61); assert.equal(logs.at(-1)?.suppressed, 20);
  assert.equal(diagnostics.snapshot().totals.suppressed, 20);
});
