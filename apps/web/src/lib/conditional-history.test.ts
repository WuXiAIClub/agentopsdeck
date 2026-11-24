import assert from 'node:assert/strict';
import test from 'node:test';
import { createConditionalHistoryCache, restoreConditionalHistory, restoreHistoryDelta } from './conditional-history.js';

const etag = `W/"history-${'a'.repeat(64)}"`;
const page = { messages: [{ text: 'hello' }], updatedAt: 1, sourceCursor: 'epoch:1', hiddenCount: 50 };
test('304 restores content but advances the current source watermark; missing cursors clear old ones', () => {
  const cache = createConditionalHistoryCache(); cache.put('account/resource/page', etag, page);
  const next = restoreConditionalHistory(cache.get('account/resource/page'), etag, JSON.stringify({ updatedAt: 5, sourceCursor: 'epoch:9' }));
  assert.equal(next.messages, page.messages); assert.equal(next.sourceCursor, 'epoch:9'); assert.equal(next.updatedAt, 5);
  assert.equal((next as typeof page).hiddenCount, 50);
  assert.equal(restoreConditionalHistory(cache.get('account/resource/page'), etag, '{"updatedAt":6,"sourceCursor":null}').sourceCursor, undefined);
});
test('validators must match the retained account/resource/page and valid response metadata', () => {
  const cache = createConditionalHistoryCache(); cache.put('a', etag, page);
  assert.throws(() => restoreConditionalHistory(cache.get('b'), etag, '{}'));
  assert.throws(() => restoreConditionalHistory(cache.get('a'), 'other', '{}'));
  for (const meta of [null, '{}', 'null', '{"updatedAt":3}', '{"updatedAt":"3","sourceCursor":null}'])
    assert.throws(() => restoreConditionalHistory(cache.get('a'), etag, meta));
  cache.clear(); assert.equal(cache.get('a'), undefined);
});
test('cache has byte and entry bounds, uses LRU, and does not retain oversized or old-server pages', () => {
  const size = JSON.stringify(page).length * 2;
  const cache = createConditionalHistoryCache(size * 2, 2);
  cache.put('a', etag, page); cache.put('b', etag, page); cache.get('a'); cache.put('c', etag, page);
  assert.equal(cache.get('b'), undefined); assert.ok(cache.get('a')); assert.ok(cache.get('c'));
  cache.put('c', etag, { ...page, messages: ['x'.repeat(size * 2)] }); assert.equal(cache.get('c'), undefined);
  cache.put('a', null, page); assert.equal(cache.get('a'), undefined);
  const disabled = createConditionalHistoryCache(size * 2, 0);
  disabled.put('a', etag, page); assert.equal(disabled.get('a'), undefined);
});

test('delta reconstructs the exact window and rejects invalid bases, references, metadata and expansion bombs', () => {
  const cache = createConditionalHistoryCache();
  const original = { ...page, messages: [{ id: 'a', text: 'hello' }, { id: 'b', text: 'old' }] };
  cache.put('a', etag, original); const entry = cache.get('a')!;
  const delta = { historyDelta: 1, base: etag, slots: [1, { id: 'a', text: 'edited' }], metadata: { updatedAt: 2, sourceCursor: 'e:2', hiddenCount: 12 } };
  assert.deepEqual(restoreHistoryDelta(entry, delta), { ...delta.metadata, messages: [original.messages[1], delta.slots[1]] });
  for (const body of [null, {}, { ...delta, base: 'wrong' }, { ...delta, slots: [-1] }, { ...delta, slots: [2] }, { ...delta, slots: [0.1] },
    { ...delta, slots: [null] }, { ...delta, slots: [{}] }, { ...delta, slots: Array(1001).fill(0) },
    { ...delta, metadata: { updatedAt: 1, messages: [] } }, { ...delta, metadata: { updatedAt: 1, sourceCursor: {} } }])
    assert.throws(() => restoreHistoryDelta(entry, body));
  assert.throws(() => restoreHistoryDelta(undefined, delta));
  assert.throws(() => restoreHistoryDelta(entry, { ...delta, slots: Array(100).fill(0) }, 1024), /size limit/);
  assert.throws(() => restoreHistoryDelta(entry, { ...delta, slots: [], metadata: { updatedAt: 1, padding: 'x'.repeat(1024) } }, 1024), /size limit/);
  assert.deepEqual(entry.page, original, 'reconstruction does not mutate the retained base');
});
