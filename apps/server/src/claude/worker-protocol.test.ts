import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeLifecycleFrame } from './worker-protocol.js';

test('Claude worker lifecycle IPC does not forward prompts, tool bodies, credentials, provider errors or costs', () => {
  const frame = claudeLifecycleFrame({ type: 'assistant', session_id: 'session', uuid: 'output', user_message_uuid: 'input',
    parent_tool_use_id: null, message: { role: 'assistant', content: 'PRIVATE TEXT' }, error: 'SECRET KEY',
    usage: { unknown: 'PRIVATE' }, result: 'PRIVATE', tools: ['PRIVATE'] });
  assert.deepEqual(frame, { type: 'assistant', session_id: 'session', uuid: 'output', user_message_uuid: 'input',
    parent_tool_use_id: null, message: { role: 'assistant' } });
});

test('Claude lifecycle projection preserves correlation violations for the adapter to reject, and bounds all fields', () => {
  const frame = claudeLifecycleFrame({ type: 'result', session_id: 'foreign', is_error: false,
    user_message_uuids: ['ours', 'foreign'], queued_turn_count: 1 });
  assert.deepEqual(frame.user_message_uuids, ['ours', 'foreign']);
  for (const event of [null, [], { type: 'x'.repeat(513) }, { type: 'result', is_error: 'false' },
    { type: 'result', queued_turn_count: Infinity }, { type: 'result', user_message_uuids: Array(17).fill('x') }]) {
    assert.throws(() => claudeLifecycleFrame(event));
  }
});
