import type { Context } from 'hono';
import { AGENTOPSDECK_VERSION, AGENTOPSDECK_BUILD, CONNECTOR_PROTOCOL, historyPendingBody, type ChatMessage } from '@agentopsdeck/shared';
import type { ServerConfig } from '../config.js';
import type { ConnectorUser } from '../connector/connector-user-store.js';
import type { HubConnection } from '../hub/hub-store.js';
import { ConnectorClientError, HistoryPreparing } from '../hub/connector-client.js';
import { ConnectorNotDispatchedError } from '../hub/connector-connect.js';
import { projectMessageMedia } from '../hub/message-projection.js';
import { decodeHubSessionId } from '../hub/session-id.js';
import { sessionRef } from '../hub/session-ref.js';
import { usesInProcessConnector } from '../server-role.js';
import { publicConnectionWithUser } from './hub-session-presentation.js';

// Wire-only helpers shared by both compositions; no store, identity or effect.
export function hubInfo(config: ServerConfig) {
  return { service: 'agentopsdeck-hub', version: AGENTOPSDECK_VERSION, build: AGENTOPSDECK_BUILD,
    connectorProtocol: CONNECTOR_PROTOCOL,
    mode: usesInProcessConnector(config) ? 'all-in-one-local' : 'split-hub-http-connector',
    features: { users: true, passkeys: true, sqlitePersistence: true, encryptedCredentialVault: true,
      connectorConnections: true, sessionsAggregation: true, messages: true, workspaceSyncPreview: 1,
      eventsFanIn: true, mediaProxy: true, connectorUsers: true, admin: false } };
}

export function publicConnectorUserConnection(connection: HubConnection,
  users: Parameters<typeof publicConnectionWithUser>[1], supported: boolean, connectorUsers: ConnectorUser[], error?: string) {
  return { ...publicConnectionWithUser(connection, users), supported, users: connectorUsers,
    userCount: connectorUsers.length, ...(error ? { error } : {}) };
}

export function normalizeRemoteConnectorUser(value: unknown): ConnectorUser | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || typeof row.label !== 'string') return undefined;
  return { id: row.id, label: row.label, createdAt: typeof row.createdAt === 'number' ? row.createdAt : 0,
    updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0 };
}

export function wrapMessage(message: ChatMessage, hubSessionId: string, connection: HubConnection) {
  const remoteSessionKey = decodeHubSessionId(hubSessionId)!.remoteSessionKey;
  const media = projectMessageMedia(message, remoteSessionKey, `/api/hub/v1/sessions/${encodeURIComponent(hubSessionId)}`);
  return { ...message, sessionRef: sessionRef(connection.nodeId, remoteSessionKey), ...(media ? { media } : {}),
    remoteSessionKey, hubSessionId, sessionKey: hubSessionId };
}

export function connectorReadError(c: Context, error: unknown) {
  if (error instanceof HistoryPreparing) {
    c.header('Cache-Control', 'no-store'); c.header('Retry-After', '1');
    return c.json(historyPendingBody(), 202);
  }
  if (error instanceof ConnectorNotDispatchedError) return c.json({ error: error.message }, 409);
  const status = error instanceof ConnectorClientError ? error.status : 502;
  if (error instanceof ConnectorClientError && error.source) {
    c.header('X-AgentOpsDeck-Source-Error', error.source.reason);
    if (error.source.canApprove) c.header('X-AgentOpsDeck-Source-Approval', 'available');
  }
  return c.json({ error: error instanceof ConnectorClientError ? error.message : 'Connector unavailable', status }, status as 502);
}
