import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRuntime, ChatMessage, SessionSummary } from '@agentopsdeck/shared';
import { executionProtectionLabel, hasMessageSnapshotRevision, formatElapsedDuration, hasOptimisticActiveSend, hasQueueBlockingRun, hasQueuedMessageControls, isSessionBusy, isStreamCatchup, mergeSelectedMessages, runSyncNotice, sessionRunOutcome, withOptimisticRunningState } from './live-session.js';

test('continuous Goal successors retain protection through long history verification and recovery', () => {
  for (const phase of ['completed', 'failed', 'interrupted'] as const)
    for (const sync of ['syncing', 'error', 'current'] as const)
      for (const threadActivity of ['running', 'waiting'] as const) {
        const session: SessionSummary = { sessionKey: 'private-long-session', title: 'private', status: 'idle',
          runStartedAt: 1, runCompletedAt: 10, runtime: { phase, sync, threadActivity, connection: 'connected', lastEventAt: 10,
            executionProtection: { state: 'blocked', nativeTurnId: 'private-old-turn', reason: 'goal-unknown' } } };
        for (const now of [1000, 86_400_000, 7 * 86_400_000]) {
          assert.equal(executionProtectionLabel(session), 'Execution continuing · execution protected');
          assert.equal(isSessionBusy(session), true); assert.equal(hasQueueBlockingRun(session), true);
          assert.equal(sessionRunOutcome(session), undefined, 'old terminal never becomes a new completion');
          const notice = runSyncNotice(session, now);
          if (sync === 'error') assert.equal(notice.errorLabel, 'Previous run history sync incomplete · thread still active');
          if (sync === 'syncing') assert.equal(notice.syncLabel, 'Syncing previous run history · thread still active');
        }
        for (const connection of ['disconnected'] as const) {
          const disconnected = { ...session, runtime: { ...session.runtime!, connection } };
          assert.notEqual(executionProtectionLabel(disconnected), 'Execution continuing · execution protected');
          assert.equal(isSessionBusy(disconnected), true);
        }
      }
});

test('known background terminal wait explains the queue fence without claiming recovery', () => {
  for (const phase of ['completed', 'failed', 'interrupted'] as const) for (const reason of [
    'Codex background terminals are still running',
    'Codex completed, but AgentOpsDeck could not load the final response: Codex background terminals are still running',
    'Codex failed, but AgentOpsDeck could not load the final response: Codex background terminals are still running',
    'Codex interrupted, but AgentOpsDeck could not load the final response: Codex background terminals are still running',
  ]) {
    const blocked: SessionSummary = { sessionKey: 'synthetic', title: 'Synthetic', status: 'idle', runStartedAt: 1,
      runtime: { phase, connection: 'connected', sync: 'error', threadActivity: 'idle', lastEventAt: 2,
        reason } };
    const notice = runSyncNotice(blocked, 9_000);
    assert.equal(notice.errorLabel, 'Run finished · background terminals still active');
    assert.equal(notice.backgroundLabel, 'Queue waiting for terminal cleanup');
    assert.equal(notice.animate, false);
    assert.equal(notice.elapsed, '');
    assert.equal(notice.incomplete, true);
    assert.equal(isSessionBusy(blocked), true, 'presentation must not relax the execution fence');
    assert.equal(sessionRunOutcome(blocked), undefined, 'no successful completion animation before verification');
    for (const patch of [
      { phase: 'running' as const }, { phase: 'unknown' as const }, { connection: 'disconnected' as const },
      { threadActivity: 'unknown' as const }, { sync: 'syncing' as const }, { sync: 'current' as const },
      { reason: 'private arbitrary provider error' }, { reason: 'Codex background terminals are still running: private detail' },
    ]) {
      const other = runSyncNotice({ ...blocked, runtime: { ...blocked.runtime!, ...patch } }, 9_000);
      assert.equal(other.backgroundLabel, undefined, JSON.stringify(patch));
      assert.notEqual(other.errorLabel, notice.errorLabel);
    }
  }
});

