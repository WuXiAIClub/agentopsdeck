import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectorUserStore } from '../connector/connector-user-store.js';
import { settleCodexNativeNotification, type CodexNativeNotification } from './native-notification.js';

const key = 'codex:notification';
const event = (changes: Partial<CodexNativeNotification> = {}): CodexNativeNotification => ({ sessionKey: key,
  connectionId: 'connection', runId: 'run', kind: 'item', phase: null, successorItemTurnId: null,
  projectable: true, tool: null, ...changes });
function fixture(phase: 'starting' | 'running' | 'completed' = 'running') {
  const owner = new ConnectorUserStore(':memory:');
  const journal = owner.codexExecutions;
  journal.begin(key, 'command', 'connection');
  if (phase !== 'starting') journal.acknowledge(key, 'command', 'connection', 'run', () => {});
  if (phase === 'completed') journal.observe(key, 'connection', 'run', 'completed');
  return { owner, journal };
}

test('original early native completion records evidence without projecting or adopting ACK', () => {
  const { owner, journal } = fixture('starting');
  try {
    const before = journal.get(key)!;
    const result = settleCodexNativeNotification(journal, event({ kind: 'complete', phase: 'completed' }));
    assert.equal(result.kind, 'ignore'); assert.deepEqual(result.execution, before);
    assert.equal(journal.get(key)?.phase, 'starting'); assert.equal(journal.get(key)?.runId, undefined);
    journal.acknowledge(key, 'command', 'connection', 'run', () => {});
    assert.equal(journal.get(key)?.phase, 'completed');
  } finally { owner.close(); }
});

for (const changes of [
  { connectionId: 'replacement' }, { runId: 'predecessor' }, { runId: null },
  { kind: 'turn', runId: null }, { kind: 'complete', phase: null },
] as Partial<CodexNativeNotification>[]) test(`notification refusal preserves journal: ${JSON.stringify(changes)}`, () => {
  const { owner, journal } = fixture();
  try {
    const before = journal.get(key);
    assert.equal(settleCodexNativeNotification(journal, event(changes)).kind, 'ignore');
    assert.deepEqual(journal.get(key), before);
  } finally { owner.close(); }
});

test('native preparation and fenced unknown do not settle lifecycle evidence', () => {
  const owner = new ConnectorUserStore(':memory:'), journal = owner.codexExecutions;
  try {
    journal.begin(key, 'command', 'connection', true);
    const before = journal.get(key);
    assert.equal(settleCodexNativeNotification(journal, event({ kind: 'complete', phase: 'completed' })).kind, 'ignore');
    assert.deepEqual(journal.get(key), before);
    journal.uncertain(key, 'command');
    const unknown = journal.get(key);
    assert.equal(settleCodexNativeNotification(journal, event({ kind: 'start', phase: 'running' })).kind, 'ignore');
    assert.deepEqual(journal.get(key), unknown);
  } finally { owner.close(); }
});

test('owned running tools settle before projection; an unsettled completion retains ownership', () => {
  const { owner, journal } = fixture();
  try {
    const started = settleCodexNativeNotification(journal, event({ tool: { id: 'tool', event: 'started' } }));
    assert.equal(started.kind, 'project'); assert.equal(started.execution?.pendingCommandTools, undefined);
    assert.deepEqual(journal.get(key)?.pendingCommandTools, ['tool']);
    settleCodexNativeNotification(journal, event({ tool: { id: 'tool', event: 'unsettled' } }));
    assert.deepEqual(journal.get(key)?.pendingCommandTools, ['tool']);
    settleCodexNativeNotification(journal, event({ tool: { id: 'tool', event: 'completed' } }));
    assert.equal(journal.get(key)?.pendingCommandTools, undefined);
  } finally { owner.close(); }
});

test('terminal late tool evidence preserves native drain identity and deduplicates starts', () => {
  const { owner, journal } = fixture('completed');
  try {
    assert.equal(settleCodexNativeNotification(journal, event({ tool: { id: 'late', event: 'started' } })).kind, 'late_tool');
    const before = journal.get(key);
    assert.equal(settleCodexNativeNotification(journal, event({ tool: { id: 'late', event: 'started' } })).kind, 'ignore');
    assert.deepEqual(journal.get(key), before);
    assert.equal(settleCodexNativeNotification(journal, event({ tool: { id: 'late', event: 'unsettled' } })).kind, 'late_tool');
    assert.deepEqual(journal.get(key)?.pendingCommandTools, ['late'], 'completion is not physical drain proof');
    assert.equal(settleCodexNativeNotification(journal, event({ tool: { id: 'not-owned', event: 'completed' } })).kind, 'ignore');
    assert.equal(journal.get(key)?.phase, 'completed');
  } finally { owner.close(); }
});

for (const kind of ['start', 'complete'] as const) test(`terminal journal cannot be reopened by contradictory ${kind}`, () => {
  const { owner, journal } = fixture('completed');
  try {
    const before = journal.get(key);
    const phase = kind === 'start' ? 'running' : 'failed';
    assert.equal(settleCodexNativeNotification(journal, event({ kind, phase })).kind, 'ignore');
    assert.deepEqual(journal.get(key), before);
  } finally { owner.close(); }
});

test('Goal protected successor deltas invalidate proof without waking every notification or adopting successor', () => {
  const { owner, journal } = fixture('completed');
  try {
    assert.equal(journal.settleNativeHistory(journal.get(key)!, { turnId: 'successor', connectionId: 'connection',
      fingerprint: 'a'.repeat(64), state: 'blocked', reason: 'goal-active' }), true);
    const result = settleCodexNativeNotification(journal, event({ runId: 'successor', successorItemTurnId: 'successor' }));
    assert.equal(result.kind, 'successor'); assert.equal(result.invalidate, true); assert.equal(result.wake, false);
    assert.equal(journal.get(key)?.runId, 'run'); assert.equal(journal.get(key)?.commandId, 'command');
    const goal = settleCodexNativeNotification(journal, event({ runId: null, kind: 'goal' }));
    assert.equal(goal.kind, 'successor'); assert.equal(goal.wake, true);
    assert.equal(journal.get(key)?.phase, 'completed');
  } finally { owner.close(); }
});

test('missing local replica does not discard valid native lifecycle evidence', () => {
  const { owner, journal } = fixture();
  try {
    assert.equal(settleCodexNativeNotification(journal, event({ kind: 'complete', phase: 'completed', projectable: false })).kind, 'ignore');
    assert.equal(journal.get(key)?.phase, 'completed');
  } finally { owner.close(); }
});
