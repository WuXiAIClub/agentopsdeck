import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMessage, SessionSummary } from '@agentopsdeck/shared';
import { codexSubagents, computeSwarmSummary, formatSubagentLabel, hasActiveOrAttentionSubagents, observedSpan } from './codex-subagents.js';
const session = { sessionKey: 's', runtime: { turnId: 'turn', phase: 'running', sync: 'current', connection: 'connected' } } as SessionSummary;
const observation = { action: 'wait' as const, source: 'live' as const, observedAt: 1000, agents: [{ id: 'child', status: 'running' as const }], task: 'Review <script> safely' };
const call: ChatMessage = { id: 'call', sessionKey: 's', turnId: 'turn', role: 'tool', toolCallId: 'wait1', toolPhase: 'call',
  status: 'sending', text: 'preview', createdAt: 1000, codexSubagent: observation };
test('pending native wait shows separate receipt time and last child state', () => {
  const state = codexSubagents(session, [call]);
  assert.equal(state.waiting, true); assert.equal(state.waitObservedAt, 1000);
  assert.equal(observedSpan(state.children[0]!, state.active, 7000), 6);
  assert.equal(state.children[0]?.task, 'Review <script> safely');
});
test('wait result stops waiting, but never completes a running child', () => {
  const result: ChatMessage = { ...call, id: 'result', toolPhase: 'result', status: 'sent', createdAt: 3000,
    codexSubagent: { ...observation, observedAt: 3000 } };
  const state = codexSubagents(session, [result, call]);
  assert.equal(state.waiting, false); assert.equal(state.children[0]?.status, 'running');
});
test('foreign sessions, child-owned tools and old turns cannot mark parent waiting', () => {
  for (const change of [{ sessionKey: 'other' }, { turnId: 'old' }, { parentToolUseId: 'nested' }]) {
    const state = codexSubagents(session, [{ ...call, ...change }]);
    assert.equal(state.waiting, false); assert.equal(state.children.length, 0);
  }
});
test('disconnection, failed history and ended parent freeze observed span, no live wait', () => {
  for (const [runtime, stale] of [[{ connection: 'disconnected' }, false], [{ sync: 'error' }, false], [{ phase: 'completed' }, false], [{}, true]] as const) {
    const state = codexSubagents({ ...session, runtime: { ...session.runtime!, ...runtime } }, [call], stale);
    assert.equal(state.waiting, false); assert.equal(observedSpan(state.children[0]!, state.active, 9000), 0);
  }
});
test('history fallback never uses synthetic message timestamps as real start', () => {
  const state = codexSubagents(session, [{ ...call, codexSubagent: { ...observation, source: 'history' } }]);
  assert.equal(state.waiting, true); assert.equal(state.waitObservedAt, undefined);
  assert.equal(observedSpan(state.children[0]!, state.active, 9999), undefined);
});
test('explicit terminal report freezes timer; a later unknown activity resets stale completion', () => {
  const ended: ChatMessage = { ...call, id: 'ended', toolPhase: 'result', createdAt: 3000,
    codexSubagent: { ...observation, observedAt: 3000, agents: [{ id: 'child', status: 'completed' }] } };
  let state = codexSubagents(session, [call, ended]);
  assert.equal(observedSpan(state.children[0]!, true, 9000), 2);
  const resumed: ChatMessage = { ...call, id: 'new', createdAt: 7000, codexSubagent: { ...observation, action: 'interacted', observedAt: 7000, agents: [{ id: 'child', status: 'unknown' }] } };
  state = codexSubagents(session, [call, ended, resumed]);
  assert.equal(state.children[0]?.status, 'unknown'); assert.equal(state.children[0]?.firstObservedAt, 7000);
});

test('newer historical evidence drops live timing rather than extending an unverifiable span', () => {
  const history: ChatMessage = { ...call, id: 'history', createdAt: 3000, toolPhase: 'result',
    codexSubagent: { action: 'wait', source: 'history', agents: [{ id: 'child', status: 'running' }] } };
  const state = codexSubagents(session, [call, history]);
  assert.equal(state.children[0]?.task, observation.task);
  assert.equal(observedSpan(state.children[0]!, state.active, 9000), undefined);
});

test('observations are bounded and activity carries its action without inventing a task', () => {
  const agents = Array.from({ length: 50 }, (_, i) => ({ id: `child-${i}`, status: 'unknown' as const }));
  const state = codexSubagents(session, [{ ...call, codexSubagent: { action: 'interacted', source: 'history', agents } }]);
  assert.equal(state.children.length, 32);
  assert.equal(state.children[0]?.action, 'interacted');
  assert.equal(state.children[0]?.task, undefined);
});

