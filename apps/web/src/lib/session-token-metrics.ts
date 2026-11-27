import type { SessionSummary } from '@agentopsdeck/shared';

/** Keep scope and precision together. A last call is not a session total, and
 * missing output cannot be derived from message length or context occupancy. */
export function sessionTokenMetrics(session: SessionSummary) {
  const native = session.nativeUsage;
  const scope: 'Last turn' | 'Last call' | 'Native cumulative' | 'Reported usage' = native?.scope === 'last-turn' ? 'Last turn' : native?.scope === 'last-call' ? 'Last call'
    : session.source === 'codex' || session.agentId === 'codex' ? 'Native cumulative' : 'Reported usage';
  const exact = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() : '—';
  // Never fill a missing native field from a different (cumulative) source.
  return { scope, input: exact(native ? native.inputTokens : session.inputTokens), output: exact(native ? native.outputTokens : session.outputTokens) };
}

/** Exact session-cumulative token totals when reported separately from last-turn usage (e.g. Antigravity). */
export function sessionCumulativeTokenMetrics(session: SessionSummary) {
  const valid = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  const inputNum = valid(session.inputTokens) ? session.inputTokens : undefined;
  const outputNum = valid(session.outputTokens) ? session.outputTokens : undefined;
  const totalNum = valid(session.totalTokens)
    ? session.totalTokens
    : inputNum !== undefined && outputNum !== undefined && Number.isSafeInteger(inputNum + outputNum)
      ? inputNum + outputNum
      : undefined;
  return {
    hasCumulative: totalNum !== undefined,
    inputValue: inputNum,
    outputValue: outputNum,
    totalValue: totalNum,
    input: inputNum !== undefined ? inputNum.toLocaleString() : '—',
    output: outputNum !== undefined ? outputNum.toLocaleString() : '—',
    total: totalNum !== undefined ? totalNum.toLocaleString() : '—',
  };
}
