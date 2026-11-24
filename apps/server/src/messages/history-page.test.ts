import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMessage } from '@agentopsdeck/shared';
import { historyPage } from './history-page.js';
import { DeckStore } from '../projection/deck-store.js';

const rows = Array.from({ length: 1200 }, (_, id): ChatMessage =>
  ({ id: `message:${id}`, sessionKey: 'own', role: 'assistant', text: String(id), createdAt: id }));
test('stable history anchors page past 500 without duplicates during live appends', () => {
  let page = historyPage(rows, 200)!;
  const ids = page.messages.map(message => message.id);
  const growing = [...rows, { ...rows[0]!, id: 'new' }];
  while (page.hiddenCount) {
    page = historyPage(growing, 200, page.messages[0]!.id)!;
    ids.unshift(...page.messages.map(message => message.id));
  }
  assert.deepEqual(ids, rows.map(message => message.id));
  assert.equal(new Set(ids).size, 1200);
});
test('missing or foreign anchors do not fall back to latest history', () => {
  assert.equal(historyPage(rows, 200, 'foreign-message'), undefined);
  assert.deepEqual(historyPage(rows, 200, rows[0]!.id)?.messages, []);
});

test('old pending input stays in latest page and historical anchors exclude the queue', () => {
  const queued: ChatMessage = { ...rows[0]!, id: 'queued', role: 'user', status: 'queued', createdAt: 1 };
  const input = [queued, ...rows];
  const page = historyPage(input, 200)!;
  assert.equal(page.messages.at(-1)?.id, queued.id);
  assert.equal(page.messages.length, 200);
  assert.equal(page.hiddenCount, 1001);
  const older = historyPage(input, 200, page.messages[0]!.id)!;
  assert.ok(!older.messages.some(message => message.id === queued.id));
  assert.equal(input[0], queued, 'no mutation of store ordering');
});

test('indexed projection pages preserve anchors and invalidate in-place message updates', () => {
  const store = new DeckStore();
  store.replaceMessages('own', rows);
  const check = () => {
    for (const before of [undefined, 'message:0', 'message:400', 'foreign-message', 'queued'])
      assert.deepEqual(store.getMessageHistoryPage('own', 120, before), historyPage(store.getMessages('own'), 120, before));
  };
  check();
  const queued: ChatMessage = { ...rows[0]!, id: 'queued', role: 'user', status: 'queued', createdAt: 1 };
  store.addMessage(queued); check();
  store.addMessage({ ...queued, status: 'sent', text: 'sent' }); check();
  store.removeMessage('own', 'message:400'); check();
  store.replaceMessages('own', rows.slice(0, 10)); check();
});
