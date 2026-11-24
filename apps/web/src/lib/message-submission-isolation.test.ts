import assert from 'node:assert/strict';
import test from 'node:test';
import { api, invalidateSnapshotReads, invalidateSessionSnapshotReads, invalidateStreamSnapshotReads, setRecoveryScope, workspaceSyncMetrics, historyCalibrationMetrics } from '../api.js';
import { setWorkspaceSyncEnabled } from './workspace-sync-preference.js';
import { sessionAddress } from './session-address.js';

for (const mode of ['standard', 'batch', 'calibration', 'shared', 'receipt', 'resend-receipt'] as const) {
  test(`${mode}: real message admission fences only its own history, not other reads/caches`, async t => {
    const oldWindow = globalThis.window, oldFetch = globalThis.fetch, oldCustomEvent = globalThis.CustomEvent;
    const storage = new Map<string, string>();
    Object.assign(globalThis, { window: { setTimeout, clearTimeout, addEventListener() {}, dispatchEvent() {},
      location: { hostname: 'example.invalid', protocol: 'https:' },
      localStorage: { getItem: () => null, setItem() {} },
      sessionStorage: { getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } } },
      CustomEvent: class { constructor(readonly type: string) {} } });
    t.after(() => {
      setWorkspaceSyncEnabled(false); setRecoveryScope(undefined);
      Object.assign(globalThis, { window: oldWindow, fetch: oldFetch, CustomEvent: oldCustomEvent });
    });
    setRecoveryScope('e'.repeat(64)); setWorkspaceSyncEnabled(mode === 'batch');
    const { sendMessageWithRecovery, resendUnknownMessage, messageRetryCache } = await import('./message-submission.js');
    const a = mode === 'shared' ? sessionAddress({ ownerUserId: 'owner-a', sessionId: 'connector:a' }).key : 'connector:a';
    const b = 'connector:b', tag = `W/"history-${'a'.repeat(64)}"`;
    const page = (sessionKey: string, updatedAt = 1) => ({ messages: [], updatedAt, totalCount: 0, hiddenCount: 0 });
    let phase = 'warm', writes = 0, oldReads = 0, release!: () => void, observed!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    t.after(() => release());
    const reading = new Promise<void>(resolve => { observed = resolve; });
    const expected = mode === 'batch' || mode === 'calibration' ? 1 : 2;
    const signals: AbortSignal[] = [];
    globalThis.fetch = async (url, init) => {
      const path = String(url);
      if (init?.method === 'POST' && path.endsWith('/messages')) {
        writes++;
        if (mode === 'receipt') throw new Error('synthetic lost POST response');
        return Response.json({ status: 'queued', command: { key: 'synthetic-send', state: 'accepted' } });
      }
      if (path.endsWith('/commands/synthetic-send')) {
        return Response.json({ command: { key: 'synthetic-send', state: 'accepted', result: { status: 200, body: { status: 'queued' } } } });
      }
      const grouped = path.endsWith('/workspace/sync') || path.endsWith('/workspace/check');
      const items: { sessionKey: string; etag?: string }[] = grouped ? JSON.parse(String(init?.body)).items :
        [{ sessionKey: path.startsWith(sessionAddress(a).path + '/') ? a : b,
          etag: new Headers(init?.headers).get('if-none-match') ?? undefined }];
      const currentPhase = phase;
      if (currentPhase === 'held') {
        signals.push(init!.signal!); if (++oldReads === expected) observed();
        await held;
      }
      if (currentPhase === 'fresh') {
        assert.equal(items.length, 1); assert.equal(items[0]!.sessionKey, a);
        assert.equal(items[0]!.etag, undefined, 'post-admission reads cannot reuse an old conditional base');
      }
      if (currentPhase === 'revalidate-b') assert.equal(items[0]!.etag, tag, 'other session keeps its conditional base');
      if (!grouped) return Response.json(page(items[0]!.sessionKey, currentPhase === 'fresh' ? 2 : 1), { headers: { etag: tag } });
      return new Response(items.map(item => JSON.stringify({ sessionKey: item.sessionKey, status: 200,
        body: page(item.sessionKey, currentPhase === 'fresh' ? 2 : 1), headers: { etag: tag } })).join('\n') + '\n',
        { headers: { 'content-type': 'application/x-ndjson', 'x-agentopsdeck-workspace-sync': '1' } });
    };
    await Promise.all([api.sessionMessages(a), api.sessionMessages(b)]);
    phase = 'held';
    const staleA = api.sessionMessages(a, 200, undefined, undefined, mode === 'calibration');
    const resultA = assert.rejects(staleA, /Session history changed/);
    const pendingB = api.sessionMessages(b, 200, undefined, undefined, mode === 'calibration');
    // Avoid waiting for the expected rejection before admission actually occurs.
    await reading;
    if (mode === 'resend-receipt') {
      messageRetryCache.put({ scope: 'e'.repeat(64), sessionKey: a, key: 'synthetic-send', text: 'synthetic', mode: 'web-only', media: [] });
      assert.equal(await resendUnknownMessage(a, 'synthetic-send', async () => { assert.fail('known receipt must not ask to resend'); }), 'recovered');
    } else await sendMessageWithRecovery(a, 'synthetic admission only', 'web-only', [], 'synthetic-send');
    assert.equal(writes, mode === 'resend-receipt' ? 0 : 1); assert.deepEqual(api.cachedSessionMessages(b), page(b));
    assert.equal(api.cachedSessionMessages(a), undefined);
    assert.ok(signals.every(signal => !signal.aborted), 'admission must not reset a shared batch or unrelated fetch');
    phase = 'fresh';
    const freshA = api.sessionMessages(a);
    assert.deepEqual(await freshA, page(a, 2), 'fresh read must not join the held pre-send read');
    release();
    await resultA; assert.deepEqual(await pendingB, page(b));
    assert.deepEqual(api.cachedSessionMessages(a), page(a, 2));
    assert.deepEqual(api.cachedSessionMessages(b), page(b));
    phase = 'revalidate-b'; await api.sessionMessages(b);
    assert.equal(mode === 'calibration' ? historyCalibrationMetrics().cancelled : workspaceSyncMetrics().cancelled, 0);
    invalidateSnapshotReads();
    assert.equal(api.cachedSessionMessages(a), undefined); assert.equal(api.cachedSessionMessages(b), undefined);
  });
}

