import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMessage, SessionSummary } from '@agentopsdeck/shared';
import { completedReplyId, hasInvalidCompletedReply, sessionPresentation, sessionSyncIssueLabel } from './session-presentation.js';
import { isSessionBusy, runSyncNotice } from './live-session.js';
const session: SessionSummary = { sessionKey: 's', agentId: 'codex', title: 'Test', status: 'idle', runStartedAt: 10, runCompletedAt: 20,
  runtime: { turnId: 't', phase: 'completed', sync: 'current', threadActivity: 'idle', connection: 'connected', lastEventAt: 20 } };
const reply: ChatMessage = { sessionKey: 's', id: 'reply', role: 'assistant', text: 'Finished', createdAt: 19, turnId: 't', phase: 'final_answer' };
test('invalid final output does not decorate an earlier answer or alter execution completion', () => {
  const invalid = { ...reply, id: 'invalid', text: '<end_of_image>'.repeat(32) };
  assert.equal(hasInvalidCompletedReply(session, [reply, invalid]), true);
  assert.equal(completedReplyId(session, [reply, invalid]), undefined);
  assert.equal(sessionPresentation(session).state, 'completed');
  assert.equal(isSessionBusy(session), false);
  assert.equal(hasInvalidCompletedReply(session, [invalid, reply]), false);
  assert.equal(completedReplyId(session, [invalid, reply]), reply.id);
});
test('invalid output from a previous turn or unsettled history cannot replace current progress', () => {
  const invalid = { ...reply, id: 'invalid', text: '<end_of_image>', turnId: 'previous' };
  assert.equal(hasInvalidCompletedReply(session, [invalid]), false);
  for (const patch of [{ phase: 'running', threadActivity: 'running' }, { sync: 'error' }, { sync: 'syncing' }] as Partial<NonNullable<SessionSummary['runtime']>>[]) {
    assert.equal(hasInvalidCompletedReply({ ...session, runtime: { ...session.runtime!, ...patch } }, [{ ...invalid, turnId: 't' }]), false);
  }
  assert.equal(hasInvalidCompletedReply(session, [{ ...invalid, turnId: 't', phase: 'commentary' }]), false);
});
test('terminal syncing is pending, but errors, disconnection and unknown activity stay visible', () => {
  for (const phase of ['completed', 'failed', 'interrupted'] as const) {
    const pending: SessionSummary = { ...session, runtime: { ...session.runtime!, phase, sync: 'syncing',
      executionProtection: { state: 'blocked', nativeTurnId: 't', reason: 'native-unavailable' } } };
    assert.equal(sessionPresentation(pending).state, 'neutral');
    assert.equal(runSyncNotice(pending, 30000).errorLabel, undefined);
    assert.equal(completedReplyId(pending, [reply]), undefined);
    assert.equal(isSessionBusy(pending), true);
    assert.equal(sessionPresentation(pending, false, 'HTTP 503').state, 'error');
    for (const patch of [{ sync: 'error' }, { connection: 'disconnected' }, { threadActivity: 'unknown' }] as Partial<NonNullable<SessionSummary['runtime']>>[]) {
      assert.equal(sessionPresentation({ ...pending, runtime: { ...pending.runtime!, ...patch } }).state, 'error');
    }
  }
});
test('settled history explains an unavailable proof without claiming an active check or idle execution', () => {
  for (const [reason, label] of [
    ['goal-unknown', 'Native goal status unavailable · execution protected'],
    ['native-unavailable', 'Native execution status unavailable · execution protected'],
    ['cleanup-unconfirmed', 'Tool cleanup unconfirmed · execution protected'],
  ] as const) {
    const protectedSession: SessionSummary = { ...session, runtime: { ...session.runtime!,
      executionProtection: { state: 'blocked', nativeTurnId: 't', reason } } };
    assert.deepEqual(sessionPresentation(protectedSession), { state: 'error', label });
    assert.equal(runSyncNotice(protectedSession, 30000).errorLabel, label);
    assert.equal(runSyncNotice(protectedSession, 30000).animate, false);
    assert.equal(isSessionBusy(protectedSession), true);
  }
});
test('uncertain execution retains specific transport, protection and compaction reasons', () => {
  const uncertain: SessionSummary = { ...session, runtime: { ...session.runtime!, phase: 'running', threadActivity: 'unknown' } };
  for (const [patch, label] of [
    [{ sync: 'error' }, 'History sync interrupted'],
    [{ connection: 'disconnected' }, 'Connector disconnected'],
    [{ executionProtection: { state: 'blocked', nativeTurnId: 't', reason: 'native-unavailable' } }, 'Native execution status unavailable · execution protected'],
    [{ operation: 'compact', phase: 'unknown' }, 'Compaction outcome unconfirmed · not retried'],
  ] as const) {
    const changed = { ...uncertain, runtime: { ...uncertain.runtime!, ...patch } };
    assert.equal(sessionPresentation(changed).state, 'error');
    assert.equal(sessionPresentation(changed).label, label);
  }
  assert.equal(sessionPresentation(uncertain, false, 'HTTP 503').label, 'Latest messages unavailable');
  const oldTerminal = { ...session, runtime: { ...session.runtime!, threadActivity: 'unknown' as const } };
  assert.equal(sessionPresentation(oldTerminal, true).label, 'Execution status unconfirmed');
  const legacyRuntime = { ...uncertain.runtime! }; delete legacyRuntime.threadActivity;
  assert.equal(sessionPresentation({ ...uncertain, runtime: legacyRuntime }).state, 'running', 'missing legacy activity is not explicit unknown');
});
test('native execution protection is not a history transport error or a running task', () => {
  const protectedSession: SessionSummary = { ...session, runtime: { ...session.runtime!,
    executionProtection: { state: 'blocked', nativeTurnId: 'native-successor', reason: 'goal-blocked' } } };
  assert.deepEqual(sessionPresentation(protectedSession), { state: 'completed', label: 'Done' });
  assert.deepEqual(sessionPresentation(protectedSession, true), { state: 'unread', label: 'Done · unread' });
  assert.equal(completedReplyId(protectedSession, [reply]), 'reply');
  assert.equal(isSessionBusy(protectedSession), true, 'keep conservative input/stop guards');
  const notice = runSyncNotice(protectedSession, 30000);
  assert.equal(notice.incomplete, false);
  assert.equal(notice.errorLabel, undefined);
  assert.equal(notice.goalLabel, 'Long-term goal paused');
  assert.equal(notice.animate, false);
  assert.equal(notice.elapsed, '');
  assert.equal(sessionPresentation(protectedSession, false, 'HTTP 503').label, 'Latest messages unavailable');
  assert.equal(protectedSession.runtime?.turnId, 't');
  const restarting: SessionSummary = { ...protectedSession, runtime: { ...protectedSession.runtime!, sync: 'syncing' } };
  assert.deepEqual(sessionPresentation(restarting), { state: 'neutral', label: 'Run finished · syncing history…' });
  assert.equal(runSyncNotice(restarting, 30000).errorLabel, undefined);
  assert.equal(runSyncNotice(restarting, 30000).syncLabel, 'Run finished · syncing history…');
  assert.equal(isSessionBusy(restarting), true);
});
test('goal waiting presentation never hides failed, uncertain, active or disconnected state', () => {
  const base: SessionSummary = { ...session, runtime: { ...session.runtime!,
    executionProtection: { state: 'blocked', nativeTurnId: 't', reason: 'goal-blocked' } } };
  for (const patch of [
    { sync: 'error' }, { sync: 'syncing' }, { connection: 'disconnected' }, { operation: 'compact' },
    { phase: 'unknown' }, { phase: 'failed' }, { phase: 'running' }, { phase: 'interrupted' },
    { threadActivity: 'unknown' }, { threadActivity: 'running' }, { threadActivity: 'waiting' }, { threadActivity: undefined },
    { executionProtection: { state: 'blocked', nativeTurnId: 't', reason: 'cleanup-unconfirmed' } },
  ] as Partial<NonNullable<SessionSummary['runtime']>>[]) {
    const changed = { ...base, runtime: { ...base.runtime!, ...patch } };
    assert.equal(runSyncNotice(changed, 30000).goalLabel, undefined, JSON.stringify(patch));
    const running = patch.phase === 'running' || patch.threadActivity === 'running' || patch.threadActivity === 'waiting';
    assert.equal(sessionPresentation(changed).state, running ? 'running' : patch.sync === 'syncing' ? 'neutral' : 'error', JSON.stringify(patch));
    assert.equal(isSessionBusy(changed), true, 'presentation must not unlock execution');
  }
  assert.deepEqual(sessionPresentation(base, false, 'HTTP 503'), { state: 'error', label: 'Latest messages unavailable' });
  assert.equal(completedReplyId(base, [reply]), 'reply', 'completed turn is independent of the paused goal');
});
test('running evidence survives sync errors without releasing execution protection or showing old completion', () => {
  for (const phase of ['starting', 'running', 'waiting', 'finalizing'] as const) {
    const active: SessionSummary = { ...session, runtime: { ...session.runtime!, phase,
      executionProtection: { state: 'blocked', nativeTurnId: 'successor', reason: 'native-unavailable' } } };
    for (const [sync, error, label] of [
      ['error', undefined, 'Running · history sync interrupted'],
      ['current', 'HTTP 503', 'Running · latest messages unavailable'],
      ['current', undefined, 'Running · execution protected'],
    ] as const) {
      const snapshot = { ...active, runtime: { ...active.runtime!, sync } };
      const before = JSON.stringify(snapshot);
      assert.deepEqual(sessionPresentation(snapshot, true, error), { state: 'running', label });
      assert.equal(isSessionBusy(snapshot), true);
      assert.equal(completedReplyId(snapshot, [reply]), undefined);
      assert.equal(JSON.stringify(snapshot), before, 'presentation does not mutate authority');
      if (sync === 'error') assert.equal(sessionSyncIssueLabel(snapshot, error), 'History sync interrupted');
      else if (error) assert.equal(sessionSyncIssueLabel(snapshot, error), 'Latest messages unavailable');
    }
  }
  const successor: SessionSummary = { ...session, runtime: { ...session.runtime!, phase: 'failed', sync: 'error', threadActivity: 'running' } };
  assert.equal(sessionPresentation(successor).state, 'running', 'native successor can outlive failed owned turn');
  for (const patch of [{ connection: 'disconnected' }, { phase: 'unknown' }, { threadActivity: 'unknown' }, { operation: 'compact' }] as const)
    assert.equal(sessionPresentation({ ...successor, runtime: { ...successor.runtime!, ...patch } }).state, 'error');
  const missingActivity = { ...successor.runtime! }; delete missingActivity.threadActivity;
  assert.equal(sessionPresentation({ ...successor, runtime: missingActivity }).state, 'error', 'old failure alone is not running evidence');
  assert.equal(sessionPresentation({ ...session, runtime: { ...session.runtime!, phase: 'running', sync: 'syncing' } }).label, 'Running · syncing history…');
});

