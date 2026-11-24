import assert from 'node:assert/strict';
import test from 'node:test';
import { api, setRecoveryScope, invalidateSnapshotReads, invalidateStreamSnapshotReads, invalidateSessionSnapshotReads } from '../api.js';

test('message transport revalidates, coalesces panes, fences scope/reset, and never converts errors into cached success', async t => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const storage = new Map<string, string>();
  Object.assign(globalThis, { window: {
    setTimeout, clearTimeout, dispatchEvent() {}, location: { hostname: 'example.invalid', protocol: 'https:' },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  } });
  t.after(() => { setRecoveryScope(undefined); globalThis.fetch = originalFetch; Object.assign(globalThis, { window: originalWindow }); });
  const etag = `W/"history-${'a'.repeat(64)}"`, session = 'connection:Y29kZXg6dGVzdA';
  const page = { messages: [{ id: 'one', sessionKey: session, role: 'assistant', text: 'hello', createdAt: 1 }], updatedAt: 1, sourceCursor: 'epoch:1' };
  const calls: Array<{ path: string; validator: string | null }> = [];
  let status = 200;
  let hold: Promise<void> | undefined;
  globalThis.fetch = async (input, init) => {
    const validator = new Headers(init?.headers).get('if-none-match');
    calls.push({ path: String(input), validator });
    const response = status === 200
      ? validator ? new Response(null, { status: 304, headers: { etag, 'x-agentopsdeck-history-meta': '{"updatedAt":2,"sourceCursor":"epoch:2"}' } })
        : Response.json(page, { headers: { etag } })
      : Response.json({ error: 'unavailable' }, { status });
    await hold;
    return response;
  };
  setRecoveryScope('a'.repeat(64));
  const [one, two] = await Promise.all([api.sessionMessages(session), api.sessionMessages(session)]);
  assert.equal(calls.length, 1); assert.deepEqual(one, two); assert.equal(calls[0]!.validator, null);
  assert.deepEqual(api.cachedSessionMessages(session), one);
  assert.equal(calls.length, 1, 'navigation cache is an explicit no-request operation');
  const same = await api.sessionMessages(session);
  assert.equal(calls[1]!.validator, etag); assert.deepEqual(same.messages, one.messages); assert.equal(same.sourceCursor, 'epoch:2');
  await api.sessionMessages(session, 8);
  assert.equal(calls.at(-1)!.validator, null, 'different window has a different cache entry');
  await api.sessionMessages(session, 200, undefined, 'older');
  assert.equal(calls.at(-1)!.validator, null, 'older-page cache cannot replace latest');
  for (const error of [503, 403, 401]) {
    status = error; await assert.rejects(api.sessionMessages(session));
    assert.equal(api.cachedSessionMessages(session), undefined, 'errors evict navigation success too');
    status = 200; await api.sessionMessages(session);
    assert.equal(calls.at(-1)!.validator, null, 'failure evicts transport entry and never returns stale success');
  }
  invalidateSnapshotReads(); assert.equal(api.cachedSessionMessages(session), undefined); await api.sessionMessages(session);
  assert.equal(calls.at(-1)!.validator, null, 'reset forces full snapshot');
  let release!: () => void;
  hold = new Promise(resolve => { release = resolve; });
  const stale = api.sessionMessages(session);
  setRecoveryScope('b'.repeat(64)); release();
  await assert.rejects(stale, /Authenticated account changed/); hold = undefined;
  await api.sessionMessages(session); assert.equal(calls.at(-1)!.validator, null, 'account switch cannot seed another account');
  storage.set('agentopsdeck.apiBaseUrl', 'https://other.example.invalid');
  await api.sessionMessages(session); assert.equal(calls.at(-1)!.validator, null, 'Hub origin is part of cache identity');
});

test('actual message API reconstructs negotiated deltas and recovers with full reads after invalid deltas/reset', async t => {
  const originalWindow = globalThis.window, originalFetch = globalThis.fetch;
  Object.assign(globalThis, { window: { setTimeout, clearTimeout, dispatchEvent() {},
    location: { hostname: 'example.invalid', protocol: 'https:' }, localStorage: { getItem: () => null },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } } });
  t.after(() => { setRecoveryScope(undefined); globalThis.fetch = originalFetch; Object.assign(globalThis, { window: originalWindow }); });
  setRecoveryScope('c'.repeat(64));
  const session = 'connection:Y29kZXg6dGVzdA';
  const firstTag = `W/"history-${'a'.repeat(64)}"`, secondTag = `W/"history-${'b'.repeat(64)}"`;
  const first = { messages: [{ id: 'a', sessionKey: session, role: 'assistant', text: 'first', createdAt: 1 }], updatedAt: 1 };
  let invalid = false, full = 0;
  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-agentopsdeck-history-delta'), '1');
    if (!headers.has('if-none-match')) { full++; return Response.json(first, { headers: { etag: firstTag } }); }
    return Response.json({ historyDelta: 1, base: headers.get('if-none-match'), slots: invalid ? [99] : [0, { ...first.messages[0], id: 'b', text: 'new' }],
      metadata: { updatedAt: 2, sourceCursor: 'e:2' } }, { headers: { etag: secondTag, 'x-agentopsdeck-history-delta': '1' } });
  };
  await api.sessionMessages(session);
  const changed = await api.sessionMessages(session);
  assert.deepEqual(changed.messages.map(message => message.text), ['first', 'new']);
  assert.equal(changed.sourceCursor, 'e:2');
  invalid = true; await assert.rejects(api.sessionMessages(session), /Invalid history delta/);
  await api.sessionMessages(session); assert.equal(full, 2, 'invalid base is evicted before the next read');
  invalidateSnapshotReads(); await api.sessionMessages(session); assert.equal(full, 3);

  // Stream-level invalidations fence navigation cache and in-flight reads while preserving
  // the conditional base ETag so live SSE refreshes receive deltas instead of full payloads.
  invalid = false;
  invalidateStreamSnapshotReads({ envConnectionId: 'connection' });
  assert.equal(api.cachedSessionMessages(session), undefined, 'navigation cache cleared on stream event');
  const deltaAfterStream = await api.sessionMessages(session);
  assert.equal(full, 3, 'SSE stream invalidation retains conditional ETag base for delta negotiation');
  assert.deepEqual(deltaAfterStream.messages.map(message => message.text), ['first', 'new']);

  // Explicit session admission invalidation resets the conditional base for that session.
  invalidateSessionSnapshotReads(session);
  await api.sessionMessages(session);
  assert.equal(full, 4, 'explicit session admission invalidation forces a fresh conditional base');
});
