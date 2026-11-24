import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHubAccountAccess } from './hub-user-access.js';

test('account reads preserve legacy enabled/version zero and monotonic disabled/restored epochs', () => {
  for (const state of [{ userId: 'member', status: 'enabled', version: 0 }, { userId: 'member', status: 'disabled', version: 1 }, { userId: 'member', status: 'enabled', version: 2 }]) {
    assert.deepEqual(parseHubAccountAccess({ access: state }, 'member'), state);
  }
});
test('account state rejects missing, coercive, forged and wrong-user ACKs', () => {
  for (const access of [undefined, [], { userId: 'other', status: 'enabled', version: 0 },
    { userId: 'member', status: 'disabled', version: 0 }, { userId: 'member', status: 'enabled', version: '2' },
    { userId: 'member', status: 'enabled', version: -1 }, { userId: 'member', status: 'enabled', version: 1.5 },
    { userId: 'member', status: 'enabled', version: Number.MAX_SAFE_INTEGER + 1 },
    { userId: 'member', status: 'enabled', version: 1, admin: true }]) {
    assert.throws(() => parseHubAccountAccess({ access }, 'member'));
  }
});
test('change ACK must match the requested transition and exactly next epoch', () => {
  const change = { status: 'disabled' as const, expectedVersion: 4 };
  assert.equal(parseHubAccountAccess({ access: { userId: 'member', status: 'disabled', version: 5 } }, 'member', change).version, 5);
  for (const access of [{ userId: 'member', status: 'enabled', version: 5 }, { userId: 'member', status: 'disabled', version: 4 }, { userId: 'member', status: 'disabled', version: 6 }]) {
    assert.throws(() => parseHubAccountAccess({ access }, 'member', change));
  }
});
