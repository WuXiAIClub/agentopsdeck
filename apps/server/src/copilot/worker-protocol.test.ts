import assert from 'node:assert/strict';
import test from 'node:test';
import { copilotHistoryIdentities, copilotLifecycleFrame, validateCopilotWorkerStart, type CopilotWorkerStart } from './worker-protocol.js';
import { randomUUID } from 'node:crypto';

test('Copilot worker accepts independent public/native journal identities and rejects invalid starts', () => {
  const request = { kind: 'start', execution: { id: randomUUID(), key: `ghcp:${randomUUID()}`,
    nativeSessionId: randomUUID(), nativeMode: 'create' }, text: 'hello' } as CopilotWorkerStart;
  assert.doesNotThrow(() => validateCopilotWorkerStart(request));
  for (const patch of [{ key: 'claude-code:wrong' }, { key: 'ghcp:' }, { key: 'ghcp:../escape' },
    { nativeSessionId: '../escape' }, { id: 'invalid' }, { nativeMode: 'adopt' }]) {
    assert.throws(() => validateCopilotWorkerStart({ ...request, execution: { ...request.execution, ...patch } } as CopilotWorkerStart));
  }
});

test('Copilot lifecycle uses event-specific positive field selection, never native payload or diagnostics', () => {
  const event = { id: 'event-1', type: 'assistant.message', agentId: 'child', private: 'secret',
    data: { messageId: 'message-1', originatingMessageId: 'user-1', parentToolCallId: 'parent',
      content: 'private answer', error: 'secret', token: 'secret', image: 'a'.repeat(1_000_000) } };
  assert.deepEqual(copilotLifecycleFrame(event), { id: 'event-1', type: 'assistant.message', agentId: 'child',
    data: { messageId: 'message-1', originatingMessageId: 'user-1', parentToolCallId: 'parent' } });
  assert.deepEqual(copilotLifecycleFrame({ id: 'error', type: 'session.error', data: { message: 'SECRET', stack: 'SECRET' } }),
    { id: 'error', type: 'session.error', data: {} });
});

test('Copilot lifecycle rejects invalid identity/child markers instead of turning child events into root events', () => {
  const event = { id: 'valid', type: 'session.idle', data: { aborted: false } };
  for (const patch of [{ id: 'x'.repeat(513) }, { id: 'with spaces' }, { type: 'bad\ntype' }, { data: null },
    { agentId: null }, { data: { parentToolCallId: null } }, { data: { aborted: 'false' } }]) {
    assert.throws(() => copilotLifecycleFrame({ ...event, ...patch }));
  }
  assert.equal(copilotLifecycleFrame(event).data.aborted, false);
  assert.equal(copilotLifecycleFrame({ id: 'tool', type: 'tool.execution_complete', data: { toolCallId: 'call', success: false } }).data.success, false);
});

test('Copilot durable identity projection excludes child/output/tool bodies and refuses duplicate or oversized evidence', () => {
  const user = { id: 'u', type: 'user.message', data: { messageId: 'message', content: 'private' } };
  const assistant = { id: 'a', type: 'assistant.message', data: { messageId: 'answer', originatingMessageId: 'message', content: 'private' } };
  assert.deepEqual(copilotHistoryIdentities([user, assistant, { ...assistant, id: 'child', agentId: 'child' },
    { id: 'tool', type: 'tool.execution_complete', data: { raw: 'private' } }]),
  [{ id: 'u', type: 'user.message', messageId: 'message' },
    { id: 'a', type: 'assistant.message', messageId: 'answer', originatingMessageId: 'message' }]);
  assert.throws(() => copilotHistoryIdentities([user, user]));
  assert.throws(() => copilotHistoryIdentities(Array.from({ length: 10001 }, (_, i) => ({ ...user, id: `id-${i}` }))));
});
