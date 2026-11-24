import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectorClient } from './connector-client.js';

function deferred() {
  let resolve!: () => void, reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('client awaits both request policy and authority before dispatch', async () => {
  const policy = deferred(), authority = deferred();
  let calls = 0, checks = 0;
  const client = new ConnectorClient('http://connector', 'synthetic', () => {
    calls++; return Response.json({ ok: true });
  }, undefined, undefined, { request: () => policy.promise, authorize: () => { checks++; return authority.promise; } });
  const result = client.json('/identity');
  await tick(); assert.equal(calls, 0); assert.equal(checks, 0);
  policy.resolve(); await tick(); assert.equal(calls, 0); assert.equal(checks, 1);
  authority.resolve(); assert.deepEqual(await result, { ok: true }); assert.equal(calls, 1);
});

for (const phase of ['request', 'preflight', 'headers', 'delivery'] as const) {
  test(`client observes async denial at ${phase} without disclosing JSON`, async () => {
    const denied = Error('revoked'); let checks = 0, dispatched = 0;
    const client = new ConnectorClient('http://connector', 'synthetic', () => {
      dispatched++; return Response.json({ private: true });
    }, undefined, undefined, {
      ...(phase === 'request' ? { request: async () => { throw denied; } } : {}),
      authorize: async () => {
        checks++;
        if (checks === ({ request: 100, preflight: 1, headers: 2, delivery: 3 }[phase])) throw denied;
      },
    });
    await assert.rejects(client.json('/identity'), error => error === denied);
    assert.equal(dispatched, phase === 'request' || phase === 'preflight' ? 0 : 1);
  });
}

for (const outcome of ['resolve', 'reject'] as const) {
  test(`aborted pending policy never dispatches after late ${outcome}`, async () => {
    const policy = deferred(), abort = new AbortController(); let calls = 0, checks = 0;
    const stopped = Error('stopped');
    const client = new ConnectorClient('http://connector', 'synthetic', () => {
      calls++; return Response.json({ ok: true });
    }, undefined, undefined, { request: () => policy.promise, authorize: () => { checks++; } });
    const result = client.json('/identity', { signal: abort.signal });
    const observed = assert.rejects(result, error => error === stopped);
    await tick(); abort.abort(stopped); await observed;
    outcome === 'resolve' ? policy.resolve() : policy.reject(Error('late denial'));
    await tick(); assert.equal(calls, 0); assert.equal(checks, 0);
  });
}

test('pending first authority is bounded without a caller AbortSignal', { timeout: 2000 }, async () => {
  let calls = 0;
  const client = new ConnectorClient('http://connector', 'synthetic', () => {
    calls++; return Response.json({ ok: true });
  }, 50, undefined, { authorize: () => new Promise<void>(() => {}) });
  await assert.rejects(client.json('/identity'), /Deadline exceeded/);
  assert.equal(calls, 0);
});

test('post-response authority uses the original deadline and cancels the body', { timeout: 2000 }, async () => {
  let checks = 0, cancelled = 0;
  const client = new ConnectorClient('http://connector', 'synthetic', () => new Response(
    new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }),
  ), 50, undefined, { authorize: () => ++checks === 2 ? new Promise<void>(() => {}) : undefined });
  await assert.rejects(client.json('/identity'), /Deadline exceeded/);
  await tick(); assert.equal(cancelled, 1);
});

for (const stream of ['events', 'fileBoardEvents', 'fileCardEvents'] as const) {
  test(`${stream} awaits per-frame authority and cancels on async revocation`, async () => {
    const gate = deferred(); let checks = 0, cancelled = 0;
    const client = new ConnectorClient('http://connector', 'synthetic', () => new Response(
      new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(new TextEncoder().encode('id: e1\nevent: update\ndata: {"ok":true}\n\n')); },
        cancel() { cancelled++; },
      }), { headers: { 'content-type': 'text/event-stream' } },
    ), undefined, undefined, { authorize: () => ++checks === 3 ? gate.promise : undefined });
    const signal = new AbortController().signal;
    const feed = stream === 'events' ? client.events(signal)
      : client[stream](['71b7d456-a736-4dfc-a74b-275ac1b2f9be'], signal);
    const frame = feed.next(); let settled = false;
    const observed = frame.then(() => { settled = true; }, error => { settled = true; throw error; });
    const denied = Error('stream revoked');
    const rejected = assert.rejects(observed, error => error === denied);
    await tick(); assert.equal(checks, 3); assert.equal(settled, false);
    gate.reject(denied); await rejected; assert.equal(cancelled, 1);
  });
}

test('media waits for its async chunk guard and aborts pending authority', async () => {
  const gate = deferred(), abort = new AbortController(); let checks = 0, cancelled = 0;
  const client = new ConnectorClient('http://connector', 'synthetic', () => new Response(
    new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array([1, 2, 3])); }, cancel() { cancelled++; },
    }), { headers: { 'content-length': '3' } },
  ));
  const response = await client.media('test', abort.signal, () => ++checks === 3 ? gate.promise : undefined);
  const reader = response.body!.getReader(), result = reader.read();
  const stopped = Error('media stopped'), observed = assert.rejects(result, error => error === stopped);
  await tick(); assert.equal(checks, 3);
  abort.abort(stopped); await observed;
  gate.reject(Error('late authority denial')); await tick();
  assert.equal(cancelled, 1); reader.releaseLock();
});
