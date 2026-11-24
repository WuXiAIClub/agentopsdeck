import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexExecutions } from './executions.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { nativeGoalEvidence, nativeGoalProtection, nativeHistoryFingerprint, hasNativeChildWork, type NativeHistoryCheckpoint } from './native-history.js';

test('malformed completion evidence cannot release native execution protection', () => {
  const goal = { threadId: 's', status: 'complete', objective: 'Task', tokenBudget: null,
    tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 2 };
  for (const patch of [{ objective: '' }, { tokensUsed: -1 }, { tokenBudget: undefined },
    { timeUsedSeconds: NaN }, { createdAt: -1 }, { updatedAt: 0 }, { tokensUsed: Number.MAX_SAFE_INTEGER + 1 }]) {
    const evidence = nativeGoalEvidence({ goal: { ...goal, ...patch } }, 's');
    assert.equal(evidence.status, 'unknown', JSON.stringify(patch));
    assert.equal(nativeGoalProtection(evidence.status), 'goal-unknown');
  }
  assert.equal(nativeGoalEvidence({ goal }, 's').status, 'complete');
});

test('same-timestamp goal replacement, budget edits and usage changes invalidate drain evidence', () => {
  const goal = { threadId: 's', status: 'complete', createdAt: 1, updatedAt: 2, objective: 'Original', tokenBudget: 100, tokensUsed: 30, timeUsedSeconds: 0 };
  const original = nativeGoalEvidence({ goal }, 's');
  for (const patch of [{ objective: 'Replacement' }, { tokenBudget: 200 }, { tokensUsed: 50 }, { status: 'active' }]) {
    assert.notEqual(nativeGoalEvidence({ goal: { ...goal, ...patch } }, 's').version, original.version);
  }
  assert.equal(JSON.stringify(original).includes('Original'), false);
});

test('activity-only child records cannot bypass legacy child-work protection', () => {
  for (const type of ['collabAgentToolCall', 'collabToolCall', 'subAgentActivity']) {
    assert.equal(hasNativeChildWork([{ type }]), true);
  }
  assert.equal(hasNativeChildWork([{ type: 'agentMessage' }]), false);
  assert.equal(
    hasNativeChildWork([{ type: 'subAgentActivity', kind: 'interacted', agentThreadId: 'root-thread', agentPath: '/root' }], 'root-thread'),
    false,
  );
  assert.equal(
    hasNativeChildWork([{ type: 'subAgentActivity', kind: 'interacted', agentThreadId: 'child-thread', agentPath: '/root/worker' }], 'root-thread'),
    true,
  );
  assert.equal(
    hasNativeChildWork([{ type: 'subAgentActivity', kind: 'interacted', agentThreadId: 'root-thread' }], 'root-thread'),
    true,
  );
});

test('goal evidence requires explicit native absence or a bound valid status, never stored objective', () => {
  for (const input of [undefined, {}, { goal: undefined }, { goal: [] }, { goal: { threadId: 'wrong', status: 'complete' } }]) {
    assert.equal(nativeGoalEvidence(input, 's').status, 'unknown');
  }
  assert.equal(nativeGoalEvidence({ goal: null }, 's').status, 'absent');
  const evidence = nativeGoalEvidence({ goal: { threadId: 's', status: 'blocked', createdAt: 1, updatedAt: 2, objective: 'SECRET',
    tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0 } }, 's');
  assert.equal(evidence.status, 'blocked');
  assert.equal(JSON.stringify(evidence).includes('SECRET'), false);
  assert.equal(nativeGoalProtection(evidence.status), 'goal-blocked');
  assert.equal(nativeGoalProtection('absent'), undefined);
  assert.equal(nativeGoalProtection('complete'), undefined);
});

test('native history fingerprint detects same-ID item changes and ordering, ignoring availability', () => {
  const thread = { id: 's', status: { type: 'idle' }, turns: [{ id: 'one', items: [{ id: 'tool', text: 'before' }] }, { id: 'two', items: [] }] };
  const original = nativeHistoryFingerprint(thread);
  thread.status.type = 'notLoaded'; assert.equal(nativeHistoryFingerprint(thread), original);
  thread.turns[0]!.items[0]!.text = 'after'; assert.notEqual(nativeHistoryFingerprint(thread), original);
  thread.turns[0]!.items[0]!.text = 'before'; thread.turns.reverse(); assert.notEqual(nativeHistoryFingerprint(thread), original);
});

test('Windows rollout path aliases retain the same native history fingerprint', { skip: process.platform !== 'win32' }, () => {
  const thread = { id: 's', path: 'C:\\sessions\\rollout.jsonl', turns: [{ id: 'owned', status: 'failed', items: [] }] };
  const original = nativeHistoryFingerprint(thread);
  assert.equal(nativeHistoryFingerprint({ ...thread, path: '\\\\?\\C:\\sessions\\rollout.jsonl' }), original);
  assert.equal(nativeHistoryFingerprint({ ...thread, path: 'C:/sessions/rollout.jsonl' }), original);
  assert.notEqual(nativeHistoryFingerprint({ ...thread, path: 'C:\\sessions\\other.jsonl' }), original);
  assert.notEqual(nativeHistoryFingerprint({ ...thread, path: '\\sessions\\rollout.jsonl' }), original);
  assert.notEqual(nativeHistoryFingerprint({ ...thread, path: '\\\\?\\C:\\sessions\\nested\\..\\rollout.jsonl' }), original);
  assert.notEqual(nativeHistoryFingerprint({ ...thread, path: '\\\\.\\C:\\sessions\\rollout.jsonl' }), original);
  assert.notEqual(nativeHistoryFingerprint({ ...thread, turns: [{ ...thread.turns[0], status: 'completed' }] }), original);
  const unc = { ...thread, path: '\\\\server\\share\\rollout.jsonl' };
  assert.equal(nativeHistoryFingerprint({ ...unc, path: '\\\\?\\UNC\\server\\share\\rollout.jsonl' }), nativeHistoryFingerprint(unc));
});

