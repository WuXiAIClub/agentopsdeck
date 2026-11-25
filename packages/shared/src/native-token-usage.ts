/** Only native numeric observations. No context-size estimates or pricing. */
export type NativeTokenCounts = { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
export type NativeModelTokens = { model: string | null; samples: number; inputTokens: number; outputTokens: number; cacheReadTokens: number | null; cacheWriteTokens: number | null };
export const nativeModelId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value);
/** Session-lifetime evidence, independent of the selected time range. The first
 * snapshot is not a time-bucket sample; a null baseline means legacy unknown. */
export type NativeCumulativeCoverage = {
  trackedSince: number;
  initialBaseline: (NativeTokenCounts & { observedAt: number }) | null;
  lastRegressionAt: number | null;
  lastCacheGapAt: number | null;
};
export type NativeTokenUsage = {
  version: 1;
  runtime: 'codex' | 'claude-code' | 'ghcp' | 'antigravity';
  attribution: 'root-agent';
  timeBasis: 'observed-at';
  coverage: 'partial';
  inputAccounting: 'includes-cache' | 'excludes-cache' | 'provider-defined';
  from: number; to: number; bucketMs: number;
  observedSince: number | null;
  cumulativeCoverage?: NativeCumulativeCoverage;
  buckets: Array<{ at: number; samples: number; inputTokens: number; outputTokens: number; cacheReadTokens: number | null; cacheWriteTokens: number | null; models?: NativeModelTokens[] }>;
};

const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const timestamp = (value: unknown): value is number => integer(value) && value <= 8_640_000_000_000_000;
export function validateNativeCumulativeCoverage(value: unknown): NativeCumulativeCoverage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid native cumulative coverage');
  const row = value as NativeCumulativeCoverage;
  if (!timestamp(row.trackedSince)
    || row.lastRegressionAt !== null && (!timestamp(row.lastRegressionAt) || row.lastRegressionAt < row.trackedSince)
    || row.lastCacheGapAt !== null && (!timestamp(row.lastCacheGapAt) || row.lastCacheGapAt < row.trackedSince)) throw Error('Invalid native cumulative coverage');
  const baseline = row.initialBaseline;
  if (baseline !== null && (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)
    || baseline.observedAt !== row.trackedSince || !integer(baseline.inputTokens) || !integer(baseline.outputTokens)
    || baseline.cacheReadTokens !== undefined && !integer(baseline.cacheReadTokens)
    || baseline.cacheWriteTokens !== undefined && !integer(baseline.cacheWriteTokens))) throw Error('Invalid native cumulative baseline');
  return { trackedSince: row.trackedSince, lastRegressionAt: row.lastRegressionAt, lastCacheGapAt: row.lastCacheGapAt,
    initialBaseline: baseline === null ? null : { observedAt: baseline.observedAt, inputTokens: baseline.inputTokens, outputTokens: baseline.outputTokens,
      ...(baseline.cacheReadTokens !== undefined ? { cacheReadTokens: baseline.cacheReadTokens } : {}),
      ...(baseline.cacheWriteTokens !== undefined ? { cacheWriteTokens: baseline.cacheWriteTokens } : {}) } };
}
export function tokenUsageRange(from: unknown, to: unknown, bucketMs: unknown) {
  const parse = (value: unknown) => typeof value === 'string' && /^\d{1,16}$/.test(value) ? Number(value) : value;
  const start = parse(from), end = parse(to), bucket = parse(bucketMs);
  if (!integer(start) || !integer(end) || end <= start || end - start > 31 * 86_400_000
    || !integer(bucket) || ![60_000, 300_000, 900_000, 3_600_000, 86_400_000].includes(bucket)
    || Math.ceil(end / bucket) - Math.floor(start / bucket) > 745) throw Error('Invalid token usage range');
  return { from: start, to: end, bucketMs: bucket };
}

/** Connector responses are untrusted. Project numeric fields only and require
 * ordered, unique, bounded buckets; never accept provider text or estimates. */
