import type { NativeTokenCounts, SessionSummary } from '@agentopsdeck/shared';
import { nativeModelId } from '@agentopsdeck/shared';

export type SdkMetricSample = {
  eventId: string;
  sequence: number;
  model?: string;
  context?: { used: number | null; limit?: number; basis: NonNullable<SessionSummary['contextSampleBasis']> };
  usage?: NonNullable<SessionSummary['nativeUsage']>;
  /** Claude root calls, accepted only after exact reconciliation with result.usage.
   * Time remains result-observed-at, not inferred provider request time. */
  reconciledCalls?: Array<NativeTokenCounts & { id: string; model: string }>;
  compacted?: true;
};
export type SdkCumulativeTotals = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};
export type SdkMetrics = {
  executionId?: string;
  sequence?: number;
  context?: SdkMetricSample['context'];
  usage?: SdkMetricSample['usage'];
  totals?: SdkCumulativeTotals;
  /** Omitted for old sessions whose earlier compactions were not observed. */
  compactionCount?: number;
};
export const metricRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export const metricNumber = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
export const metricId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(value);
const denied = () => new Error('Invalid SDK metric sample');

/** Independent numeric-only IPC. Never copy native provider/errors/tool data. */
export function validateSdkMetricSample(value: unknown): SdkMetricSample {
  if (!metricRecord(value) || !metricId(value.eventId) || !metricNumber(value.sequence) || value.sequence < 1
    || Object.keys(value).some(key => !['eventId', 'sequence', 'context', 'usage', 'compacted', 'model', 'reconciledCalls'].includes(key))) throw denied();
  const sample: SdkMetricSample = { eventId: value.eventId, sequence: value.sequence };
  if (value.model !== undefined) { if (!nativeModelId(value.model)) throw denied(); sample.model = value.model; }
  if (value.context !== undefined) {
    const ctx = value.context;
    if (!metricRecord(ctx) || ctx.used !== null && !metricNumber(ctx.used)
      || ctx.limit !== undefined && (!metricNumber(ctx.limit) || ctx.limit === 0)
      || !['native-context', 'last-request-input', 'post-compaction'].includes(ctx.basis as string)
      || Object.keys(ctx).some(key => !['used', 'limit', 'basis'].includes(key))) throw denied();
    sample.context = { used: ctx.used as number | null, basis: ctx.basis as NonNullable<SessionSummary['contextSampleBasis']>,
      ...(ctx.limit !== undefined ? { limit: ctx.limit as number } : {}) };
  }
  if (value.usage !== undefined) {
    const usage = value.usage;
    if (!metricRecord(usage) || !['last-turn', 'last-call'].includes(usage.scope as string)
      || !metricNumber(usage.inputTokens) || !metricNumber(usage.outputTokens)
      || ['cacheReadTokens', 'cacheWriteTokens'].some(key => usage[key] !== undefined && !metricNumber(usage[key]))
      || Object.keys(usage).some(key => !['scope', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].includes(key))) throw denied();
    sample.usage = { scope: usage.scope as NonNullable<SessionSummary['nativeUsage']>['scope'],
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens as number } : {}),
      ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens as number } : {}) };
  }
  if (value.compacted !== undefined) {
    if (value.compacted !== true) throw denied();
    sample.compacted = true;
  }
  if (value.reconciledCalls !== undefined) {
    if (!sample.usage || sample.usage.scope !== 'last-turn' || sample.model !== undefined || sample.context || sample.compacted
      || !Array.isArray(value.reconciledCalls) || value.reconciledCalls.length < 1 || value.reconciledCalls.length > 256) throw denied();
    const ids = new Set<string>();
    sample.reconciledCalls = value.reconciledCalls.map(call => {
      if (!metricRecord(call) || !metricId(call.id) || ids.has(call.id) || !nativeModelId(call.model)
        || Object.keys(call).some(key => !['id', 'model', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].includes(key))
        || !metricNumber(call.inputTokens) || !metricNumber(call.outputTokens)
        || ['cacheReadTokens', 'cacheWriteTokens'].some(key => call[key] !== undefined && !metricNumber(call[key]))) throw denied();
      ids.add(call.id);
      return { id: call.id, model: call.model, inputTokens: call.inputTokens, outputTokens: call.outputTokens,
        ...(call.cacheReadTokens !== undefined ? { cacheReadTokens: call.cacheReadTokens as number } : {}),
        ...(call.cacheWriteTokens !== undefined ? { cacheWriteTokens: call.cacheWriteTokens as number } : {}) };
    });
    for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
      const expected = sample.usage[field];
      // An unknown component cannot be substituted by zero or a known subtotal.
      if (expected === undefined) {
        if (sample.reconciledCalls.some(call => call[field] !== undefined)) throw denied();
      } else {
        let sum = 0;
        for (const call of sample.reconciledCalls) {
          if (call[field] === undefined || !metricNumber(sum += call[field]!)) throw denied();
        }
        if (sum !== expected) throw denied();
      }
    }
  }
  if (!sample.context && !sample.usage && !sample.compacted) throw denied();
  return sample;
}
