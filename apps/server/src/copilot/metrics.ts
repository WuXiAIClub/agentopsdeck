import { metricId, metricNumber, metricRecord, type SdkMetricSample } from '../connector/sdk-metrics.js';
import { nativeModelId } from '@agentopsdeck/shared';

/** Fixed SDK 1.0.14/protocol3. assistant.usage is per API call; root attribution
 * is essential because child/tool/background calls must not rewrite context. */
export function copilotMetricSample(value: unknown, sequence: number): SdkMetricSample | undefined {
  if (!metricRecord(value) || !metricId(value.id) || !metricRecord(value.data)
    || value.agentId !== undefined || value.data.parentToolCallId !== undefined) return;
  const data = value.data, sample: SdkMetricSample = { eventId: value.id, sequence };
  if (value.type === 'session.usage_info' && metricNumber(data.currentTokens) && metricNumber(data.tokenLimit) && data.tokenLimit > 0) {
    sample.context = { used: data.currentTokens, limit: data.tokenLimit, basis: 'native-context' };
  // The pinned BYOK CLI emits initiator="user" for root conversation calls,
  // despite the SDK declaration saying user-initiated calls omit the field.
  } else if (value.type === 'assistant.usage' && (data.initiator === undefined || data.initiator === 'user')
    && (data.interactionType === undefined || data.interactionType === 'conversation-agent')
    && metricNumber(data.inputTokens) && metricNumber(data.outputTokens)) {
    sample.usage = { scope: 'last-call', inputTokens: data.inputTokens, outputTokens: data.outputTokens,
      ...(metricNumber(data.cacheReadTokens) ? { cacheReadTokens: data.cacheReadTokens } : {}),
      ...(metricNumber(data.cacheWriteTokens) ? { cacheWriteTokens: data.cacheWriteTokens } : {}) };
    if (nativeModelId(data.model)) sample.model = data.model;
  } else if (value.type === 'session.compaction_complete' && data.success === true) {
    sample.compacted = true;
    sample.context = { used: metricNumber(data.postCompactionTokens) ? data.postCompactionTokens : null, basis: 'post-compaction',
      ...(metricNumber(data.tokenLimit) && data.tokenLimit > 0 ? { limit: data.tokenLimit } : {}) };
  }
  return sample.context || sample.usage || sample.compacted ? sample : undefined;
}