test('completion requires terminal current evidence, survives being read, and never masks newer work', () => {
  const session: SessionSummary = { sessionKey: 's', agentId: 'codex', title: 'Test', status: 'idle', runCompletedAt: 20,
    runtime: { phase: 'completed', sync: 'current', threadActivity: 'idle', connection: 'connected', lastEventAt: 20 } };
  assert.equal(sessionRunOutcome(session), 'completed');
  for (const phase of ['failed', 'interrupted'] as const) assert.equal(sessionRunOutcome({ ...session, runtime: { ...session.runtime!, phase } }), phase);
  for (const patch of [{ phase: 'running' }, { phase: 'unknown' }, { phase: 'idle' }, { sync: 'syncing' }, { sync: 'error' }, { connection: 'disconnected' }, { threadActivity: 'running' }, { threadActivity: 'unknown' }] as Partial<AgentRuntime>[]) {
    assert.equal(sessionRunOutcome({ ...session, runtime: { ...session.runtime!, ...patch } }), undefined);
  }
  const { runtime: _runtime, ...legacy } = session;
  assert.equal(sessionRunOutcome(legacy), 'completed');
  assert.equal(sessionRunOutcome({ ...legacy, runStartedAt: 21 }), undefined);
  const { runCompletedAt: _completed, ...fresh } = legacy;
  assert.equal(sessionRunOutcome(fresh), undefined);
});

test('idle admission never opens the queue dock, and unknown/sync errors are not a running task', () => {
  const session = { sessionKey: 'test', agentId: 'test', status: 'idle' } as SessionSummary;
  assert.equal(hasQueueBlockingRun(session), false);
  assert.equal(hasQueueBlockingRun({ ...session, status: 'running' }), true);
  for (const phase of ['completed', 'failed', 'interrupted', 'unknown'] as const) {
    assert.equal(hasQueueBlockingRun({ ...session, runtime: { phase, sync: 'error', threadActivity: 'idle', connection: 'connected', lastEventAt: 1 } }), false);
  }
  assert.equal(hasQueueBlockingRun({ ...session, runtime: { phase: 'completed', sync: 'current', threadActivity: 'running', connection: 'connected', lastEventAt: 1 } }), true);
});

test('queue controls require an active run and a versioned user message, independent of backlog size', () => {
  const message: ChatMessage = { id: 'queued', sessionKey: 'test', role: 'user', text: 'hello', createdAt: 1, status: 'queued', queueVersion: '1:1' };
  assert.equal(hasQueuedMessageControls(message, true), true);
  assert.equal(hasQueuedMessageControls(message, false), false);
  assert.equal(hasQueuedMessageControls({ ...message, queueVersion: undefined }, true), false);
  assert.equal(hasQueuedMessageControls({ ...message, role: 'assistant' }, true), false);
  assert.equal(hasQueuedMessageControls({ ...message, status: 'sent' }, true), false);
  for (const count of [1, 2, 5]) {
    assert.equal(Array.from({ length: count }, (_, id) => hasQueuedMessageControls({ ...message, id: String(id) }, true)).filter(Boolean).length, count);
  }
});

test('active model retry reason is visible without treating it as a final failure', () => {
  const active: SessionSummary = { sessionKey: 'codex:test', title: 'Test', status: 'running',
    runtime: { phase: 'running', connection: 'connected', sync: 'current', lastEventAt: 1, reason: 'Model connection interrupted · Codex is retrying…' } };
  assert.equal(runSyncNotice(active, 2).progressLabel, active.runtime!.reason);
  assert.equal(isSessionBusy(active), true);
  for (const phase of ['completed', 'failed', 'interrupted', 'unknown', 'waiting'] as const) {
    assert.equal(runSyncNotice({ ...active, runtime: { ...active.runtime!, phase } }, 2).progressLabel, undefined);
  }
});

const session: SessionSummary = { sessionKey: 'codex:test', title: 'Test', status: 'idle' };

for (const phase of ['running', 'waiting'] as const) test(`${phase} turn with unknown thread activity is queue-gated without a live timer`, () => {
  const unconfirmed: SessionSummary = { ...session, runStartedAt: 1_000,
    runtime: { phase, threadActivity: 'unknown', connection: 'connected', sync: 'current', lastEventAt: 3_000 } };
  assert.equal(isSessionBusy(unconfirmed), true);
  const notice = runSyncNotice(unconfirmed, 99_000);
  assert.equal(notice.animate, false); assert.equal(notice.elapsed, '');
  assert.equal(unconfirmed.runtime?.phase, phase);
});

