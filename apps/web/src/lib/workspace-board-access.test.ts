import test from 'node:test';
import assert from 'node:assert/strict';
import { boardGrantState, type BoardGrant } from './workspace-board-access.js';

const grant: BoardGrant = { id: 'grant', resourceId: 'board', taskIds: ['task'], fields: ['status'], createdAt: 100, expiresAt: 200, revokedAt: null };
test('grant expires at the exact deadline and revocation takes precedence', () => {
  assert.equal(boardGrantState(grant, 199), 'active');
  assert.equal(boardGrantState(grant, 200), 'expired');
  assert.equal(boardGrantState(grant, 201), 'expired');
  assert.equal(boardGrantState({ ...grant, revokedAt: 150 }, 160), 'revoked');
  assert.equal(boardGrantState({ ...grant, revokedAt: 150 }, 220), 'revoked');
  assert.equal(boardGrantState({ ...grant, revokedAt: 0 }, 160), 'revoked');
});
