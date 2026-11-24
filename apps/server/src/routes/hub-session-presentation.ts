import type { SessionSummary } from '@agentopsdeck/shared';
import type { HubConnection, SessionPreferences } from '../hub/hub-store.js';
import { sessionRef } from '../hub/session-ref.js';
import { encodeHubSessionId } from '../hub/session-id.js';

// Pure wire presentation shared by legacy and async-only discovery. No owner,
// authorization, IO, timers or store instance is captured here.
export function publicConnectionWithUser(connection: HubConnection, users: Array<{ id: string; label: string }>) {
  const owner = users.find((user) => user.id === connection.ownerUserId);
  return publicConnection(connection, owner?.label);
}

export function publicConnectionsWithUsers(connections: HubConnection[], users: Array<{ id: string; label: string }>) {
  return connections.map((connection) => publicConnectionWithUser(connection, users));
}

export function publicConnection(connection: HubConnection, ownerUserLabel?: string | undefined) {
  return {
    nodeId: connection.nodeId,
    identityStatus: connection.nodeId ? 'verified' : 'unverified',
    id: connection.id,
    ownerUserId: connection.ownerUserId,
    ownerUserLabel,
    kind: connection.kind,
    label: connection.label,
    connectorUrl: connection.connectorUrl,
    status: connection.status,
    environmentId: connection.environmentId,
    environmentLabel: connection.environmentLabel,
    capabilities: connection.capabilities,
    hasCredential: connection.hasCredential,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

export function wrapSession(session: SessionSummary, connection: HubConnection) {
  const { id: connectionId, label: connectionLabel } = connection;
  return {
    ...session,
    sessionRef: sessionRef(connection.nodeId, session.sessionKey),
    remoteSessionKey: session.sessionKey,
    hubSessionId: encodeHubSessionId(connectionId, session.sessionKey),
    envConnectionId: connectionId,
    envConnectionLabel: connectionLabel,
    sessionKey: encodeHubSessionId(connectionId, session.sessionKey),
  };
}

export function filterHiddenSessionGroups(groups: Array<{ agentId: string; sessions: ReturnType<typeof wrapSession>[] }>, preferences: Map<string, SessionPreferences>, includeHidden: boolean, includeArchived: boolean) {
  let hiddenCount = 0;
  let archivedCount = 0;
  let pinnedCount = 0;
  const visibleGroups = groups.map((group) => {
    const sessions = group.sessions.flatMap((session) => {
      const preference = preferences.get(session.sessionKey);
      const hidden = preference?.hidden ?? Boolean(session.hidden);
      const archived = preference?.archived ?? Boolean(session.archived);
      const pinned = preference?.pinned ?? Boolean(session.pinned);
      if (hidden) hiddenCount += 1;
      if (archived) archivedCount += 1;
      if (pinned) pinnedCount += 1;
      if (hidden && !includeHidden) return [];
      if (archived && !includeArchived) return [];
      return [{
        ...session,
        hidden, archived, pinned,
      }];
    }).sort(comparePinnedSessions);
    return { ...group, sessions };
  }).filter((group) => group.sessions.length > 0);
  return { groups: visibleGroups, hiddenCount, archivedCount, pinnedCount };
}

export function mergeSessionGroups(groups: Array<{ agentId: string; sessions: ReturnType<typeof wrapSession>[] }>) {
  const byAgent = new Map<string, ReturnType<typeof wrapSession>[]>();
  for (const group of groups) {
    const current = byAgent.get(group.agentId) ?? [];
    current.push(...group.sessions);
    byAgent.set(group.agentId, current);
  }
  return [...byAgent.entries()]
    .map(([agentId, sessions]) => ({
      agentId,
      sessions: sessions.sort((a, b) => comparePinnedSessions(a, b) || a.hubSessionId.localeCompare(b.hubSessionId)),
    }))
    .sort((a, b) => a.agentId.localeCompare(b.agentId));
}

export function comparePinnedSessions(a: SessionSummary, b: SessionSummary) {
  const pinnedDelta = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
  if (pinnedDelta !== 0) return pinnedDelta;
  return (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0);
}
