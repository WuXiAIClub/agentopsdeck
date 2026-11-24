import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StartupDatabaseOwners } from './startup-owner.js';
import { connectionRecoverySnapshot, StorageConnectionUnavailable } from './connection-recovery.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

for (const [index, sample] of [NaN, Infinity, -Infinity, -1, Number.MAX_SAFE_INTEGER, undefined, null, '1000', {}].entries()) {
  test(`invalid startup cleanup sample ${index} preserves the original cooldown and close-only fence`, () => {
    let now: unknown = 0, closes = 0, broken = true;
    const logs: unknown[] = [];
    const diagnostics = new PerformanceDiagnostics(line => logs.push(JSON.parse(line)));
    const owners = new StartupDatabaseOwners(diagnostics, () => now as number);
    const db = owners.open(':memory:');
    const cached = db.prepare('SELECT 1');
    const native = DatabaseSync.prototype.close;
    DatabaseSync.prototype.close = function () { closes++; if (broken) throw Error('private-close'); return native.call(this); };
    try {
      db.exec('BEGIN');
      owners.abandon(db);
      assert.equal(closes, 1);
      now = sample;
      owners.abandon(db); owners.abandon(db);
      assert.equal(closes, 1);
      assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
      assert.throws(() => cached.get(), StorageConnectionUnavailable);
      assert.throws(() => db.exec('COMMIT'), StorageConnectionUnavailable);
      broken = false; now = 999;
      owners.abandon(db); assert.equal(closes, 1);
      now = 1000;
      owners.abandon(db); assert.equal(closes, 2);
      assert.equal(connectionRecoverySnapshot(db).state, 'closed');
      assert.equal(diagnostics.snapshot().events.filter(event => event.operation === 'storage-startup-cleanup'
        && event.deferred === 1 && event.classificationUnknown === 1 && event.unknown === 1).length, 2);
      assert.doesNotMatch(JSON.stringify(logs), /private|SELECT|COMMIT|BEGIN/);
    } finally { DatabaseSync.prototype.close = native; db.close(); }
  });
}

for (const throwing of [false, true]) test(`unusable initial startup clock is sanitized without SQL admission; throws=${throwing}`, () => {
  let valid = false, calls = 0, closes = 0;
  const hostile = { valueOf() { calls++; throw Error('private-value'); }, get then() { calls++; throw Error('private-getter'); } };
  const diagnostics = new PerformanceDiagnostics(() => {});
  const owners = new StartupDatabaseOwners(diagnostics, () => {
    if (valid) return 0;
    if (throwing) throw Error('private-clock');
    return hostile as unknown as number;
  });
  const db = owners.open(':memory:'), cached = db.prepare('SELECT 1');
  const native = DatabaseSync.prototype.close;
  DatabaseSync.prototype.close = function () { closes++; return native.call(this); };
  try {
    assert.doesNotThrow(() => owners.abandon(db));
    assert.equal(calls, 0); assert.equal(closes, 0);
    assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
    assert.throws(() => cached.get(), StorageConnectionUnavailable);
    valid = true;
    owners.abandon(db);
    assert.equal(closes, 1); assert.equal(connectionRecoverySnapshot(db).state, 'closed');
    assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /private|valueOf|getter/);
  } finally { DatabaseSync.prototype.close = native; db.close(); }
});

test('unusable cleanup clock cannot reopen a file or reenter its abandoned transaction', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentopsdeck-startup-clock-')), file = join(root, 'state.sqlite');
  let valid = false, opens = 0, observations = 0, db: DatabaseSync;
  const diagnostics = new PerformanceDiagnostics(() => {});
  const owners = new StartupDatabaseOwners(diagnostics, () => {
    observations++;
    assert.throws(() => db.prepare('SELECT 1'), StorageConnectionUnavailable);
    assert.throws(() => owners.open(file), StorageConnectionUnavailable);
    owners.abandon(db);
    return valid ? 0 : NaN;
  }, path => { opens++; return new DatabaseSync(path); });
  db = owners.open(file);
  let replacement: DatabaseSync | undefined;
  try {
    db.exec('BEGIN; CREATE TABLE unfinished(value); INSERT INTO unfinished VALUES(1)');
    owners.abandon(db);
    assert.equal(opens, 1); assert.equal(observations, 1);
    assert.equal(connectionRecoverySnapshot(db).state, 'close-required');
    assert.throws(() => owners.open(file), StorageConnectionUnavailable);
    assert.equal(opens, 1); assert.equal(observations, 2);
    valid = true;
    replacement = owners.open(file);
    assert.equal(opens, 2); assert.equal(observations, 3);
    assert.equal(connectionRecoverySnapshot(db).state, 'closed');
    assert.equal(replacement.prepare("SELECT name FROM sqlite_master WHERE name='unfinished'").get(), undefined);
  } finally { replacement?.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});
