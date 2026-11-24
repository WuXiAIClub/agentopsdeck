import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { recoverableConnection, connectionRecoverySnapshot, StorageConnectionUnavailable } from '../storage/connection-recovery.js';
import { CompletionUnreadStore } from './completion-unread-store.js';
import { QuickChatStore } from './quick-chat-store.js';

for (const domain of ['quick-chat', 'completion'] as const) for (const fault of ['begin', 'commit', 'rollback'] as const) {
  test(`${domain}: ${fault} ambiguity preserves atomic receipt and original failure without replay`, () => {
    const raw = new DatabaseSync(':memory:'), logs: string[] = [];
    const diagnostics = new PerformanceDiagnostics(line => logs.push(line));
    let clock = 0;
    const db = recoverableConnection(raw, diagnostics, () => clock);
    const quick = new QuickChatStore(db, () => 1000, undefined, diagnostics);
    const completion = new CompletionUnreadStore(db, () => 1000, diagnostics);
    const capability = { ephemeralRequest: true, noPersistentThread: true, originalLookup: true, maxOutput: 1024, epoch: 'epoch' };
    const write = () => domain === 'quick-chat'
      ? quick.saveProfile('owner:private', 0, { id: 'profile', name: 'profile', target: 'target', model: 'model', outputLimit: 10 }, capability)
      : completion.baseline('owner:private', 'target', 'epoch', 10);
    const exec = db.exec, original = Error('private-original'), cleanup = Error('private-cleanup');
    db.exec = sql => {
      if (fault === 'rollback' && sql === 'ROLLBACK') throw cleanup;
      exec(sql);
      if ((fault === 'begin' && sql === 'BEGIN IMMEDIATE') || (fault === 'commit' && sql === 'COMMIT')
        || (fault === 'rollback' && sql.includes('CREATE TABLE'))) throw original;
    };
    try {
      assert.throws(write, error => error === original);
      if (fault === 'rollback') {
        assert.equal(connectionRecoverySnapshot(db).state, 'owner-rollback-required');
        assert.throws(write, StorageConnectionUnavailable);
        db.exec = exec; clock += 1000;
        assert.throws(write, StorageConnectionUnavailable);
        assert.equal(connectionRecoverySnapshot(db).state, 'ready');
      } else db.exec = exec;
      assert.equal(raw.isTransaction, false);
      const exists = raw.prepare("SELECT count(*) n FROM sqlite_master WHERE name=?").get(domain === 'quick-chat' ? 'quick_chat_profiles' : 'completion_baselines')!.n;
      assert.equal(exists, fault === 'commit' ? 1 : 0);
      if (fault === 'commit') assert.equal(Number(raw.prepare(`SELECT count(*) n FROM ${domain === 'quick-chat' ? 'quick_chat_profiles' : 'completion_baselines'}`).get()!.n), 1);
      assert.ok(logs.some(line => JSON.parse(line).unknown === 1));
      assert.doesNotMatch(logs.join('\n'), /private|owner:|CREATE TABLE|profile/);
    } finally { raw.close(); }
  });
}
