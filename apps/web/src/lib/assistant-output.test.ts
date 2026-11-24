import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMessage } from '@agentopsdeck/shared';
import { assistantDisplayText, hasInvalidAssistantOutput, INVALID_ASSISTANT_OUTPUT_TEXT } from './assistant-output.js';

const message: ChatMessage = { sessionKey: 'synthetic', id: 'reply', role: 'assistant', text: '<end_of_image>'.repeat(32), createdAt: 10 };

test('image-marker-only assistant output is explained without mutating history', () => {
  const original = structuredClone(message);
  assert.equal(hasInvalidAssistantOutput(message), true);
  assert.equal(assistantDisplayText(message), INVALID_ASSISTANT_OUTPUT_TEXT);
  assert.deepEqual(message, original);
  assert.equal(hasInvalidAssistantOutput({ ...message, text: ' \n<end_of_image> \t<end_of_image>\n' }), true);
});

test('normal prose, quoted tokens, code and partial streaming tokens are preserved', () => {
  for (const text of ['', 'An image: <end_of_image>', '`<end_of_image>`', '```\n<end_of_image>\n```', '<end_of_ima', 'Done']) {
    const candidate = { ...message, text };
    assert.equal(hasInvalidAssistantOutput(candidate), false);
    assert.equal(assistantDisplayText(candidate), text);
  }
});

test('user input, tools, subagents and real media are never rewritten', () => {
  for (const patch of [{ role: 'user' }, { role: 'tool' }, { toolName: 'view_image' }, { toolCallId: 'call' },
    { toolPhase: 'result' }, { parentToolUseId: 'parent' },
    { media: [{ type: 'image', url: '/synthetic.png' }] }] as Partial<ChatMessage>[]) {
    const candidate = { ...message, ...patch };
    assert.equal(hasInvalidAssistantOutput(candidate), false);
    assert.equal(assistantDisplayText(candidate), message.text);
  }
});