test('completed owned turn with active native Goal shows running and current history without unlocking execution', () => {
  for (const reason of ['goal-active', 'goal-unknown', 'background-work'] as const) {
    const continuing: SessionSummary = { ...session, runtime: { ...session.runtime!, phase: 'completed',
      sync: 'current', threadActivity: 'running',
      executionProtection: { state: 'blocked', nativeTurnId: 'successor', reason } } };
    const before = JSON.stringify(continuing);
    assert.deepEqual(sessionPresentation(continuing), { state: 'running', label: 'Running · execution protected' });
    assert.equal(sessionSyncIssueLabel(continuing), undefined);
    assert.equal(completedReplyId(continuing, [reply]), undefined);
    assert.equal(isSessionBusy(continuing), true);
    assert.equal(JSON.stringify(continuing), before);
  }
});
test('presentation distinguishes unread/read completion, execution, transport failure and neutral idle', () => {
  assert.equal(sessionPresentation(session, true).state, 'unread');
  assert.equal(sessionPresentation(session).state, 'completed');
  assert.deepEqual(sessionPresentation(session, false, 'HTTP 503'), { state: 'error', label: 'Latest messages unavailable' });
  assert.equal(sessionPresentation({ ...session, runtime: { ...session.runtime!, phase: 'running' } }).state, 'running');
  assert.equal(sessionPresentation({ ...session, runtime: { ...session.runtime!, phase: 'failed' } }).label, 'Run failed');
  assert.equal(sessionPresentation({ ...session, runtime: { ...session.runtime!, sync: 'error' } }).label, 'History sync interrupted');
  assert.equal(sessionPresentation({ ...session, runtime: { ...session.runtime!, phase: 'interrupted' } }).state, 'neutral');
  assert.equal(sessionPresentation({ sessionKey: 'new', agentId: 'hermes', title: 'New', status: 'idle' }).state, 'neutral');
  assert.deepEqual(sessionPresentation({ sessionKey: 'antigravity:new', agentId: 'antigravity', title: 'New', status: 'unknown' }), {
    state: 'error', label: 'Agent runtime not ready',
  });
});
test('only the last completed root reply is highlighted; queued followups do not hide it', () => {
  assert.equal(completedReplyId(session, [reply]), 'reply');
  assert.equal(completedReplyId(session, [reply, { ...reply, id: 'queued', role: 'user', status: 'queued' }]), 'reply');
  for (const patch of [{ phase: 'commentary' }, { parentToolUseId: 'child' }, { toolName: 'exec' }, { turnId: 'old' }, { text: 'NO_REPLY' }] as Partial<ChatMessage>[]) {
    assert.equal(completedReplyId(session, [{ ...reply, ...patch }]), undefined);
  }
  assert.equal(completedReplyId(session, [reply, { ...reply, role: 'user', id: 'new-user' }]), undefined);
});
test('no stale final during run/sync/failed, legacy timestamps guard earlier replies', () => {
  for (const phase of ['running', 'failed', 'interrupted'] as const) assert.equal(completedReplyId({ ...session, runtime: { ...session.runtime!, phase } }, [reply]), undefined);
  assert.equal(completedReplyId({ ...session, runtime: { ...session.runtime!, sync: 'syncing' } }, [reply]), undefined);
  const legacy = { ...session }; delete legacy.runtime;
  assert.equal(completedReplyId(legacy, [{ ...reply, createdAt: 9 }]), undefined);
  assert.equal(completedReplyId(legacy, [reply]), 'reply');
});
