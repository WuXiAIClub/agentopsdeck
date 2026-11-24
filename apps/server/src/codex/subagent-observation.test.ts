import assert from 'node:assert/strict';
import test from 'node:test';
import { subagentObservation } from './subagent-observation.js';
import { stableGatewayRowsRevision } from '../refresh/signature.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer, historicalMessages } from './app-server.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';

const item = { type: 'collabAgentToolCall', tool: 'wait', status: 'completed', receiverThreadIds: ['child'],
  agentsStates: { child: { status: 'running', message: 'Checking tests' } }, prompt: 'Review parser', privateExtra: 'SECRET' };

test('native projection preserves start receipt through progress and records independent result evidence', async t => {
  const users = new ConnectorUserStore(':memory:'), store = new DeckStore();
  const codex = new CodexAppServer({ enabled: true, command: 'must-not-launch', defaultCwd: '/nonexistent',
    defaultModel: 'test', approvalPolicy: 'never', store, turnQueue: users.turns, executions: users.codexExecutions,
    authorizeTurn: () => true });
  t.after(async () => { await codex.close(); users.close(); });
  const runtime = codex as any, key = 'codex:thread';
  runtime.ensureStarted = runtime.request = async () => { throw new Error('No native requests allowed'); };
  store.upsertSession({ sessionKey: key, agentId: 'codex', title: 'fixture', status: 'running',
    runtime: { turnId: 'turn', phase: 'running', sync: 'current', connection: 'connected', lastEventAt: 1000 } });
  runtime.recordToolStarted(key, 'wait', { ...item, status: 'inProgress' }, 1000);
  runtime.recordToolProgress(key, 'wait', 'progress', 2000);
  assert.equal(store.getMessages(key)[0]?.codexSubagent?.observedAt, 1000);
  runtime.recordToolCompleted(key, 'wait', item, 3000);
  const messages = store.getMessages(key);
  assert.equal(messages.find(m => m.toolPhase === 'call')?.codexSubagent?.observedAt, 1000);
  assert.equal(messages.find(m => m.toolPhase === 'result')?.codexSubagent?.observedAt, 3000);
  assert.equal(messages.find(m => m.toolPhase === 'result')?.codexSubagent?.agents[0]?.status, 'running');
  assert.ok(messages.every(m => m.turnId === 'turn'));
  assert.equal(users.codexExecutions.get(key), undefined);
});

test('native history projection never promotes synthetic timestamps into execution timing', async () => {
  const messages = await historicalMessages('codex:thread', [{ id: 'turn', status: 'completed',
    startedAt: 100, completedAt: 200, items: [{ ...item, id: 'wait' },
      { id: 'activity', type: 'subAgentActivity', kind: 'started', agentThreadId: 'child', agentPath: '/root/tests' }] }]);
  assert.equal(messages.length, 4);
  for (const message of messages) {
    assert.equal(message.codexSubagent?.source, 'history');
    assert.equal(message.codexSubagent?.observedAt, undefined);
  }
});
test('finished wait reports native running child, never infers child completion', () => {
  const result = subagentObservation(item, 1000)!;
  assert.equal(result.agents[0]?.status, 'running'); assert.equal(result.action, 'wait');
  assert.equal(result.observedAt, 1000); assert.equal(result.source, 'live');
  assert.equal(result.task, 'Review parser'); assert.ok(!JSON.stringify(result).includes('SECRET'));
  const history = subagentObservation(item)!;
  assert.equal(history.source, 'history'); assert.equal(history.observedAt, undefined);
});
test('activity has identity but no invented running/completed status', () => {
  for (const kind of ['started', 'interacted', 'interrupted']) {
    const result = subagentObservation({ type: 'subAgentActivity', kind, agentThreadId: 'child', agentPath: '/root/tests', secret: 'SECRET' })!;
    assert.equal(result.agents[0]?.status, kind === 'interrupted' ? 'interrupted' : 'unknown');
    assert.equal(result.agents[0]?.path, '/root/tests');
  }
  assert.equal(subagentObservation({ type: 'subAgentActivity', kind: 'completed', agentThreadId: 'child' }), undefined);
  assert.equal(subagentObservation({ type: 'subAgentActivity', kind: 'interacted', agentThreadId: 'parent', agentPath: '/root' }, 1000, 'parent'), undefined);
  assert.equal(subagentObservation({ type: 'subAgentActivity', kind: 'interacted', agentThreadId: 'any-id', agentPath: '/root' }), undefined);
  assert.equal(subagentObservation({ type: 'subAgentActivity', kind: 'interacted', agentThreadId: 'parent' }, undefined, 'parent'), undefined);
});
test('whitelist bounds target count/content, rejects unknown tool and handles prototype keys', () => {
  assert.equal(subagentObservation({ ...item, tool: 'arbitrary' }), undefined);
  assert.equal(subagentObservation({ ...item, type: 'dynamicToolCall' }), undefined);
  const result = subagentObservation({ ...item, receiverThreadIds: Array.from({ length: 90 }, (_, i) => `c${i}`), prompt: 'x'.repeat(2000) })!;
  assert.equal(result.agents.length, 32); assert.equal(result.task?.length, 600);
  assert.equal(subagentObservation({ ...item, receiverThreadIds: ['toString'], agentsStates: {} })!.agents[0]?.status, 'unknown');
  assert.equal(subagentObservation(item, NaN)!.observedAt, undefined);
});
test('metadata-only state changes invalidate message equality and row revision', () => {
  const store = new DeckStore();
  const message = { id: 'tool', sessionKey: 'codex:test', role: 'tool' as const, text: 'preview', createdAt: 1,
    codexSubagent: subagentObservation(item)! };
  store.addMessage(message);
  const changed = { ...message, codexSubagent: subagentObservation({ ...item, agentsStates: { child: { status: 'completed' } } })! };
  store.addMessage(changed);
  assert.equal(store.getMessages(message.sessionKey)[0]?.codexSubagent?.agents[0]?.status, 'completed');
  assert.notEqual(stableGatewayRowsRevision([message]), stableGatewayRowsRevision([changed]));
});
