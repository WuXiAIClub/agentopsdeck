import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { BOARD_CAPABILITY_PREFIX, WorkspaceBoardCapabilities } from './workspace-board-capabilities.js';
import { WorkspaceBoards } from './workspace-boards.js';
import { validHubBoardMachineCommand, hubBoardMachineReplyExpectation } from './member-board-machine-domain.js';
import { validHubBoardCapabilityResult, validHubBoardCapabilityReply, hubBoardCapabilityReplyExpectation } from './member-board-capability-domain.js';
import { hasBoardCapabilityCredential, registerWorkspaceAgentRoutes } from '../routes/workspace-agent.js';
import { validBoardToolCredential } from '../tools/workspace-board-cli.js';

const legacyBoardPrefix = ['cp', 'board', ''].join('_');
const legacyNotePrefix = ['cp', 'note', ''].join('_');
const taskId = '00000000-0000-4000-8000-000000000010';
const input = { taskIds: [taskId], fields: ['status' as const], expiresAt: 2000 };
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

test('AOD board grants retain 256-bit entropy and digest storage; legacy digest cannot authorize', () => {
  const db = new DatabaseSync(':memory:');
  const boards = new WorkspaceBoards(db);
  const caps = new WorkspaceBoardCapabilities(db, boards, () => 1000);
  try {
    boards.save('owner', 'default', {
      title: 'Board',
      revision: 0,
      mutationId: randomUUID(),
      tasks: [{ id: taskId, title: 'Task', detail: 'secret-detail', status: 'todo' }],
    });
    const issued = caps.issue('owner', 'default', input)!;
    const second = caps.issue('owner', 'default', input)!;
    assert.equal(BOARD_CAPABILITY_PREFIX, 'aod_board_');
    assert.match(issued.token, /^aod_board_[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(issued.token.slice(BOARD_CAPABILITY_PREFIX.length), 'base64url').length, 32);
    assert.notEqual(issued.token, second.token);
    const row = db.prepare('SELECT * FROM hub_board_capabilities WHERE id=?').get(issued.capability.id) as Record<string, unknown>;
    assert.equal(row.token_hash, digest(issued.token));
    assert.equal(JSON.stringify(row).includes(issued.token), false);
    assert.deepEqual(caps.list('owner', 'default').find(capability => capability.id === issued.capability.id), issued.capability);
    const readSnapshot = caps.read(issued.token);
    assert.ok(readSnapshot);
    assert.equal(readSnapshot.tasks[0]?.detail, undefined, 'ungranted detail facet remains excluded');
    const legacy = legacyBoardPrefix + issued.token.slice(BOARD_CAPABILITY_PREFIX.length);
    db.prepare('UPDATE hub_board_capabilities SET token_hash=? WHERE id=?').run(digest(legacy), issued.capability.id);
    assert.equal(caps.authorized(legacy), false, 'legacy namespace rejected even with a matching synthetic digest');
    assert.equal(caps.read(legacy), undefined);
    db.prepare('UPDATE hub_board_capabilities SET token_hash=? WHERE id=?').run(digest(issued.token), issued.capability.id);
    assert.equal(caps.authorized(issued.token), true);
    assert.equal(caps.revoke('owner', 'default', issued.capability.id), true);
    assert.equal(caps.authorized(issued.token), false);
  } finally {
    db.close();
  }
});

test('machine command, CLI credential, and capability reply schemas accept only the exact AOD board namespace', () => {
  const token = 'aod_board_' + 'a'.repeat(43);
  const command = { action: 'authorized' as const, token };
  const reply = {
    action: 'issue' as const,
    issued: {
      token,
      capability: {
        id: '00000000-0000-4000-8000-000000000001',
        resourceId: 'default',
        ...input,
        createdAt: 1000,
        revokedAt: null,
      },
    },
  };
  const expectation = hubBoardCapabilityReplyExpectation({ action: 'issue', resourceId: 'default', input });
  assert.equal(validHubBoardMachineCommand(command), true);
  assert.equal(validHubBoardCapabilityResult(reply), true);
  assert.equal(validHubBoardCapabilityReply(expectation, reply), true);
  assert.equal(validBoardToolCredential({ endpoint: 'https://hub.example/api/workspace-agent/v1/board', token, expiresAt: 2000 }, 1000), true);
  for (const rejected of [legacyBoardPrefix + 'a'.repeat(43), 'aod_note_' + 'a'.repeat(43), 'aod_board_' + 'a'.repeat(42), token + 'a', token + '!', 'AOD_board_' + 'a'.repeat(43)]) {
    assert.equal(validHubBoardMachineCommand({ ...command, token: rejected }), false);
    assert.equal(validHubBoardCapabilityResult({ ...reply, issued: { ...reply.issued, token: rejected } }), false);
    assert.equal(validHubBoardCapabilityReply(expectation, { ...reply, issued: { ...reply.issued, token: rejected } }), false);
    assert.equal(validBoardToolCredential({ endpoint: 'https://hub.example/api/workspace-agent/v1/board', token: rejected, expiresAt: 2000 }, 1000), false);
  }
  assert.doesNotMatch(JSON.stringify([hubBoardMachineReplyExpectation(command), expectation]), /aod_board_/);
});

test('machine HTTP parser and human-API credential fence reject legacy prefixes while accepting exact AOD board grants', async () => {
  for (const machineToken of ['aod_board_synthetic', 'aod_note_synthetic', legacyBoardPrefix + 'synthetic', legacyNotePrefix + 'synthetic']) {
    assert.equal(hasBoardCapabilityCredential(new Request('http://hub.local/api/health', { headers: { authorization: `Bearer ${machineToken}` } })), true);
    assert.equal(hasBoardCapabilityCredential(new Request('http://hub.local/api/health', { headers: { 'x-agentopsdeck-key': machineToken } })), true);
  }
  assert.equal(hasBoardCapabilityCredential(new Request('http://hub.local/api/health', { headers: { authorization: 'Bearer hub_key_valid' } })), false);

  const app = new Hono();
  const token = 'aod_board_' + 'a'.repeat(43);
  const calls: string[] = [];
  registerWorkspaceAgentRoutes(app, {
    async authorized(original) { calls.push('authorized'); assert.equal(original, token); return true; },
    async read(original, query) {
      calls.push('read'); assert.equal(original, token); assert.deepEqual(query, {});
      return { resourceId: 'default', revision: 1, tasks: [] };
    },
    async update() { throw new Error('must not dispatch'); },
  });
  const path = '/api/workspace-agent/v1/board';
  for (const bearer of [legacyBoardPrefix + 'a'.repeat(43), token + 'a', token + '!']) {
    const response = await app.request(path, { headers: { authorization: `Bearer ${bearer}` } });
    assert.equal(response.status, 401);
    assert.equal((await response.text()).includes(bearer), false);
    assert.deepEqual(calls, []);
  }
  const response = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['authorized', 'read']);
  assert.equal((await response.text()).includes(token), false);
});
