import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage } from '@agentopsdeck/shared';
import { createSessionPreviewCache, previewKey, previewActivityVersion, PREVIEW_REFRESH_MS } from './session-preview-cache.js';

const message = (id = '1', text = 'hello'): ChatMessage => ({ id, text, role: 'assistant', sessionKey: 'session', createdAt: 1 });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
test('2900s of unchanged background preview reduces 49 reads to 10, with periodic revalidation', async () => {
  let now = 0, backgroundCalls = 0, previousCalls = 0;
  const cache = createSessionPreviewCache(() => now), previous = createSessionPreviewCache(() => now);
  for (now = 0; now <= 2_900_000; now += PREVIEW_REFRESH_MS) {
    await cache.load('idle', async () => { backgroundCalls++; return [message()]; }, false, false, 'unchanged');
    await previous.load('idle', async () => { previousCalls++; return [message()]; });
  }
  assert.equal(backgroundCalls, 10); assert.equal(previousCalls, 49);
});
test('activity changes, hover and failures keep the short freshness/retry path', async () => {
  let now = 0, calls = 0;
  const cache = createSessionPreviewCache(() => now), load = async () => { calls++; return [message()]; };
  await cache.load('a', load, false, false, 'v1'); now += PREVIEW_REFRESH_MS;
  await cache.load('a', load, false, false, 'v2'); assert.equal(calls, 2);
  now += PREVIEW_REFRESH_MS;
  await cache.load('a', load); assert.equal(calls, 3, 'direct hover does not use the longer background TTL');
  now += PREVIEW_REFRESH_MS;
  const fail = async () => { calls++; throw Object.assign(new Error('denied'), { status: 403 }); };
  await cache.load('a', fail, false, false, 'v2'); assert.deepEqual(cache.peek('a')?.messages, []);
  await cache.load('a', fail, false, false, 'v3'); assert.equal(calls, 4, 'version change cannot bypass retry backoff');
  now += 30_000; await cache.load('a', load, false, false, 'v3'); assert.equal(calls, 5);
});
test('preview activity tracks conversation changes but not card styling', () => {
  const session = { sessionKey: 's', title: 'one', status: 'idle' as const, recent: 'hello', messageCount: 1 };
  assert.equal(previewActivityVersion(session), previewActivityVersion({ ...session, title: 'renamed', pinned: true }));
  assert.notEqual(previewActivityVersion(session), previewActivityVersion({ ...session, messageCount: 2 }));
});
test('text-only cache bounds entries, text and conversational rows; never retains tool or media data', () => {
  const cache = createSessionPreviewCache(() => 100, 2);
  cache.seed('a', [message()]); cache.seed('b', [message()]);
  cache.seed('c', [message('1'), message('2'), message('3'), message('4'), { ...message('5', 'x'.repeat(9000)), media: [{ type: 'image', name: 'image', url: 'data:image/png;base64,secret' }] }, { ...message('6'), toolName: 'view_image' }]);
  assert.equal(cache.peek('a'), undefined);
  assert.equal(cache.peek('c')?.messages.length, 4);
  assert.equal(cache.peek('c')?.messages.at(-1)?.text.length, 3000);
  assert.equal(JSON.stringify(cache.peek('c')).includes('secret'), false);
});
test('fresh chat seed serves preview without another request; older results cannot replace it', async () => {
  let now = 1000, calls = 0;
  const cache = createSessionPreviewCache(() => now);
  cache.seed('a', [message()]);
  await cache.load('a', async () => { calls++; return []; }); assert.equal(calls, 0);
  now += PREVIEW_REFRESH_MS;
  const promise = cache.load('a', async () => { calls++; await flush(); return [message('old')]; });
  await flush(); now++;
  cache.seed('a', [message('new')]); await promise;
  assert.equal(cache.peek('a')?.messages[0]?.id, 'new'); assert.equal(calls, 1);
});
test('deduplicates preview consumers and limits concurrency; hover promotes queued request', async () => {
  const cache = createSessionPreviewCache(), releases: (() => void)[] = [], seen: string[] = [];
  const loader = (key: string) => async () => { seen.push(key); await new Promise<void>(resolve => releases.push(resolve)); return [message(key)]; };
  const a = cache.load('a', loader('a'));
  assert.equal(a, cache.load('a', loader('duplicate')));
  const b = cache.load('b', loader('b')), c = cache.load('c', loader('c')), d = cache.load('d', loader('d'));
  cache.load('d', loader('duplicate-d'), false, true);
  await flush(); assert.deepEqual(seen, ['a', 'b']);
  releases.shift()!(); await a; await flush(); assert.deepEqual(seen, ['a', 'b', 'd']);
  releases.shift()!(); await b; await flush();
  releases.splice(0).forEach(resolve => resolve()); await Promise.all([c, d]);
});
test('clear aborts in-flight requests and cancels queued requests; old account response cannot return', async () => {
  const cache = createSessionPreviewCache(Date.now, 4, 1);
  let complete!: (messages: ChatMessage[]) => void, signal!: AbortSignal, called = false;
  const a = cache.load(previewKey('one', 'a'), async s => { signal = s; return new Promise(resolve => { complete = resolve; }); });
  const b = cache.load(previewKey('one', 'b'), async () => { called = true; return []; });
  await flush(); cache.clear(); assert.equal(signal.aborted, true);
  complete([message()]); await Promise.all([a, b]); await flush();
  assert.equal(called, false); assert.equal(cache.peek(previewKey('one', 'a')), undefined);
  assert.notEqual(previewKey('one', 'a'), previewKey('two', 'a'));
});
test('failed reads back off and preserve stale text; forbidden clears text and suppresses summary fallback', async () => {
  let now = 1000, calls = 0;
  const cache = createSessionPreviewCache(() => now);
  cache.seed('a', [message()]); now += PREVIEW_REFRESH_MS;
  const fail = async () => { calls++; throw new Error('offline'); };
  await cache.load('a', fail); await cache.load('a', fail);
  assert.equal(calls, 1); assert.equal(cache.peek('a')?.messages.length, 1);
  await cache.load('a', async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); }, true);
  assert.deepEqual(cache.peek('a')?.messages, []); assert.equal(cache.peek('a')?.denied, true);
});
test('offscreen queued requests are removed without cancelling another active preview', async () => {
  const cache = createSessionPreviewCache(Date.now, 4, 1);
  let release!: () => void, called = false;
  const a = cache.load('a', async () => { await new Promise<void>(resolve => { release = resolve; }); return []; });
  const b = cache.load('b', async () => { called = true; return []; });
  cache.cancelQueued('b'); await b; await flush(); release(); await a;
  assert.equal(called, false); assert.equal(cache.peek('b')?.loading, false);
});
test('authority invalidation advances the seed epoch but preserves unrelated node text', () => {
  const cache = createSessionPreviewCache();
  cache.seed('node-one', [message()]); cache.seed('node-two', [message()]);
  const epoch = cache.epoch(); cache.clear(key => key === 'node-one');
  assert.notEqual(cache.epoch(), epoch); assert.equal(cache.peek('node-one'), undefined);
  assert.equal(cache.peek('node-two')?.messages.length, 1);
});
