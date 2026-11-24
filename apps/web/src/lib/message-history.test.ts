import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMessage } from '@agentopsdeck/shared';
import { prependHistory, refreshHistory } from './message-history.js';

const rows = (start: number, end: number): ChatMessage[] => Array.from({ length: end - start }, (_, n) =>
  ({ id: String(start + n), sessionKey: 'session', role: 'assistant', text: String(start + n), createdAt: start + n }));

test('older pages stay visible after fresh live suffix, without fetching an ever-growing limit', () => {
  const current = prependHistory(rows(600, 800), { messages: rows(400, 600), hiddenCount: 400 }, '600')!;
  assert.equal(current.items.length, 400);
  const next = refreshHistory(current, { messages: rows(601, 801), hiddenCount: 601 });
  assert.equal(next.items[0]?.id, '400');
  assert.equal(next.items.at(-1)?.id, '800');
  assert.equal(next.hiddenCount, 400);
  assert.equal(next.items.length, 401);
});

test('identical latest polling retains the auto-filled older page and its anchor', () => {
  let current = prependHistory(rows(600, 800), { messages: rows(400, 600), hiddenCount: 400 }, '600')!;
  for (let poll = 0; poll < 5; poll++) {
    current = refreshHistory(current, { messages: rows(600, 800), hiddenCount: 600 });
    assert.equal(current.items.length, 400);
    assert.equal(current.items[0]?.id, '400');
    assert.equal(current.hiddenCount, 400);
  }
});

test('refresh replaces authoritative suffix and resets safely on missing overlap', () => {
  const current = { items: rows(400, 800), historyExpanded: true };
  const next = refreshHistory(current, { messages: rows(600, 799), hiddenCount: 600 });
  assert.equal(next.items.at(-1)?.id, '798');
  const reset = refreshHistory(current, { messages: rows(900, 1100), hiddenCount: 900 });
  assert.equal(reset.items.length, 200);
  assert.equal(reset.historyExpanded, false);
});

test('late, overlapping and reset pages cannot duplicate or reintroduce history', () => {
  assert.equal(prependHistory(rows(600, 800), { messages: rows(400, 600) }, 'other'), undefined);
  assert.equal(prependHistory(rows(600, 800), { messages: rows(500, 700) }, '600'), undefined);
  assert.equal(prependHistory(rows(0, 200), { messages: [], hiddenCount: 0 }, '0')?.hiddenCount, 0);
});

test('expanded history cannot retain old pending copies after dispatch or cancellation', () => {
  const queued: ChatMessage = { id: 'queue', sessionKey: 'session', role: 'user', text: 'next', createdAt: 450, status: 'queued' };
  const cancelled = { ...queued, id: 'cancelled' };
  const current = { items: [...rows(400, 450), queued, cancelled, ...rows(450, 800)], historyExpanded: true };
  const sent: ChatMessage = { ...queued, status: 'sent', createdAt: 801 };
  const next = refreshHistory(current, { messages: [...rows(601, 801), sent], hiddenCount: 601 });
  assert.equal(next.items.filter(item => item.id === queued.id).length, 1);
  assert.equal(next.items.at(-1), sent);
  assert.equal(next.items.some(item => item.id === cancelled.id), false);
  assert.equal(next.hiddenCount, 400);
  assert.equal(next.items[0]?.id, '400');
});

test('expanded history retains older pages even when latest page shifts past previous anchor item', () => {
  const current = { items: rows(400, 800), historyExpanded: true };
  // Suppose item 600 was a temporary item removed in the new page [599, 601..800]
  const pageMessages = [rows(599, 600)[0]!, ...rows(601, 801)];
  const next = refreshHistory(current, { messages: pageMessages, hiddenCount: 600 });
  assert.equal(next.items[0]?.id, '400');
  assert.equal(next.items.at(-1)?.id, '800');
});
