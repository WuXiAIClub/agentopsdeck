import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionExecutionSnapshot } from './session-execution.js';
import { DeckStore } from './deck-store.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';

test('terminal synchronization error explains the current run without reviving stale diagnostics', () => {
  const database = new ConnectorUserStore(':memory:'), deck = new DeckStore();
  const facts = database.codexExecutions, sessionKey = 'codex:one';
  const session = { sessionKey, agentId: 'codex', source: 'codex' as const, title: 'Synthetic', status: 'unknown' as const };
  deck.bindCodexExecutions(facts, () => 'connection');
  try {
    facts.begin(sessionKey, 'command', 'connection');
    facts.acknowledge(sessionKey, 'command', 'connection', 'run', () => {});
    facts.observe(sessionKey, 'connection', 'run', 'interrupted');
    const expected = { sessionKey, commandId: 'command', runId: 'run' };
    facts.settleHistory(expected, 'error');
    const runtime = { turnId: 'run', phase: 'interrupted' as const, connection: 'disconnected' as const,
      sync: 'error' as const, lastEventAt: 1, reason: 'Native tool cleanup is unconfirmed' };
    deck.upsertSession({ ...session, runtime });
    assert.equal(deck.getSession(sessionKey)?.runtime?.reason, runtime.reason);
    assert.equal(facts.canStart(sessionKey), false);
    // Different turns, phases and fresh synchronization cannot inherit it.
    for (const patch of [{ turnId: 'old' }, { phase: 'completed' as const }, { sync: 'current' as const }]) {
      deck.upsertSession({ ...session, runtime: { ...runtime, ...patch } });
      assert.equal(deck.getSession(sessionKey)?.runtime?.reason, undefined);
    }
    deck.upsertSession({ ...session, runtime });
    facts.settleHistory(expected, 'current');
    assert.equal(deck.getSession(sessionKey)?.runtime?.reason, undefined);
    assert.equal(facts.canStart(sessionKey), true);
  } finally { database.close(); }
});

test('execution boundary preserves only validated thread activity independently of a terminal outcome', () => {
  for (const threadActivity of ['idle', 'running', 'waiting', 'unknown']) {
    const runtime = { phase: 'completed', connection: 'connected', sync: 'current', lastEventAt: 1, threadActivity };
    const row = { sessionKey: 'codex:one', status: 'running', runtime };
    assert.equal(sessionExecutionSnapshot(row, row.sessionKey).runtime?.threadActivity, threadActivity);
    assert.equal(sessionExecutionSnapshot(row, row.sessionKey).runtime?.phase, 'completed');
    for (const invalid of [null, [], {}, 'active', 1]) {
      assert.throws(() => sessionExecutionSnapshot({ ...row, runtime: { ...runtime, threadActivity: invalid } }, row.sessionKey));
    }
  }
});

test('execution snapshot whitelists known facts without inventing freshness or completion', () => {
  const runtime = { phase: 'running', connection: 'disconnected', sync: 'error', lastEventAt: 42, turnId: 'turn', reason: 'private diagnostics' };
  const result = sessionExecutionSnapshot({ sessionKey: 'codex:one', status: 'running', runtime, title: 'personal title',
    sourceCursor: 'source:1', sessionRef: { nodeId: 'untrusted' }, pinned: true, credential: 'never forward' }, 'codex:one');
  assert.deepEqual(result, { sessionKey: 'codex:one', status: 'running', sourceCursor: 'source:1',
    runtime: { phase: 'running', connection: 'disconnected', sync: 'error', lastEventAt: 42, turnId: 'turn' } });
  assert.deepEqual(sessionExecutionSnapshot({ sessionKey: 'agent:one', status: 'unknown' }, 'agent:one'), { sessionKey: 'agent:one', status: 'unknown' });
});

test('execution snapshot rejects invalid identity, states, timestamps and nested fields', () => {
  const base = { sessionKey: 'codex:one', status: 'running' };
  for (const row of [null, [], { ...base, sessionKey: 'codex:two' }, { ...base, status: 'done' },
    { ...base, runStartedAt: -1 }, { ...base, runCompletedAt: 1.5 }, { ...base, hasActiveRun: 'true' },
    { ...base, sourceCursor: '' }, { ...base, sourceCursor: 'x'.repeat(4097) }, { ...base, sourceCursor: '\n' },
    { ...base, runtime: {} }, { ...base, runtime: { phase: 'running', connection: 'connected', sync: 'current', lastEventAt: Infinity } },
    { ...base, structuredStatus: { runState: 'done' } }]) assert.throws(() => sessionExecutionSnapshot(row, base.sessionKey));
});

test('exact execution getter does not scan terminal transcript messages or create missing sessions', () => {
  const deck = new DeckStore();
  const sessionKey = 'agent:main:dashboard:execution';
  deck.upsertSession({ sessionKey, title: 'private', status: 'running', hasActiveRun: true, runStartedAt: 10 });
  deck.addMessage({ id: 'assistant', sessionKey, role: 'assistant', status: 'sent', text: 'commentary, not run completion', createdAt: 20 });
  // The legacy getter still has this heuristic; the new exact snapshot must not.
  assert.equal(deck.getSession(sessionKey)?.status, 'idle');
  const state = deck.getSessionExecution(sessionKey)!;
  assert.equal(state.status, 'running');
  assert.equal(state.hasActiveRun, true);
  assert.equal(state.runStartedAt, 10);
  assert.equal(state.sourceCursor, deck.latestEventId());
  assert.equal('title' in state, false);
  assert.equal(deck.getSessionExecution('agent:missing'), undefined);
});
