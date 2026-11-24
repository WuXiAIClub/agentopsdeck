import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionSummary } from '@agentopsdeck/shared';
import { executionProtectionLabel, hasQueueBlockingRun, isSessionBusy, runSyncNotice, sessionRunOutcome } from './live-session.js';
import { sessionPresentation, sessionSyncIssueLabel } from './session-presentation.js';

const base: SessionSummary = { sessionKey: 's', agentId: 'codex', title: 'Goal', status: 'idle', runStartedAt: 1,
  runtime: { turnId: 'previous', phase: 'completed', sync: 'error', threadActivity: 'running', connection: 'connected', lastEventAt: 2,
    executionProtection: { state: 'blocked', nativeTurnId: 'successor', reason: 'goal-unknown' } } };

for (const phase of ['completed', 'failed', 'interrupted'] as const) {
  for (const threadActivity of ['running', 'waiting'] as const) {
    test(`old ${phase} turn with ${threadActivity} successor separates history from protected execution`, () => {
      const session: SessionSummary = { ...base, runtime: { ...base.runtime!, phase, threadActivity } };
      const before = structuredClone(session);
      const notice = runSyncNotice(session, 50_000);
      assert.equal(notice.errorLabel, 'Previous run history sync incomplete · thread still active');
      assert.equal(notice.incomplete, true);
      assert.equal(notice.elapsed, '', 'never attribute successor elapsed time to the previous turn');
      assert.equal(notice.animate, false, 'warning does not animate the previous turn');
      assert.equal(executionProtectionLabel(session), 'Execution continuing · execution protected');
      assert.deepEqual(sessionPresentation(session), { state: 'running', label: 'Running · history sync interrupted' });
      assert.equal(sessionSyncIssueLabel(session), 'Previous run history sync incomplete · thread still active', 'existing retry visibility remains with exact old-turn scope');
      assert.equal(isSessionBusy(session), true); assert.equal(hasQueueBlockingRun(session), true);
      assert.equal(sessionRunOutcome(session), undefined);
      const syncing = { ...session, runtime: { ...session.runtime!, sync: 'syncing' as const } };
      assert.equal(runSyncNotice(syncing, 50_000).syncLabel, 'Syncing previous run history · thread still active');
      assert.equal(runSyncNotice(syncing, 50_000).errorLabel, 'Execution continuing · execution protected');
      assert.deepEqual(session, before, 'presentation never rewrites ownership or history markers');
      assert.equal(sessionSyncIssueLabel(session, 'HTTP 503'), 'Previous run history sync incomplete · latest messages unavailable', 'old history failure must not hide visible-message fetch failure');
    });
  }
}

for (const patch of [
  { connection: 'disconnected' }, { threadActivity: 'unknown' }, { threadActivity: 'idle' },
  { phase: 'unknown' }, { operation: 'compact' },
] as const) {
  test(`unconfirmed or non-successor snapshot never claims continuing execution: ${JSON.stringify(patch)}`, () => {
    const session: SessionSummary = { ...base, runtime: { ...base.runtime!, ...patch } };
    const notice = runSyncNotice(session, 50_000);
    assert.notEqual(notice.errorLabel, 'Previous run history sync incomplete · thread still active');
    assert.notEqual(notice.syncLabel, 'Syncing previous run history · thread still active');
    assert.notEqual(executionProtectionLabel(session), 'Execution continuing · execution protected');
    assert.equal(sessionSyncIssueLabel(session), 'History sync interrupted');
    assert.equal(sessionSyncIssueLabel(session, 'HTTP 503'), 'History sync incomplete · latest messages unavailable');
    assert.equal(isSessionBusy(session), true); assert.equal(sessionRunOutcome(session), undefined);
  });
}

test('ordinary confirmed running protection avoids an indefinite check without changing guards', () => {
  const session: SessionSummary = { ...base, runtime: { ...base.runtime!, phase: 'running', sync: 'syncing' } };
  assert.equal(executionProtectionLabel(session), 'Execution continuing · execution protected');
  assert.equal(runSyncNotice(session, 50_000).errorLabel, 'Execution continuing · execution protected');
  assert.equal(hasQueueBlockingRun(session), true); assert.equal(isSessionBusy(session), true);
  assert.equal(sessionRunOutcome(session), undefined);
});

test('legacy active status alone is not evidence of a continuing native successor', () => {
  const { runtime: _runtime, ...legacy } = base;
  assert.equal(executionProtectionLabel({ ...legacy, status: 'running' }), undefined);
  assert.notEqual(runSyncNotice({ ...legacy, status: 'running' }, 50_000).errorLabel,
    'Previous run history sync incomplete · thread still active');
});

test('missing legacy activity, current history, and transport-only errors retain separate meaning', () => {
  const runtime = { ...base.runtime! }; delete runtime.threadActivity;
  const legacy = { ...base, runtime };
  assert.equal(sessionSyncIssueLabel(legacy), 'History sync interrupted');
  assert.equal(sessionSyncIssueLabel(legacy, 'HTTP 503'), 'History sync incomplete · latest messages unavailable');
  const current = { ...base, runtime: { ...base.runtime!, sync: 'current' as const } };
  assert.equal(sessionSyncIssueLabel(current), undefined);
  assert.equal(sessionSyncIssueLabel(current, 'HTTP 503'), 'Latest messages unavailable');
  const syncing = { ...base, runtime: { ...base.runtime!, sync: 'syncing' as const } };
  assert.equal(sessionSyncIssueLabel(syncing, 'HTTP 503'), 'Latest messages unavailable');
  assert.equal(sessionSyncIssueLabel(base, ''), 'Previous run history sync incomplete · thread still active');
});
