import test from 'node:test';
import assert from 'node:assert/strict';
import type { NativeTokenUsage } from '@agentopsdeck/shared';
import { allowsUsageGranularity, defaultUsageGranularity, summarizeUsage, usageCacheRate, usageLineSegments, usageTimeline } from './token-usage-view.js';

const bucket = (at: number, inputTokens = 100, cacheReadTokens: number | null = 20) => ({ at, samples: 1, inputTokens, outputTokens: 10, cacheReadTokens, cacheWriteTokens: 0 });
const data = (buckets: NativeTokenUsage['buckets']): NativeTokenUsage => ({ version: 1, runtime: 'codex', attribution: 'root-agent', coverage: 'partial', timeBasis: 'observed-at', inputAccounting: 'includes-cache', from: 1, to: 240_001, bucketMs: 60_000, observedSince: 1, buckets });
test('overview sums buckets once and model breakdown sums independently', () => {
  const a = { ...bucket(0), models: [{ ...bucket(0), model: 'a' }] };
  const b = { ...bucket(60_000, 300, 40), models: [{ ...bucket(60_000, 300, 40), model: 'b' }] };
  const { totals, models } = summarizeUsage(data([a, b]));
  assert.equal(totals.inputTokens, 400); assert.equal(totals.outputTokens, 20); assert.equal(totals.samples, 2);
  assert.deepEqual(models.map(m => m.model), ['b', 'a']);
  assert.equal(usageCacheRate('includes-cache', totals), 0.15);
});
test('same model combines across time and unknown model is preserved', () => {
  const a = { ...bucket(0), models: [{ ...bucket(0), model: 'a' }] };
  const b = { ...bucket(60_000), models: [{ ...bucket(60_000), model: 'a' }] };
  const result = summarizeUsage(data([a, b, bucket(120_000)]));
  assert.equal(result.models.length, 2); assert.equal(result.models[0]?.inputTokens, 200); assert.equal(result.models[1]?.model, null);
});
test('missing cache poisons aggregate cache, not input/output, and never becomes 0%', () => {
  const { totals } = summarizeUsage(data([bucket(0), bucket(60_000, 100, null)]));
  assert.equal(totals.cacheReadTokens, null); assert.equal(totals.inputTokens, 200); assert.equal(usageCacheRate('includes-cache', totals), null);
});
test('empty period is unknown while observed zero stays zero', () => {
  assert.equal(summarizeUsage(data([])).totals.inputTokens, null);
  assert.equal(summarizeUsage(data([bucket(0, 0, 0)])).totals.inputTokens, 0);
});
test('aggregate overflow never shows an imprecise integer', () => {
  const totals = summarizeUsage(data([bucket(0, Number.MAX_SAFE_INTEGER), bucket(60_000)])).totals;
  assert.equal(totals.inputTokens, null); assert.equal(totals.outputTokens, 20); assert.equal(usageCacheRate('includes-cache', totals), null);
});
test('cache rate obeys provider accounting and weights tokens, not samples', () => {
  const counts = { samples: 2, inputTokens: 100, outputTokens: 10, cacheReadTokens: 200, cacheWriteTokens: 100 };
  assert.equal(usageCacheRate('excludes-cache', counts), 0.5);
  assert.equal(usageCacheRate('provider-defined', counts), null);
  assert.equal(usageCacheRate('excludes-cache', { ...counts, cacheWriteTokens: null }), null);
});
test('rolling ranges include partial edge buckets, gaps are not zero', () => {
  const timeline = usageTimeline(data([bucket(0), bucket(120_000)]));
  assert.deepEqual(timeline.map(t => t.at), [0, 60_000, 120_000, 180_000, 240_000]);
  assert.equal(timeline[1]?.bucket, null); assert.equal(timeline[0]?.bucket?.inputTokens, 100);
});
test('trend segments stop at gaps and retain observed zero and isolated points', () => {
  assert.deepEqual(usageLineSegments([null, 0, 10, null, 20, null]), [[{ index: 1, value: 0 }, { index: 2, value: 10 }], [{ index: 4, value: 20 }]]);
});
test('granularity options respect API bucket budget including partial boundaries', () => {
  assert.equal(allowsUsageGranularity(1, 60_000), false); assert.equal(allowsUsageGranularity(1, 300_000), true);
  assert.equal(allowsUsageGranularity(7, 900_000), true); assert.equal(allowsUsageGranularity(30, 900_000), false);
  assert.equal(allowsUsageGranularity(30, 3_600_000), true);
  assert.deepEqual([1 / 24, 1, 7, 30].map(defaultUsageGranularity), [60_000, 300_000, 3_600_000, 86_400_000]);
});
