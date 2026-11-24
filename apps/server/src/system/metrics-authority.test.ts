import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { SystemMetrics } from '@agentopsdeck/shared';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerMetricsRead } from './metrics-http.js';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function held<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const value: SystemMetrics = { version: 1, source: { kind: 'connector', id: 'synthetic' }, sampledAt: 1,
  scope: 'process', cpu: { percent: null, cores: 1 }, memory: { usedBytes: 1, totalBytes: null, availableBytes: null }, volumes: [] };
const diagnostics = () => new PerformanceDiagnostics(() => {});
test('both metrics authorities await, with no private data on final revocation', async () => {
  const app = new Hono(), initial = held<void>(), final = held<void>(); let checks = 0, samples = 0;
  const routes = registerMetricsRead(app, '/metrics', { sample: async () => { samples++; return value; }, close: async () => {} }, async () => {
    checks++; await initial.promise; return async () => { checks++; await final.promise; throw new HTTPException(403); };
  }, { diagnostics: diagnostics() });
  const read = app.request('/metrics'); await tick(); assert.equal(samples, 0);
  initial.resolve(); await tick(); assert.equal(samples, 1); assert.equal(checks, 2);
  final.resolve(); const response = await read; assert.equal(response.status, 403);
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.doesNotMatch(await response.text(), /usedBytes|synthetic/); await routes.close();
});
for (const phase of [1, 2, 3]) for (const ending of ['timeout', 'abort', 'close'] as const) {
  test(`${ending} metrics phase ${phase}: one deadline, retain original, no dependent dispatch`, async () => {
    const app = new Hono(), gate = held<void>(), entered = held<void>(), abort = new AbortController(); let calls = 0, sampleClosed = false;
    const stage = async (step: number) => { calls++; if (phase === step) { entered.resolve(); await gate.promise; } };
    const routes = registerMetricsRead(app, '/metrics', { sample: async () => { await stage(2); return value; }, close: async () => { sampleClosed = true; } }, async () => {
      await stage(1); return () => stage(3);
    }, { diagnostics: diagnostics(), requestWaitMs: ending === 'timeout' ? 10 : 1000 });
    const read = app.request(new Request('http://synthetic.invalid/metrics', { signal: abort.signal }));
    await entered.promise;
    if (ending === 'abort') abort.abort();
    let closed = false; const close = ending === 'close' ? routes.close() : undefined; if (close) void close.then(() => { closed = true; });
    if (ending !== 'close') { const response = await read; assert.equal(response.status, ending === 'abort' ? 408 : 503); }
    const drain = close ?? routes.close(); void drain.then(() => { closed = true; });
    await tick(); assert.equal(closed, false); assert.equal(sampleClosed, true);
    gate.resolve(); assert.equal((await read).status, ending === 'abort' ? 408 : 503); await drain; assert.equal(calls, phase);
  });
}
test('successful metrics preserve existing public payload', async () => {
  const app = new Hono(); const routes = registerMetricsRead(app, '/metrics', { sample: async () => value, close: async () => {} }, async () => async () => {}, { diagnostics: diagnostics() });
  const response = await app.request('/metrics'); assert.equal(response.status, 200); assert.deepEqual(await response.json(), value); await routes.close();
});
