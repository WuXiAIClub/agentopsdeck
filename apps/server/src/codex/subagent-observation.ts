import type { ChatMessage } from '@agentopsdeck/shared';

type Observation = NonNullable<ChatMessage['codexSubagent']>;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number) => typeof v === 'string' && v.trim() ? v.slice(0, max) : undefined;
const identity = (v: unknown) => typeof v === 'string' && v.trim() && v.length <= 512 ? v : undefined;
const statuses = new Set(['pendingInit', 'running', 'interrupted', 'completed', 'errored', 'shutdown', 'notFound']);

/** Protocol whitelist. Does not discover/read child threads or forward arbitrary payloads. */
export function subagentObservation(item: unknown, observedAt?: number, parentThreadId?: string): Observation | undefined {
  if (!record(item)) return;
  const source = observedAt !== undefined && Number.isFinite(observedAt) && observedAt >= 0
    ? { source: 'live' as const, observedAt } : { source: 'history' as const };
  if (item.type === 'subAgentActivity') {
    const id = identity(item.agentThreadId);
    const path = text(item.agentPath, 512);
    if (!id || path?.trim() === '/root' || (parentThreadId && id === parentThreadId)
      || !['started', 'interacted', 'interrupted'].includes(String(item.kind))) return;
    return { ...source, action: item.kind as Observation['action'], agents: [{ id,
      ...(path ? { path } : {}),
      status: item.kind === 'interrupted' ? 'interrupted' : 'unknown' }] };
  }
  if (!['collabAgentToolCall', 'collabToolCall'].includes(String(item.type))
    || !['spawnAgent', 'sendInput', 'resumeAgent', 'wait', 'closeAgent'].includes(String(item.tool))) return;
  const states = record(item.agentsStates) ? item.agentsStates : {};
  const ids = [...new Set([...(Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.slice(0, 32) : []),
    ...Object.keys(states).slice(0, 32)].map(identity).filter((id): id is string => !!id))].slice(0, 32);
  const task = text(item.prompt, 600);
  return { ...source, action: item.tool as Observation['action'],
    ...(task ? { task } : {}),
    agents: ids.map(id => {
      const state = Object.hasOwn(states, id) && record(states[id]) ? states[id] : {};
      const message = text(state.message, 600);
      return { id, status: statuses.has(String(state.status)) ? state.status as Observation['agents'][number]['status'] : 'unknown',
        ...(message ? { message } : {}) };
    }) };
}
