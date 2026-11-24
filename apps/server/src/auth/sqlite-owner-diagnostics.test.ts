import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsyncSqliteAuthOwner } from './async-sqlite-owner.js';
import { PasskeyUnavailableError } from './passkeys.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { reportSqliteAuthOwnerFailure } from './sqlite-owner-diagnostics.js';
import { standaloneAuthKinds, type StandaloneAuthKind } from './standalone-owner-domain.js';
import { openSqliteAuth } from './sqlite-store.js';

for (const failedSink of [false, true]) test(`owner SQL failure before ACK retains safe code; failed sink=${failedSink}`, () => {
  const db = new DatabaseSync(':memory:'), lines: string[] = [];
  const diagnostics = new PerformanceDiagnostics(line => { if (failedSink) throw Error('private-sink'); lines.push(line); });
  try {
    let original: unknown;
    try { db.exec('SELECT private_missing_column FROM private_table'); } catch (error) { original = error; }
    reportSqliteAuthOwnerFailure('deleteSession', original, diagnostics);
    const row = diagnostics.snapshot().events[0]!;
    assert.equal(row.operation, 'auth-sqlite-owner-failure'); assert.equal(row.step, 7); assert.equal(row.sqlErrorCode, 1);
    assert.equal(row.delivery, failedSink ? 'failed' : 'delivered');
    assert.doesNotMatch(JSON.stringify({ lines, snapshot: diagnostics.snapshot() }), /private|SELECT|no such table|ERR_/);
  } finally { db.close(); }
});

test('all owner domain commands have stable non-secret phases; startup and close cannot collide', () => {
  const diagnostics = new PerformanceDiagnostics(() => {});
  const expected: Record<StandaloneAuthKind | 'open' | 'close', number> = {
    open: 0, status: 1, list: 2, authorized: 3, sessionCurrent: 4, accessKeySession: 5,
    issueAdministratorSession: 6, deleteSession: 7, clearSessions: 8, credentialCurrent: 9,
    revoke: 10, registrationOptions: 11, authenticationOptions: 12,
    verifyRegistration: 13, verifyAuthentication: 14, close: 15,
    originalJsonSession: 16, originalJsonAuthorized: 17, issueUnrestrictedSession: 18, currentKeyBinding: 19,
    localPreference: 20, localPreferenceSnapshot: 21,
  };
  const kinds = ['open', ...standaloneAuthKinds, 'close'] as const;
  assert.deepEqual([...kinds].sort(), Object.keys(expected).sort(), 'every production command has a fixed diagnostic phase');
  for (const kind of kinds) reportSqliteAuthOwnerFailure(kind, Error('private-outcome'), diagnostics);
  const rows = diagnostics.snapshot().events;
  assert.equal(rows.length, 22); assert.equal(new Set(rows.map(row => row.step)).size, 22);
  assert.deepEqual(rows.map(row => row.step), kinds.map(kind => expected[kind]));
  assert.equal(rows[0]!.step, 0); assert.equal(rows.at(-1)!.step, 15);
  assert.ok(rows.every(row => row.classificationUnknown === 1)); assert.doesNotMatch(JSON.stringify(rows), /private-outcome/);
});

test('owner failure classification never executes getter/proxy authority or replaces the failure', () => {
  let calls = 0;
  const getter = Object.defineProperties({}, {
    code: { get() { calls++; throw Error('private-code'); } }, errcode: { get() { calls++; throw Error('private-number'); } },
  });
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { calls++; throw Error('private-proxy'); } });
  const diagnostics = new PerformanceDiagnostics(() => { throw Error('private-sink'); });
  for (const error of [getter, proxy]) assert.doesNotThrow(() => reportSqliteAuthOwnerFailure('close', error, diagnostics));
  assert.equal(calls, 0); assert.ok(diagnostics.snapshot().events.every(row => row.classificationUnknown === 1));
});

