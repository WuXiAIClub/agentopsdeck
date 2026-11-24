import assert from 'node:assert/strict';
import test from 'node:test';
import { hasUnmatchedToolCall } from './tool-timeline.js';

test('indexed matching preserves empty ids, interleaved results and out-of-order results', () => {
  const rows = [{ toolPhase: 'call', toolCallId: '' }, { toolPhase: 'result', toolCallId: 'b' },
    { toolPhase: 'call', toolCallId: 'a' }, { toolPhase: 'call', toolCallId: 'b' }];
  assert.equal(hasUnmatchedToolCall(rows), true);
  assert.equal(hasUnmatchedToolCall([...rows, { toolPhase: 'result', toolCallId: 'a' }]), false);
  assert.equal(hasUnmatchedToolCall([]), false);
  assert.equal(hasUnmatchedToolCall([{ toolPhase: 'call' }]), false);
});

test('matching uses linear field reads for a large completed tool history', () => {
  let reads = 0;
  const rows = Array.from({ length: 2000 }, (_, i) => ({ toolPhase: i < 1000 ? 'call' : 'result',
    get toolCallId() { reads++; return String(i % 1000); } }));
  assert.equal(hasUnmatchedToolCall(rows), false);
  assert.ok(reads <= 6000, `expected linear reads, got ${reads}`);
});
