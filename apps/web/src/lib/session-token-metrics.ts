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
