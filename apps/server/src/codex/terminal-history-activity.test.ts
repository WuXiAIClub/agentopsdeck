import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeNotificationThread, nativeNotificationTurn, successorItemTurn, terminalHistoryActivity } from './terminal-history-activity.js';

test('terminal readability observer is bounded and does not mistake silence for safe activity', () => {
  const activity = terminalHistoryActivity('thread');
  const current = activity.checkpoint();
  assert.equal(current('head'), false);
  for (let i = 0; i < 10_000; i++) activity.observe('item/agentMessage/delta', { threadId: 'thread', turnId: 'head', delta: 'not retained' });
  assert.equal(current('head'), true);
  assert.equal(current('other'), false);
  const next = activity.checkpoint();
  assert.equal(next('head'), false);
});

for (const [method, params] of [
  ['turn/started', { threadId: 'thread', turn: { id: 'head' } }],
  ['turn/completed', { threadId: 'thread', turn: { id: 'head', status: 'completed' } }],
  ['thread/goal/updated', { threadId: 'thread' }],
  ['thread/status/changed', { threadId: 'thread' }],
  ['item/unknown/delta', { threadId: 'thread', turnId: 'head' }],
  ['item/agentMessage/delta', { threadId: 'thread' }],
  ['item/agentMessage/delta', { turnId: 'head' }],
  ['item/agentMessage/delta', { threadId: 'thread', turnId: 'x'.repeat(513) }],
] as const) {
  test(`${method} ambiguous/lifecycle evidence remains a permanent barrier for this read`, () => {
    const activity = terminalHistoryActivity('thread');
    const current = activity.checkpoint();
    activity.observe(method, params);
    activity.observe('item/agentMessage/delta', { threadId: 'thread', turnId: 'head' });
    assert.equal(current('head'), false);
  });
}

test('mixed turn items remain unsafe; unrelated thread items do not invalidate this terminal read', () => {
  const activity = terminalHistoryActivity('thread');
  const current = activity.checkpoint();
  activity.observe('item/started', { threadId: 'unrelated', turnId: 'elsewhere' });
  activity.observe('item/started', { threadId: 'thread', turnId: 'head' });
  assert.equal(current('head'), true);
  activity.observe('item/completed', { threadId: 'thread', turnId: 'owned' });
  assert.equal(current('head'), false);
});

test('only explicit bounded native turn identity and allowlisted item method is classified', () => {
  assert.equal(successorItemTurn('item/completed', { turn: { id: 'head' } }), 'head');
  assert.equal(successorItemTurn('turn/completed', { turn: { id: 'head' } }), undefined);
  assert.equal(successorItemTurn('item/completed', { item: { turnId: 'head' } }), undefined);
  assert.equal(successorItemTurn('item/completed', { turnId: '' }), undefined);
});

for (const [name, params] of [
  ['turn aliases disagree', { threadId: 'thread', turn: { id: 'head' }, turnId: 'different' }],
  ['thread object disagrees', { threadId: 'thread', thread: { id: 'other' }, turnId: 'head' }],
  ['primary thread alias unrelated', { threadId: 'other', thread: { id: 'thread' }, turnId: 'head' }],
  ['turn thread disagrees', { threadId: 'thread', turn: { id: 'head', threadId: 'other' } }],
  ['item thread disagrees', { threadId: 'thread', item: { threadId: 'other' }, turnId: 'head' }],
  ['empty secondary turn', { threadId: 'thread', turn: { id: 'head' }, turnId: '' }],
  ['null primary turn', { threadId: 'thread', turn: { id: null }, turnId: 'head' }],
  ['nonstring secondary thread', { threadId: 'thread', item: { threadId: 1 }, turnId: 'head' }],
  ['null primary thread', { threadId: null, thread: { id: 'thread' }, turnId: 'head' }],
  ['oversized secondary thread', { threadId: 'thread', thread: { id: 'x'.repeat(513) }, turnId: 'head' }],
] as const) {
  test(`ambiguous native identity (${name}) cannot preserve a protected head or read window`, () => {
    assert.equal(successorItemTurn('item/agentMessage/delta', params), undefined);
    const activity = terminalHistoryActivity('thread');
    const current = activity.checkpoint();
    activity.observe('item/agentMessage/delta', { threadId: 'thread', turnId: 'head' });
    activity.observe('item/agentMessage/delta', params);
    activity.observe('item/agentMessage/delta', { threadId: 'thread', turnId: 'head' });
    assert.equal(current('head'), false, 'later valid traffic cannot erase ambiguity');
  });
}

test('matching redundant aliases and each standalone thread alias remain supported', () => {
  for (const params of [
    { threadId: 'thread' }, { thread: { id: 'thread' } },
    { turn: { id: 'head', threadId: 'thread' } }, { item: { threadId: 'thread' } },
    { threadId: 'thread', thread: { id: 'thread' }, turn: { id: 'head', threadId: 'thread' }, item: { threadId: 'thread' } },
  ]) {
    const event = { ...params, turnId: 'head' };
    assert.equal(successorItemTurn('item/completed', event), 'head');
    assert.equal(nativeNotificationThread(event), 'thread');
    assert.equal(nativeNotificationTurn(event), 'head');
    const activity = terminalHistoryActivity('thread');
    const current = activity.checkpoint();
    activity.observe('item/completed', event);
    assert.equal(current('head'), true);
  }
});

test('conflicting scope cannot bypass the unscoped activity epoch or project a lifecycle turn', () => {
  assert.equal(nativeNotificationThread({ threadId: 'other', thread: { id: 'thread' } }), undefined);
  assert.equal(nativeNotificationThread({ threadId: 'thread', item: { threadId: null } }), undefined);
  assert.equal(nativeNotificationThread({}), undefined);
  assert.equal(nativeNotificationTurn({ turn: { id: 'head' }, turnId: 'other' }), undefined);
  assert.equal(nativeNotificationTurn({ turn: { id: 'head' }, turnId: null }), undefined);
  assert.equal(nativeNotificationTurn({}), undefined);
});
