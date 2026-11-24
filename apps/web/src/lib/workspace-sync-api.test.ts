import assert from 'node:assert/strict';
import test from 'node:test';
import { api, setRecoveryScope, invalidateSnapshotReads } from '../api.js';
import { setWorkspaceSyncEnabled } from './workspace-sync-preference.js';

test('actual API preserves full/304/delta/coalescing, bypasses previews/pagination, and switches back without reload', async t => {
  const originalWindow = globalThis.window, originalFetch = globalThis.fetch, storage = new Map<string, string>();
  Object.assign(globalThis, { window: { setTimeout, clearTimeout, dispatchEvent() {},
    location: { hostname: 'example.invalid', protocol: 'https:' },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } } });
  t.after(() => { setRecoveryScope(undefined); globalThis.fetch = originalFetch; Object.assign(globalThis, { window: originalWindow }); });
  setRecoveryScope('d'.repeat(64)); setWorkspaceSyncEnabled(true);
  const sessions = Array.from({ length: 6 }, (_, i) => `connection:session${i}`);
  const tag = `W/"history-${'a'.repeat(64)}"`, nextTag = `W/"history-${'b'.repeat(64)}"`;
  const page = (key: string) => ({ messages: [{ id: 'a', sessionKey: key, role: 'assistant', text: 'first', createdAt: 1 }], updatedAt: 1 });
  let batches = 0, direct = 0, phase = 'full';
  globalThis.fetch = async (url, init) => {
    if (!String(url).endsWith('/workspace/sync')) { direct++; return Response.json(page(sessions[0]!)); }
    batches++;
    assert.equal(init?.method, 'POST'); assert.equal(new Headers(init?.headers).get('x-agentopsdeck-recovery-scope'), 'd'.repeat(64));
    const { items } = JSON.parse(String(init?.body));
    const frames = items.map((item: { sessionKey: string; etag?: string }) => {
      if (phase === 'same') { assert.equal(item.etag, tag); return { sessionKey: item.sessionKey, status: 304, headers: { etag: tag, 'x-agentopsdeck-history-meta': JSON.stringify({ updatedAt: 2, sourceCursor: '2' }) } }; }
      if (phase === 'delta') return { sessionKey: item.sessionKey, status: 200, headers: { etag: nextTag, 'x-agentopsdeck-history-delta': '1' },
        body: { historyDelta: 1, base: tag, slots: [0, { id: 'b', sessionKey: item.sessionKey, role: 'assistant', text: 'second', createdAt: 2 }], metadata: { updatedAt: 3 } } };
      if (phase === 'error') return { sessionKey: item.sessionKey, status: 503, body: { error: 'Unavailable' } };
      assert.equal(item.etag, undefined);
      return { sessionKey: item.sessionKey, status: 200, headers: { etag: tag }, body: page(item.sessionKey) };
    });
    return new Response(frames.map((frame: unknown) => JSON.stringify(frame)).join('\n') + '\n', { headers: { 'content-type': 'application/x-ndjson', 'x-agentopsdeck-workspace-sync': '1' } });
  };
  const first = await Promise.all([...sessions, sessions[0]!].map(key => api.sessionMessages(key)));
  assert.equal(batches, 1); assert.deepEqual(first[0], first[6]);
  phase = 'same'; const same = await Promise.all(sessions.map(key => api.sessionMessages(key)));
  assert.equal(same[0]!.sourceCursor, '2'); assert.deepEqual(same[0]!.messages, first[0]!.messages);
  phase = 'delta'; const changed = await Promise.all(sessions.map(key => api.sessionMessages(key)));
  assert.deepEqual(changed[0]!.messages.map(message => message.text), ['first', 'second']);
  assert.equal(batches, 3); assert.equal(direct, 0);
  await api.sessionMessages(sessions[0]!, 8);
  await api.sessionMessages(sessions[0]!, 200, undefined, 'older');
  assert.equal(direct, 2); assert.equal(batches, 3);
  phase = 'error'; await assert.rejects(api.sessionMessages(sessions[0]!), /Unavailable/);
  assert.equal(api.cachedSessionMessages(sessions[0]!), undefined);
  assert.equal(direct, 2, '503 is not hidden behind legacy fallback');
  setWorkspaceSyncEnabled(false); await api.sessionMessages(sessions[0]!); assert.equal(direct, 3);
  setWorkspaceSyncEnabled(true); invalidateSnapshotReads(); phase = 'full';
  await api.sessionMessages(sessions[0]!); assert.equal(batches, 5);

  // A stalled Preview must neither capture message writes nor survive opt-out
  // through the per-session coalescer. Simulate a fetch that ignores abort.
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  let sends = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/workspace/sync')) { began(); return new Promise<Response>(() => {}); }
    if (init?.method === 'POST') { sends++; return Response.json({ ok: true }); }
    direct++; return Response.json(page(sessions[0]!));
  };
  const stalled = api.sessionMessages(sessions[0]!);
  const rejected = assert.rejects(stalled, /cancel|scope changed/i);
  await started;
  await api.sendMessage(sessions[0]!, 'synthetic write while Preview stalls');
  assert.equal(sends, 1, 'sending bypasses the batch read transport');
  setWorkspaceSyncEnabled(false);
  await rejected;
  const resumed = await api.sessionMessages(sessions[0]!);
  assert.equal(resumed.messages[0]!.text, 'first');
});
