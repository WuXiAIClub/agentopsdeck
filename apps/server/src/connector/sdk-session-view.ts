import type { AgentRuntime, AntigravityQuotaWaitState, SessionSummary } from '@agentopsdeck/shared';
import type { SdkAgentId, SdkExecution, SdkSession } from './sdk-execution-journal.js';

const terminal = (phase: AgentRuntime['phase']) => ['completed', 'failed', 'interrupted'].includes(phase);

/** Pure view of durable truth. Read authorization belongs to the Connector
 * route. Transport/readiness failures do not rewrite known execution outcomes;
 * neither a result event nor a quiet transcript is proof of completion. */
export function sdkSessionView(runtime: SdkAgentId, session: SdkSession, execution: SdkExecution | undefined,
  ready: boolean, extra?: { messageCount?: number; quotaWait?: AntigravityQuotaWaitState }): SessionSummary {
  if (!session.key.startsWith(`${runtime}:`) || session.key.length <= runtime.length + 1 || execution && (execution.key !== session.key
    || execution.nativeSessionId !== session.nativeSessionId)) throw new Error('SDK session projection identity is invalid');
  let phase: AgentRuntime['phase'] | undefined;
  if (execution) phase = execution.phase === 'dispatching' ? 'starting'
    : execution.phase === 'settling' ? 'finalizing' : execution.phase;
  // Unmaterialized/legacy or orphaned starting state must not advertise idle.
  if (session.nativeState === 'unknown' || session.nativeState === 'starting' && !execution) phase = 'unknown';
  const busy = phase === 'starting' || phase === 'running' || phase === 'finalizing';
  const quotaWait = !busy && phase !== 'unknown' ? extra?.quotaWait : undefined;
  const summary: SessionSummary = {
    sessionKey: session.key, agentId: runtime, source: runtime, title: session.title,
    status: busy ? 'running' : quotaWait ? 'waiting' : phase === 'unknown' ? 'unknown' : phase === 'failed' ? 'failed'
      : !phase && !ready ? 'unknown' : 'idle',
    hasActiveRun: busy, lastActiveAt: execution?.updatedAt ?? session.createdAt,
    controlCapabilities: { compact: ready && session.nativeState === 'ready',
      attachments: ready },
  };
  // A newly allocated session has no finished run. Omitting runtime is better
  // than manufacturing a green Done notification before its first message.
  if (phase || quotaWait) {
    const resolvedPhase: AgentRuntime['phase'] = quotaWait ? 'waiting' : phase!;
    summary.runtime = {
      ...(execution ? { turnId: execution.id, operation: execution.kind, stopRequested: execution.stopRequested } : {}),
      phase: resolvedPhase,
      connection: ready ? 'connected' : 'disconnected',
      sync: 'current',
      lastEventAt: quotaWait ? Math.max(quotaWait.detectedAt, execution?.updatedAt ?? session.createdAt) : (execution?.updatedAt ?? session.createdAt),
      threadActivity: busy ? 'running' : quotaWait ? 'waiting' : resolvedPhase === 'unknown' ? 'unknown' : 'idle',
      ...(quotaWait ? { reason: quotaWait.reason } : {}),
    };
  }
  if (quotaWait) {
    summary.quotaWait = { ...quotaWait };
  }
  if (execution && execution.kind !== 'compact') {
    summary.runStartedAt = execution.createdAt;
    if (phase && terminal(phase)) summary.runCompletedAt = execution.updatedAt;
  }
  const metrics = session.metrics;
  if (metrics?.context) {
    summary.contextUsedTokens = metrics.context.used;
    summary.contextSampleBasis = metrics.context.basis;
    if (metrics.context.limit !== undefined) summary.contextTokens = metrics.context.limit;
  }
  if (metrics?.usage) summary.nativeUsage = { ...metrics.usage };
  if (runtime === 'antigravity' && metrics?.totals) {
    summary.inputTokens = metrics.totals.inputTokens;
    summary.outputTokens = metrics.totals.outputTokens;
    summary.totalTokens = metrics.totals.totalTokens;
  }
  if (metrics?.compactionCount !== undefined) summary.compactionCount = metrics.compactionCount;
  if (extra?.messageCount !== undefined && Number.isSafeInteger(extra.messageCount) && extra.messageCount >= 0) {
    summary.messageCount = extra.messageCount;
  }
  return summary;
}
