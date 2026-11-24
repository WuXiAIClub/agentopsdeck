import type { api as client, HubNodeGrant, HubNodeGrantPage } from '../api.js';

type AccessApi = Pick<typeof client, 'hubNodeGrants' | 'hubUpdateNodeGrant' | 'hubCreateNodeGrant' | 'hubRevokeNodeGrant'>;
export const environmentRoles = {
  developer: { label: 'Developer', description: 'Create and chat in their own sessions. No access to other members’ sessions.', actions: ['sessions:create'] },
  observer: { label: 'Environment observer', description: 'Read all current and future Codex sessions. Cannot send messages or create sessions.', actions: ['sessions:read', 'messages:read', 'events:read'] },
  collaborator: { label: 'Environment collaborator', description: 'Read and chat in all current and future Codex sessions, and create sessions.', actions: ['sessions:read', 'messages:read', 'events:read', 'messages:send', 'sessions:create'] },
} as const;
export type EnvironmentRole = keyof typeof environmentRoles;

export function roleForGrant(grant: HubNodeGrant): EnvironmentRole | undefined {
  if (grant.derived || grant.policy.runtime !== 'codex' || grant.policy.sessionKey || grant.policy.agentId) return;
  return (Object.keys(environmentRoles) as EnvironmentRole[]).find(role => {
    const actions: readonly string[] = environmentRoles[role].actions;
    return grant.policy.actions.length === actions.length && grant.policy.actions.every(action => actions.includes(action));
  });
}

export function memberAccess(page: HubNodeGrantPage, userId: string) {
  const grants = page.grants.filter(grant => grant.userId === userId && !grant.revoked);
  const direct = grants.filter(grant => !grant.derived);
  const derived = grants.filter(grant => grant.derived && grant.nodeVersion === page.nodeVersion);
  const grant = direct.length === 1 ? direct[0] : undefined;
  const role = grant && roleForGrant(grant);
  const stale = direct.some(item => item.nodeVersion !== page.nodeVersion);
  const broad = direct.some(item => item.nodeVersion === page.nodeVersion && !item.policy.sessionKey && !item.policy.agentId
    && item.policy.actions.some(action => ['sessions:read', 'messages:read', 'messages:send'].includes(action)));
  const editable = direct.length === 0 || Boolean(grant && grant.policy.runtime === 'codex' && !grant.policy.sessionKey && !grant.policy.agentId);
  return { direct, derived, grant, role, stale, broad, editable,
    label: !page.verified ? 'Environment unavailable' : stale ? 'Access needs review' : direct.length === 0 ? 'No environment role'
      : role ? environmentRoles[role].label : 'Custom access' };
}

export async function loadEnvironmentAccess(api: AccessApi, connectionId: string, current: () => boolean) {
  const check = () => { if (!current()) throw new Error('Login changed. Reopen access management.'); };
  check();
  const first = await api.hubNodeGrants(connectionId);
  check();
  const grants = [...first.grants], cursors = new Set<string>();
  let cursor = first.nextCursor;
  while (cursor) {
    if (cursors.has(cursor) || cursors.size >= 200) throw new Error('Authorization list incomplete. Retry before making changes.');
    cursors.add(cursor);
    const next = await api.hubNodeGrants(connectionId, cursor);
    check();
    if (next.nodeVersion !== first.nodeVersion || next.verified !== first.verified || next.creationConfigured !== first.creationConfigured
      || next.executionConfigured !== first.executionConfigured) throw new Error('Environment changed. Reload access.');
    grants.push(...next.grants); cursor = next.nextCursor;
  }
  if (new Set(grants.map(grant => grant.id)).size !== grants.length) throw new Error('Authorization list changed. Reload access.');
  return { ...first, grants, nextCursor: null };
}

export async function saveEnvironmentRole(api: AccessApi, connectionId: string, userId: string, expected: HubNodeGrantPage,
  role: EnvironmentRole | null, current: () => boolean) {
  const latest = await loadEnvironmentAccess(api, connectionId, current);
  const fingerprint = (page: HubNodeGrantPage) => JSON.stringify(memberAccess(page, userId).direct
    .map(grant => [grant.id, grant.version, grant.nodeVersion]).sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
  if (!latest.verified || latest.nodeVersion !== expected.nodeVersion || fingerprint(latest) !== fingerprint(expected)) {
    throw new Error('Saved access changed. Reload and review before saving.');
  }
  const access = memberAccess(latest, userId);
  if (!current()) throw new Error('Login changed. Reopen access management.');
  if (!access.editable) throw new Error('Multiple or scoped authorizations require custom access review. No permissions were changed.');
  if (!role) {
    if (access.grant) await api.hubRevokeNodeGrant(connectionId, access.grant);
    return;
  }
  if (role !== 'observer' && (!latest.creationConfigured || !latest.executionConfigured)) {
    throw new Error('Member session creation must be enabled in Environments → Member execution first. No role was saved.');
  }
  if (access.role === role && !access.stale) return;
  const policy = { runtime: 'codex' as const, actions: [...environmentRoles[role].actions] };
  if (access.grant) await api.hubUpdateNodeGrant(connectionId, access.grant, latest.nodeVersion, policy);
  else await api.hubCreateNodeGrant(connectionId, { userId, nodeVersion: latest.nodeVersion, policy });
}
