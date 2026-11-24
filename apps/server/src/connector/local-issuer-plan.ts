import type { ConnectorScope } from '../auth/connector-token.js';

/** Exact original local issuer policy, shared by both composition roots. */
export function localIssuerPlan(hubId: string, createSessions = false) {
  const scopes: ConnectorScope[] = ['execution:delegate', 'messages:read', 'messages:send', 'queue:manage'];
  if (createSessions) scopes.push('sessions:create');
  return { label: 'Hub shared Codex execution', delegationHubId: hubId, scopes };
}
