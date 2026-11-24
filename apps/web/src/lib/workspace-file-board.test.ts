import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFileBoardIntent } from './workspace-file-board.js';
test('saved whole-board intent retains exact ID and rejects corrupt/authority-bearing data', () => {
  const intent = { requestId: '12345678-1234-1234-1234-123456789abc', sessionId: 'connector:session', revision: 0 };
  assert.deepEqual(parseFileBoardIntent(JSON.stringify(intent)), intent);
  for (const value of [null, {}, { ...intent, path: '/private' }, { ...intent, owner: 'other' }, { ...intent, requestId: '-'.repeat(36) }, { ...intent, revision: -1 }]) {
    assert.equal(parseFileBoardIntent(JSON.stringify(value)), undefined);
  }
});
