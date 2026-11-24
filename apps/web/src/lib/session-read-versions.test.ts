import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionReadVersions } from './session-read-versions.js';

test('local invalidation isolates sessions; eviction and global reset never revive old tokens', () => {
  const versions = createSessionReadVersions(2);
  const a = versions.capture('a'), b = versions.capture('b');
  assert.equal(versions.capture('a'), a);
  versions.invalidate('a');
  assert.equal(a.valid, false); assert.equal(b.valid, true);
  const next = versions.capture('a');
  assert.ok(next.revision > a.revision);
  versions.capture('c');
  assert.equal(b.valid, false, 'evicted in-flight reads remain fenced');
  assert.ok(versions.capture('b').revision > b.revision);
  versions.clear(); assert.equal(next.valid, false);
});
