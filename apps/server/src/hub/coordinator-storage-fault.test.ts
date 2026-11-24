import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { recoverableConnection, connectionRecoverySnapshot, StorageConnectionUnavailable } from '../storage/connection-recovery.js';
import { TransactionAuthStore } from '../auth/transaction-store.js';
import { SessionGuidanceStore } from './session-guidance-store.js';
import { UsageManifests } from './usage-manifests.js';
import { TaskSessionWorkflow } from './task-session-workflow.js';

const id = '11111111-1111-4111-8111-111111111111';
for (const domain of ['auth', 'guidance', 'usage', 'workflow'] as const) {
  for (const fault of ['begin', 'commit', 'rollback', 'outer'] as const) {
    test(`${domain} coordinator ${fault}: preserve original failure, owner and durable state`, () => {
      const raw = new DatabaseSync(':memory:'), logs: string[] = [];
      let clock = 0;
      const diagnostics = new PerformanceDiagnostics(line => logs.push(line));
      const db = recoverableConnection(raw, diagnostics, () => clock);
      const auth = new TransactionAuthStore(db, () => 1000, diagnostics);
      const guidance = new SessionGuidanceStore(db, () => 1000, diagnostics);
      const usage = new UsageManifests(db, () => true, () => 1000, undefined, diagnostics);
      const workflow = new TaskSessionWorkflow(db, () => true, diagnostics);
      const write = () => {
        if (domain === 'auth') return auth.register('private-owner', 'credential', 'rp');
        if (domain === 'guidance') return guidance.save('private-owner', 'target', 0, 'private-text', true);
        if (domain === 'usage') return usage.cancel('private-owner', id);
        return workflow.cancel('private-owner', id);
      };
      const table = domain === 'auth' ? 'auth_v2_credentials' : domain === 'guidance' ? 'session_guidance'
        : domain === 'usage' ? 'hub_usage_cancellations' : 'hub_task_session_cancellations';
      const exec = db.exec, original = Error('private-original'), cleanup = Error('private-cleanup');
      db.exec = sql => {
        if (fault === 'rollback' && sql === 'ROLLBACK') throw cleanup;
        exec(sql);
        if (fault === 'begin' && sql === 'BEGIN IMMEDIATE' || fault === 'commit' && sql === 'COMMIT') throw original;
      };
      if (fault === 'rollback') {
        if (domain === 'auth') raw.exec("CREATE TRIGGER reject_auth BEFORE INSERT ON auth_v2_credentials BEGIN SELECT RAISE(ABORT,'private-original'); END");
        if (domain === 'guidance') db.exec = sql => { if (sql.includes('CREATE TABLE')) throw original; if (sql === 'ROLLBACK') throw cleanup; exec(sql); };
        if (domain === 'usage' || domain === 'workflow') raw.exec(`CREATE TRIGGER reject_cancel BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'private-original'); END`);
      }
      try {
        if (fault === 'outer') {
          raw.exec('BEGIN; CREATE TABLE parent_fact(id); INSERT INTO parent_fact VALUES(1)');
          assert.throws(write, /outer/);
          assert.equal(raw.isTransaction, true);
          assert.equal(raw.prepare('SELECT count(*) n FROM parent_fact').get()!.n, 1);
          raw.exec('ROLLBACK');
        } else {
          assert.throws(write, error => fault === 'rollback' && domain !== 'guidance'
            ? error instanceof Error && error.message === 'private-original' : error === original);
          if (fault === 'rollback') {
            assert.equal(connectionRecoverySnapshot(db).state, 'owner-rollback-required');
            assert.throws(write, StorageConnectionUnavailable);
            db.exec = exec; clock += 1000;
            assert.throws(write, StorageConnectionUnavailable);
            assert.equal(connectionRecoverySnapshot(db).state, 'ready');
          } else db.exec = exec;
          assert.equal(raw.isTransaction, false);
          const exists = raw.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(table);
          assert.equal(exists ? Number(raw.prepare(`SELECT count(*) n FROM ${table}`).get()!.n) : 0, fault === 'commit' ? 1 : 0);
          assert.ok(logs.some(line => JSON.parse(line).unknown === 1));
          assert.doesNotMatch(logs.join('\n'), /private|credential|CREATE TABLE|11111111/);
        }
      } finally { raw.close(); }
    });
  }
}
