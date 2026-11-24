import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { recoverableConnection, connectionRecoverySnapshot, StorageConnectionUnavailable } from '../storage/connection-recovery.js';
import { createDeckSession } from '../auth/passkeys.js';
import { SqlitePasskeys } from '../auth/sqlite-passkeys.js';
import { AuthPersistenceError } from '../auth/private-store.js';
import { SqliteMaintenanceJournal } from './maintenance-journal.js';
import { newMaintenanceJob } from './connector-maintenance.js';

for (const domain of ['auth', 'maintenance'] as const) for (const fault of ['begin', 'commit', 'rollback'] as const) {
  test(`${domain}: lost ${fault} boundary preserves failure, original receipt and sanitized recovery logs`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-journal-fault-'));
    const raw = new DatabaseSync(join(directory, 'private.sqlite')); raw.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
    const logs: string[] = [], diagnostics = new PerformanceDiagnostics(line => logs.push(line));
    let recoveryClock = 0;
    const db = recoverableConnection(raw, diagnostics, () => recoveryClock), token = createDeckSession();
    const auth = domain === 'auth' ? new SqlitePasskeys(db, () => undefined, Date.now, diagnostics) : undefined;
    const journal = domain === 'maintenance' ? new SqliteMaintenanceJournal(db, diagnostics) : undefined;
    const job = newMaintenanceJob({ id: 'request:1', actorId: 'actor:1', nodeId: 'node:1', operation: 'restart', createdAt: 1000, deadline: 60_000 });
    const exec = db.exec;
    try {
      if (fault === 'rollback') raw.exec(domain === 'auth'
        ? "CREATE TRIGGER failed_audit BEFORE INSERT ON shared_auth_audit BEGIN SELECT RAISE(ABORT,'private-secret-SQL'); END"
        : "CREATE TRIGGER failed_job BEFORE INSERT ON connector_maintenance_jobs BEGIN SELECT RAISE(ABORT,'private-secret-SQL'); END");
      db.exec = sql => {
        if (fault === 'rollback' && sql === 'ROLLBACK') throw Error('private-secret-cleanup');
        exec(sql);
        if (sql === (fault === 'begin' ? 'BEGIN IMMEDIATE' : fault === 'commit' ? 'COMMIT' : 'not-sql')) throw Error('private-secret-ack');
      };
      const write = () => auth ? auth.addAdministratorSession(token) : journal!.enqueue(job);
      assert.throws(write, domain === 'auth' ? AuthPersistenceError : Error);
      if (fault === 'rollback') {
        assert.equal(connectionRecoverySnapshot(db).state, 'owner-rollback-required');
        assert.throws(write, domain === 'auth' ? AuthPersistenceError : StorageConnectionUnavailable);
        db.exec = exec;
        recoveryClock += 1000;
        assert.throws(write, domain === 'auth' ? AuthPersistenceError : StorageConnectionUnavailable);
        assert.equal(connectionRecoverySnapshot(db).state, 'ready');
      } else db.exec = exec;
      assert.equal(raw.isTransaction, false);
      const count = Number(raw.prepare(`SELECT count(*) n FROM ${auth ? 'shared_auth_sessions' : 'connector_maintenance_jobs'}`).get()!.n);
      assert.equal(count, fault === 'commit' ? 1 : 0);
      assert.ok(logs.some(line => JSON.parse(line).unknown === 1));
      assert.doesNotMatch(logs.join('\n'), /private-secret|request:1|actor:1|private.sqlite/);
      if (fault === 'commit') {
        assert.equal(auth ? auth.sessionAuthorized(token) : journal!.get(job.id)?.id === job.id, true);
      }
    } finally { raw.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}
