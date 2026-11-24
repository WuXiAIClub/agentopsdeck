import test from 'node:test';
import assert from 'node:assert/strict';
import { DeckStore } from '../projection/deck-store.js';
import { summarizeToolMessage } from './tool-summary.js';
import type { ChatMessage } from '@agentopsdeck/shared';

test('64 MiB tool history becomes bounded summaries while details stay independently readable', () => {
  const text = 'x'.repeat(1024 * 1024);
  const messages: ChatMessage[] = Array.from({ length: 64 }, (_, index) => ({ id: `tool-${index}`, sessionKey: 'fixture',
    role: 'tool', text, createdAt: index }));
  const store = new DeckStore();
  store.replaceMessages('fixture', messages);
  const summaries = store.getMessages('fixture').map(summarizeToolMessage);
  assert.ok(Buffer.byteLength(JSON.stringify(summaries)) < 150_000);
  assert.equal(summaries.every(message => message.text.length === 1000 && message.toolDetailAvailable), true);
  assert.equal(store.getMessages('fixture')[0]?.text.length, 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(store.getEventsSince())) < 200_000);
  store.addMessage({ ...messages[0]!, text: text + 'changed' });
  assert.ok(Buffer.byteLength(JSON.stringify(store.getEventsSince())) < 205_000);
});

test('conversation, tool identity and metadata are preserved, short tools need no detail fetch', () => {
  const message: ChatMessage = { id: 'a', sessionKey: 's', role: 'assistant', text: 'a'.repeat(2000), createdAt: 1 };
  assert.equal(summarizeToolMessage(message), message);
  assert.equal(summarizeToolMessage({ ...message, role: 'tool', text: 'short' }).toolDetailAvailable, false);
  assert.equal(summarizeToolMessage({ ...message, role: 'tool', toolCallId: 'call', turnId: 'turn' }).toolCallId, 'call');
});
