import { nativeModelId, validateNativeTokenUsage, type NativeModelTokens, type NativeTokenUsage } from './native-token-usage.js';

export const NATIVE_TOKEN_EXPORT_LIMIT = 4096;
export type NativeTokenObservation = Omit<NativeModelTokens, 'samples'> & { identity: string; observedAt: number };
export type NativeTokenUsageExport = { version: 1; usage: NativeTokenUsage; observations: NativeTokenObservation[] };
const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** A bounded, complete selected range, never a silently truncated sample.
 * Validate every row against bucket/model totals before allowing a download.
 * Identities are one-way digests, not upstream IDs or authority capabilities. */
export function validateNativeTokenUsageExport(value: unknown): NativeTokenUsageExport {
  const fail = (): never => { throw Error('Invalid native token export'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const raw = value as NativeTokenUsageExport;
  if (raw.version !== 1 || !Array.isArray(raw.observations) || raw.observations.length > NATIVE_TOKEN_EXPORT_LIMIT) return fail();
  const usage = validateNativeTokenUsage(raw.usage), seen = new Set<string>();
  const totals = new Map<string, NativeModelTokens>();
  let previousAt = -1;
  const observations = raw.observations.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.identity !== 'string'
      || !/^[a-f0-9]{64}$/.test(row.identity) || seen.has(row.identity)
      || !integer(row.observedAt) || row.observedAt < usage.from || row.observedAt >= usage.to || row.observedAt < previousAt
      || row.model !== null && !nativeModelId(row.model)
      || !integer(row.inputTokens) || !integer(row.outputTokens)
      || fields.slice(2).some(field => row[field] !== null && !integer(row[field]))) return fail();
    seen.add(row.identity); previousAt = row.observedAt;
    const key = JSON.stringify([Math.floor(row.observedAt / usage.bucketMs) * usage.bucketMs, row.model]);
    const sum = totals.get(key) ?? { model: row.model, samples: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    sum.samples++;
    for (const field of fields) {
      const total = sum[field] === null || row[field] === null ? null : sum[field]! + row[field]!;
      if (total !== null && !integer(total)) return fail();
      if (field === 'cacheReadTokens' || field === 'cacheWriteTokens') sum[field] = total;
      else { if (total === null) return fail(); sum[field] = total; }
    }
    totals.set(key, sum);
    return { identity: row.identity, observedAt: row.observedAt, model: row.model, inputTokens: row.inputTokens,
      outputTokens: row.outputTokens, cacheReadTokens: row.cacheReadTokens, cacheWriteTokens: row.cacheWriteTokens };
  });
  for (const bucket of usage.buckets) {
    if (!bucket.models) return fail();
    for (const model of bucket.models) {
      const key = JSON.stringify([bucket.at, model.model]), sum = totals.get(key);
      if (!sum || sum.samples !== model.samples || fields.some(field => sum[field] !== model[field])) return fail();
      totals.delete(key);
    }
  }
  if (totals.size) return fail();
  return { version: 1, usage, observations };
}
