import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import test from 'node:test';
import { AsyncSqliteAuthOwner } from './async-sqlite-owner.js';
import { AuthPersistenceError } from './private-store.js';
import { createDeckSession } from './passkeys.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';

for (const fault of ['once', 'persistent'] as const)
test(`original auth worker ${fault} rollback fault never publishes the failed session or replays its command`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-auth-original-rollback-'));
  chmodSync(directory, 0o700);
  const file = join(directory, 'auth.sqlite'), source = import.meta.url.endsWith('.ts');
  const entry = new URL(`./sqlite-owner-worker.${source ? 'ts' : 'js'}`, import.meta.url).href;
  const digest = 'a'.repeat(64), failedToken = createDeckSession(), laterToken = createDeckSession();
  let output = '';
  // Injection exists only in this isolated test worker. No callback, SQL or
  // recovery flag is added to the production command vocabulary.
  const launch = () => {
    const worker = new Worker(`(async () => {
      const { workerData } = require('node:worker_threads');
      const fault = workerData.fault; delete workerData.fault;
      const { DatabaseSync } = require('node:sqlite');
      const originalPrepare = DatabaseSync.prototype.prepare, originalExec = DatabaseSync.prototype.exec;
      let auditFailures = 0, rollbackFailures = 0;
      DatabaseSync.prototype.prepare = function(sql) {
        const statement = originalPrepare.call(this, sql);
        if (/^INSERT INTO shared_auth_audit\\b/.test(sql)) {
          const run = statement.run;
          statement.run = function(...args) {
            if (++auditFailures === 1) throw Object.assign(Error('PRIVATE audit failure'), {code:'ERR_SQLITE_ERROR',errcode:10});
            return run.apply(this, args);
          };
        }
        return statement;
      };
      DatabaseSync.prototype.exec = function(sql) {
        if (/^\\s*ROLLBACK\\b/i.test(sql) && (++rollbackFailures === 1 || fault === 'persistent')) {
          throw Object.assign(Error('PRIVATE rollback failure'), {code:'ERR_SQLITE_ERROR',errcode:10});
        }
        return originalExec.call(this, sql);
      };
      if (workerData.loader) {
        const { tsImport } = await import(workerData.loader); await tsImport(workerData.entry, workerData.entry);
      } else await import(workerData.entry);
    })().catch(() => { process.exitCode=1; require('node:worker_threads').parentPort.close(); });`, {
      eval: true, execArgv: [], stdout: true, stderr: true,
      workerData: { file, legacyFiles: [], accessKeyDigest: digest, entry, fault,
        loader: source ? import.meta.resolve('tsx/esm/api') : undefined },
    });
    worker.stdout.on('data', chunk => { output += chunk; });
    worker.stderr.on('data', chunk => { output += chunk; });
    return worker;
  };
  const callerRows: string[] = [];
  const owner = new AsyncSqliteAuthOwner({ file, legacyFiles: [], accessKeyDigest: digest },
    new PerformanceDiagnostics(line => callerRows.push(line)), launch);
  try {
    await owner.open();
    await assert.rejects(owner.command('issueAdministratorSession', {
      token: failedToken, evidence: { suppliedKeyDigest: digest },
    }), AuthPersistenceError);
    if (fault === 'once') {
      assert.equal(await owner.command('sessionCurrent', { token: failedToken }), false);
      await owner.command('issueAdministratorSession', { token: laterToken, evidence: { suppliedKeyDigest: digest } });
      assert.equal(await owner.command('sessionCurrent', { token: laterToken }), true);
    } else {
      await assert.rejects(owner.command('issueAdministratorSession', {
        token: laterToken, evidence: { suppliedKeyDigest: digest },
      }), AuthPersistenceError);
    }
    await owner.close();
    assert.equal(owner.snapshot().ownerExitConfirmed, true);
    // Only after actual original-owner exit may a separate connection inspect
    // durable state. Shutdown success never changes the first command failure.
    const observation = new DatabaseSync(file, { readOnly: true });
    try {
      const expected = fault === 'once' ? 1 : 0;
      assert.equal(observation.prepare('SELECT count(*) n FROM shared_auth_sessions').get()!.n, expected);
      assert.equal(observation.prepare("SELECT count(*) n FROM shared_auth_audit WHERE kind='administrator-issued'").get()!.n, expected);
    } finally { observation.close(); }
    const rows = output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    assert.ok(rows.some(row => row.rollbackErrorCode === 10 && row.rollbackFailed === 1));
    if (fault === 'once') assert.ok(rows.some(row => row.operation === 'storage-connection-recovery' && row.recovered === 1));
    else assert.ok(rows.some(row => row.operation === 'storage-connection-recovery' && row.unknown === 1));
    assert.doesNotMatch(output + callerRows.join('\n'), /PRIVATE|auth\.sqlite/);
    assert.ok(!output.includes(failedToken) && !output.includes(laterToken));
    const commands = callerRows.map(row => JSON.parse(row)).filter(row => row.operation === 'auth-sqlite-command' && row.step === 6);
    assert.equal(commands.length, 2); assert.equal(commands[0].category, 'failed');
    assert.equal(commands[0].settled, undefined);
  } finally {
    await owner.closeForShutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('real SQLite busy refusal leaves the same auth owner usable without replay or event-loop blocking', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-auth-original-busy-'));
  chmodSync(directory, 0o700);
  const file = join(directory, 'auth.sqlite'), source = import.meta.url.endsWith('.ts');
  const entry = new URL(`./sqlite-owner-worker.${source ? 'ts' : 'js'}`, import.meta.url).href;
  const digest = 'b'.repeat(64), failedToken = createDeckSession(), laterToken = createDeckSession();
  let output = '';
  const callerRows: string[] = [];
  const owner = new AsyncSqliteAuthOwner({ file, legacyFiles: [], accessKeyDigest: digest },
    new PerformanceDiagnostics(line => callerRows.push(line)), () => {
      const worker = new Worker(`(async () => {
        const { workerData } = require('node:worker_threads');
        if (workerData.loader) {
          const { tsImport } = await import(workerData.loader); await tsImport(workerData.entry, workerData.entry);
        } else await import(workerData.entry);
      })().catch(() => { process.exitCode=1; require('node:worker_threads').parentPort.close(); });`, {
        eval: true, execArgv: [], stdout: true, stderr: true,
        workerData: { file, legacyFiles: [], accessKeyDigest: digest, entry,
          loader: source ? import.meta.resolve('tsx/esm/api') : undefined },
      });
      worker.stdout.on('data', chunk => { output += chunk; });
      worker.stderr.on('data', chunk => { output += chunk; });
      return worker;
    });
  let blocker: DatabaseSync | undefined;
  try {
    await owner.open();
    // An isolated fixture connection holds a real write lock. It never writes
    // domain data and is not a second application owner or recovery mechanism.
    blocker = new DatabaseSync(file);
    blocker.exec('BEGIN IMMEDIATE');
    const attempt = owner.command('issueAdministratorSession', {
      token: failedToken, evidence: { suppliedKeyDigest: digest },
    });
    const rejection = assert.rejects(attempt, AuthPersistenceError);
    const first = await Promise.race([
      attempt.then(() => 'command', () => 'command'),
      new Promise<string>(resolve => setImmediate(() => resolve('event-loop'))),
    ]);
    assert.equal(first, 'event-loop');
    await rejection;
    assert.equal(owner.snapshot().unavailable, false);
    assert.equal(owner.snapshot().ownerExitConfirmed, false);
    blocker.exec('ROLLBACK'); blocker.close(); blocker = undefined;
    assert.equal(await owner.command('sessionCurrent', { token: failedToken }), false);
    await owner.command('issueAdministratorSession', { token: laterToken, evidence: { suppliedKeyDigest: digest } });
    assert.equal(await owner.command('sessionCurrent', { token: laterToken }), true);
    assert.equal(await owner.command('sessionCurrent', { token: failedToken }), false);
    await owner.close();
    assert.equal(owner.snapshot().ownerExitConfirmed, true);
    const observation = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(observation.prepare('SELECT count(*) n FROM shared_auth_sessions').get()!.n, 1);
      assert.equal(observation.prepare("SELECT count(*) n FROM shared_auth_audit WHERE kind='administrator-issued'").get()!.n, 1);
    } finally { observation.close(); }
    const rows = output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
    // The original transaction reports SQLITE_BUSY before SqlitePasskeys
    // sanitizes the error. The later worker ACK boundary cannot recover a
    // numeric code from that sanitized AuthPersistenceError.
    assert.ok(rows.some(row => row.operation === 'auth-passkey-change' && row.step === 1 && row.sqlErrorCode === 5));
    const commands = callerRows.map(row => JSON.parse(row)).filter(row => row.operation === 'auth-sqlite-command' && row.step === 6);
    assert.equal(commands.length, 2);
    assert.equal(commands[0].category, 'failed'); assert.equal(commands[0].settled, undefined);
    assert.equal(commands[1].settled, 1);
    for (const secret of [directory, failedToken, laterToken, digest]) assert.ok(!(output + callerRows.join('\n')).includes(secret));
  } finally {
    // Release only the fixture's original lock before awaiting owner cleanup.
    blocker?.close();
    await owner.closeForShutdown();
    rmSync(directory, { recursive: true, force: true });
  }
});