test('native checkpoint CAS preserves command binding and rejects revision/connection/identity drift', () => {
  const db = new DatabaseSync(':memory:'), facts = new CodexExecutions(db);
  try {
    facts.begin('s', 'command', 'connection'); facts.acknowledge('s', 'command', 'connection', 'owned', () => {});
    facts.observe('s', 'connection', 'owned', 'completed');
    const before = facts.get('s')!;
    const checkpoint: NativeHistoryCheckpoint = { turnId: 'successor', fingerprint: 'a'.repeat(64), connectionId: 'connection', state: 'verified', reason: 'settled' };
    for (const patch of [{ revision: before.revision - 1 }, { commandId: 'wrong' }, { runId: 'wrong' }, { connectionId: 'wrong' }]) {
      assert.equal(facts.settleNativeHistory({ ...before, ...patch }, checkpoint), false);
      assert.deepEqual(facts.get('s'), before);
    }
    assert.equal(facts.settleNativeHistory(before, checkpoint), true);
    assert.equal(facts.get('s')?.runId, 'owned'); assert.equal(facts.canStart('s'), true);
    facts.invalidateNativeHistory('s');
    assert.equal(facts.canStart('s'), false);
    assert.equal(facts.settleNativeHistory(before, checkpoint), false);
    // Legacy history-settlement callers must not remove the independent guard.
    facts.settleHistory(before, 'current'); assert.equal(facts.canStart('s'), false);
    assert.deepEqual(facts.recoveryPage('', 64), ['s']);
    assert.equal(facts.begin('s', 'next', 'connection'), false);
  } finally { db.close(); }
});

test('durable native checkpoint survives database reopen but cannot authorize the restarted connection', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-checkpoint-restart-'));
  const file = join(directory, 'facts.sqlite');
  let db = new DatabaseSync(file);
  try {
    let facts = new CodexExecutions(db);
    facts.begin('s', 'command', 'old'); facts.acknowledge('s', 'command', 'old', 'owned', () => {});
    facts.observe('s', 'old', 'owned', 'completed');
    facts.settleNativeHistory(facts.get('s')!, { turnId: 'successor', fingerprint: 'a'.repeat(64), connectionId: 'old', state: 'verified', reason: 'settled' });
    db.close(); db = new DatabaseSync(file); facts = new CodexExecutions(db);
    assert.equal(facts.get('s')?.nativeHistory?.turnId, 'successor');
    assert.equal(facts.begin('s', 'next', 'new'), false, 'observer connection is checked even before boot recovery');
    facts.recoverInterrupted();
    assert.equal(facts.canStart('s'), false);
    assert.equal(facts.get('s')?.nativeHistory?.reason, 'restarted');
    assert.equal(facts.get('s')?.commandId, 'command');
    assert.equal(facts.get('s')?.runId, 'owned');
    assert.deepEqual(facts.recoveryPage('', 64, 'new'), ['s']);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('first checkpoint atomically fences legacy startup and writers, without affecting legacy-only databases', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentopsdeck-checkpoint-compat-'));
  const file = join(directory, 'users.sqlite');
  let users = new ConnectorUserStore(file);
  try {
    const facts = users.codexExecutions;
    facts.begin('s', 'command', 'connection'); facts.acknowledge('s', 'command', 'connection', 'owned', () => {});
    facts.observe('s', 'connection', 'owned', 'completed');
    const legacyBefore = new DatabaseSync(file);
    assert.equal(legacyBefore.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE 'codex_native_history_%'").get()?.n, 0);
    legacyBefore.close();
    facts.settleNativeHistory(facts.get('s')!, { turnId: 'successor', fingerprint: 'a'.repeat(64), connectionId: 'connection', state: 'blocked', reason: 'goal-blocked' });
    const before = facts.get('s');
    users.close();
    const legacy = new DatabaseSync(file);
    try {
      legacy.function('agentopsdeck_connector_writer_epoch', () => 1);
      assert.throws(() => legacy.exec("INSERT INTO connector_users SELECT * FROM connector_users WHERE 0"), /agentopsdeck_codex_native_history_epoch/);
      assert.throws(() => legacy.exec("UPDATE connector_codex_executions SET fact = fact"), /agentopsdeck_codex_native_history_epoch/);
      assert.throws(() => legacy.exec("DELETE FROM connector_codex_executions WHERE session_key = 's'"), /agentopsdeck_codex_native_history_epoch/);
      assert.equal(JSON.parse((legacy.prepare('SELECT fact FROM connector_codex_executions').get() as { fact: string }).fact).commandId, before?.commandId);
    } finally { legacy.close(); }
    users = new ConnectorUserStore(file);
    assert.equal(users.codexExecutions.canStart('s'), false);
    assert.equal(users.codexExecutions.get('s')?.nativeHistory?.reason, 'goal-blocked');
  } finally { users.close(); rmSync(directory, { recursive: true, force: true }); }
});
