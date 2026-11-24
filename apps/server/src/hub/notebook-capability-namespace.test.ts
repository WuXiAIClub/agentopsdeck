import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { NOTEBOOK_CAPABILITY_PREFIX, NotebookCapabilities } from './notebook-capabilities.js';
import { SessionNotebooks } from './session-notebooks.js';
import { validHubNotebookMachineCommand, notebookMachineExpectation } from './member-notebook-machine-domain.js';
import { validHubNotebookControlResult, validHubNotebookControlReply, hubNotebookControlExpectation } from './member-notebook-control-domain.js';
import { registerWorkspaceAgentNotebook } from '../routes/workspace-agent-notebook.js';

const legacyPrefix = ['cp', 'note', ''].join('_');
const input = { facets: ['hot:read' as const], expiresAt: 2000 };
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

test('AOD notebook grants retain 256-bit entropy and digest storage; legacy digest cannot authorize', () => {
  const db = new DatabaseSync(':memory:');
  const notes = new SessionNotebooks(db);
  const caps = new NotebookCapabilities(db, notes, () => true, () => 1000);
  try {
    notes.save('owner', { resourceId: 'r', revision: 0, text: 'synthetic' });
    const issued = caps.issue('owner', 'r', input, null)!;
    const second = caps.issue('owner', 'r', input, null)!;
    assert.equal(NOTEBOOK_CAPABILITY_PREFIX, 'aod_note_');
    assert.match(issued.token, /^aod_note_[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(issued.token.slice(NOTEBOOK_CAPABILITY_PREFIX.length), 'base64url').length, 32);
    assert.notEqual(issued.token, second.token);
    const row = db.prepare('SELECT * FROM hub_notebook_capabilities WHERE id=?').get(issued.capability.id)!;
    assert.equal(row.token_hash, digest(issued.token));
    assert.equal(JSON.stringify(row).includes(issued.token), false);
    assert.deepEqual(caps.list('owner', 'r').find(capability => capability.id === issued.capability.id), issued.capability);
    assert.ok(caps.authorized(issued.token, ['hot:read']));
    assert.equal(caps.authorized(issued.token, ['cold:read']), undefined);
    const legacy = legacyPrefix + issued.token.slice(NOTEBOOK_CAPABILITY_PREFIX.length);
    db.prepare('UPDATE hub_notebook_capabilities SET token_hash=? WHERE id=?').run(digest(legacy), issued.capability.id);
    assert.equal(caps.authorized(legacy), undefined, 'legacy namespace rejected even with a matching synthetic digest');
    db.prepare('UPDATE hub_notebook_capabilities SET token_hash=? WHERE id=?').run(digest(issued.token), issued.capability.id);
    assert.ok(caps.authorized(issued.token));
    assert.ok(caps.revoke('owner', 'r', issued.capability.id));
    assert.equal(caps.authorized(issued.token), undefined);
  } finally { db.close(); }
});

test('machine command and control reply schemas accept only the exact AOD notebook namespace', () => {
  const token = 'aod_note_' + 'a'.repeat(43);
  const command = { token, action: 'authorized' as const, facets: ['hot:read' as const] };
  const resourceId = JSON.stringify(['hub-notebook', 1]);
  const reply = { action: 'issue' as const, resourceId, issued: { token, capability: {
    id: '00000000-0000-4000-8000-000000000001', resourceId, ...input, createdAt: 1000, revokedAt: null,
  } } };
  const expectation = hubNotebookControlExpectation({ action: 'issue', resourceId, input });
  assert.equal(validHubNotebookMachineCommand(command), true);
  assert.equal(validHubNotebookControlResult(reply), true);
  assert.equal(validHubNotebookControlReply(expectation, reply), true);
  for (const rejected of [legacyPrefix + 'a'.repeat(43), 'aod_note_' + 'a'.repeat(42), token + 'a', token + '!', 'AOD_note_' + 'a'.repeat(43)]) {
    assert.equal(validHubNotebookMachineCommand({ ...command, token: rejected }), false);
    assert.equal(validHubNotebookControlResult({ ...reply, issued: { ...reply.issued, token: rejected } }), false);
    assert.equal(validHubNotebookControlReply(expectation, { ...reply, issued: { ...reply.issued, token: rejected } }), false);
  }
  assert.doesNotMatch(JSON.stringify([notebookMachineExpectation(command), expectation]), /aod_note_/);
});

test('machine HTTP parser rejects the legacy namespace before authority dispatch and preserves AOD read facets', async () => {
  const app = new Hono();
  const token = 'aod_note_' + 'a'.repeat(43);
  const calls: string[] = [];
  registerWorkspaceAgentNotebook(app, { mode: 'async', notebookMachine: {
    async authorized(_request, original) { calls.push('authorized'); assert.equal(original, token); return true; },
    async read(_request, original, query) {
      calls.push('read'); assert.equal(original, token); assert.deepEqual(query, [['area', 'cold']]);
      return { status: 200, body: { resourceId: 'r', area: 'cold', revision: 1, start: 0, end: 4, total: 4, text: 'cold' } };
    },
    async move() { throw Error('must not dispatch'); },
  } });
  const path = '/api/workspace-agent/v1/notebook?area=cold';
  for (const bearer of [legacyPrefix + 'a'.repeat(43), token + 'a', token + '!']) {
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
