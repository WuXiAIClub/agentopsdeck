import type { AgentRuntime, SessionSummary } from '@agentopsdeck/shared';
import type { HermesExecution } from './journal.js';

/** One original wire mapping for live and asynchronously restored sessions.
 * Persisted history publication is NOT native final-history verification. */
export function hermesSessionView(key: string, title: string, execution: HermesExecution | undefined,
  connected: boolean, blocked = false): SessionSummary {
  const phase = blocked ? 'unknown' : execution?.phase ?? (connected ? 'completed' : 'unknown');
  const busy = phase === 'starting' || phase === 'running';
  const runtime: AgentRuntime = { ...(execution ? { turnId: execution.id, operation: 'message' as const } : {}), phase,
    connection: connected ? 'connected' : 'disconnected', sync: 'current', lastEventAt: execution?.updated ?? Date.now(),
    threadActivity: busy ? 'running' : phase === 'unknown' ? 'unknown' : 'idle' };
  return { sessionKey: key, agentId: 'hermes', source: 'hermes', title,
    status: busy ? 'running' : phase === 'unknown' ? 'unknown' : phase === 'failed' ? 'failed' : 'idle', runtime,
    hasActiveRun: busy, ...(execution ? { runStartedAt: execution.at, lastActiveAt: execution.updated,
      ...(['completed', 'failed', 'interrupted'].includes(phase) ? { runCompletedAt: execution.updated } : {}) } : {}) };
}
