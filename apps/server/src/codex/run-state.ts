import type { AgentRuntime, SessionSummary } from '@agentopsdeck/shared';

export function runtimeBusy(runtime: AgentRuntime | undefined) {
  return Boolean(runtime && ['starting', 'running', 'waiting', 'finalizing', 'unknown'].includes(runtime.phase));
}

/** The only projection from Codex execution truth into legacy session badges. */
export function projectRuntime(session: SessionSummary, runtime: AgentRuntime): SessionSummary {
  const busy = runtimeBusy(runtime) || (!!runtime.threadActivity && runtime.threadActivity !== 'idle');
  const status = runtime.connection === 'disconnected' || runtime.phase === 'unknown' || runtime.threadActivity === 'unknown' || runtime.sync === 'error' ? 'unknown'
    : runtime.phase === 'waiting' || runtime.threadActivity === 'waiting' ? 'waiting'
      : busy ? 'running' : runtime.phase === 'failed' ? 'failed' : 'idle';
  const { structuredStatus: _legacy, ...base } = session;
  return { ...base, runtime, status, hasActiveRun: busy };
}

export function snapshotRuntime(thread: any, now: number): AgentRuntime {
  const turn = Array.isArray(thread?.turns) ? thread.turns.at(-1) : undefined;
  const turnId = typeof turn?.id === 'string' ? turn.id : undefined;
  const active = thread?.status?.type === 'active' || ['inProgress', 'in_progress', 'running'].includes(turn?.status);
  const waiting = thread?.status?.activeFlags?.length > 0;
  const terminal = ['completed', 'failed', 'interrupted'].includes(turn?.status);
  const phase: AgentRuntime['phase'] = thread?.status?.type === 'notLoaded' && active ? 'unknown'
    : thread?.status?.type === 'systemError' ? 'unknown'
    : active && !terminal ? waiting ? 'waiting' : 'running'
      : turn?.status === 'failed' ? 'failed'
        : turn?.status === 'interrupted' ? 'interrupted'
          : turn?.status === 'completed' || thread?.status?.type === 'idle' ? 'completed' : 'unknown';
  const threadActivity = phase === 'unknown' ? 'unknown' : active ? waiting ? 'waiting' : 'running' : 'idle';
  return { ...(turnId ? { turnId } : {}), phase, threadActivity, connection: 'connected', sync: thread?.status?.type === 'systemError' ? 'error' : 'current', lastEventAt: now };
}
