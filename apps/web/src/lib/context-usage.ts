import type { SessionSummary } from '@agentopsdeck/shared';

const numberFormatter = new Intl.NumberFormat('en-US');
const number = (value: number) => numberFormatter.format(Math.round(value));

export function contextUsageValues(session: SessionSummary) {
  const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const used = finite(session.contextUsedTokens) ? session.contextUsedTokens
    : session.contextUsedTokens === null || ['codex', 'claude-code', 'ghcp'].includes(session.source ?? '') ? undefined
    : finite(session.totalTokens) ? session.totalTokens : finite(session.estimatedTokens) ? session.estimatedTokens : undefined;
  const limit = session.contextSampleBasis !== 'last-request-input' && finite(session.contextTokens) && session.contextTokens > 0 ? session.contextTokens : undefined;
  const ratio = limit && used !== undefined ? Math.max(0, Math.min(1, used / limit)) : 0;
  return { used, limit, ratio };
}

export function formatContextUsage(session: SessionSummary) {
  const { used, limit } = contextUsageValues(session);
  return `${used === undefined ? '—' : number(used)}${limit ? `/${number(limit)}` : ''}`;
}

export function contextUsageDescription(session: SessionSummary) {
  if (session.contextSampleBasis === 'last-request-input') return 'Last request input, including cached tokens; not current context occupancy.';
  if (session.contextUsedTokens === null || contextUsageValues(session).used === undefined)
    return 'Context usage not reported by this runtime. It is not zero; cumulative token usage is not a substitute.';
  if (session.contextSampleBasis === 'post-compaction') return 'Native context sample after compaction.';
  return 'Context used / context window';
}

export function contextUsageLabel(session: SessionSummary, compact = false) {
  return session.contextSampleBasis === 'last-request-input' ? 'Last input' : compact ? 'ctx' : 'Context';
}

export function formatCompactionCount(session: SessionSummary) {
  return typeof session.compactionCount === 'number' && Number.isFinite(session.compactionCount) && session.compactionCount >= 0 ? number(session.compactionCount) : '—';
}
