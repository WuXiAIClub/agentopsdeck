import assert from 'node:assert/strict';
import test from 'node:test';
import { DeckStore } from './deck-store.js';

test('DeckStore maintains O(1) indexed lookups, merged paging, list versions, and watermark summary fields on large sessions', () => {
  const store = new DeckStore();
  const sessionKey = 'codex:large-session';
  store.replaceSessions([{
    key: sessionKey,
    agentId: 'codex',
    source: 'codex',
    label: 'Large Session',
    status: 'idle',
    updatedAt: 1_000,
    rolloutBytes: 245 * 1024 * 1024,
    compactionCount: 22,
    lastTurnCompactions: 16,
    maxTurnCompactions: 18,
  }]);

  const initialSession = store.getSession(sessionKey);
  assert.equal(initialSession?.rolloutBytes, 245 * 1024 * 1024);
  assert.equal(initialSession?.lastTurnCompactions, 16);
  assert.equal(initialSession?.maxTurnCompactions, 18);
  assert.equal(store.getMessageListVersion(sessionKey), 0);

  const count = 5_000;
  const initialMessages = Array.from({ length: count }, (_, index) => ({
    id: `msg-${index}`,
    sessionKey,
    role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    text: `Message body ${index}`,
    status: 'sent' as const,
    createdAt: 10_000 + index * 10,
    updatedAt: 10_000 + index * 10,
  }));
  store.replaceMessages(sessionKey, initialMessages, { authoritative: true });
  const v1 = store.getMessageListVersion(sessionKey);
  assert.ok(v1 > 0);

  assert.equal(store.hasMessage(sessionKey, 'msg-0'), true);
  assert.equal(store.hasMessage(sessionKey, 'msg-4999'), true);
  assert.equal(store.hasMessage(sessionKey, 'msg-missing'), false);
  assert.equal(store.getMessage(sessionKey, 'msg-2500')?.text, 'Message body 2500');

  // Streaming updates in place advance version and invalidate cached pages while preserving O(1) lookup
  const pageBefore = store.getMergedMessageHistoryPage(sessionKey, 20);
  assert.equal(pageBefore?.totalCount, count);
  assert.equal(pageBefore?.messages.at(-1)?.id, 'msg-4999');

  store.addMessage({
    id: 'msg-4999',
    sessionKey,
    role: 'assistant',
    text: 'Message body 4999 + delta',
    status: 'sending',
    createdAt: 10_000 + 4999 * 10,
    updatedAt: 10_000 + 4999 * 10 + 5,
  });
  const v2 = store.getMessageListVersion(sessionKey);
  assert.equal(v2, v1 + 1);
  assert.equal(store.getMessage(sessionKey, 'msg-4999')?.text, 'Message body 4999 + delta');

  // Out-of-order insertion rebuilds index cleanly
  store.addMessage({
    id: 'msg-mid',
    sessionKey,
    role: 'system',
    text: 'Inserted middle marker',
    createdAt: 10_000 + 100 * 10 + 5,
    updatedAt: 10_000 + 100 * 10 + 5,
  });
  assert.equal(store.getMessage(sessionKey, 'msg-mid')?.text, 'Inserted middle marker');
  assert.equal(store.getMessage(sessionKey, 'msg-4999')?.text, 'Message body 4999 + delta');

  const pageAfter = store.getMergedMessageHistoryPage(sessionKey, 20, 'msg-4999');
  assert.equal(pageAfter?.totalCount, count + 1);
  assert.equal(pageAfter?.messages.at(-1)?.id, 'msg-4998');

  // Cached metrics update accurately
  const updatedSession = store.getSession(sessionKey);
  assert.equal(updatedSession?.messageCount, count + 1);
  assert.equal(updatedSession?.rolloutBytes, 245 * 1024 * 1024);
});
