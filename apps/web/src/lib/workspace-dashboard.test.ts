import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionSummary } from '@agentopsdeck/shared';
import { overviewLabel, overviewState, overviewSessions, summarizeDashboardTokens } from './workspace-dashboard.js';
import { sessionPresentation, sessionSyncIssueLabel } from './session-presentation.js';
import { hasQueueBlockingRun, isSessionBusy } from './live-session.js';
const base: SessionSummary = { sessionKey: 'session', title: 'Example', status: 'idle', runtime: {
  phase: 'completed', threadActivity: 'idle', connection: 'connected', sync: 'current', lastEventAt: 1 } };
test('dashboard execution state distinguishes active, completed, idle and unconfirmed history', () => {
  assert.equal(overviewState(base), 'completed');
  const { runtime: _runtime, ...legacy } = base;
  assert.equal(overviewState(legacy), 'idle');
  for (const phase of ['starting', 'running', 'waiting', 'finalizing'] as const) assert.equal(overviewState({ ...base, runtime: { ...base.runtime!, phase } }), 'run');
  for (const phase of ['failed', 'unknown'] as const) assert.equal(overviewState({ ...base, runtime: { ...base.runtime!, phase } }), 'attention');
  assert.equal(overviewState({ ...base, runtime: { ...base.runtime!, phase: 'interrupted' } }), 'idle');
  for (const patch of [{ connection: 'disconnected' }, { sync: 'error' }, { sync: 'syncing' }, { threadActivity: 'unknown' }] as const)
    assert.equal(overviewState({ ...base, runtime: { ...base.runtime!, ...patch } }), 'attention');
  assert.equal(overviewState({ ...base, runtime: { ...base.runtime!, phase: 'running', sync: 'syncing' } }), 'run', 'history reads do not replace active execution');
  assert.equal(overviewState({ ...base, runtime: { ...base.runtime!, phase: 'running', connection: 'disconnected' } }), 'attention');
});
test('dashboard preserves connected execution and exposes sync or protection separately', () => {
  for (const patch of [{ phase: 'running', sync: 'error' }, { phase: 'failed', threadActivity: 'running', sync: 'error' },
    { phase: 'running', executionProtection: { state: 'blocked', reason: 'native-unavailable', nativeTurnId: 't' } }] as const) {
    const active = { ...base, runtime: { ...base.runtime!, ...patch } };
    assert.equal(overviewState(active), 'run');
    assert.match(overviewLabel(active), /^Running · /);
  }
  const interrupted = { ...base, runtime: { ...base.runtime!, phase: 'interrupted' as const } };
  assert.equal(overviewLabel(interrupted), 'Interrupted');
  const protectedInterrupted = { ...interrupted, runtime: { ...interrupted.runtime,
    executionProtection: { state: 'blocked' as const, reason: 'cleanup-unconfirmed' as const, nativeTurnId: 't' } } };
  assert.equal(overviewState(protectedInterrupted), 'attention');
  assert.equal(overviewLabel(protectedInterrupted), 'Tool cleanup unconfirmed · execution protected');
  const missingActivity = { ...interrupted.runtime }; delete missingActivity.threadActivity;
  assert.equal(overviewState({ ...interrupted, runtime: missingActivity }), 'attention');
  assert.equal(overviewLabel({ ...base, runtime: { ...base.runtime!, sync: 'error' } }), 'History sync interrupted');
});
test('dashboard does not expose hidden/archived sessions; duplicates use latest authorized metadata', () => {
  const updated = { ...base, title: 'Latest' };
  assert.deepEqual(overviewSessions([base, { ...base, sessionKey: 'hidden', hidden: true }, { ...base, sessionKey: 'archive', archived: true }, updated]), [updated]);
  assert.deepEqual(overviewSessions([]), []);
  assert.deepEqual(overviewSessions([base, { ...base, hidden: true }]), [], 'latest hidden metadata supersedes an older visible entry');
});
test('unknown execution evidence agrees across session and dashboard without releasing guards', () => {
  const runtimes = [
    ...(['starting', 'running', 'waiting', 'finalizing'] as const).map(phase => ({
      ...base.runtime!, phase, threadActivity: 'unknown' as const,
    })),
    ...(['running', 'waiting'] as const).map(threadActivity => ({
      ...base.runtime!, phase: 'unknown' as const, threadActivity,
    })),
  ];
  for (const runtime of runtimes) {
    for (const sync of ['current', 'syncing'] as const) {
      const uncertain = { ...base, runtime: { ...runtime, sync } };
      assert.deepEqual(sessionPresentation(uncertain), { state: 'error', label: 'Execution status unconfirmed' });
      assert.equal(overviewState(uncertain), 'attention');
      assert.equal(overviewLabel(uncertain), 'Execution status unconfirmed');
      assert.equal(sessionSyncIssueLabel(uncertain), 'Execution status unconfirmed');
      assert.equal(hasQueueBlockingRun(uncertain), true);
      assert.equal(isSessionBusy(uncertain), true);
    }
  }
});