test('computeSwarmSummary tracks effort level, completion ratio, and parallel activity', () => {
  const m1: ChatMessage = { ...call, id: 'm1', createdAt: 1000, codexSubagent: {
    action: 'spawnAgent', source: 'live', observedAt: 1000,
    agents: [
      { id: 'c1', status: 'running', path: 'worker-alpha' },
      { id: 'c2', status: 'completed', path: 'worker-beta' },
      { id: 'c3', status: 'errored', path: 'worker-gamma' },
    ],
  } };
  const state = codexSubagents(session, [call, m1]);
  const summary = computeSwarmSummary(state.children, state.active, state.waiting, 15000);
  assert.equal(summary.total, 4);
  assert.equal(summary.running, 2);
  assert.equal(summary.completed, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.completionRatio, 0.5);
  assert.ok(summary.effortScore >= 55);
  assert.ok(['high', 'max'].includes(summary.effortLevel));
});

test('computeSwarmSummary builds ganttBars, parallelismRatio, and per-child history transitions', () => {
  const m1: ChatMessage = {
    ...call,
    id: 'm1',
    createdAt: 1000,
    codexSubagent: {
      action: 'spawnAgent',
      source: 'live',
      observedAt: 1000,
      agents: [
        { id: 'c1', status: 'running', path: 'worker-alpha' },
        { id: 'c2', status: 'running', path: 'worker-beta' },
      ],
    },
  };
  const m2: ChatMessage = {
    ...call,
    id: 'm2',
    createdAt: 5000,
    toolPhase: 'result',
    codexSubagent: {
      action: 'wait',
      source: 'live',
      observedAt: 5000,
      agents: [
        { id: 'c1', status: 'completed', path: 'worker-alpha' },
        { id: 'c2', status: 'completed', path: 'worker-beta' },
      ],
    },
  };
  const state = codexSubagents(session, [m1, m2]);
  assert.equal(state.children[0]?.history?.length, 2);
  const summary = computeSwarmSummary(state.children, state.active, state.waiting, 5000);
  assert.equal(summary.ganttBars.length, 2);
  assert.ok(summary.parallelismRatio >= 1.5);
  assert.equal(summary.wallClockSeconds, 4);
});

test('computeChildEffort and computeSwarmSummary clusters group sub-agents and score dynamic child effort', () => {
  const m1: ChatMessage = {
    ...call,
    id: 'm-cluster',
    createdAt: 1000,
    codexSubagent: {
      action: 'spawnAgent',
      source: 'live',
      observedAt: 1000,
      agents: [
        { id: 'c1', status: 'running', path: 'explorer-api' },
        { id: 'c2', status: 'running', path: 'explorer-db' },
        { id: 'c3', status: 'completed', path: 'worker-patch' },
      ],
    },
  };
  const state = codexSubagents(session, [m1]);
  const summary = computeSwarmSummary(state.children, state.active, state.waiting, 9000);
  assert.ok(summary.clusters.length >= 2);
  const explorerCluster = summary.clusters.find(c => c.id === 'role:explorer');
  assert.ok(explorerCluster);
  assert.equal(explorerCluster.total, 2);
  assert.equal(explorerCluster.running, 2);
  assert.ok(explorerCluster.effortScore >= 60);
});

test('filters self-root /root coordinator observations and strips /root/ prefixes for labels & clusters', () => {
  const rootSession = {
    ...session,
    sessionKey: 'parallel-codex:opaque-session-key',
    sessionRef: {
      sourceId: 'parallel-codex',
      nodeId: 'local-node',
      runtimeId: 'codex',
      nativeSessionKey: 'codex:01a0ec55-e040-7881-8e57-cee152657ee2',
    },
  } as unknown as SessionSummary;
  const msg: ChatMessage = {
    ...call,
    id: 'm-root-filter',
    sessionKey: rootSession.sessionKey,
    toolCallId: 'subagent-root-1',
    codexSubagent: {
      action: 'interacted',
      source: 'history',
      agents: [
        { id: '01a0ec55-e040-7881-8e57-cee152657ee2', status: 'unknown', path: '/root' },
        { id: 'other-root-id', status: 'unknown', path: '/root' },
        { id: '01a0ec55-e040-7881-8e57-cee152657ee2', status: 'running', path: '/root/self_echo' },
        { id: 'real-child-1', status: 'running', path: '/root/explorer_api' },
        { id: 'real-child-2', status: 'completed', path: '/root/explorer_db' },
      ],
    },
  };
  const state = codexSubagents(rootSession, [msg]);
  assert.equal(state.children.length, 2);
  assert.deepEqual(
    state.children.map((c) => formatSubagentLabel(c)),
    ['explorer_api', 'explorer_db'],
  );
  const summary = computeSwarmSummary(state.children, state.active, state.waiting, 5000);
  const explorerCluster = summary.clusters.find((c) => c.id === 'role:explorer');
  assert.ok(explorerCluster);
  assert.equal(explorerCluster.total, 2);
});

