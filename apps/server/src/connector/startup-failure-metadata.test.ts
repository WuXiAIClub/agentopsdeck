import assert from 'node:assert/strict';
import test from 'node:test';
import { readStartupFailure, startupFailure } from './startup-failure-metadata.js';

test('startup diagnostic metadata preserves original errors and bounded cause fields', () => {
  const cause = startupFailure(Error('private'), { controlReason: 6, aclReason: 3, controlTarget: 1 });
  const error = Error('ownership');
  assert.equal(startupFailure(error, { leaseStage: 16 }, cause), error);
  assert.deepEqual(readStartupFailure(error), { controlReason: 6, aclReason: 3, controlTarget: 1, leaseStage: 16 });
  const copy = readStartupFailure(error);
  copy.controlReason = 1;
  assert.equal(readStartupFailure(error).controlReason, 6);
});

test('startup diagnostic metadata rejects values outside the existing fixed enums', () => {
  const error = startupFailure(Error('private'), { controlReason: 99, aclReason: NaN, controlTarget: 0 });
  assert.deepEqual(readStartupFailure(error), {});
  assert.equal(startupFailure('unchanged', { controlReason: 1 }), 'unchanged');
  assert.deepEqual(readStartupFailure(undefined), {});
});
