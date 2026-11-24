import assert from 'node:assert/strict';
import test from 'node:test';
import { clearOptimisticMessages, hasMatchingRealMessage, mergeMessages, readOptimisticMessages, writeOptimisticMessages } from './optimistic-messages.js';

const baseTime = 1_783_300_000_000;

type TestMessage = {
  id: string;
  role: string;
  text: string;
  createdAt: number;
  status?: string;
  queueVersion?: string;
};

function message(overrides: Partial<TestMessage>): TestMessage {
  return {
    id: 'm1',
    role: 'user',
    text: 'hello',
    createdAt: baseTime,
    ...overrides,
  };
}

test('queued optimistic messages are not removed by same-text transcript rows with different ids', () => {
  const queued = message({ id: 'queued-1', status: 'queued', text: 'please queue this', createdAt: baseTime });
  const transcriptEcho = message({ id: 'transcript-user-row', text: 'please queue this', createdAt: baseTime + 1_000 });

  assert.equal(hasMatchingRealMessage([transcriptEcho], queued), false);
  assert.deepEqual(mergeMessages([transcriptEcho], [queued]).map((item) => item.id), ['transcript-user-row', 'queued-1']);
});

test('queued optimistic messages are replaced only by same-id queue records', () => {
  const queued = message({ id: 'queued-1', status: 'queued', text: 'please queue this', createdAt: baseTime });
  const sameQueueRecord = message({ id: 'queued-1', status: 'queued', text: 'please queue this', createdAt: baseTime + 1_000 });

  assert.equal(hasMatchingRealMessage([sameQueueRecord], queued), true);
  assert.deepEqual(mergeMessages([sameQueueRecord], [queued]).map((item) => item.id), ['queued-1']);
});

test('sending messages cannot disappear against a previous same-text turn before admission', () => {
  const sending = message({ id: 'local-1', status: 'sending', text: 'hello sent', createdAt: baseTime });
  const transcriptEcho = message({ id: 'transcript-user-row', text: 'hello sent', createdAt: baseTime + 1_000 });

  assert.equal(hasMatchingRealMessage([transcriptEcho], sending), false);
  assert.deepEqual(mergeMessages([transcriptEcho], [sending]).map((item) => item.id), ['transcript-user-row', 'local-1']);
});

test('unknown delivery cannot be erased by an older same-text transcript', () => {
  const unknown = message({ id: 'local:command', status: 'outcome_unknown' });
  const prior = message({ id: 'previous-send' });
  assert.equal(hasMatchingRealMessage([prior], unknown), false);
  assert.equal(mergeMessages([prior], [unknown]).length, 2);
  assert.equal(hasMatchingRealMessage([{ ...prior, id: unknown.id }], unknown), true);
});

test('unversioned late history cannot erase an admission or duplicate its bubble', () => {
  const accepted = message({ status: 'queued', queueVersion: 'opaque-v1' });
  const old = message({ status: 'queued' });
  assert.equal(hasMatchingRealMessage([old], accepted), false);
  assert.deepEqual(mergeMessages([old], [accepted]), [accepted]);
  const edited = message({ status: 'queued', text: 'edited', queueVersion: 'opaque-v2' });
  assert.deepEqual(mergeMessages([edited], [accepted]), [edited]);
  assert.equal(hasMatchingRealMessage([message({ status: 'sent' })], accepted), true);
});

test('pending queue stays below newer output, then actual dispatch time owns history order', () => {
  const first = message({ id: 'first', status: 'queued', createdAt: baseTime });
  const second = message({ id: 'second', status: 'queued', createdAt: baseTime + 1 });
  const reply = message({ id: 'reply', role: 'assistant', createdAt: baseTime + 500 });
  assert.deepEqual(mergeMessages([second, reply, first], []).map(row => row.id), ['reply', 'first', 'second']);
  const sent = { ...first, status: 'sent', createdAt: baseTime + 1000 };
  const response = message({ id: 'response', role: 'assistant', createdAt: baseTime + 1100 });
  assert.deepEqual(mergeMessages([sent, reply, response, second], [first]).map(row => row.id), ['reply', 'first', 'response', 'second']);
  assert.equal(mergeMessages([sent], [first])[0]?.createdAt, sent.createdAt);
});

test('R19: optimistic messages persist across layout switches per scope and session', () => {
  clearOptimisticMessages();
  const outgoing = message({ id: 'local:send-1', status: 'sending', text: 'keep me across layout switch' });
  writeOptimisticMessages('scope-a', 'codex:s1', [outgoing]);

  assert.deepEqual(readOptimisticMessages('scope-a', 'codex:s1'), [outgoing]);
  assert.deepEqual(readOptimisticMessages('scope-b', 'codex:s1'), []);
  assert.deepEqual(readOptimisticMessages('scope-a', 'codex:s2'), []);

  clearOptimisticMessages((sk, sc) => sc === 'scope-a' && sk === 'codex:s1');
  assert.deepEqual(readOptimisticMessages('scope-a', 'codex:s1'), []);
});
