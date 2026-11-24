import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeHubSessionId } from './session-id.js';
import type { NodeGrantProof } from './node-grants.js';
import { validHubExecutionCommand, validHubExecutionCommandReply, type HubExecutionCommand } from './member-execution-command-domain.js';

const target = { ownerUserId: 'alice', sessionId: encodeHubSessionId('node', 'codex:original') };
const read: NodeGrantProof = { ownerUserId: 'alice', userId: 'bob', connectionId: 'node', grantId: 'read', version: 1, nodeVersion: 1,
  action: 'messages:read', resource: { runtime: 'codex', sessionKey: 'codex:original' } };

test('shared fixed domain rejects generic SQL, paths, caller principals and malformed receipt inputs', () => {
  const good: HubExecutionCommand = { action: 'lookup', target, read, key: 'original' };
  assert.equal(validHubExecutionCommand(good), true);
  for (const value of [
    { ...good, sql: 'SELECT 1' }, { ...good, principal: { userId: 'bob', admin: true } },
    { ...good, key: '../other' }, { ...good, digest: 'not-a-digest' }, { ...good, action: 'arbitrary-method' },
    { action: 'effectOpen', target, read, effect: { kind: 'receipt', key: 'original', path: '/arbitrary' } },
    { action: 'settle', target, read, key: 'original', receipt: { key: 'original', state: 'accepted' }, notDispatched: false },
    { action: 'queueClaim', target, read, key: 'edit', commandKey: 'original', nodeId: 'node_' + 'a'.repeat(36), digest: 'a'.repeat(64), patch: false,
      send: { ...read, action: 'messages:send' } },
  ]) assert.equal(validHubExecutionCommand(value), false);
});

test('shared replies bind original owner, user, connection, runtime, session, grant generation and key', () => {
  const opened = { action: 'open', target: { ...target, userId: 'bob' }, read, nodeId: 'node_00000000-0000-4000-8000-000000000000' };
  const command: HubExecutionCommand = { action: 'open', target };
  assert.equal(validHubExecutionCommandReply(command, opened), true);
  for (const changed of [
    { ...read, ownerUserId: 'mallory' }, { ...read, userId: 'mallory' }, { ...read, connectionId: 'other' },
    { ...read, resource: { ...read.resource, runtime: 'openclaw' } },
    { ...read, resource: { ...read.resource, sessionKey: 'codex:other' } },
  ]) assert.equal(validHubExecutionCommandReply(command, { ...opened, read: changed }), false);
  const send = { ...read, action: 'messages:send' as const, grantId: 'send' };
  const permission: HubExecutionCommand = { action: 'permission', target, read, permission: 'messages:send', proof: send };
  assert.equal(validHubExecutionCommandReply(permission, { action: 'permission', proof: send }), true);
  assert.equal(validHubExecutionCommandReply(permission, { action: 'permission', proof: { ...send, version: 2 } }), false);
  const lookup: HubExecutionCommand = { action: 'lookup', target, read, key: 'original' };
  const receipt = { id: 'receipt', key: 'original', state: 'outcome_unknown', createdAt: 1, updatedAt: 1 };
  assert.equal(validHubExecutionCommandReply(lookup, { action: 'lookup', receipt, authorityId: 7 }), true);
  assert.equal(validHubExecutionCommandReply(lookup, { action: 'lookup', receipt: { ...receipt, key: 'other' }, authorityId: 7 }), false);
  assert.equal(validHubExecutionCommandReply(lookup, { action: 'lookup', receipt: null, authorityId: 7 }), false);
});
