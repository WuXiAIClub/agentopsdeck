import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRuntime, SessionSummary } from '@agentopsdeck/shared';
import { executionFailureLabel, hasQueueBlockingRun, isSessionBusy, runSyncNotice, sessionRunOutcome } from './live-session.js';
import { sessionPresentation, sessionSyncIssueLabel } from './session-presentation.js';
import { translateMessage } from './translations.js';

function session(patch: Partial<AgentRuntime> = {}): SessionSummary {
  return { sessionKey: 'codex:synthetic', title: 'Synthetic', status: 'failed', runStartedAt: 1, runCompletedAt: 2,
    runtime: { turnId: 'turn', phase: 'failed', threadActivity: 'idle', connection: 'connected', sync: 'current', lastEventAt: 2, ...patch } };
}

test('verified failed execution permits continuation without a processing timer', () => {
  const finished = session();
  assert.equal(isSessionBusy(finished), false);
  assert.equal(hasQueueBlockingRun(finished), false);
  assert.equal(sessionRunOutcome(finished), 'failed');
  const notice = runSyncNotice(finished, 86_400_000);
  assert.equal(notice.executionLabel, 'Execution failed · ready for your next message');
  assert.deepEqual(notice.detailLabels, []);
  assert.equal(notice.animate, false);
  assert.equal(notice.elapsed, '');
});

test('failure outcome and final-history failure remain separately visible and protected', () => {
  const failedHistory = session({ sync: 'error' });
  const notice = runSyncNotice(failedHistory, 86_400_000);
  assert.equal(notice.executionLabel, 'Execution failed');
  assert.deepEqual(notice.detailLabels, ['Run finished · history sync incomplete']);
  assert.equal(sessionSyncIssueLabel(failedHistory, 'Synthetic read failure'), 'History sync incomplete · latest messages unavailable');
  assert.equal(isSessionBusy(failedHistory), true);
  assert.equal(notice.elapsed, '');
  assert.equal(notice.animate, false);
});

test('structured background protection is not mislabeled as execution or transport activity', () => {
  for (const sync of ['current', 'error'] as const) {
    const unfinished = session({ phase: 'completed', sync,
      executionProtection: { state: 'blocked', nativeTurnId: 'turn', reason: 'background-work' } });
    const notice = runSyncNotice(unfinished, 86_400_000);
    assert.equal(notice.executionLabel, undefined);
    assert.equal(notice.backgroundWorkLabel, 'Background work unfinished · execution protected');
    assert.deepEqual(notice.detailLabels, sync === 'error'
      ? ['Background work unfinished · execution protected', 'Run finished · history sync incomplete']
      : ['Background work unfinished · execution protected']);
    assert.equal(sessionPresentation(unfinished).label, notice.backgroundWorkLabel);
    assert.equal(isSessionBusy(unfinished), true);
    assert.equal(notice.animate, false);
    assert.equal(notice.elapsed, '');
  }
});

test('latest-message fetch failure stays visible independently of verified outcome and background work', () => {
  const notice = runSyncNotice(session({ sync: 'error',
    executionProtection: { state: 'blocked', nativeTurnId: 'turn', reason: 'background-work' } }), 1_000, true);
  assert.equal(notice.executionLabel, 'Execution failed');
  assert.deepEqual(notice.detailLabels, ['Background work unfinished · execution protected',
    'Run finished · history sync incomplete', 'Latest messages unavailable']);
  assert.equal(runSyncNotice(session(), 1_000, true).executionLabel, 'Execution failed · ready for your next message');
});

test('failed execution with background work displays both facts without offering continuation', () => {
  const unfinished = session({ sync: 'error', reason: 'Codex failed, but AgentOpsDeck could not load the final response: Codex background terminals are still running' });
  const notice = runSyncNotice(unfinished, 86_400_000);
  assert.equal(notice.executionLabel, 'Execution failed');
  assert.deepEqual(notice.detailLabels, ['Background work unfinished · execution protected']);
  assert.equal(isSessionBusy(unfinished), true);
});

test('nonretry error is an unconfirmed outcome, never terminal evidence or a continuing execution spinner', () => {
  const active = session({ phase: 'running', threadActivity: 'running', reason: 'Codex reported an error · waiting for final run status' });
  for (const now of [1_000, 86_400_000, 7 * 86_400_000]) {
    const before = JSON.stringify(active);
    const notice = runSyncNotice(active, now);
    assert.equal(notice.executionLabel, 'Execution reported an error · outcome unconfirmed');
    assert.equal(sessionPresentation(active).label, notice.executionLabel);
    assert.equal(notice.animate, false);
    assert.equal(notice.elapsed, '');
    assert.equal(isSessionBusy(active), true);
    assert.equal(sessionRunOutcome(active), undefined);
    assert.equal(JSON.stringify(active), before);
  }
  const retrying = session({ phase: 'running', threadActivity: 'running', reason: 'Model connection interrupted · Codex is retrying…' });
  assert.equal(executionFailureLabel(retrying), undefined);
  assert.equal(runSyncNotice(retrying, 1_000).animate, true);
});

test('previous failure cannot hide active successor or its history failure', () => {
  const successor = session({ threadActivity: 'running', sync: 'error' });
  const notice = runSyncNotice(successor, 86_400_000);
  assert.equal(notice.executionLabel, 'Previous execution failed');
  assert.deepEqual(notice.detailLabels, ['Previous run history sync incomplete · thread still active', 'Previous run finished · thread still active']);
  assert.equal(sessionPresentation(successor).state, 'running');
  assert.equal(hasQueueBlockingRun(successor), true);
  assert.equal(sessionRunOutcome(successor), undefined);
});

test('disconnection, unknown state and cleanup cannot become ready just by aging', () => {
  for (const patch of [
    { connection: 'disconnected' }, { threadActivity: 'unknown' }, { sync: 'syncing' },
    { executionProtection: { state: 'blocked', nativeTurnId: 'turn', reason: 'cleanup-unconfirmed' } },
    { phase: 'unknown', sync: 'error', reason: 'Codex dispatch outcome is unknown' },
  ] as Partial<AgentRuntime>[]) {
    const protectedSession = session(patch);
    for (const now of [1_000, 7 * 86_400_000]) {
      assert.notEqual(runSyncNotice(protectedSession, now).executionLabel, 'Execution failed · ready for your next message');
      assert.equal(sessionRunOutcome(protectedSession), undefined);
      assert.equal(runSyncNotice(protectedSession, now).animate, false);
    }
  }
  const compacting = session({ operation: 'compact' });
  assert.equal(executionFailureLabel(compacting), undefined);
  assert.equal(sessionPresentation(compacting).label, 'Compaction failed');
  const legacy = session();
  delete legacy.runtime!.threadActivity;
  assert.equal(executionFailureLabel(legacy), 'Execution failed');
});

test('lifecycle stage labels have distinct Chinese translations', () => {
  for (const [label, expected] of [
    ['Execution failed', '执行失败'],
    ['Execution failed · ready for your next message', '执行失败 · 可以继续发送消息'],
    ['Execution reported an error · outcome unconfirmed', '执行报错 · 正在核实是否结束'],
    ['Background work unfinished · execution protected', '后台工作未结束 · 执行受保护'],
    ['Run finished · history sync incomplete', '执行已结束 · 历史同步失败'],
    ['History sync interrupted', '历史同步失败'],
    ['History sync incomplete · run state unconfirmed', '历史同步失败 · 执行状态待核实'],
  ] as const) {
    assert.equal(translateMessage(label, 'zh-CN'), expected);
    assert.equal(translateMessage(label, 'en'), label);
  }
});
