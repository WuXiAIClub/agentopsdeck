import assert from 'node:assert/strict';
import test from 'node:test';
import { LEGACY_MAX_MESSAGE_CHARS, MAX_MESSAGE_CHARS, resolveMessageLimits } from '@agentopsdeck/shared';

test('unadvertised, corrupt and unsupported message limits fail conservatively', () => {
  for (const limits of [undefined, null, [], '100000', {}, { maxMessageChars: '100000' },
    { maxMessageChars: 0 }, { maxMessageChars: -1 }, { maxMessageChars: NaN },
    { maxMessageChars: Infinity }, { maxMessageChars: 1.5 }, { maxMessageChars: Number.MAX_VALUE }]) {
    assert.deepEqual(resolveMessageLimits(limits), { maxMessageChars: LEGACY_MAX_MESSAGE_CHARS });
  }
});
test('target limits are bounded and never carry upstream extra metadata', () => {
  assert.deepEqual(resolveMessageLimits({ maxMessageChars: 1024, owner: 'private' }), { maxMessageChars: 1024 });
  assert.deepEqual(resolveMessageLimits({ maxMessageChars: 100000 }), { maxMessageChars: MAX_MESSAGE_CHARS });
  assert.deepEqual(resolveMessageLimits({ maxMessageChars: 1000000 }), { maxMessageChars: MAX_MESSAGE_CHARS });
});
test('limits follow each authorized snapshot, including downgrade and legacy fallback', () => {
  const snapshots = [undefined, { maxMessageChars: 100000 }, { maxMessageChars: 5000 }, undefined];
  assert.deepEqual(snapshots.map(value => resolveMessageLimits(value).maxMessageChars), [20000, 100000, 5000, 20000]);
  // Validation never mutates/truncates a draft if its target is downgraded.
  const draft = '文'.repeat(100000);
  assert.ok(draft.length > resolveMessageLimits(undefined).maxMessageChars);
  assert.equal(draft.length, 100000);
});