for (const envConnectionId of ['node', undefined]) test(`owner stream ${envConnectionId ?? 'reset'} fences only its own history; exact shared/account invalidation remains effective`, async t => {
  const oldWindow = globalThis.window, oldFetch = globalThis.fetch;
  Object.assign(globalThis, { window: { setTimeout, clearTimeout, dispatchEvent() {},
    location: { hostname: 'example.invalid', protocol: 'https:' },
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} } } });
  t.after(() => { setRecoveryScope(undefined); Object.assign(globalThis, { window: oldWindow, fetch: oldFetch }); });
  setRecoveryScope('d'.repeat(64)); setWorkspaceSyncEnabled(false);
  const keys = ['node:a', sessionAddress({ ownerUserId: 'owner', sessionId: 'node:b' }).key, 'node-other:a', 'different:a'];
  const page = { messages: [], updatedAt: 1 };
  let held = false, reads = 0, release!: () => void, observed!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  const started = new Promise<void>(resolve => { observed = resolve; });
  const signals: AbortSignal[] = [];
  globalThis.fetch = async (_url, init) => {
    if (held) { signals.push(init!.signal!); if (++reads === keys.length) observed(); await gate; }
    return Response.json(page);
  };
  await Promise.all(keys.map(key => api.sessionMessages(key)));
  held = true;
  const pending = keys.map(key => api.sessionMessages(key));
  // Observe every outcome immediately, including on an assertion failure. A
  // shared resource belongs to another owner even when its connection ID is
  // identical; only its exact feed or a real account reset may invalidate it.
  const settled = Promise.allSettled(pending);
  const invalidated = keys.map((_, index) => index !== 1 && (!envConnectionId || index === 0));
  await started;
  invalidateStreamSnapshotReads(envConnectionId ? { envConnectionId } : {});
  assert.ok(signals.every(signal => !signal.aborted));
  for (const [index, key] of keys.entries()) assert.deepEqual(api.cachedSessionMessages(key), invalidated[index] ? undefined : page);
  release();
  for (const [index, result] of (await settled).entries()) {
    if (invalidated[index]) {
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') assert.match(String(result.reason), /Session history changed/);
    } else {
      assert.equal(result.status, 'fulfilled');
      if (result.status === 'fulfilled') assert.deepEqual(result.value, page);
    }
    assert.deepEqual(api.cachedSessionMessages(keys[index]!), invalidated[index] ? undefined : page, 'late reads cannot restore invalidated history');
  }
  invalidateSessionSnapshotReads(keys[1]!);
  assert.equal(api.cachedSessionMessages(keys[1]!), undefined, 'the exact shared feed still invalidates its own history');
  invalidateSnapshotReads();
  for (const key of keys) assert.equal(api.cachedSessionMessages(key), undefined);
});