test('ordinary auth refusals remain logged without consuming original SQL failure telemetry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentopsdeck-owner-log-')); chmodSync(dir, 0o700);
  const file = join(dir, 'private-auth.sqlite'), accessKeyDigest = 'a'.repeat(64);
  const token = 'A'.repeat(43);
  // Seed and close before starting the sole runtime worker; no second writer.
  const seed = openSqliteAuth(file, [], () => accessKeyDigest.slice(0, 24));
  try {
    seed.passkeys.addAdministratorSession(token);
    seed.passkeys.db.exec("CREATE TRIGGER private_delete_fault BEFORE DELETE ON shared_auth_sessions BEGIN SELECT RAISE(ABORT,'private-sql-error'); END");
  } finally { await seed.close(); }
  const source = import.meta.url.endsWith('.ts');
  const entry = new URL(source ? './sqlite-owner-worker.ts' : './sqlite-owner-worker.js', import.meta.url);
  const lines: string[] = [], diagnostics = new PerformanceDiagnostics(() => {});
  const owner = new AsyncSqliteAuthOwner({ file, legacyFiles: [], accessKeyDigest }, diagnostics, () => {
    const worker = new Worker(`(async () => {
      const {workerData} = require('node:worker_threads');
      if (workerData.loader) { const {tsImport} = await import(workerData.loader); await tsImport(workerData.entry, workerData.entry); }
      else await import(workerData.entry);
    })().catch(() => process.exit(1));`, { eval: true, execArgv: [], stdout: true, workerData: {
      file, legacyFiles: [], accessKeyDigest, entry: entry.href, loader: source ? import.meta.resolve('tsx/esm/api') : undefined,
    } });
    worker.stdout!.setEncoding('utf8'); worker.stdout!.on('data', chunk => lines.push(chunk)); return worker;
  });
  try {
    await owner.open();
    for (let i = 0; i < 20; i++) {
      await assert.rejects(owner.command('authenticationOptions', { origin: 'https://auth.example' }), PasskeyUnavailableError);
    }
    assert.deepEqual(await owner.command('status', {}), { available: false, count: 0 });
    await assert.rejects(owner.command('deleteSession', { token }));
    assert.equal(await owner.command('sessionCurrent', { token }), true, 'original transaction rolled back without losing the session');
    assert.equal(owner.snapshot().unavailable, false); await owner.close();
    const childRows = lines.join('').split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    const row = childRows.find(row => row.operation === 'auth-sqlite-owner-failure');
    assert.ok(row); assert.equal(row.step, 7); assert.equal(row.classificationUnknown, 1); assert.equal(row.category, 'failed');
    // The domain intentionally replaces the original SQL exception before its
    // ACK. Raw numeric code remains in the child's original transaction log.
    assert.ok(childRows.some(row => row.operation === 'auth-passkey-change' && row.sqlErrorCode === 1811));
    assert.equal(childRows.filter(row => row.operation === 'auth-sqlite-owner-failure' && row.step === 12).length, 0);
    assert.doesNotMatch(JSON.stringify(row), /private-auth|aaaa|auth.example|SELECT|PasskeyUnavailable/);
    const parentRow = diagnostics.snapshot().events.find(row => row.operation === 'auth-sqlite-owner-failure');
    assert.ok(parentRow); assert.equal(parentRow.step, 7); assert.equal(parentRow.classificationUnknown, 1);
    const refusals = diagnostics.snapshot().events.filter(row => row.operation === 'auth-sqlite-command' && row.deferred === 1);
    assert.equal(refusals.length, 20); assert.ok(refusals.every(row => !row.unknown));
    assert.equal(diagnostics.snapshot().events.filter(row => row.operation === 'auth-sqlite-owner-failure' && row.step === 12).length, 0);
    assert.doesNotMatch(JSON.stringify(diagnostics.snapshot()), /private-auth|aaaa|auth.example|SELECT|PasskeyUnavailable/);
    assert.equal(owner.snapshot().ownerExitConfirmed, true);
  } finally { await owner.close(); rmSync(dir, { recursive: true, force: true }); }
});
