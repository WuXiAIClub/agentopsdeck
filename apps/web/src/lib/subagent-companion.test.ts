import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMessage, SessionSummary } from '@agentopsdeck/shared';
import { decodeGhcpMessageScope, resolveSessionSubagentCompanion } from './subagent-companion.js';

function ghcpId(
  sessionKey: string,
  agentId: string | null,
  parentToolCallId: string | null,
  role: string,
  identity: string,
): string {
  return `ghcp-message:${Buffer.from(JSON.stringify([sessionKey, agentId, parentToolCallId, role, identity])).toString('base64url')}`;
}

test('resolveSessionSubagentCompanion resolves live Codex wave and retains rich child steps after completion', () => {
  const session: SessionSummary = {
    sessionKey: 'mac-codex-214:codex:thread-1',
    agentId: 'codex',
    title: 'Parent Codex',
    status: 'running',
    runtime: {
      turnId: 'turn-live',
      phase: 'running',
      sync: 'current',
      connection: 'connected',
      lastEventAt: 2000,
    },
  };

  const messages: ChatMessage[] = [
    {
      id: 'm1',
      sessionKey: session.sessionKey,
      turnId: 'turn-live',
      role: 'tool',
      toolPhase: 'call',
      toolCallId: 'spawn-1',
      text: 'Spawned sub-agent',
      createdAt: 1000,
      status: 'sending',
      codexSubagent: {
        source: 'live',
        action: 'spawnAgent',
        observedAt: 1000,
        task: 'Verify connector IPC schema',
        agents: [
          {
            id: 'child-uuid-1',
            path: '/root/verifier',
            status: 'running',
            currentStep: '$ rg connector apps/server',
            latestText: 'Checking connector-sdk-history-domain.ts…',
            steps: [
              {
                id: 's1',
                kind: 'tool',
                title: '$ rg connector apps/server',
                detail: 'apps/server/src/connector/connector-sdk-history-domain.ts',
                status: 'running',
                updatedAt: 1500,
              },
            ],
          },
        ],
      },
    },
  ];

  const liveState = resolveSessionSubagentCompanion(session, messages, false);
  assert.ok(liveState);
  assert.equal(liveState.runtimeKind, 'codex');
  assert.equal(liveState.hasLiveDispatch, true);
  assert.equal(liveState.waveId, 'codex:turn-live');
  assert.equal(liveState.children.length, 1);
  assert.equal(liveState.children[0]?.label, 'verifier');
  assert.equal(liveState.children[0]?.currentStep, '$ rg connector apps/server');
  assert.equal(liveState.children[0]?.steps.length, 1);

  // After turn finishes (idle, no active turnId), companion keeps last completed wave visible with hasLiveDispatch = false
  const idleSession: SessionSummary = {
    ...session,
    status: 'idle',
    runtime: {
      phase: 'completed',
      sync: 'current',
      connection: 'connected',
      lastEventAt: 3000,
    },
  };
  const { currentStep: _omitted, ...firstAgentRest } = messages[0]!.codexSubagent!.agents[0]!;
  const completedMessages: ChatMessage[] = [
    {
      ...messages[0]!,
      status: 'sent',
      toolPhase: 'result',
      codexSubagent: {
        ...messages[0]!.codexSubagent!,
        agents: [
          {
            ...firstAgentRest,
            status: 'completed',
          },
        ],
      },
    },
  ];
  const completedState = resolveSessionSubagentCompanion(idleSession, completedMessages, false);
  assert.ok(completedState);
  assert.equal(completedState.hasLiveDispatch, false);
  assert.equal(completedState.children[0]?.status, 'completed');
  assert.equal(completedState.children[0]?.task, 'Verify connector IPC schema');
});

test('resolveSessionSubagentCompanion decodes GHCP child scopes, steps, and root completion', () => {
  const key = 'ghcp:session-abc';
  const session: SessionSummary = {
    sessionKey: key,
    agentId: 'ghcp',
    title: 'Copilot Parent',
    status: 'running',
    runtime: {
      turnId: 'exec-1',
      phase: 'running',
      sync: 'current',
      connection: 'connected',
      lastEventAt: 2000,
    },
  };

  const rootToolCallId = ghcpId(key, null, null, 'tool-call', 'root-call-1');
  const childParentRef = ghcpId(key, 'researcher', null, 'tool-call', 'root-call-1');
  const childToolId = ghcpId(key, 'researcher', 'root-call-1', 'tool-call', 'c-tool-1');

  const decoded = decodeGhcpMessageScope(ghcpId(key, 'researcher', 'root-call-1', 'assistant', 'm-1'));
  assert.deepEqual(decoded, {
    sessionKey: key,
    agentId: 'researcher',
    parentToolCallId: 'root-call-1',
    role: 'assistant',
    identity: 'm-1',
  });

  const messages: ChatMessage[] = [
    {
      id: ghcpId(key, null, null, 'tool-start', 'root-call-1'),
      sessionKey: key,
      turnId: 'exec-1',
      role: 'tool',
      toolCallId: rootToolCallId,
      toolName: 'runSubagent',
      toolPhase: 'call',
      text: 'Audit workspace-layout dock tree',
      createdAt: 1000,
      status: 'sending',
    },
    {
      id: ghcpId(key, 'researcher', 'root-call-1', 'tool-start', 'c-tool-1'),
      sessionKey: key,
      turnId: 'exec-1',
      role: 'tool',
      toolCallId: childToolId,
      toolName: 'grep_search',
      toolPhase: 'call',
      parentToolUseId: childParentRef,
      text: 'grep_search',
      createdAt: 1100,
      status: 'sending',
    },
    {
      id: ghcpId(key, 'researcher', 'root-call-1', 'assistant', 'c-msg-1'),
      sessionKey: key,
      turnId: 'exec-1',
      role: 'assistant',
      parentToolUseId: childParentRef,
      text: 'Found dockFitsWorkspace in workspace-layout.ts.',
      createdAt: 1200,
      status: 'sent',
    },
  ];

  const running = resolveSessionSubagentCompanion(session, messages, false);
  assert.ok(running);
  assert.equal(running.runtimeKind, 'ghcp');
  assert.equal(running.hasLiveDispatch, true);
  assert.equal(running.children.length, 1);
  assert.equal(running.children[0]?.label, 'researcher');
  assert.equal(running.children[0]?.status, 'running');
  assert.equal(running.children[0]?.task, 'Audit workspace-layout dock tree');
  assert.equal(running.children[0]?.currentStep, 'grep_search');
  assert.equal(running.children[0]?.latestText, 'Found dockFitsWorkspace in workspace-layout.ts.');

  // Root tool completes -> child flips to completed
  const finishedMessages: ChatMessage[] = [
    ...messages,
    {
      id: ghcpId(key, null, null, 'tool-complete', 'root-call-1'),
      sessionKey: key,
      turnId: 'exec-1',
      role: 'tool',
      toolCallId: rootToolCallId,
      toolPhase: 'result',
      text: '',
      createdAt: 1400,
      status: 'sent',
    },
  ];
  const done = resolveSessionSubagentCompanion(session, finishedMessages, false);
  assert.ok(done);
  assert.equal(done.children[0]?.status, 'completed');
  assert.equal(done.hasLiveDispatch, false);
});
