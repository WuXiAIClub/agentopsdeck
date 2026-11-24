import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { createConditionalHistory } from './conditional-history.js';
import { createConditionalHistoryCache, restoreConditionalHistory, restoreHistoryDelta, HISTORY_DELTA_HEADER } from '@agentopsdeck/shared';

test('conditional history validators and deltas preserve the current session proof, never upgrade cached authority', async () => {
  const respond = createConditionalHistory(), cache = createConditionalHistoryCache();
  const messages = Array.from({ length: 20 }, (_, id) => ({ id: String(id), text: 'stable text '.repeat(100) }));
  let page = { messages, updatedAt: 1, historyStatus: 'cached' as 'cached' | 'verified-session' };
  const app = new Hono();
  app.get('/messages', c => respond(c, page));
  const first = await app.request('/messages', { headers: { [HISTORY_DELTA_HEADER]: '1' } });
  cache.put('page', first.headers.get('etag'), await first.json());
  for (const status of ['cached', 'verified-session', 'verified-session', 'cached', 'cached'] as const) {
    const previous = cache.get('page')!;
    page = { ...page, updatedAt: page.updatedAt + 1, historyStatus: status };
    const response = await app.request('/messages', { headers: { [HISTORY_DELTA_HEADER]: '1', 'if-none-match': previous.etag } });
    const changed = previous.page.historyStatus !== status;
    assert.equal(response.status, changed ? 200 : 304, 'proof transitions must change the validator even for identical messages');
    let restored;
    if (response.status === 304) {
      assert.equal((await response.text()).length, 0);
      restored = restoreConditionalHistory(previous, response.headers.get('etag'), response.headers.get('x-agentopsdeck-history-meta'));
    } else {
      assert.notEqual(response.headers.get('etag'), previous.etag);
      assert.equal(response.headers.get(HISTORY_DELTA_HEADER), '1');
      restored = restoreHistoryDelta(previous, await response.json());
    }
    assert.deepEqual(restored.messages, messages);
    assert.equal(restored.historyStatus, status);
    assert.equal(restored.updatedAt, page.updatedAt);
    assert.equal(restored.sourceCursor, undefined, 'transport must not manufacture a global cursor');
    cache.put('page', response.headers.get('etag'), restored);
  }
});

test('changed pages use exact ordered deltas, including edits, removals, queued reordering and window rollover', async () => {
  const respond = createConditionalHistory();
  const cache = createConditionalHistoryCache();
  let messages = Array.from({ length: 200 }, (_, index) => ({ id: String(index), text: 'unchanged '.repeat(100) }));
  let page = { messages, updatedAt: 1, sourceCursor: 'e:1', hiddenCount: 0, access: { messagesSend: true } };
  const app = new Hono(); app.get('/messages', c => respond(c, page));
  const first = await app.request('/messages', { headers: { [HISTORY_DELTA_HEADER]: '1' } });
  cache.put('page', first.headers.get('etag'), await first.json());
  for (const next of [
    [...messages.slice(0, -1), { id: '199', text: 'streamed new text' }],
    [...messages.slice(1), { id: '200', text: 'new message' }],
    [messages[100]!, ...messages.slice(0, 100), ...messages.slice(101)],
    messages.filter(message => message.id !== '50'),
    [],
  ]) {
    messages = next;
    page = { ...page, messages, updatedAt: page.updatedAt + 1, sourceCursor: `e:${page.updatedAt + 1}`, hiddenCount: 20, access: { messagesSend: false } };
    const previous = cache.get('page')!;
    const response = await app.request('/messages', { headers: { [HISTORY_DELTA_HEADER]: '1', 'if-none-match': previous.etag } });
    assert.equal(response.status, 200);
    const body = await response.json();
    const reconstructed = response.headers.has(HISTORY_DELTA_HEADER) ? restoreHistoryDelta(previous, body) : body;
    assert.deepEqual(reconstructed, page);
    if (messages.length) assert.equal(response.headers.get(HISTORY_DELTA_HEADER), '1');
    cache.put('page', response.headers.get('etag'), reconstructed);
  }
});

test('delta cache is optional, bounded, expires and never crosses page identity', async () => {
  let now = 0;
  const respond = createConditionalHistory(2048, 1, () => now);
  const app = new Hono(); let version = 0;
  app.get('/:page', c => respond(c, { messages: [{ id: 'a', text: 'a'.repeat(2000) }, { id: 'b', text: String(version) }], updatedAt: version }));
  const first = await app.request('/one?limit=200', { headers: { [HISTORY_DELTA_HEADER]: '1' } });
  const headers = { [HISTORY_DELTA_HEADER]: '1', 'if-none-match': first.headers.get('etag')! };
  version++;
  for (const path of ['/two?limit=200', '/one?limit=8', '/one?limit=200&before=b']) {
    const response = await app.request(path, { headers });
    assert.equal(response.headers.get(HISTORY_DELTA_HEADER), null);
  }
  assert.equal((await app.request('/one?limit=200', { headers })).headers.get(HISTORY_DELTA_HEADER), null, 'eviction falls back to full');
  const warm = await app.request('/one?limit=200', { headers: { [HISTORY_DELTA_HEADER]: '1' } });
  headers['if-none-match'] = warm.headers.get('etag')!;
  version++; now = 300_001;
  assert.equal((await app.request('/one?limit=200', { headers })).headers.get(HISTORY_DELTA_HEADER), null, 'expired signature falls back to full');
  assert.equal((await app.request('/one?limit=200', { headers: { 'if-none-match': headers['if-none-match'] } })).headers.get(HISTORY_DELTA_HEADER), null, 'old clients always receive full pages');
  const cold = new Hono(); const noBudget = createConditionalHistory(0);
  cold.get('/', c => noBudget(c, { messages: [{ id: 'a', text: 'a'.repeat(2000) }], updatedAt: 1 }));
  assert.equal((await cold.request('/', { headers })).headers.get(HISTORY_DELTA_HEADER), null);
});

