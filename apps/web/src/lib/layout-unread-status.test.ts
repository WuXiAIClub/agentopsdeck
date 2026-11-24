import test from 'node:test';
import assert from 'node:assert/strict';
import { partialUnreadCoverage } from './layout-unread-status.js';

test('no streams and partial historical coverage are not API failures', () => {
  assert.equal(partialUnreadCoverage([], []), false);
  assert.equal(partialUnreadCoverage(['new'], []), true);
  assert.equal(partialUnreadCoverage(['a'], [{ sessionKey: 'a', coverage: 'gap' }]), true);
  assert.equal(partialUnreadCoverage(['a'], [{ sessionKey: 'a', coverage: 'observed' }]), false);
  assert.equal(partialUnreadCoverage(['a', 'b'], [{ sessionKey: 'a', coverage: 'observed' }]), true);
  assert.equal(partialUnreadCoverage([], [], true), true);
});
