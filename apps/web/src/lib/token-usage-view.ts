import { nativeCacheHitRate, type NativeTokenUsage } from '@agentopsdeck/shared';

export const usageGranularities = [60_000, 300_000, 900_000, 3_600_000, 86_400_000] as const;
export const usageFields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;
export type UsageField = typeof usageFields[number];
export type UsageTotals = Record<UsageField, number | null> & { samples: number | null };
export type UsageModel = UsageTotals & { model: string | null };

// The extra boundary bucket matters for rolling (not midnight-aligned) ranges.
export function allowsUsageGranularity(days: number, bucketMs: number) {
  return Math.ceil(days * 86_400_000 / bucketMs) + 1 <= 745;
}
export function defaultUsageGranularity(days: number) {
  return days < 1 ? 60_000 : days === 1 ? 300_000 : days === 7 ? 3_600_000 : 86_400_000;
}
const empty = (): UsageTotals => ({ samples: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
function add(total: UsageTotals, counts: UsageTotals) {
  for (const field of ['samples', ...usageFields] as const) {
    const a = total[field], b = counts[field];
    const sum = a === null || b === null ? null : a + b;
    total[field] = sum !== null && Number.isSafeInteger(sum) && sum >= 0 ? sum : null;
  }
}
export function usageCacheRate(accounting: NativeTokenUsage['inputAccounting'], total: UsageTotals) {
  return total.inputTokens === null ? null : nativeCacheHitRate(accounting, { ...total, inputTokens: total.inputTokens });
}

/** Aggregate each bucket exactly once; model rows are a breakdown, not extra usage. */
export function summarizeUsage(data: NativeTokenUsage) {
  const totals = empty(), models = new Map<string | null, UsageModel>();
  for (const bucket of data.buckets) {
    add(totals, bucket);
    for (const row of bucket.models ?? [{ ...bucket, model: null }]) {
      const target = models.get(row.model) ?? { ...empty(), model: row.model };
      add(target, row); models.set(row.model, target);
    }
  }
  if (!data.buckets.length) for (const field of ['samples', ...usageFields] as const) totals[field] = null;
  return { totals, models: [...models.values()].sort((a, b) => (b.inputTokens ?? -1) - (a.inputTokens ?? -1)
    || (a.model ?? '').localeCompare(b.model ?? '')) };
}

export function usageTimeline(data: NativeTokenUsage) {
  const byTime = new Map(data.buckets.map(bucket => [bucket.at, bucket]));
  const start = Math.floor(data.from / data.bucketMs) * data.bucketMs;
  const count = Math.min(745, Math.ceil((data.to - start) / data.bucketMs));
  return Array.from({ length: count }, (_, i) => ({ at: start + i * data.bucketMs, bucket: byTime.get(start + i * data.bucketMs) ?? null }));
}

/** Do not draw a line across unobserved intervals or missing provider fields. */
export function usageLineSegments(values: Array<number | null>) {
  const segments: Array<Array<{ index: number; value: number }>> = [];
  let segment: Array<{ index: number; value: number }> = [];
  values.forEach((value, index) => {
    if (value === null) { if (segment.length) segments.push(segment); segment = []; }
    else segment.push({ index, value });
  });
  if (segment.length) segments.push(segment);
  return segments;
}
