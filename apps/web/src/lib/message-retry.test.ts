import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommandReceipt, SendMessageResponse } from '@agentopsdeck/shared';
import { MessageRetryCache, inspectMessageRetry, type RetryPayload } from './message-retry.js';
import { CommandJournal, CommandOutcomeUnknownError, sendWithJournal } from './command-recovery.js';
const row = (key: string, text = 'hello'): RetryPayload => ({ scope: 'alice', sessionKey: 'session', key, text, media: [], mode: 'web-only' });
test('resend payloads are bounded, isolated by account/session/key, and explicitly cleared', () => {
  const cache = new MessageRetryCache(2, 24);
  cache.put(row('one')); cache.put(row('two'));
  assert.equal(cache.get('bob', 'session', 'one'), undefined);
  assert.equal(cache.get('alice', 'other', 'one'), undefined);
  cache.put(row('three'));
  assert.equal(cache.get('alice', 'session', 'one'), undefined);
  assert.equal(cache.get('alice', 'session', 'three')?.text, 'hello');
  cache.put(row('too-big', 'x'.repeat(20)));
  assert.equal(cache.get('alice', 'session', 'too-big'), undefined);
  cache.remove('alice', 'session', 'three');
  assert.equal(cache.get('alice', 'session', 'three'), undefined);
  cache.clear(); assert.equal(cache.get('alice', 'session', 'two'), undefined);
});
test('resend preflight recovers acceptance, never infers rejection from a missing receipt', async () => {
  const receipt = { id: 'id', key: 'original', state: 'accepted' as const, createdAt: 1, updatedAt: 1, result: { status: 200, body: { status: 'queued', idempotencyKey: 'delivery' } } };
  assert.equal((await inspectMessageRetry('original', async () => receipt))?.idempotencyKey, 'delivery');
  assert.equal(await inspectMessageRetry('original', async () => { throw Error('offline'); }), undefined);
  assert.equal(await inspectMessageRetry('original', async () => ({ ...receipt, state: 'outcome_unknown' })), undefined);
  await assert.rejects(inspectMessageRetry('other', async () => receipt), /identity mismatch/);
});

test('resend preflight never accepts malformed or unknown result bodies', async () => {
  for (const result of [undefined, { status: 500, body: { status: 'queued' } }, { status: 200, body: { status: 'outcome_unknown' } },
    { status: 200, body: null }, { status: NaN, body: { status: 'queued' } }, { status: 200.5, body: { status: 'queued' } }]) {
    assert.equal(await inspectMessageRetry('original', async () => ({ id: 'id', key: 'original', state: 'accepted', createdAt: 1, updatedAt: 1,
      result } as CommandReceipt)), undefined);
  }
});

test('malformed direct send replies retain the original unknown journal and only query receipts', async () => {
  const scope = 'a'.repeat(64);
  for (const response of [null, [], { status: 'unexpected' }, { status: 'accepted' }, { status: true }, { status: 'outcome_unknown' }]) {
    const saved = new Map<string, string>();
    const journal = new CommandJournal({ getItem: key => saved.get(key) ?? null, setItem: (key, value) => { saved.set(key, value); } });
    let posts = 0, reads = 0;
    await assert.rejects(sendWithJournal(journal, scope, 'session', 'original', async () => {
      posts += 1; return response as SendMessageResponse;
    }, async key => {
      reads += 1;
      return { id: key, key, state: 'outcome_unknown', createdAt: 1, updatedAt: 1 };
    }), CommandOutcomeUnknownError);
    assert.equal(posts, 1); assert.equal(reads, 1);
    assert.equal(journal.list(scope, 'session')[0]?.key, 'original');
    assert.equal(journal.list(scope, 'session')[0]?.state, 'outcome_unknown');
  }
});

test('malformed direct send reply can settle only through its exact accepted receipt', async () => {
  const scope = 'a'.repeat(64);
  const saved = new Map<string, string>();
  const journal = new CommandJournal({ getItem: key => saved.get(key) ?? null, setItem: (key, value) => { saved.set(key, value); } });
  let posts = 0, reads = 0;
  const response = await sendWithJournal(journal, scope, 'session', 'original', async () => {
    posts += 1; return { status: 'unexpected' } as unknown as SendMessageResponse;
  }, async key => {
    reads += 1;
    return { id: key, key, state: 'accepted', createdAt: 1, updatedAt: 1, result: { status: 200, body: { status: 'queued' } } };
  });
  assert.equal(response.status, 'queued');
  assert.equal(posts, 1); assert.equal(reads, 1);
  assert.equal(journal.list(scope, 'session').length, 0);
});
