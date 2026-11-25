import assert from 'node:assert/strict';
import test from 'node:test';
import { projectAntigravityUpdate } from './message-projection.js';

test('Antigravity text projection strips metadata and rejects oversized or malformed text', () => {
  assert.deepEqual(projectAntigravityUpdate({ sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: '你好', _meta: 'synthetic-private' }, _meta: 'synthetic-private' }), {
    sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好' },
  });
  for (const text of [[], 1, null, '好'.repeat(174763)]) {
    assert.throws(() => projectAntigravityUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }));
  }
  for (const sessionUpdate of ['agent_thought_chunk', 'user_message_chunk', 'session_info_update', 'plan']) {
    assert.equal(projectAntigravityUpdate({ sessionUpdate, content: { type: 'text', text: 'synthetic-private' } }), undefined);
  }
  assert.equal(projectAntigravityUpdate({ sessionUpdate: 'agent_message_chunk',
    content: { type: 'image', data: 'synthetic-native-body' } }), undefined);
});

test('Antigravity tool projection whitelists metadata, not executable input or native output', () => {
  assert.deepEqual(projectAntigravityUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'synthetic-tool',
    status: 'failed', rawInput: 'synthetic-private', rawOutput: 'synthetic-private', content: ['synthetic-native-body'] }), {
    sessionUpdate: 'tool_call_update', toolCallId: 'synthetic-tool', status: 'failed',
  });
  for (const invalid of [{ toolCallId: '' }, { title: ['Read'] }, { title: '好'.repeat(171) }, { title: 'synthetic\nprivate' },
    { status: ['completed'] }, { status: 'unknown' }, { kind: 'native-exec' }]) {
    assert.throws(() => projectAntigravityUpdate({ sessionUpdate: 'tool_call', toolCallId: 'synthetic-tool', ...invalid }));
  }
  for (const invalid of [[], null, { sessionUpdate: [] }]) assert.throws(() => projectAntigravityUpdate(invalid));
});