test('deduplicates static history or identical-timestamp call+result pairs without collapsing distinct live transitions', () => {
  const histCall: ChatMessage = {
    ...call,
    id: 'hist-call',
    toolCallId: 'tc-hist-1',
    toolPhase: 'call',
    createdAt: 1000,
    codexSubagent: {
      action: 'interacted',
      source: 'history',
      agents: [{ id: 'worker-1', status: 'unknown', path: '/root/worker_alpha' }],
    },
  };
  const histResult: ChatMessage = {
    ...histCall,
    id: 'hist-result',
    toolPhase: 'result',
    status: 'sent',
    createdAt: 1001,
  };
  const histState = codexSubagents(session, [histCall, histResult]);
  assert.equal(histState.children.length, 1);
  assert.equal(histState.children[0]?.eventCount, 1);
  assert.equal(histState.children[0]?.history?.length, 1);

  const liveCall: ChatMessage = {
    ...call,
    id: 'live-call',
    toolCallId: 'tc-live-1',
    toolPhase: 'call',
    createdAt: 2000,
    codexSubagent: {
      action: 'wait',
      source: 'live',
      observedAt: 2000,
      agents: [{ id: 'worker-2', status: 'running', path: '/root/worker_beta' }],
    },
  };
  const liveResult: ChatMessage = {
    ...liveCall,
    id: 'live-result',
    toolPhase: 'result',
    status: 'sent',
    createdAt: 4000,
    codexSubagent: {
      action: 'wait',
      source: 'live',
      observedAt: 4000,
      agents: [{ id: 'worker-2', status: 'completed', path: '/root/worker_beta' }],
    },
  };
  const liveState = codexSubagents(session, [liveCall, liveResult]);
  assert.equal(liveState.children[0]?.eventCount, 2);
  assert.equal(liveState.children[0]?.status, 'completed');
});


test('hasActiveOrAttentionSubagents hides bottom status bar once all children reach 0/N completed while parent turn continues', () => {
  const spawnCall: ChatMessage = {
    ...call,
    id: 'spawn-two',
    toolCallId: 'tc-spawn-two',
    toolPhase: 'result',
    status: 'sent',
    createdAt: 1000,
    codexSubagent: {
      action: 'spawnAgent',
      source: 'live',
      observedAt: 1000,
      agents: [
        { id: 'c1', status: 'running', path: '/root/Einstein' },
        { id: 'c2', status: 'running', path: '/root/Lovelace' },
      ],
    },
  };
  const liveState = codexSubagents(session, [spawnCall]);
  assert.equal(hasActiveOrAttentionSubagents(liveState), true);

  const waitDone: ChatMessage = {
    ...call,
    id: 'wait-done',
    toolCallId: 'tc-wait-two',
    toolPhase: 'result',
    status: 'sent',
    createdAt: 4000,
    codexSubagent: {
      action: 'wait',
      source: 'live',
      observedAt: 4000,
      agents: [
        { id: 'c1', status: 'completed', path: '/root/Einstein' },
        { id: 'c2', status: 'completed', path: '/root/Lovelace' },
      ],
    },
  };
  // Parent turn is still running (session.runtime.phase === 'running'), but 0/2 children are running:
  const finishedChildrenState = codexSubagents(session, [spawnCall, waitDone]);
  assert.equal(finishedChildrenState.active, true);
  assert.equal(finishedChildrenState.children.length, 2);
  assert.equal(hasActiveOrAttentionSubagents(finishedChildrenState), false);

  // Shutdown (close_agent) also stays hidden:
  const closedDone: ChatMessage = {
    ...waitDone,
    id: 'close-done',
    toolCallId: 'tc-close-two',
    createdAt: 5000,
    codexSubagent: {
      action: 'closeAgent',
      source: 'live',
      observedAt: 5000,
      agents: [
        { id: 'c1', status: 'shutdown', path: '/root/Einstein' },
        { id: 'c2', status: 'shutdown', path: '/root/Lovelace' },
      ],
    },
  };
  assert.equal(hasActiveOrAttentionSubagents(codexSubagents(session, [spawnCall, waitDone, closedDone])), false);

  // Errored child keeps attention bar visible:
  const erroredDone: ChatMessage = {
    ...waitDone,
    id: 'err-done',
    toolCallId: 'tc-err',
    createdAt: 6000,
    codexSubagent: {
      action: 'wait',
      source: 'live',
      observedAt: 6000,
      agents: [
        { id: 'c1', status: 'completed', path: '/root/Einstein' },
        { id: 'c2', status: 'errored', path: '/root/Lovelace' },
      ],
    },
  };
  assert.equal(hasActiveOrAttentionSubagents(codexSubagents(session, [spawnCall, erroredDone])), true);
});