test('200 growing-page polls transfer less than 3% of repeated full JSON bodies with identical reconstructed content', async t => {
  const respond = createConditionalHistory(), cache = createConditionalHistoryCache();
  let tick = 0;
  const stable = Array.from({ length: 199 }, (_, id) => ({ id: String(id), text: Array.from({ length: 16 }, (_, word) => createHash('sha256').update(`${id}:${word}`).digest('hex')).join(' ') }));
  const page = () => ({ messages: [...stable, { id: 'live', text: 'stream '.repeat(tick + 1) }], updatedAt: tick, sourceCursor: `e:${tick}`, revision: String(tick) });
  const app = new Hono(); app.get('/', c => respond(c, page()));
  let fullBytes = 0, actualBytes = 0, fullGzipBytes = 0, actualGzipBytes = 0, deltas = 0;
  for (tick = 0; tick < 200; tick++) {
    const previous = cache.get('page');
    const response = await app.request('/', { headers: { [HISTORY_DELTA_HEADER]: '1', ...(previous ? { 'if-none-match': previous.etag } : {}) } });
    const text = await response.text(); const body = JSON.parse(text);
    const delta = response.headers.get(HISTORY_DELTA_HEADER) === '1';
    const restored = delta ? restoreHistoryDelta(previous, body) : body;
    assert.deepEqual(restored, page());
    fullBytes += Buffer.byteLength(JSON.stringify(page())); actualBytes += Buffer.byteLength(text); if (delta) deltas++;
    fullGzipBytes += gzipSync(JSON.stringify(page())).length; actualGzipBytes += gzipSync(text).length;
    cache.put('page', response.headers.get('etag'), restored);
  }
  assert.equal(deltas, 199); assert.ok(actualBytes < fullBytes * .03);
  assert.ok(actualGzipBytes < fullGzipBytes * .03);
  t.diagnostic(JSON.stringify({ polls: tick, deltas, fullBytes, actualBytes, ratio: actualBytes / fullBytes, fullGzipBytes, actualGzipBytes, gzipRatio: actualGzipBytes / fullGzipBytes }));
});

test('history validates all content/metadata, with independent watermarks and page identities', async () => {
  const conditionalHistory = createConditionalHistory();
  let page = { messages: [{ id: 'm', text: 'unchanged' }], updatedAt: 1, sourceCursor: 'epoch:1', hiddenCount: 2,
    revision: 'r1', limits: { maxMessageChars: 100_000 }, access: { messagesSend: false } };
  const app = new Hono(); app.get('/messages', c => conditionalHistory(c, page));
  const first = await app.request('/messages?limit=200'); const etag = first.headers.get('etag')!;
  assert.equal(first.status, 200); assert.match(etag, /^W\/"history-/); assert.equal(first.headers.get('cache-control'), 'no-store');
  page = { ...page, updatedAt: 2, sourceCursor: 'epoch:9' };
  const same = await app.request('/messages?limit=200', { headers: { 'if-none-match': etag } });
  assert.equal(same.status, 304); assert.equal(await same.text(), '');
  assert.deepEqual(JSON.parse(same.headers.get('x-agentopsdeck-history-meta')!), { updatedAt: 2, sourceCursor: 'epoch:9' });
  for (const path of ['/messages?limit=8', '/messages?limit=200&before=m'])
    assert.equal((await app.request(path, { headers: { 'if-none-match': etag } })).status, 200);
  const original = page;
  for (const change of [{ messages: [{ id: 'm', text: 'changed' }] }, { hiddenCount: 3 },
    { limits: { maxMessageChars: 20_000 } }, { access: { messagesSend: true } }]) {
    page = { ...original, ...change };
    assert.equal((await app.request('/messages?limit=200', { headers: { 'if-none-match': etag } })).status, 200);
  }
});

test('49 unchanged 200-message polls transfer one page body instead of 49', async () => {
  const conditionalHistory = createConditionalHistory();
  const app = new Hono();
  let updatedAt = 0;
  const messages = Array.from({ length: 200 }, (_, id) => ({ id: String(id), text: 'x'.repeat(1000) }));
  app.get('/messages', c => conditionalHistory(c, { messages, updatedAt: ++updatedAt, sourceCursor: `epoch:${updatedAt}` }));
  let etag: string | undefined, bytes = 0, firstBytes = 0;
  for (let poll = 0; poll < 49; poll++) {
    const response = await app.request('/messages?limit=200', etag ? { headers: { 'if-none-match': etag } } : {});
    const size = (await response.arrayBuffer()).byteLength;
    bytes += size; if (!poll) firstBytes = size;
    assert.equal(response.status, poll ? 304 : 200);
    etag = response.headers.get('etag')!;
  }
  assert.equal(bytes, firstBytes);
  assert.ok(bytes < firstBytes * 49 * .021, 'over 97.9% fewer body bytes; headers and changed pages excluded');
});
