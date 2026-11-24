import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultCreationAgent, isLocalCreationConnection } from './creation-target.js';

const state = { connections: [{ id: 'parallel-codex', kind: 'local' as const }, { id: 'remote', kind: 'remote' as const }], groups: [] };
const agents = [{ id: 'codex', label: 'Codex' }];

test('empty custom-named local Connector selects its available Codex agent', () => {
  assert.equal(isLocalCreationConnection(state, 'parallel-codex'), true);
  assert.equal(defaultCreationAgent(state, agents, undefined, 'parallel-codex'), 'codex');
});

test('disabled OpenClaw default cannot override the local agent catalog', () => {
  assert.equal(defaultCreationAgent(state, agents, { ok: false, enabled: false, status: 'unknown', defaultAgentId: 'main', updatedAt: 1 }, 'parallel-codex'), 'codex');
});

test('remote connections never inherit the local Codex catalog', () => {
  assert.equal(defaultCreationAgent(state, agents, undefined, 'remote'), 'main');
  assert.equal(defaultCreationAgent({ ...state, groups: [{ agentId: 'remote-agent', sessions: [{ connectionId: 'remote' }] }] }, agents, undefined, 'remote'), 'remote-agent');
});

test('connection kind takes precedence over the legacy local ID', () => {
  assert.equal(isLocalCreationConnection({ groups: [] }, 'local'), true);
  assert.equal(isLocalCreationConnection({ groups: [], connections: [{ id: 'local', kind: 'remote' }] }, 'local'), false);
});
