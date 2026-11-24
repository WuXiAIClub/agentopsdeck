import assert from 'node:assert/strict';
import test from 'node:test';
import { api, invalidateSnapshotReads, setRecoveryScope, workspaceSyncMetrics } from '../api.js';
import type { HistoryReadSchedule } from './history-read-scheduler.js';
import { setWorkspaceSyncEnabled } from './workspace-sync-preference.js';
import { HISTORY_ASYNC_HEADER, historyPendingBody } from '@agentopsdeck/shared';

for (const batch of [false, true]) test(`${batch ? 'batch' : 'standard'} history preserves cache while preparing; retries only reads and returns verified messages`, async t => {
  const oldWindow = globalThis.window, oldFetch = globalThis.fetch;
  Object.assign(globalThis, { window: { setTimeout, clearTimeout, dispatchEvent() {},
    location: { hostname: 'example.invalid', protocol: 'https:' },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    localStorage: { getItem() { return null; }, setItem() {} } } });
  t.after(() => { setWorkspaceSyncEnabled(false); setRecoveryScope(undefined); Object.assign(globalThis, { window: oldWindow, fetch: oldFetch }); });
  setRecoveryScope('a'.repeat(64)); setWorkspaceSyncEnabled(batch);
  const key = 'connector:Y29kZXg6c3ludGhldGlj', etag = `W/"history-${'a'.repeat(64)}"`;
  const page = { messages: [{ id: 'm', sessionKey: key, role: 'assistant', text: 'verified', createdAt: 1 }], updatedAt: 1, totalCount: 1, hiddenCount: 0 };
  let preparing = false, reads = 0, writes = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/messages') && init?.method === 'POST') { writes++; return Response.json({ ok: true }); }
    reads++; assert.equal(new Headers(init?.headers).get(HISTORY_ASYNC_HEADER), '1');
    const status = preparing ? 202 : 200, body = preparing ? { ...historyPendingBody(), retryAfterMs: 250 } : page;
    if (batch) {
      const items = JSON.parse(init?.body as string).items;
      if (reads > 1) assert.equal(items[0].etag, etag, 'pending must retain the conditional base');
      return new Response(JSON.stringify({ sessionKey: key, status, body, ...(status === 200 ? { headers: { etag } } : {}) }) + '\n',
        { headers: { 'content-type': 'application/x-ndjson', 'x-agentopsdeck-workspace-sync': '1' } });
    }
    if (reads > 1) assert.equal(new Headers(init?.headers).get('if-none-match'), etag);
    return Response.json(body, { status, ...(status === 200 ? { headers: { etag } } : {}) });
  };
  assert.deepEqual(await api.sessionMessages(key), page);
  preparing = true;
  const pending = api.sessionMessages(key);
  await new Promise(resolve => setTimeout(resolve, batch ? 1700 : 20));
  assert.deepEqual(api.cachedSessionMessages(key), page, 'last message remains available while syncing');
  await api.sendMessage(key, 'synthetic send during history preparation');
  assert.equal(writes, 1, 'send is independent and never retried');
  preparing = false;
  assert.deepEqual(await pending, page);
  assert.ok(reads >= 3);
  if (batch) assert.equal(workspaceSyncMetrics().errors, 0, '202 is not a failed session read');
});

for (const boundary of ['abort', 'transport', 'account'] as const) test(`history preparation stops at ${boundary} without another request`, async t => {
  const oldWindow = globalThis.window, oldFetch = globalThis.fetch;
  Object.assign(globalThis, { window: { setTimeout, clearTimeout, dispatchEvent() {},
    location: { hostname: 'example.invalid', protocol: 'https:' },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    localStorage: { getItem() { return null; }, setItem() {} } } });
  t.after(() => { setWorkspaceSyncEnabled(false); setRecoveryScope(undefined); Object.assign(globalThis, { window: oldWindow, fetch: oldFetch }); });
  setRecoveryScope('b'.repeat(64));
  const key = 'connector:Y29kZXg6c3ludGhldGlj', page = { messages: [], updatedAt: 1, totalCount: 0, hiddenCount: 0 };
  let reads = 0;
  let observed!: () => void;
  const preparing = new Promise<void>(resolve => { observed = resolve; });
  globalThis.fetch = async () => {
    if (++reads === 1) return Response.json(page);
    observed();
    return Response.json({ ...historyPendingBody(), retryAfterMs: 250 }, { status: 202 });
  };
  await api.sessionMessages(key);
  const controller = new AbortController();
  const waiting = api.sessionMessages(key, 200, controller.signal);
  const rejected = assert.rejects(waiting, boundary === 'account' ? /account changed/ : /aborted|transport changed/i);
  await preparing;
  if (boundary === 'abort') controller.abort();
  if (boundary === 'transport') setWorkspaceSyncEnabled(true);
  if (boundary === 'account') setRecoveryScope('c'.repeat(64));
  await rejected;
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(reads, 2);
  if (boundary === 'abort') assert.deepEqual(api.cachedSessionMessages(key), page, 'cancelling a pane must not evict its verified navigation history');
});

for (const boundary of ['abort', 'transport', 'account'] as const) test(`queued automatic history checks ${boundary} before network dispatch`, async t => {
  const oldWindow = globalThis.window, oldFetch = globalThis.fetch;
  Object.assign(globalThis, { window: { setTimeout, clearTimeout, dispatchEvent() {},
    location: { hostname: 'example.invalid', protocol: 'https:' },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    localStorage: { getItem() { return null; }, setItem() {} } } });
  t.after(() => { setRecoveryScope(undefined); Object.assign(globalThis, { window: oldWindow, fetch: oldFetch }); });
  setRecoveryScope('d'.repeat(64));
  let requests = 0, dispatch!: () => void, queued!: () => void;
  const ready = new Promise<void>(resolve => { queued = resolve; });
  const schedule: HistoryReadSchedule = read => new Promise((resolve, reject) => {
    dispatch = () => { void Promise.resolve().then(read).then(resolve, reject); };
    queued();
  });
  schedule.expedite = () => {};
  globalThis.fetch = async () => { requests++; throw Error('must not access network'); };
  const controller = new AbortController();
  const pending = api.sessionMessages('connector:cXVldWVk', 200, controller.signal, undefined, false, schedule);
  const rejected = assert.rejects(pending, boundary === 'account' ? /account changed/ : /aborted|transport changed/i);
  await ready;
  if (boundary === 'abort') controller.abort();
  if (boundary === 'account') setRecoveryScope('e'.repeat(64));
  if (boundary === 'transport') invalidateSnapshotReads();
  dispatch(); await rejected;
  assert.equal(requests, 0);
});
