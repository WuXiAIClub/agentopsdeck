import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectorUserStore } from './connector-user-store.js';

test('shared turn start pause gates both native runtimes while preserving original queue and settlement', () => {
  const users = new ConnectorUserStore(':memory:');
  try {
    users.turns.enqueue('codex', { id: 'running', sessionKey: 'codex:active', createdAt: 1, payload: {} });
    assert.equal(users.turns.start('codex', 'codex:active', 'running'), true);
    const resume = users.pauseTurnStarts();
    assert.equal(users.pauseTurnStarts(), resume);
    users.turns.enqueue('codex', { id: 'queued', sessionKey: 'codex:queued', createdAt: 2, payload: {} });
    assert.equal(users.turns.start('codex', 'codex:queued', 'queued'), false);
    assert.equal(users.codexExecutions.begin('codex:queued', 'queued', 'synthetic'), false);
    assert.equal(users.openClawExecutions.begin('agent:synthetic', 'openclaw'), false);
    users.turns.complete('codex', 'running');
    assert.equal(users.turns.head('codex', 'codex:active'), undefined);
    assert.equal(users.turns.head('codex', 'codex:queued')?.state, 'queued');
    assert.equal(resume(), true);
    const next = users.pauseTurnStarts();
    assert.equal(resume(), false);
    assert.equal(users.turns.start('codex', 'codex:queued', 'queued'), false);
    assert.equal(next(), true);
    assert.equal(users.turns.start('codex', 'codex:queued', 'queued'), true);
    assert.equal(users.codexExecutions.begin('codex:queued', 'queued', 'synthetic'), true);
    assert.equal(users.openClawExecutions.begin('agent:synthetic', 'openclaw'), true);
    const stopped = users.pauseTurnStarts();
    users.stopTurnStarts();
    assert.equal(stopped(), false);
  } finally { users.close(); }
});

test('closing the original SQLite owner permanently prevents pause release', () => {
  const users = new ConnectorUserStore(':memory:');
  const resume = users.pauseTurnStarts();
  users.close();
  assert.equal(resume(), false);
  assert.equal(users.pauseTurnStarts()(), false);
});
