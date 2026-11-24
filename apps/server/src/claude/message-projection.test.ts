import assert from 'node:assert/strict';
import test from 'node:test';
import { projectClaudeMessage, validateClaudeProjection, CLAUDE_MESSAGE_TEXT_LIMIT } from './message-projection.js';

const message = (role: string, content: unknown, extra = {}) => ({ type: role, uuid: 'native-message',
  session_id: 'session', parent_tool_use_id: null, message: { role, content }, ...extra });

test('Claude projects stable per-block identities without lifecycle or provider internals', () => {
  const event = message('assistant', [{ type: 'text', text: 'Hello' }, { type: 'text', text: 'world' }], { usage: { private: true } });
  const rows = projectClaudeMessage(event, 'session');
  assert.deepEqual(rows.map(row => [row.nativeMessageId, row.blockIndex, row.text]), [['native-message', 0, 'Hello'], ['native-message', 1, 'world']]);
  assert.deepEqual(projectClaudeMessage(event, 'session'), rows);
  assert.deepEqual(projectClaudeMessage({ type: 'result', result: 'do not duplicate' }, 'session'), []);
  assert.ok(!JSON.stringify(rows).includes('private'));
});

test('Claude tool previews retain lazy identities but omit inputs, binary bodies and thinking', () => {
  const call = projectClaudeMessage(message('assistant', [{ type: 'tool_use', id: 'call', name: 'view_image',
    input: { image: 'PRIVATE_BINARY'.repeat(100_000) } }, { type: 'thinking', thinking: 'PRIVATE_THINKING' }]), 'session');
  assert.equal(call.length, 1); assert.ok(call[0]); assert.equal(call[0].detailAvailable, true); assert.equal(call[0].toolPhase, 'call');
  assert.ok(JSON.stringify(call).length < 400);
  const result = projectClaudeMessage(message('user', [{ type: 'tool_result', tool_use_id: 'call', is_error: true,
    content: [{ type: 'image', source: { data: 'PRIVATE_BINARY'.repeat(100_000) } }, { type: 'text', text: 'x'.repeat(200_000) }] }]), 'session');
  assert.ok(result[0]); assert.equal(result[0].text.length, 1000); assert.equal(result[0].truncated, true);
  assert.equal(result[0].detailAvailable, true); assert.equal(result[0].toolError, true);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});

test('Claude bounds the whole native message, marks truncation and handles empty text', () => {
  const rows = projectClaudeMessage(message('assistant', Array.from({ length: 4 }, () => ({ type: 'text', text: 'x'.repeat(80_000) }))), 'session');
  assert.equal(rows.reduce((sum, row) => sum + row.text.length, 0), CLAUDE_MESSAGE_TEXT_LIMIT);
  assert.equal(rows[3]?.truncated, true);
  assert.deepEqual(projectClaudeMessage(message('user', ''), 'session'), []);
  assert.equal(projectClaudeMessage(message('user', 'input'), 'session')[0]?.role, 'user');
});

test('Claude rejects crossed sessions, malformed tools and excessive blocks', () => {
  for (const event of [message('assistant', [], { session_id: 'other' }), message('assistant', [], { uuid: '' }),
    message('assistant', [], { parent_tool_use_id: undefined }), message('assistant', [{ type: 'tool_use', id: 'a' }]),
    message('user', [{ type: 'tool_result', tool_use_id: 'a', is_error: 'false' }]),
    message('assistant', Array.from({ length: 257 }, () => ({ type: 'text', text: '' })))]) {
    assert.throws(() => projectClaudeMessage(event, 'session'));
  }
});

test('Claude preserves child-tool identity without treating it as root completion', () => {
  const row = projectClaudeMessage(message('assistant', 'child output', { parent_tool_use_id: 'parent-tool' }), 'session')[0];
  assert.ok(row);
  assert.equal(row.parentToolUseId, 'parent-tool');
  assert.equal(row.text, 'child output');
});

test('Claude validates child IPC identities, ordering and whole-message bounds and drops unknown fields', () => {
  const rows = projectClaudeMessage(message('assistant', 'Hello'), 'session');
  assert.ok(rows[0]);
  assert.deepEqual(validateClaudeProjection([{ ...rows[0], extra: 'PRIVATE' }], 'native-message', null), rows);
  for (const bad of [[{ ...rows[0], nativeMessageId: 'other' }], [rows[0], rows[0]],
    [{ ...rows[0], blockIndex: -1 }], [{ ...rows[0], text: 'x'.repeat(CLAUDE_MESSAGE_TEXT_LIMIT + 1) }],
    [{ ...rows[0], role: 'tool', toolCallId: '', toolPhase: 'result' }], [{ ...rows[0], parentToolUseId: 'different' }]]) {
    assert.throws(() => validateClaudeProjection(bad, 'native-message', null));
  }
});