test('summarizeDashboardTokens aggregates known session tokens by runtime and ignores hidden/unknown', () => {
  const s1: SessionSummary = { ...base, sessionKey: 's1', agentId: 'codex', inputTokens: 1200, outputTokens: 300 };
  const s2: SessionSummary = { ...base, sessionKey: 's2', agentId: 'ghcp', nativeUsage: { scope: 'last-turn', inputTokens: 500, outputTokens: 100 } };
  const sHidden: SessionSummary = { ...base, sessionKey: 's3', hidden: true, inputTokens: 9999, outputTokens: 9999 };
  const summary = summarizeDashboardTokens([s1, s2, sHidden]);
  assert.equal(summary.countedSessions, 2);
  assert.equal(summary.totalInput, 1700);
  assert.equal(summary.totalOutput, 400);
  assert.equal(summary.groups.length, 2);
});

test('summarizeDashboardTokens supports multi-dimension aggregation (env, tag, group, layout) and built-in GHCP credit estimation', () => {
  const s1: SessionSummary = {
    ...base,
    sessionKey: 'prod-env:s1',
    agentId: 'ghcp',
    model: 'gpt-4o',
    inputTokens: 1_000_000,
    outputTokens: 200_000,
  };
  const s2: SessionSummary = {
    ...base,
    sessionKey: 'dev-env:s2',
    agentId: 'codex',
    model: 'gpt-5',
    inputTokens: 500_000,
    outputTokens: 100_000,
  };

  const byAgent = summarizeDashboardTokens([s1, s2], { dimension: 'agent' });
  assert.equal(byAgent.dimension, 'agent');
  assert.ok(byAgent.totalGhcpCredits > 0, 'GHCP credits are auto-estimated out of the box');
  assert.ok(byAgent.totalEstimatedCredits >= byAgent.totalGhcpCredits);

  const byEnv = summarizeDashboardTokens([s1, s2], { dimension: 'env' });
  assert.equal(byEnv.groups.length, 2);
  assert.ok(byEnv.groups.some(g => g.label === 'prod-env'));
  assert.ok(byEnv.groups.some(g => g.label === 'dev-env'));

  const byTag = summarizeDashboardTokens([s1, s2], {
    dimension: 'tag',
    preferences: {
      revision: 1,
      sessions: {
        [s1.sessionKey]: { tags: ['frontend', 'release'], groupId: 'g-core' },
        [s2.sessionKey]: { tags: ['release'], groupId: 'g-infra' },
      },
      groups: [{ id: 'g-core', name: 'Core Team' }, { id: 'g-infra', name: 'Infra' }],
    },
  });
  const releaseTag = byTag.groups.find(g => g.label === '#release');
  assert.ok(releaseTag);
  assert.equal(releaseTag.sessions, 2);
  assert.equal(releaseTag.inputTokens, 1_500_000);

  const byGroup = summarizeDashboardTokens([s1, s2], {
    dimension: 'group',
    preferences: {
      revision: 1,
      sessions: {
        [s1.sessionKey]: { tags: [], groupId: 'g-core' },
      },
      groups: [{ id: 'g-core', name: 'Core Team' }],
    },
  });
  assert.ok(byGroup.groups.some(g => g.label === 'Core Team'));
  assert.ok(byGroup.groups.some(g => g.label === 'Ungrouped'));
});
