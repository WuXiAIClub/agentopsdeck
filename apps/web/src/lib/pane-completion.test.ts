import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionSummary } from '@agentopsdeck/shared';
import { createPaneCompletionTracker } from './pane-completion.js';
const session = (phase: 'running' | 'completed' | 'failed' | 'interrupted', turnId = '1', runCompletedAt = 10): SessionSummary => ({ sessionKey: 'a', title: 'A', status: phase === 'running' ? 'running' : 'idle', runCompletedAt,
  runtime: { phase, turnId, threadActivity: phase === 'running' ? 'running' : 'idle', connection: 'connected', sync: 'current', lastEventAt: 1 } });
test('diagnostics explain completion suppression without exposing identities or poll spam', () => {
  const events: Array<{ stage: string; facts: Record<string, unknown> }> = [];
  const tracker = createPaneCompletionTracker((_key, stage, facts) => events.push({ stage, facts }));
  const running = session('running', 'private-turn-id');
  tracker.observe(running); tracker.observe(running);
  const before = events.length;
  for (let i = 0; i < 10; i++) { running.runtime!.lastEventAt++; tracker.observe(running); }
  assert.equal(events.length, before, 'lastEventAt changes alone do not create logs');
  const pending = session('completed', 'private-turn-id'); pending.runtime!.sync = 'syncing';
  tracker.observe(pending);
  assert.equal(events.at(-1)!.facts.reason, 'awaiting-authoritative-outcome');
  pending.runtime!.sync = 'current';
  assert.equal(tracker.observe(pending), 'completed');
  assert.equal(events.at(-1)!.facts.reason, 'new-completion');
  assert.ok(!JSON.stringify(events).includes('private-turn-id'));
  pending.runtime!.executionProtection = { state: 'blocked', nativeTurnId: 'private-native-id', reason: 'private-provider-detail' };
  tracker.observe(pending);
  assert.equal(events.at(-1)!.facts.hasProtectionReason, true);
  assert.ok(!JSON.stringify(events).includes('private-provider-detail'));
  assert.ok(!JSON.stringify(events).includes('private-native-id'));
});
test('a first fast turn after an observed empty idle session gets attention once', () => {
  const tracker = createPaneCompletionTracker();
  assert.equal(tracker.observe({ sessionKey: 'a', title: 'A', status: 'idle' }), undefined);
  const pending = session('completed'); pending.runtime!.sync = 'syncing';
  assert.equal(tracker.observe(pending), undefined);
  assert.equal(tracker.observe(session('completed')), 'completed');
  assert.equal(tracker.observe(session('completed')), undefined);
});
test('historical completion identity enrichment and initial sync do not replay attention', () => {
  const tracker = createPaneCompletionTracker(), historical = session('completed');
  delete historical.runtime!.turnId; delete historical.runCompletedAt;
  historical.runtime!.sync = 'syncing';
  assert.equal(tracker.observe(historical), undefined);
  assert.equal(tracker.observe(session('completed')), undefined);
  assert.equal(tracker.observe(session('completed', '2', 20)), 'completed');
});
test('authoritative empty runtime also notices the first fast completed turn', () => {
  const tracker = createPaneCompletionTracker();
  const idle: SessionSummary = { sessionKey: 'a', title: 'A', status: 'idle', messageCount: 0,
    runtime: { phase: 'completed', sync: 'current', connection: 'connected', threadActivity: 'idle', lastEventAt: 1 } };
  assert.equal(tracker.observe(idle), undefined);
  assert.equal(tracker.observe(session('completed')), 'completed');
  assert.equal(tracker.observe(session('completed')), undefined);
  const uncertain = createPaneCompletionTracker();
  uncertain.observe({ ...idle, runtime: { ...idle.runtime!, sync: 'syncing' } });
  assert.equal(uncertain.observe(session('completed')), undefined, 'uncertain historical baseline is not a new turn');
});
test('whole-pane attention seeds historical Done and notices fast completed turns between reads once', () => {
  const tracker = createPaneCompletionTracker();
  assert.equal(tracker.observe(session('completed')), undefined);
  assert.equal(tracker.observe(session('completed', '2', 20)), 'completed');
  assert.equal(tracker.observe(session('completed', '2', 20)), undefined);
  assert.equal(tracker.observe(session('completed', '2', 10)), undefined);
  assert.equal(tracker.observe(session('completed', '2', 20)), undefined);
});
test('running resets the animation; transient history errors defer rather than lose completion', () => {
  const tracker = createPaneCompletionTracker();
  assert.equal(tracker.observe(session('running')), 'running');
  const pending = session('completed'); pending.runtime!.sync = 'syncing';
  assert.equal(tracker.observe(pending), undefined);
  pending.runtime!.sync = 'error'; assert.equal(tracker.observe(pending), undefined);
  assert.equal(tracker.observe(session('completed')), 'completed');
  assert.equal(tracker.observe(session('running', '2')), 'running');
  assert.equal(tracker.observe(session('completed', '2')), 'completed');
});
test('failed/interrupted/compaction and reopening old panes never celebrate success', () => {
  const tracker = createPaneCompletionTracker();
  tracker.observe(session('running')); assert.equal(tracker.observe(session('failed')), undefined);
  tracker.observe(session('running', '2')); assert.equal(tracker.observe(session('interrupted', '2')), undefined);
  tracker.prune(new Set()); assert.equal(tracker.observe(session('completed', '3')), undefined);
  const compact = session('running', '4'); compact.runtime!.operation = 'compact';
  assert.equal(tracker.observe(compact), undefined); compact.runtime!.phase = 'completed'; compact.runtime!.threadActivity = 'idle';
  assert.equal(tracker.observe(compact), undefined);
});

test('late terminal snapshots older than a witnessed run do not consume its completion', () => {
  const reasons: unknown[] = [];
  const tracker = createPaneCompletionTracker((_key, _stage, facts) => reasons.push(facts.reason));
  tracker.observe(session('completed', 'old', 10));
  const running = { ...session('running', 'new'), runStartedAt: 20 };
  assert.equal(tracker.observe(running), 'running');
  for (const phase of ['completed', 'failed', 'interrupted'] as const) {
    assert.equal(tracker.observe(session(phase, 'old', 15)), undefined);
    assert.equal(reasons.at(-1), 'stale-terminal-before-run');
  }
  assert.equal(tracker.observe({ ...session('completed', 'new', 30), runStartedAt: 20 }), 'completed');
  assert.equal(tracker.observe(session('completed', 'new', 30)), undefined);
});

test('fast successor completion and untimed runtimes retain completion attention', () => {
  const tracker = createPaneCompletionTracker();
  tracker.observe({ ...session('running', 'first'), runStartedAt: 20 });
  assert.equal(tracker.observe(session('completed', 'successor', 40)), 'completed');
  tracker.observe(session('running', 'untimed'));
  const terminal = session('completed', 'untimed');
  delete terminal.runCompletedAt;
  assert.equal(tracker.observe(terminal), 'completed');
});
