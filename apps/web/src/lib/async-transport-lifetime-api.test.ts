import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { api, json, ApiResponseError, AuthRequiredError, downloadMediaUrl, setRecoveryScope, sourcePreviewUrl, invalidateStreamSnapshotReads } from '../api.js';
import { browserDiagnostics } from './browser-diagnostics.js';

const sourceUrl = `/api/hub/v1/sessions/private-session/messages/private-message/media/${'a'.repeat(64)}`;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(t: TestContext) {
  const oldWindow = globalThis.window, oldFetch = globalThis.fetch;
  const timers = new Map<number, () => void>(), events: string[] = []; let nextTimer = 0;
  Object.assign(globalThis, { window: {
    setTimeout(callback: () => void) { const key = ++nextTimer; timers.set(key, callback); return key; },
    clearTimeout(key: number) { timers.delete(key); }, dispatchEvent(event: Event) { events.push(event.type); },
    location: new URL('https://example.invalid/'), localStorage: { getItem: () => null },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  } });
  setRecoveryScope('a'.repeat(64)); browserDiagnostics.setLevel('debug');
  t.after(() => { setRecoveryScope(undefined); browserDiagnostics.setLevel('errors'); Object.assign(globalThis, { window: oldWindow, fetch: oldFetch }); });
  return { timers, events };
}

for (const envConnectionId of [undefined, 'same']) test(`owner stream reset ${envConnectionId ?? 'global'} cannot cancel another owner's shared history`, async t => {
  fixture(t);
  const release = deferred<void>(), entered = deferred<void>(); let reads = 0;
  const shared = { ownerUserId: 'other-owner', sessionId: 'same:session' };
  globalThis.fetch = async () => {
    if (++reads === 2) entered.resolve();
    await release.promise;
    return Response.json({ messages: [], updatedAt: 1 });
  };
  const originalShared = api.sessionMessages(shared, 180);
  const originalOwned = api.sessionMessages('same:session', 180);
  const rejectedOwned = assert.rejects(originalOwned, { name: 'AbortError' });
  await entered.promise;
  invalidateStreamSnapshotReads(envConnectionId ? { envConnectionId } : {}); release.resolve();
  assert.deepEqual(await originalShared, { messages: [], updatedAt: 1 });
  await rejectedOwned; assert.equal(reads, 2, 'no implicit replay or new polling lane');
});

test('primitive file error bodies retain HTTP status and retry advice', async t => {
  fixture(t);
  for (const body of [null, false, 'unavailable']) {
    globalThis.fetch = async () => Response.json(body, { status: 503, headers: { 'retry-after': '2' } });
    await assert.rejects(api.downloadFile({ type: 'gateway' }, '/private-file'), error =>
      error instanceof ApiResponseError && error.status === 503 && error.retryAfterMs === 2000);
  }
});

test('pre-cancelled actual JSON, source and file requests do not enter fetch or leak listeners', async t => {
  const f = fixture(t), controller = new AbortController(), reason = new DOMException('closed', 'AbortError');
  controller.abort(reason); let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({}); };
  for (const operation of [() => json('/api/sessions/private', { signal: controller.signal }),
    () => sourcePreviewUrl(sourceUrl, controller.signal),
    () => api.downloadFile({ type: 'gateway' }, '/private-file', controller.signal)]) {
    await assert.rejects(operation(), error => error === reason);
    assert.equal(f.timers.size, 0);
  }
  assert.equal(calls, 0);
  assert.ok(browserDiagnostics.read().every(e => e.event === 'request-cancelled'));
});

test('raw download owns timeout through body completion and never repeats the request', async t => {
  const f = fixture(t), entered = deferred<void>(), body = deferred<Blob>(); let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls++;
    const response = new Response('ignored');
    response.blob = () => { entered.resolve(); return body.promise; };
    init!.signal!.addEventListener('abort', () => body.resolve(new Blob(['late-result'])), { once: true });
    return response;
  };
  const request = downloadMediaUrl('/api/private-media'); await entered.promise;
  assert.equal(f.timers.size, 1, 'headers must not release body deadline');
  f.timers.values().next().value!();
  await assert.rejects(request, /Request timed out/);
  assert.equal(f.timers.size, 0); assert.equal(calls, 1);
  assert.equal(browserDiagnostics.read().at(-1)!.event, 'request-timeout');
});

test('explicit file cancellation preserves original reason and removes external listener', async t => {
  const f = fixture(t), entered = deferred<void>(), body = deferred<Blob>(), controller = new AbortController();
  const reason = new DOMException('pane closed', 'AbortError');
  let adds = 0, removes = 0;
  const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args: Parameters<AbortSignal['addEventListener']>) => { adds++; return add(...args); };
  controller.signal.removeEventListener = (...args: Parameters<AbortSignal['removeEventListener']>) => { removes++; return remove(...args); };
  globalThis.fetch = async (_input, init) => {
    const response = new Response('ignored'); response.blob = () => { entered.resolve(); return body.promise; };
    init!.signal!.addEventListener('abort', () => body.resolve(new Blob()), { once: true }); return response;
  };
  const request = api.downloadFile({ type: 'gateway' }, '/private-file', controller.signal);
  await entered.promise; controller.abort(reason);
  await assert.rejects(request, error => error === reason);
  assert.equal(adds, 1); assert.equal(removes, 1); assert.equal(f.timers.size, 0);
});