for (const phase of ['completed', 'failed', 'interrupted'] as const) for (const threadActivity of ['idle', 'running', 'waiting', 'unknown'] as const) {
  test(`${phase} with thread ${threadActivity} keeps queue and notice independent of the previous timer`, () => {
    const finished: SessionSummary = { ...session, runStartedAt: 1_000, runCompletedAt: 2_000,
      runtime: { phase, threadActivity, connection: 'connected', sync: 'current', lastEventAt: 3_000 } };
    assert.equal(isSessionBusy(finished), threadActivity !== 'idle');
    const notice = runSyncNotice(finished, 99_000);
    assert.equal(notice.elapsed, '', 'never restart a terminal turn timer for unassociated native activity');
    assert.equal(notice.animate, threadActivity === 'running' || threadActivity === 'waiting');
    if (threadActivity === 'idle') assert.equal(notice.threadLabel, undefined);
    else assert.match(notice.threadLabel!, /Previous run finished/);
    assert.equal(finished.runtime?.phase, phase);
  });
}

test('only the actually applied message snapshot may skip an equal revision response', () => {
  const current = { sessionKey: 'one', loadedLimit: 120, revision: 'r1' };
  assert.equal(hasMessageSnapshotRevision(current, 'one', 120, 'r1'), true);
  assert.equal(hasMessageSnapshotRevision({ sessionKey: 'one', loadedLimit: 120 }, 'one', 120, 'r1'), false, 'cache miss after navigation is not an applied snapshot');
  assert.equal(hasMessageSnapshotRevision({ ...current, revision: undefined }, 'one', 120, 'r1'), false, 'selection-frozen mixed content is not authoritative');
  assert.equal(hasMessageSnapshotRevision(current, 'two', 120, 'r1'), false);
  assert.equal(hasMessageSnapshotRevision(current, 'one', 240, 'r1'), false);
  assert.equal(hasMessageSnapshotRevision(current, 'one', 120, 'r2'), false);
  assert.equal(hasMessageSnapshotRevision(current, 'one', 120, undefined), false);
});

test('execution truth takes precedence over the legacy idle badge for queue decisions', () => {
  for (const phase of ['starting', 'running', 'waiting', 'finalizing', 'unknown'] as const) {
    const runtime: AgentRuntime = { phase, connection: 'disconnected', sync: 'error', lastEventAt: 1 };
    assert.equal(isSessionBusy({ ...session, runtime }), true, phase);
  }
  assert.equal(isSessionBusy({ ...session, runtime: { phase: 'completed', connection: 'connected', sync: 'current', lastEventAt: 1 } }), false);
});

test('text selection freezes selected content but allows appended replies and unrelated updates', () => {
  const selected: ChatMessage = { id: 'one', sessionKey: session.sessionKey, role: 'assistant', text: 'copy this', createdAt: 1 };
  const other = { ...selected, id: 'two', text: 'working', createdAt: 2 };
  const reply = { ...selected, id: 'three', text: 'final response', createdAt: 3 };
  const incoming = [{ ...selected, text: 'reformatted' }, { ...other, text: 'updated' }, reply];
  const merged = mergeSelectedMessages([selected, other], incoming, new Set(['one']));
  assert.equal(merged[0], selected);
  assert.equal(merged[1]?.text, 'updated');
  assert.equal(merged[2], reply);
  assert.equal(mergeSelectedMessages(merged, incoming, new Set())[0]?.text, 'reformatted');
});

test('both browser reconnect and upstream connector status trigger snapshot catchup', () => {
  for (const type of ['stream.reset', 'stream.status'] as const) assert.equal(isStreamCatchup({ id: 'event', type, ts: 1, payload: {} }), true);
});

test('a finished run with incomplete sync is not displayed as an indefinitely running retry', () => {
  const finished: SessionSummary = { ...session, runStartedAt: 1_000, runtime: { phase: 'completed', sync: 'error', connection: 'connected', lastEventAt: 5_000 } };
  const notice = runSyncNotice(finished, 2_227_000);
  assert.equal(notice.errorLabel, 'Run finished · history sync incomplete');
  assert.equal(notice.elapsed, '');
  assert.equal(notice.animate, false);
  assert.equal(isSessionBusy(finished), true, 'queue remains protected until reconciliation');
  assert.match(runSyncNotice({ ...finished, runtime: { ...finished.runtime!, phase: 'unknown' } }, 2_227_000).errorLabel!, /run state unconfirmed/);
});

