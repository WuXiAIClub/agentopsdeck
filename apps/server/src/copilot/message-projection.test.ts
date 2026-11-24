import assert from 'node:assert/strict';
import test from 'node:test';
import { COPILOT_MESSAGE_TEXT_LIMIT, copilotMessageId, projectCopilotMessage, validateCopilotProjection } from './message-projection.js';
import { copilotLifecycleFrame } from './worker-protocol.js';
const event = (type: string, data: Record<string, unknown>) => ({ id: 'event', type, data, timestamp: '2026-09-23T00:00:00.000Z' });

test('Copilot text projection preserves scope and stable logical identity, not provider metadata', () => {
  const source = { ...event('assistant.message', { messageId: 'msg', content: '你好', reasoningText: 'PRIVATE',
    encryptedContent: 'PRIVATE', parentToolCallId: 'parent' }), agentId: 'child' };
  const row = projectCopilotMessage(source)!;
  assert.equal(row.text, '你好'); assert.equal(row.agentId, 'child'); assert.equal(row.parentToolCallId, 'parent');
  assert.ok(!JSON.stringify(row).includes('PRIVATE'));
  assert.deepEqual(validateCopilotProjection({ ...row, secret: 'PRIVATE' }, copilotLifecycleFrame(source)), row);
  assert.equal(copilotMessageId('ghcp:session', row, row.role, row.messageId!),
    copilotMessageId('ghcp:session', row, row.role, 'msg'));
  assert.notEqual(copilotMessageId('ghcp:session', row, row.role, 'msg'), copilotMessageId('ghcp:session', {}, row.role, 'msg'));
});
test('Copilot message/tool projection bounds text before IPC and excludes raw tool arguments/results', () => {
  const row = projectCopilotMessage(event('user.message', { messageId: 'u', content: '中'.repeat(COPILOT_MESSAGE_TEXT_LIMIT + 1) }))!;
  assert.equal(row.text.length, COPILOT_MESSAGE_TEXT_LIMIT); assert.equal(row.truncated, true);
  const tool = projectCopilotMessage(event('tool.execution_start', { toolCallId: 'call', toolName: 'mcp.server/tool', arguments: { secret: 'PRIVATE' } }))!;
  assert.equal(tool.text, 'mcp.server/tool'); assert.equal(tool.toolPhase, 'call');
  const result = projectCopilotMessage(event('tool.execution_complete', { toolCallId: 'call', success: false,
    result: { content: 'PRIVATE' }, error: { message: 'PRIVATE' } }))!;
  assert.equal(result.toolError, true); assert.equal(result.text, '');
  assert.ok(!JSON.stringify([tool, result]).includes('PRIVATE'));
});
test('Copilot parent rejects projection identity/scope/type/body mutation', () => {
  const source = event('assistant.message', { messageId: 'msg', content: 'answer' }), row = projectCopilotMessage(source)!;
  for (const patch of [{ nativeEventId: 'other' }, { messageId: 'other' }, { agentId: 'child' }, { role: 'tool' },
    { text: 'x'.repeat(COPILOT_MESSAGE_TEXT_LIMIT + 1) }, { createdAt: NaN }, { truncated: 'false' }]) {
    assert.throws(() => validateCopilotProjection({ ...row, ...patch }, copilotLifecycleFrame(source)));
  }
  assert.throws(() => projectCopilotMessage({ ...source, timestamp: 'invalid' }));
});