export function validateNativeTokenUsage(value: unknown): NativeTokenUsage {
  if (!value || typeof value !== 'object') throw Error('Invalid native token usage');
  const row = value as NativeTokenUsage;
  const range = tokenUsageRange(row.from, row.to, row.bucketMs);
  if (row.cumulativeCoverage !== undefined && row.runtime !== 'codex') throw Error('Invalid cumulative coverage runtime');
  const cumulativeCoverage = row.cumulativeCoverage === undefined ? undefined : validateNativeCumulativeCoverage(row.cumulativeCoverage);
  const accounting = { codex: 'includes-cache', 'claude-code': 'excludes-cache', ghcp: 'provider-defined', antigravity: 'provider-defined' } as const;
  if (row.version !== 1 || !Object.hasOwn(accounting, row.runtime) || row.inputAccounting !== accounting[row.runtime]
    || row.attribution !== 'root-agent' || row.timeBasis !== 'observed-at' || row.coverage !== 'partial'
    || row.observedSince !== null && !integer(row.observedSince) || !Array.isArray(row.buckets) || row.buckets.length > 745) throw Error('Invalid native token usage');
  let previous = -1;
  let modelRows = 0;
  const buckets = row.buckets.map(bucket => {
    if (!bucket || !integer(bucket.at) || bucket.at % range.bucketMs !== 0 || bucket.at <= previous
      || bucket.at < Math.floor(range.from / range.bucketMs) * range.bucketMs || bucket.at >= range.to
      || !integer(bucket.samples) || bucket.samples === 0 || !integer(bucket.inputTokens) || !integer(bucket.outputTokens)
      || bucket.cacheReadTokens !== null && !integer(bucket.cacheReadTokens)
      || bucket.cacheWriteTokens !== null && !integer(bucket.cacheWriteTokens)) throw Error('Invalid native token bucket');
    previous = bucket.at;
    if (bucket.models !== undefined && !Array.isArray(bucket.models)) throw Error('Invalid native model buckets');
    const models = bucket.models?.map(model => {
      if (++modelRows > 8192 || !model || model.model !== null && !nativeModelId(model.model)
        || !integer(model.samples) || model.samples === 0 || !integer(model.inputTokens) || !integer(model.outputTokens)
        || model.cacheReadTokens !== null && !integer(model.cacheReadTokens)
        || model.cacheWriteTokens !== null && !integer(model.cacheWriteTokens)) throw Error('Invalid native model bucket');
      return { model: model.model, samples: model.samples, inputTokens: model.inputTokens, outputTokens: model.outputTokens,
        cacheReadTokens: model.cacheReadTokens, cacheWriteTokens: model.cacheWriteTokens };
    });
    if (models) {
      if (!models.length || new Set(models.map(m => m.model)).size !== models.length) throw Error('Invalid native model buckets');
      for (const field of ['samples', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
        const sum = models.some(m => m[field] === null) ? null : models.reduce((n, m) => n + m[field]!, 0);
        if (sum !== bucket[field]) throw Error('Native model totals mismatch');
      }
    }
    return { at: bucket.at, samples: bucket.samples, inputTokens: bucket.inputTokens, outputTokens: bucket.outputTokens,
      cacheReadTokens: bucket.cacheReadTokens, cacheWriteTokens: bucket.cacheWriteTokens, ...(models ? { models } : {}) };
  });
  return { version: 1, runtime: row.runtime, attribution: 'root-agent', timeBasis: 'observed-at', coverage: 'partial',
    inputAccounting: accounting[row.runtime], ...range, observedSince: row.observedSince, buckets,
    ...(cumulativeCoverage ? { cumulativeCoverage } : {}) };
}

/** Token-weighted cache hit rate, NOT requests hit / requests made. Unknown
 * provider accounting or missing components must never become a fabricated 0%. */
export function nativeCacheHitRate(accounting: NativeTokenUsage['inputAccounting'], counts: Pick<NativeModelTokens, 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): number | null {
  if (accounting === 'provider-defined' || counts.cacheReadTokens === null) return null;
  if (accounting === 'excludes-cache' && counts.cacheWriteTokens === null) return null;
  const total = accounting === 'includes-cache' ? counts.inputTokens : counts.inputTokens + counts.cacheReadTokens + counts.cacheWriteTokens!;
  return Number.isSafeInteger(total) && total > 0 && counts.cacheReadTokens <= total ? counts.cacheReadTokens / total : null;
}