test('only execution shows the run timer, not final-history synchronization', () => {
  const running: SessionSummary = { ...session, runStartedAt: 1_000, runtime: { phase: 'running', sync: 'current', connection: 'connected', lastEventAt: 1_000 } };
  assert.equal(runSyncNotice(running, 8_000).elapsed, '7s');
  assert.equal(runSyncNotice({ ...running, runtime: { ...running.runtime!, phase: 'finalizing', sync: 'syncing' } }, 8_000).elapsed, '');
});

test('terminal history refresh is visible without blocking new input or pretending execution continues', () => {
  const finished: SessionSummary = { ...session, runStartedAt: 1_000,
    runtime: { phase: 'completed', sync: 'syncing', connection: 'connected', lastEventAt: 5_000 } };
  const notice = runSyncNotice(finished, 8_000);
  assert.equal(notice.syncLabel, 'Run finished · syncing history…');
  assert.equal(notice.animate, false);
  assert.equal(notice.elapsed, '');
  assert.equal(isSessionBusy(finished), false);
});

test('unknown or disconnected execution is queue-protected but never animated as confirmed running', () => {
  for (const phase of ['running', 'unknown'] as const) for (const connection of ['connected', 'disconnected'] as const) {
    if (phase === 'running' && connection === 'connected') continue;
    const uncertain: SessionSummary = { ...session, runStartedAt: 1_000,
      runtime: { phase, connection, sync: 'current', lastEventAt: 1_000 } };
    assert.equal(isSessionBusy(uncertain), true);
    assert.equal(runSyncNotice(uncertain, 3_360_000).elapsed, '');
    assert.equal(runSyncNotice(uncertain, 3_360_000).animate, false);
  }
});

test('history errors do not make confirmed execution unknown and disconnect cannot reopen a terminal', () => {
  const running: SessionSummary = { ...session,
    runtime: { phase: 'running', sync: 'error', connection: 'connected', lastEventAt: 1_000 } };
  assert.equal(runSyncNotice(running, 8_000).errorLabel, 'History sync incomplete');
  const finished: SessionSummary = { ...session,
    runtime: { phase: 'completed', sync: 'current', connection: 'disconnected', lastEventAt: 1_000 } };
  const notice = runSyncNotice(finished, 8_000);
  assert.equal(notice.connectionLabel, 'Agent connection lost · run finished');
  assert.equal(notice.animate, false);
  assert.equal(isSessionBusy(finished), false);
});

test('R19: optimistic active send immediately projects running presentation without relaxing real session guards', () => {
  const idleSession: SessionSummary = {
    ...session,
    status: 'idle',
    hasActiveRun: false,
    runCompletedAt: 5_000,
    runtime: { phase: 'completed', threadActivity: 'idle', sync: 'current', connection: 'connected', lastEventAt: 5_000 },
  };
  const outgoing = {
    id: 'local:1',
    sessionKey: idleSession.sessionKey,
    role: 'user' as const,
    text: 'hello',
    createdAt: 10_000,
    status: 'sending' as const,
  };

  assert.equal(hasOptimisticActiveSend(idleSession, false, [outgoing], 10_500), true);
  const projected = withOptimisticRunningState(idleSession, true, outgoing.createdAt);
  assert.equal(projected.status, 'running');
  assert.equal(projected.hasActiveRun, true);
  assert.equal(projected.runtime?.phase, 'starting');
  assert.equal(projected.runtime?.threadActivity, 'running');
  assert.equal(runSyncNotice(projected, 13_000).elapsed, '3s');
  // Real session remains idle until server confirms
  assert.equal(isSessionBusy(idleSession), false);
});

test('formatElapsedDuration and runSyncNotice convert elapsed seconds to m and h units', () => {
  assert.equal(formatElapsedDuration(0), '0s');
  assert.equal(formatElapsedDuration(59), '59s');
  assert.equal(formatElapsedDuration(60), '1m');
  assert.equal(formatElapsedDuration(95), '1m 35s');
  assert.equal(formatElapsedDuration(3600), '1h');
  assert.equal(formatElapsedDuration(3930), '1h 5m');

  const running: SessionSummary = {
    ...session,
    runStartedAt: 1_000,
    runtime: { phase: 'running', sync: 'current', connection: 'connected', lastEventAt: 1_000 },
  };
  assert.equal(runSyncNotice(running, 96_000).elapsed, '1m 35s');
  assert.equal(runSyncNotice(running, 3_931_000).elapsed, '1h 5m');
});