test('media and file late success/401 cannot return data or log out a new account', async t => {
  const f = fixture(t);
  for (const status of [200, 401]) {
    for (const operation of [() => downloadMediaUrl('/api/private-media'),
      () => api.downloadFile({ type: 'gateway' }, '/private-file')]) {
      setRecoveryScope('a'.repeat(64)); const entered = deferred<void>(), response = deferred<Response>();
      globalThis.fetch = async () => { entered.resolve(); return response.promise; };
      const request = operation(); await entered.promise;
      setRecoveryScope('b'.repeat(64)); response.resolve(new Response('private-content', { status }));
      await assert.rejects(request, AuthRequiredError);
      assert.deepEqual(f.events, []); assert.deepEqual(browserDiagnostics.read(), []);
      assert.equal(f.timers.size, 0);
    }
  }
});

test('source and download reject account changes during body consumption, not just headers', async t => {
  const f = fixture(t);
  for (const source of [false, true]) {
    setRecoveryScope('a'.repeat(64)); const entered = deferred<void>(), release = deferred<void>();
    globalThis.fetch = async () => {
      if (!source) { const r = new Response(); r.blob = async () => { entered.resolve(); await release.promise; return new Blob(['private']); }; return r; }
      return new Response(new ReadableStream({ async pull(stream) {
        entered.resolve(); await release.promise;
        stream.enqueue(new TextEncoder().encode(JSON.stringify({ path: 'private.md', text: 'secret', startLine: 1, line: 1, totalLines: 1, modifiedAt: 1 })));
        stream.close();
      } }, { highWaterMark: 0 }));
    };
    const request = source ? sourcePreviewUrl(sourceUrl, new AbortController().signal) : downloadMediaUrl('/api/private-media');
    await entered.promise; setRecoveryScope('b'.repeat(64)); release.resolve();
    await assert.rejects(request, AuthRequiredError); assert.equal(f.timers.size, 0);
  }
});

test('malformed successful mutation response is unknown, not empty success or automatic replay', async t => {
  fixture(t); let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('<html>proxy-secret</html>'); };
  await assert.rejects(json('/api/sessions/private/messages', { method: 'POST', body: 'private-message' }),
    error => error instanceof ApiResponseError && error.status === 502 && !error.message.includes('proxy-secret'));
  assert.equal(calls, 1);
  assert.equal(browserDiagnostics.read().at(-1)!.event, 'request-format');
  assert.doesNotMatch(JSON.stringify(browserDiagnostics.read()), /private|proxy|message/);
  globalThis.fetch = async () => { calls++; return Response.json({ invalid: true }, { status: 202 }); };
  await assert.rejects(json('/api/hub/v1/sessions/private/messages?limit=80', { conditionalHistory: true }),
    error => error instanceof ApiResponseError && error.status === 502);
  assert.equal(calls, 2);
  assert.equal(browserDiagnostics.read().at(-1)!.event, 'request-format');
});

test('204 remains compatible; proxy failures preserve HTTP status/backoff without retrying writes', async t => {
  const f = fixture(t); let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(null, { status: 204 }); };
  assert.equal(await json('/api/sessions/private', { method: 'DELETE' }), undefined);
  for (const status of [429, 503]) {
    globalThis.fetch = async () => { calls++; return new Response('proxy-error', { status, headers: { 'retry-after': '3' } }); };
    await assert.rejects(json('/api/sessions/private/messages', { method: 'POST' }),
      error => error instanceof ApiResponseError && error.status === status && error.retryAfterMs === 3000);
    await assert.rejects(api.downloadFile({ type: 'gateway' }, '/private-file'),
      error => error instanceof ApiResponseError && error.status === status && error.retryAfterMs === 3000);
  }
  assert.equal(calls, 5); assert.equal(f.timers.size, 0);
});

test('JSON late 401 during body parse cannot invalidate new account, drafts or diagnostics', async t => {
  const f = fixture(t), entered = deferred<void>(), release = deferred<void>();
  globalThis.fetch = async () => { const response = Response.json({ error: 'unauthorized' }, { status: 401 });
    response.json = async () => { entered.resolve(); await release.promise; return { error: 'unauthorized' }; }; return response; };
  const request = json('/api/sessions/private'); await entered.promise;
  setRecoveryScope('b'.repeat(64)); release.resolve(); await assert.rejects(request, AuthRequiredError);
  assert.deepEqual(f.events, []); assert.deepEqual(browserDiagnostics.read(), []); assert.equal(f.timers.size, 0);
});
