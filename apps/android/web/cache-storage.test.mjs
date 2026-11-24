import assert from 'node:assert/strict';
import test from 'node:test';
import { createCacheStorage } from './cache-storage.mjs';

const scope = 'a'.repeat(64);
test('deleted entries remain tombstoned until their disk deletion is acknowledged', async () => {
  const { cache, sent, reply } = fixture({ 'agentopsdeck.cache.deleted': 'old' });
  cache.setScope(scope);
  cache.removeItem('agentopsdeck.cache.deleted');
  assert.equal(cache.getItem('agentopsdeck.cache.deleted'), null);
  assert.equal(sent.filter(packet => packet.type === 'cache.get' && packet.key === 'agentopsdeck.cache.deleted').length, 0);
  const pending = cache.flush(); reply(sent.at(-1)); await pending;
  assert.equal(cache.getItem('agentopsdeck.cache.deleted'), null);
});

test('memory eviction keeps durable entries on disk', async () => {
  const { cache, sent, reply } = fixture();
  for (let index = 0; index < 70; index++) {
    cache.setItem(`agentopsdeck.cache.item.${index}`, 'value');
    const pending = cache.flush(); reply(sent.at(-1)); await pending;
  }
  assert.equal(cache.length, 64);
  assert.equal(sent.filter(packet => packet.type === 'cache.write').flatMap(packet => packet.changes).some(change => change.value === null), false);
});

test('transport write batches also limit total payload size', async () => {
  const { cache, sent, reply } = fixture();
  for (let index = 0; index < 4; index++) cache.setItem(`agentopsdeck.cache.large.${index}`, 'x'.repeat(3 * 1024 * 1024));
  const pending = cache.flush();
  assert.equal(sent[0].changes.length, 2);
  reply(sent[0]); await pending;
});

function fixture(initial = {}) {
  const sent = [], timers = new Map(), notified = [];
  let sequence = 0;
  const cache = createCacheStorage(initial, packet => sent.push(packet), (callback, delay) => {
    timers.set(++sequence, { callback, delay }); return sequence;
  }, id => timers.delete(id), key => notified.push(key));
  const reply = (packet, values = {}) => cache.receive({ id: packet.id, ...values });
  return { cache, sent, timers, reply, notified };
}

test('exposes loaded entries synchronously without a startup snapshot', () => {
  const { cache, sent } = fixture({ 'agentopsdeck.cache.a': 'history' });
  assert.equal(cache.length, 1);
  assert.equal(cache.key(0), 'agentopsdeck.cache.a');
  assert.equal(cache.getItem('missing'), null);
  assert.equal(cache.getItem('agentopsdeck.cache.a'), 'history');
  assert.equal(sent.length, 0);
});

test('coalesces writes, excludes secrets and waits for durable acknowledgement', async () => {
  const { cache, sent, reply } = fixture();
  cache.setItem('agentopsdeck.cache.a', 'one'); cache.setItem('agentopsdeck.cache.a', 'two');
  cache.setItem('agentopsdeck.accessKey', 'never persist'); cache.setItem('__probe__', '1'); cache.removeItem('__probe__');
  const pending = cache.flush();
  assert.deepEqual(sent[0].changes, [{ key: 'agentopsdeck.cache.a', value: 'two' }]);
  await cache.flush();
  assert.equal(sent.length, 1);
  reply(sent[0]); await pending;
  await cache.flush(); assert.equal(sent.length, 1);
});

test('an acknowledgement cannot discard a newer edit', async () => {
  const { cache, sent, reply } = fixture();
  cache.setItem('agentopsdeck.cache.a', 'one'); const first = cache.flush();
  cache.setItem('agentopsdeck.cache.a', 'two'); reply(sent[0]); await first;
  const second = cache.flush(); assert.equal(sent[1].changes[0].value, 'two'); reply(sent[1]); await second;
});

test('failed writes remain pending and retry', async () => {
  const { cache, sent, reply } = fixture();
  cache.setItem('agentopsdeck.cache.a', 'one'); const first = cache.flush();
  reply(sent[0], { error: 'disk unavailable' }); await first;
  const second = cache.flush(); assert.equal(sent[1].changes[0].value, 'one'); reply(sent[1]); await second;
  assert.equal(cache.metrics.retries, 1);
});

test('lazy reads are coalesced and announce hydration', async () => {
  const { cache, sent, reply, notified } = fixture();
  cache.setScope(scope);
  const key = `agentopsdeck.cache.v2.${scope}.android.messages.one`;
  assert.equal(cache.getItem(key), null); cache.getItem(key);
  const reads = sent.filter(packet => packet.key === key); assert.equal(reads.length, 1);
  reply(reads[0], { value: 'saved' }); await cache.load(key);
  assert.equal(cache.getItem(key), 'saved'); assert.deepEqual(notified, [key]);
});

test('a late read cannot overwrite current messages or cross account boundaries', async () => {
  const { cache, sent, reply } = fixture();
  cache.setScope(scope);
  const key = `agentopsdeck.cache.v2.${scope}.android.messages.one`;
  const pending = cache.load(key); const read = sent.at(-1);
  cache.setItem(key, 'new'); reply(read, { value: 'old' }); await pending;
  assert.equal(cache.getItem(key), 'new');
  const late = cache.load('agentopsdeck.cache.other'); const stale = sent.at(-1);
  cache.setScope('b'.repeat(64)); reply(stale, { value: 'wrong account' }); await late;
  assert.equal(cache.getItem('agentopsdeck.cache.other'), null);
});

test('logout clears unloaded disk entries as well as loaded data', async () => {
  const { cache, sent, reply } = fixture({ 'agentopsdeck.cache.a': 'history' });
  const pending = cache.clear(); assert.equal(cache.length, 0);
  assert.equal(sent[0].type, 'cache.clear'); reply(sent[0]); await pending;
});

test('preserves exact history metadata and only reuses it for the authenticated scope', async () => {
  const { cache, sent, reply } = fixture(); cache.setScope(scope);
  const path = '/api/hub/v1/sessions/one/messages?limit=200&before=cursor';
  const etag = `W/"history-${'c'.repeat(64)}"`;
  const page = { messages: [{ id: 'one', text: 'hello' }], sourceCursor: 'cursor', revision: 'r1', updatedAt: 123 };
  cache.saveHistory(scope, path, etag, page);
  assert.deepEqual(await cache.history(scope, path), { path, etag, page });
  assert.equal(await cache.history('b'.repeat(64), path), undefined);
  const pending = cache.flush(); assert.equal(sent.at(-1).changes.length, 1); reply(sent.at(-1)); await pending;
});

test('rejects oversized values before mutating memory and bounds transport batches', async () => {
  const { cache, sent, reply } = fixture();
  assert.throws(() => cache.setItem('agentopsdeck.cache.big', 'x'.repeat(4 * 1024 * 1024 + 1)), { name: 'QuotaExceededError' });
  assert.equal(cache.length, 0);
  for (let index = 0; index < 35; index++) cache.setItem(`agentopsdeck.cache.${index}`, 'value');
  for (let index = 0; index < 3; index++) { const pending = cache.flush(); reply(sent.at(-1)); await pending; }
  assert.deepEqual(sent.map(packet => packet.changes.length), [16, 16, 3]);
});
