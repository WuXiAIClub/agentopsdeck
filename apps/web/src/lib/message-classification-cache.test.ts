import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMessage } from '@agentopsdeck/shared';
import { memoizeMessageClassification } from './message-classification-cache.js';

const row = (): ChatMessage => ({ id: 'same-id', sessionKey: 'one', role: 'assistant', text: 'hello', createdAt: 1 });

test('repeated unchanged classification is computed once, without copying or changing a message', () => {
  let calls = 0;
  const classify = memoizeMessageClassification(() => { calls++; return 'chat'; });
  const message = Object.freeze(row());
  for (let i = 0; i < 100; i++) assert.equal(classify(message), 'chat');
  assert.equal(calls, 1);
});

test('text, role and status edits invalidate the cached kind immediately', () => {
  let calls = 0;
  const classify = memoizeMessageClassification(m => {
    calls++;
    return m.status === 'failed' ? 'chat' : m.text === 'hidden' ? 'hidden' : m.role === 'tool' ? 'tool' : 'chat';
  });
  const message = row();
  assert.equal(classify(message), 'chat');
  message.role = 'tool'; assert.equal(classify(message), 'tool');
  message.text = 'hidden'; assert.equal(classify(message), 'hidden');
  message.status = 'failed'; assert.equal(classify(message), 'chat');
  message.status = 'sent'; assert.equal(classify(message), 'hidden');
  assert.equal(calls, 5);
});

test('messages with the same ID/text in other histories never share entries', () => {
  let calls = 0;
  const classify = memoizeMessageClassification(() => { calls++; return 'chat'; });
  classify(row()); classify(row()); classify({ ...row(), sessionKey: 'two' });
  assert.equal(calls, 3);
});

test('legacy structured text is never cached, including in-place nested changes', () => {
  let calls = 0;
  const classify = memoizeMessageClassification(m => { calls++; return JSON.stringify(m.text).includes('hidden') ? 'hidden' : 'chat'; });
  const nested = { content: 'visible' };
  const message = { ...row(), text: [nested] } as unknown as ChatMessage;
  assert.equal(classify(message), 'chat');
  nested.content = 'hidden'; assert.equal(classify(message), 'hidden');
  message.text = 'normal'; assert.equal(classify(message), 'chat');
  assert.equal(classify(message), 'chat');
  assert.equal(calls, 3);
});

test('failed classification is not cached and metadata unrelated to kind does not invalidate', () => {
  let calls = 0;
  const classify = memoizeMessageClassification(() => { if (++calls === 1) throw new Error('decode'); return 'chat'; });
  const message = row();
  assert.throws(() => classify(message), /decode/);
  assert.equal(classify(message), 'chat');
  message.createdAt = 2;
  assert.equal(classify(message), 'chat');
  assert.equal(calls, 2);
});
