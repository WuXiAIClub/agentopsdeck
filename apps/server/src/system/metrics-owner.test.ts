import assert from 'node:assert/strict';
import test from 'node:test';
import { MetricsSampler, type RawMetrics } from './metrics.js';
import { PerformanceDiagnostics } from '../diagnostics/performance.js';
function held<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const raw = (): RawMetrics => ({ scope: 'process', identity: 'synthetic', busy: 1, capacity: 1, clock: 1,
  cores: 1, memory: { usedBytes: 1, totalBytes: null, availableBytes: null }, volumes: [] });
for (const ending of ['success', 'failure', 'timeout'] as const) {
  test(`close after provider ${ending} drains original, not timed HTTP race`, async () => {
    const gate = held<RawMetrics>(), entered = held<AbortSignal>(); let starts = 0;
    const sampler = new MetricsSampler({ kind: 'hub', id: 'synthetic' }, signal => { starts++; entered.resolve(signal); return gate.promise; }, () => 1, 10);
    const sampled = sampler.sample(), signal = await entered.promise;
    const rejected = assert.rejects(sampled, /closed|timed out|PRIVATE/);
    if (ending === 'timeout') await rejected;
    const close = sampler.close(); assert.equal(close, sampler.close()); let drained = false; void close.then(() => { drained = true; });
    await tick(); assert.equal(drained, false); assert.equal(signal.aborted, true);
    await assert.rejects(sampler.sample(), /closed/); assert.equal(starts, 1);
    if (ending === 'failure') gate.reject(Error('PRIVATE late failure')); else gate.resolve(raw());
    await rejected; await close; assert.equal(drained, true);
  });
}
test('close before provider microtask prevents all IO and cached reads cannot reopen', async () => {
  let starts = 0; const sampler = new MetricsSampler({ kind: 'hub', id: 'synthetic' }, async () => { starts++; return raw(); });
  const sampled = sampler.sample(), close = sampler.close(); await assert.rejects(sampled, /closed/); await close; assert.equal(starts, 0);
  const cached = new MetricsSampler({ kind: 'hub', id: 'synthetic' }, async () => raw()); await cached.sample(); await cached.close(); await assert.rejects(cached.sample(), /closed/);
});
test('provider reentrant close owns the already-published original', async () => {
  const gate = held<RawMetrics>(); let sampler!: MetricsSampler, close!: Promise<void>;
  sampler = new MetricsSampler({ kind: 'hub', id: 'synthetic' }, () => { close = sampler.close(); return gate.promise; });
  const sampled = sampler.sample(), observed = assert.rejects(sampled, /closed/); await tick();
  let drained = false; void close.then(() => { drained = true; }); await tick(); assert.equal(drained, false);
  gate.resolve(raw()); await observed; await close; assert.equal(drained, true);
});
for (const timeout of [0, -1, NaN, Infinity, 2_147_483_648]) test(`invalid sampler deadline ${timeout}`, () => {
  assert.throws(() => new MetricsSampler({ kind: 'hub', id: 'synthetic' }, async () => raw(), Date.now, timeout), /timeout/);
});

for (const boundary of ['start', 'admitted', 'finish'] as const) test(`metrics diagnostics reentrant close at ${boundary} cannot restart or cache provider`, async () => {
  let sampler!: MetricsSampler, close: Promise<void> | undefined, starts = 0, observed = false;
  const trigger = () => { if (!observed) { observed = true; close = sampler.close(); } };
  const diagnostics = { start() {
    if (boundary === 'start') trigger();
    return { add(metric: string) { if (boundary === 'admitted' && metric === 'admitted') trigger(); }, reportPending() {},
      finish() { if (boundary === 'finish') trigger(); } };
  } } as unknown as PerformanceDiagnostics;
  sampler = new MetricsSampler({ kind: 'hub', id: 'synthetic' }, async () => { starts++; return raw(); }, Date.now, 1000, diagnostics);
  await assert.rejects(sampler.sample(), /closed/); await close;
  assert.equal(starts, boundary === 'finish' ? 1 : 0);
  await assert.rejects(sampler.sample(), /closed/);
});

test('metrics diagnostic sink failure cannot replace provider result and observations remain redacted', async () => {
  let clock = 0; const lines: string[] = [];
  const diagnostics = new PerformanceDiagnostics(line => { lines.push(line); throw Error('PRIVATE sink failure'); }, () => clock += 1000);
  const sampler = new MetricsSampler({ kind: 'hub', id: 'PRIVATE_SOURCE' }, async () => ({ ...raw(), identity: 'PRIVATE_IDENTITY' }), Date.now, 1000, diagnostics);
  assert.equal((await sampler.sample()).source.id, 'PRIVATE_SOURCE'); await sampler.close();
  const observations = lines.map(line => JSON.parse(line));
  assert.ok(observations.some(item => item.step === 4)); assert.ok(observations.some(item => item.step === 5));
  assert.ok(!JSON.stringify(lines).includes('PRIVATE'));
});
