import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexSubagentLiveTracker } from './subagent-live-tracker.js';
import { DeckStore } from '../projection/deck-store.js';
import { CodexAppServer } from './app-server.js';
import { ConnectorUserStore } from '../connector/connector-user-store.js';

test('CodexSubagentLiveTracker preserves untouched observations and enriches live child steps', async () => {
  const flushed: Array<{ parentSessionKey: string; anchorMessageId: string; childId: string }> = [];
  const tracker = new CodexSubagentLiveTracker((parentSessionKey, anchorMessageId, childId) => {
    flushed.push({ parentSessionKey, anchorMessageId, childId });
  });

  const initialObs = {
    source: 'live' as const,
    action: 'spawnAgent' as const,
    observedAt: 1000,
    task: 'Audit rollout reader bounds',
    agents: [{ id: 'child-1', status: 'pendingInit' as const }],
  };

  const registered = tracker.registerParentObservation('codex:parent', 'turn-1', 'msg-call-1', initialObs);
  assert.equal(registered, initialObs, 'without child telemetry, original observation reference is preserved');
  assert.equal(tracker.hasChild('child-1'), true);

  assert.equal(tracker.observeChildNotification('child-1', 'turn/started', { threadId: 'child-1', turn: { id: 'ct-1' } }, 1100), true);
  assert.equal(flushed.length, 1);

  tracker.observeChildNotification(
    'child-1',
    'item/started',
    {
      threadId: 'child-1',
      item: { id: 'cmd-1', type: 'commandExecution', command: ['rg', 'rollout', 'apps/server'] },
    },
    1200,
  );
  tracker.observeChildNotification(
    'child-1',
    'item/commandExecution/outputDelta',
    { threadId: 'child-1', itemId: 'cmd-1', delta: 'apps/server/src/codex/rollout-reader.ts:42\n' },
    1250,
  );
  tracker.observeChildNotification(
    'child-1',
    'item/completed',
    {
      threadId: 'child-1',
      item: { id: 'cmd-1', type: 'commandExecution', command: ['rg', 'rollout', 'apps/server'], status: 'completed', exitCode: 0 },
    },
    1300,
  );
  tracker.observeChildNotification(
    'child-1',
    'item/agentMessage/delta',
    { threadId: 'child-1', itemId: 'msg-1', delta: 'Checked bounds: max 128 threads.' },
    1350,
  );

  const midObs = tracker.applyToObservation('codex:parent', initialObs)!;
  assert.equal(midObs.agents[0]?.status, 'running');
  assert.equal(midObs.agents[0]?.turnStatus, 'running');
  assert.equal(midObs.agents[0]?.latestText, 'Checked bounds: max 128 threads.');
  assert.equal(midObs.agents[0]?.steps?.length, 2);
  assert.equal(midObs.agents[0]?.steps?.[0]?.title, '$ rg rollout apps/server');
  assert.equal(midObs.agents[0]?.steps?.[0]?.status, 'done');
  assert.match(midObs.agents[0]?.steps?.[0]?.detail ?? '', /rollout-reader\.ts:42/);

  tracker.observeChildNotification(
    'child-1',
    'turn/completed',
    { threadId: 'child-1', turn: { id: 'ct-1', status: 'completed' } },
    1500,
  );

  const enrichedHistory = tracker.enrichMessages('codex:parent', [
    {
      id: 'msg-hist-1',
      sessionKey: 'codex:parent',
      role: 'tool',
      text: 'Spawned agent',
      createdAt: 1000,
      status: 'sent',
      codexSubagent: {
        source: 'history',
        action: 'spawnAgent',
        task: 'Audit rollout reader bounds',
        agents: [{ id: 'child-1', status: 'unknown' }],
      },
    },
  ]);
  assert.equal(enrichedHistory[0]?.codexSubagent?.agents[0]?.status, 'completed');
  assert.equal(enrichedHistory[0]?.codexSubagent?.agents[0]?.turnStatus, 'completed');
  assert.equal(enrichedHistory[0]?.codexSubagent?.agents[0]?.latestText, 'Checked bounds: max 128 threads.');

  tracker.clearAll();
});

test('CodexAppServer forwards ignored child thread notifications into parent subagent projection without RPCs', async (t) => {
  const users = new ConnectorUserStore(':memory:');
  const store = new DeckStore();
  const codex = new CodexAppServer({
    enabled: true,
    command: 'must-not-launch',
    defaultCwd: '/nonexistent',
    defaultModel: 'test',
    approvalPolicy: 'never',
    store,
    turnQueue: users.turns,
    executions: users.codexExecutions,
    authorizeTurn: () => true,
  });
  t.after(async () => {
    await codex.close();
    users.close();
  });

  const runtime = codex as any;
  runtime.connectionId = 'conn-1';
  runtime.ensureStarted = runtime.request = async () => {
    throw new Error('No native RPC requests allowed');
  };

  const parentKey = 'codex:parent-thread';
  store.upsertSession({
    sessionKey: parentKey,
    agentId: 'codex',
    title: 'Parent session',
    status: 'running',
    runtime: { turnId: 'turn-p1', phase: 'running', sync: 'current', connection: 'connected', lastEventAt: 1000 },
  });

  runtime.recordToolStarted(
    parentKey,
    'spawn-1',
    {
      type: 'collabAgentToolCall',
      tool: 'spawnAgent',
      status: 'inProgress',
      receiverThreadIds: ['child-thread-99'],
      agentsStates: { 'child-thread-99': { status: 'pendingInit' } },
      prompt: 'Inspect GHCP transcript mapping',
    },
    1000,
  );

  await runtime.projectNotification('turn/started', {
    threadId: 'child-thread-99',
    turn: { id: 'child-turn-1', status: 'inProgress' },
  });
  await runtime.projectNotification('item/started', {
    threadId: 'child-thread-99',
    item: { id: 'c-item-1', type: 'fileChange', changes: [{ path: 'apps/web/src/lib/subagent-companion.ts' }] },
  });

  const messages = store.getMessages(parentKey);
  const callMsg = messages.find((m) => m.toolPhase === 'call');
  assert.ok(callMsg?.codexSubagent);
  assert.equal(callMsg.codexSubagent.agents[0]?.status, 'running');
  assert.equal(callMsg.codexSubagent.agents[0]?.currentStep, 'Edit apps/web/src/lib/subagent-companion.ts');
  assert.equal(callMsg.codexSubagent.agents[0]?.steps?.[0]?.title, 'Edit apps/web/src/lib/subagent-companion.ts');
  assert.equal(store.getSession('codex:child-thread-99'), undefined, 'child thread is never materialized as top-level session');
});
