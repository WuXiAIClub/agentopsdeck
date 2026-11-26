import type { AgentRuntime, SessionSummary } from '@agentopsdeck/shared';
import type { SdkAgentId, SdkExecution, SdkSession } from './sdk-execution-journal.js';

const terminal = (phase: AgentRuntime['phase']) => ['completed', 'failed', 'interrupted'].includes(phase);

/** Pure view of durable truth. Read authorization belongs to the Connector
 * route. Transport/readiness failures do not rewrite known execution outcomes;
 * neither a result event nor a quiet transcript is proof of completion. */
export function sdkSessionView(runtime: SdkAgentId, session: SdkSession, execution: SdkExecution | undefined,
  ready: boolean): SessionSummary {
  if (!session.key.startsWith(`${runtime}:`) || session.key.length <= runtime.length + 1 || execution && (execution.key !== session.key
    || execution.nativeSessionId !== session.nativeSessionId)) throw new Error('SDK session projection identity is invalid');
  let phase: AgentRuntime['phase'] | undefined;
  if (execution) phase = execution.phase === 'dispatching' ? 'starting'
    : execution.phase === 'settling' ? 'finalizing' : execution.phase;
  // Unmaterialized/legacy or orphaned starting state must not advertise idle.
  if (session.nativeState === 'unknown' || session.nativeState === 'starting' && !execution) phase = 'unknown';
  const busy = phase === 'starting' || phase === 'running' || phase === 'finalizing';
  const summary: SessionSummary = {
    sessionKey: session.key, agentId: runtime, source: runtime, title: session.title,
    status: busy ? 'running' : phase === 'unknown' ? 'unknown' : phase === 'failed' ? 'failed'
      : !phase && !ready ? 'unknown' : 'idle',
    hasActiveRun: busy, lastActiveAt: execution?.updatedAt ?? session.createdAt,
    controlCapabilities: { compact: ready && session.nativeState === 'ready',
      attachments: ready },
  };
  // A newly allocated session has no finished run. Omitting runtime is better
  // than manufacturing a green Done notification before its first message.
  if (phase) {
    summary.runtime = { ...(execution ? { turnId: execution.id, operation: execution.kind, stopRequested: execution.stopRequested } : {}), phase,
      connection: ready ? 'connected' : 'disconnected', sync: 'current',
      lastEventAt: execution?.updatedAt ?? session.createdAt,
      threadActivity: busy ? 'running' : phase === 'unknown' ? 'unknown' : 'idle' };
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
  if (metrics?.compactionCount !== undefined) summary.compactionCount = metrics.compactionCount;
  return summary;
}
