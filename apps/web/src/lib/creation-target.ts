import type { AgentSummary, GatewayHealth } from '@agentopsdeck/shared';

type CreationState = {
  connections?: { id: string; kind: 'local' | 'remote' }[];
  groups: { agentId: string; sessions: { connectionId?: string; agentId?: string }[] }[];
};

export function isLocalCreationConnection(state: CreationState, connectionId: string) {
  const connection = state.connections?.find(candidate => candidate.id === connectionId);
  return connection ? connection.kind === 'local' : connectionId === 'local';
}

export function defaultCreationAgent(state: CreationState, agents: AgentSummary[], gateway: GatewayHealth | undefined, connectionId: string) {
  const local = isLocalCreationConnection(state, connectionId);
  const agentIds = local ? agents.map(agent => agent.id).filter(Boolean) : [];
  const sessionAgentIds = state.groups.flatMap(group => group.sessions
    .filter(session => (session.connectionId ?? 'local') === connectionId)
    .map(session => session.agentId ?? group.agentId).filter(Boolean));
  if (local && gateway?.enabled !== false && gateway?.defaultAgentId) return gateway.defaultAgentId;
  return agentIds[0] ?? sessionAgentIds[0] ?? 'main';
}
