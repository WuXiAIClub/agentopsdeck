import { nativeModelId } from '@agentopsdeck/shared';
import { metricId, metricNumber, metricRecord, validateSdkMetricSample, type SdkMetricSample } from '../connector/sdk-metrics.js';

/** SDK assistant messages are per content block, and their usage may be
 * unfinished. Keep only the latest monotonic snapshot per native message ID;
 * never charge these directly. Attribute a result only if every component
 * exactly reconciles. Missing/inconsistent telemetry keeps the aggregate
 * model unknown. Bounded per-turn state, cleared even on an invalid result. */
export class ClaudeReconciledMetrics {
  private calls = new Map<string, NonNullable<SdkMetricSample['reconciledCalls']>[number]>();
  private incomplete = false;

  sample(value: unknown, sessionId: string, sequence: number): SdkMetricSample | undefined {
    const sample = claudeMetricSample(value, sessionId, sequence);
    if (!metricRecord(value) || value.session_id !== sessionId
      || value.parent_tool_use_id !== undefined && value.parent_tool_use_id !== null) return sample;
    if (value.type === 'assistant' && !this.incomplete) {
      const message = value.message;
      if (!metricRecord(message) || !metricId(message.id) || !nativeModelId(message.model) || !metricRecord(message.usage)) this.incomplete = true;
      else {
        const usage = message.usage;
        if (!metricNumber(usage.input_tokens) || !metricNumber(usage.output_tokens)
          || ['cache_read_input_tokens', 'cache_creation_input_tokens'].some(key => usage[key] !== undefined && !metricNumber(usage[key]))) this.incomplete = true;
        else {
          const call = { id: message.id, model: message.model, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
            ...(usage.cache_read_input_tokens !== undefined ? { cacheReadTokens: usage.cache_read_input_tokens as number } : {}),
            ...(usage.cache_creation_input_tokens !== undefined ? { cacheWriteTokens: usage.cache_creation_input_tokens as number } : {}) };
          const previous = this.calls.get(call.id);
          if (previous && (previous.model !== call.model
            || (['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const).some(field =>
              previous[field] !== undefined && (call[field] === undefined || call[field]! < previous[field]!)))) this.incomplete = true;
          else if (!previous && this.calls.size >= 256) this.incomplete = true;
          else this.calls.set(call.id, call);
        }
      }
      if (this.incomplete) this.calls.clear();
    }
    if (value.type !== 'result') return sample;
    try {
      if (sample?.usage && !this.incomplete && this.calls.size) {
        try { return validateSdkMetricSample({ ...sample, reconciledCalls: [...this.calls.values()] }); }
        catch { /* No partial allocation: retain the authoritative turn total. */ }
      }
      return sample;
    } finally { this.close(); }
  }

  close() { this.calls.clear(); this.incomplete = false; }
}

/** Fixed SDK 0.3.280: result.usage is main-loop/per-turn, NOT modelUsage's
 * cumulative multi-model accounting. Native numeric fields only. */
export function claudeMetricSample(value: unknown, sessionId: string, sequence: number): SdkMetricSample | undefined {
  if (!metricRecord(value) || value.session_id !== sessionId || !metricId(value.uuid)
    || value.parent_tool_use_id !== undefined && value.parent_tool_use_id !== null) return;
  const sample: SdkMetricSample = { eventId: value.uuid, sequence };
  if (value.type === 'result' && metricRecord(value.usage)) {
    const usage = value.usage;
    if (metricNumber(usage.input_tokens) && metricNumber(usage.output_tokens)) {
      sample.usage = { scope: 'last-turn', inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
        ...(metricNumber(usage.cache_read_input_tokens) ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
        ...(metricNumber(usage.cache_creation_input_tokens) ? { cacheWriteTokens: usage.cache_creation_input_tokens } : {}) };
    }
  } else if (value.type === 'assistant') {
    const context = value.context_usage;
    if (metricRecord(context) && metricNumber(context.total_tokens) && metricNumber(context.raw_max_tokens) && context.raw_max_tokens > 0) {
      sample.context = { used: context.total_tokens, limit: context.raw_max_tokens, basis: 'native-context' };
    } else if (metricRecord(value.message) && metricRecord(value.message.usage)) {
      const usage = value.message.usage;
      // Anthropic input excludes cache reads/writes. Require every component;
      // absent telemetry is unknown, not zero. Never add output to context.
      if ([usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens].every(metricNumber)) {
        const used = (usage.input_tokens as number) + (usage.cache_read_input_tokens as number) + (usage.cache_creation_input_tokens as number);
        if (metricNumber(used)) sample.context = { used, basis: 'last-request-input' };
      }
    }
  } else if (value.type === 'system' && value.subtype === 'compact_boundary') {
    sample.compacted = true;
    const metadata = value.compact_metadata;
    sample.context = { used: metricRecord(metadata) && metricNumber(metadata.post_tokens) ? metadata.post_tokens : null,
      basis: 'post-compaction' };
  }
  return sample.context || sample.usage || sample.compacted ? sample : undefined;
}
