import type { SessionSummary } from '@agentopsdeck/shared';
import { visitRollout, type RolloutSource } from './rollout-projection.js';
import { nativeTokenCounts } from '../connector/native-token-usage.js';

/** Cumulative native counts, never last-request context usage. */
export function codexCumulativeUsage(value: unknown) {
  if (!value || typeof value !== 'object') return;
  const usage = value as { total?: Record<string, unknown>; total_token_usage?: Record<string, unknown> };
  const total = usage.total ?? usage.total_token_usage;
  if (!total) return;
  const cache = total.cachedInputTokens ?? total.cached_input_tokens;
  return nativeTokenCounts({ inputTokens: total.inputTokens ?? total.input_tokens, outputTokens: total.outputTokens ?? total.output_tokens,
    ...(cache !== undefined ? { cacheReadTokens: cache } : {}) });
}

type Usage = Pick<SessionSummary, 'contextUsedTokens' | 'contextTokens' | 'compactionCount' | 'lastTurnCompactions' | 'maxTurnCompactions' | 'inputTokens' | 'outputTokens'>;
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Native last-request usage is a context sample, not lifetime billing usage. */
export function codexContextUsage(usage: any): Usage {
  const used = count(usage?.last?.totalTokens ?? usage?.last_token_usage?.total_tokens);
  const limit = count(usage?.modelContextWindow ?? usage?.model_context_window);
  return { ...(used !== undefined ? { contextUsedTokens: used } : {}), ...(limit ? { contextTokens: limit } : {}) };
}

/** Per-read state, also consumed by the combined message/model/usage scan. */
export function createRolloutUsageAccumulator() {
  let valid = false;
  let usage: Usage = { compactionCount: 0 };
  let currentTurnId: string | undefined;
  const perTurnCompactions = new Map<string, number>();
  return {
    accept(row: any) {
      if (row?.type === 'session_meta') valid = true;
      const payload = row?.payload;
      if (row?.type === 'turn_context' || payload?.type === 'turn_context'
        || (row?.type === 'event_msg' && payload?.type === 'task_started')) {
        const turnId = typeof payload?.turn_id === 'string' ? payload.turn_id.trim() : '';
        if (turnId) {
          currentTurnId = turnId;
          if (!perTurnCompactions.has(turnId)) perTurnCompactions.set(turnId, 0);
        }
      }
      if (row?.type === 'compacted') {
        usage = { ...usage, compactionCount: (usage.compactionCount ?? 0) + 1, contextUsedTokens: null };
        if (currentTurnId) perTurnCompactions.set(currentTurnId, (perTurnCompactions.get(currentTurnId) ?? 0) + 1);
      } else if (row?.type === 'event_msg' && row.payload?.type === 'token_count') {
        usage = { ...usage, ...codexContextUsage(row.payload.info) };
        const total = codexCumulativeUsage(row.payload.info);
        // Assign the latest native counters, never sum repeated cumulative
        // snapshots or add reasoning output a second time. Context is separate.
        if (total) usage = { ...usage, inputTokens: total.inputTokens, outputTokens: total.outputTokens };
      }
    },
    // Missing/truncated history must not claim zero compactions.
    result: (): Usage => {
      if (!valid) return {};
      const maxTurnCompactions = Math.max(0, ...perTurnCompactions.values());
      if (!maxTurnCompactions) return { ...usage };
      const lastTurnCompactions = currentTurnId ? (perTurnCompactions.get(currentTurnId) ?? 0) : 0;
      return { ...usage, lastTurnCompactions, maxTurnCompactions };
    },
  };
}

/** Scan an already verified projection; does not reread the native source. */
export function codexRolloutUsage(rollout: string): Usage;
export function codexRolloutUsage(rollout: RolloutSource): Usage | Promise<Usage>;
export function codexRolloutUsage(rollout: RolloutSource): Usage | Promise<Usage> {
  const usage = createRolloutUsageAccumulator();
  return visitRollout(rollout, line => {
    let row: any;
    try { row = JSON.parse(line); } catch { return; }
    usage.accept(row);
  }, usage.result);
}
