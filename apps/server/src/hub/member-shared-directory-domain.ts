import type { DatabaseSync } from 'node:sqlite';
import type { SessionDirectoryPage, SessionDirectoryQuery, SharedSessionDirectoryPage } from '@agentopsdeck/shared';
import type { HubStore } from './hub-store.js';
import type { HubPrincipal } from './identity.js';
import type { NodeGrantProof } from './node-grants.js';
import { validHubNodeGrantProof } from './member-connector-access-domain.js';
import { boundOriginalRows } from './member-grant-domain.js';
import { sessionDirectoryPage, sessionDirectoryParams } from '../projection/session-directory.js';
import { isNodeId } from '../connector/node-identity.js';
import { sessionRef } from './session-ref.js';
import { encodeHubSessionId } from './session-id.js';

type Target = { ownerUserId: string; connectionId: string; grantId: string };
type Resource = Pick<SessionDirectoryQuery, 'runtime' | 'sessionKey'>;
export type HubSharedDirectoryCommand = { target: Target } & (
  { action: 'open' } | { action: 'project'; proof: NodeGrantProof; query: SessionDirectoryQuery; page: SessionDirectoryPage }
);
export type HubSharedDirectoryResult = null | { error: 'missing' | 'changed' }
  | { action: 'open'; target: Target; userId: string; nodeId: string; proof: NodeGrantProof; resource: Resource }
  | { action: 'project'; target: Target; userId: string; proof: NodeGrantProof; page: SharedSessionDirectoryPage };
export const HUB_SHARED_DIRECTORY_BYTES = 1024 * 1024;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && Object.keys(v).every(k => names.includes(k));
const id = (v: unknown): v is string => typeof v === 'string' && !!v && Buffer.byteLength(v) <= 4096 && !v.includes('\0');
const target = (v: unknown): v is Target => object(v) && fields(v, ['ownerUserId','connectionId','grantId']) && Object.values(v).every(id);
const sameTarget = (a: Target, b: Target) => a.ownerUserId === b.ownerUserId && a.connectionId === b.connectionId && a.grantId === b.grantId;
const sameProof = (a: NodeGrantProof, b: NodeGrantProof) => a.ownerUserId === b.ownerUserId && a.connectionId === b.connectionId
  && a.userId === b.userId && a.grantId === b.grantId && a.version === b.version && a.nodeVersion === b.nodeVersion
  && a.action === b.action && !!a.administrator === !!b.administrator && a.resource.runtime === b.resource.runtime
  && a.resource.sessionKey === b.resource.sessionKey && a.resource.agentId === b.resource.agentId;
const boundProof = (p: unknown, t: Target): p is NodeGrantProof => validHubNodeGrantProof(p) && p.ownerUserId === t.ownerUserId
  && p.connectionId === t.connectionId && p.grantId === t.grantId && p.action === 'sessions:read' && p.resource.agentId === undefined;
function validPage(page: unknown, query: SessionDirectoryQuery) {
  try {
    if (!object(page) || !fields(page, ['sessions','nextCursor','sourceCursor']) || !Array.isArray(page.sessions)
      || !page.sessions.every(item => object(item) && fields(item, ['sessionKey','runtime']))) return false;
    sessionDirectoryPage(page, query); return true;
  } catch { return false; }
}
export function validHubSharedDirectoryCommand(v: unknown): v is HubSharedDirectoryCommand {
  if (!object(v) || !target(v.target)) return false;
  if (v.action === 'open') return fields(v, ['action','target']);
  if (v.action !== 'project' || !fields(v, ['action','target','proof','query','page']) || !boundProof(v.proof, v.target) || !object(v.query)) return false;
  try { sessionDirectoryParams(v.query); } catch { return false; }
  return v.query.runtime === v.proof.resource.runtime && v.query.sessionKey === v.proof.resource.sessionKey
    && validPage(v.page, v.query);
}
export function validHubSharedDirectoryResult(v: unknown): v is HubSharedDirectoryResult {
  if (v === null) return true;
  if (!object(v)) return false;
  if (fields(v, ['error'])) return v.error === 'missing' || v.error === 'changed';
  if (!target(v.target) || !id(v.userId) || !boundProof(v.proof, v.target) || v.proof.userId !== v.userId) return false;
  if (v.action === 'open') {
    if (!fields(v, ['action','target','userId','nodeId','proof','resource']) || !isNodeId(v.nodeId) || !object(v.resource)
      || Object.keys(v.resource).some(k => k !== 'runtime' && k !== 'sessionKey')) return false;
    try { sessionDirectoryParams(v.resource); } catch { return false; }
    return v.resource.runtime === v.proof.resource.runtime && v.resource.sessionKey === v.proof.resource.sessionKey;
  }
  if (v.action !== 'project' || !fields(v, ['action','target','userId','proof','page']) || !object(v.page)
    || !fields(v.page, ['sessions','nextCursor','sourceCursor']) || !Array.isArray(v.page.sessions) || v.page.sessions.length > 100) return false;
  const connectionId = v.target.connectionId;
  return v.page.sessions.every(item => object(item) && fields(item, ['sessionKey','runtime','sessionId'])
    && (item.sessionId === null || typeof item.sessionId === 'string' && item.sessionId.length <= 4096
      && item.sessionId === encodeHubSessionId(connectionId, String(item.sessionKey))))
    && validPage({ ...v.page, sessions: v.page.sessions.map(({ sessionId: _id, ...item }) => item) },
      { ...v.proof.resource, ...(v.page.sessions.length ? { limit: v.page.sessions.length } : {}) });
}
export function validHubSharedDirectoryReply(command: HubSharedDirectoryCommand, value: unknown): value is HubSharedDirectoryResult {
  if (!validHubSharedDirectoryResult(value)) return false;
  if (value === null || 'error' in value) return true;
  if (value.action !== command.action || !sameTarget(value.target, command.target)) return false;
  if (command.action === 'open') return true;
  return value.action === 'project' && sameProof(value.proof, command.proof)
    && value.page.nextCursor === command.page.nextCursor && value.page.sourceCursor === command.page.sourceCursor
    && value.page.sessions.length === command.page.sessions.length && value.page.sessions.every((entry, i) =>
      entry.sessionKey === command.page.sessions[i]!.sessionKey && entry.runtime === command.page.sessions[i]!.runtime);
}
/** Called inside the original identity savepoint. A directory read never
 * authorizes execution. Both preflight and post-remote projection derive the
 * actor and check current role/grant/node facts on the original connection. */
export function executeHubSharedDirectoryCommand(db: DatabaseSync, store: HubStore, actor: HubPrincipal,
  command: HubSharedDirectoryCommand): HubSharedDirectoryResult {
  if (!validHubSharedDirectoryCommand(command)) throw Error('hub_shared_directory_unavailable');
  const t = command.target, access = { ...t, userId: actor.userId, administrator: actor.admin };
  boundOriginalRows(db, t);
  const grant = store.grants.get(access, t.grantId), connection = store.getConnection(t.connectionId, t.ownerUserId);
  if (!grant || grant.userId !== actor.userId || grant.revoked || grant.policy.agentId !== undefined
    || !connection || connection.status === 'disabled' || !isNodeId(connection.nodeId)) return { error: command.action === 'open' ? 'missing' : 'changed' };
  const resource = { ...(grant.policy.runtime ? { runtime: grant.policy.runtime } : {}),
    ...(grant.policy.sessionKey ? { sessionKey: grant.policy.sessionKey } : {}) };
  const proof = store.grants.authorize(access, 'sessions:read', resource, grant.id);
  if (!proof) return { error: command.action === 'open' ? 'missing' : 'changed' };
  if (command.action === 'open') return { action: 'open', target: { ...t }, userId: actor.userId, nodeId: connection.nodeId, proof, resource };
  if (!sameProof(proof, command.proof) || !store.grants.revalidate(command.proof)) return { error: 'changed' };
  const sessions = command.page.sessions.map(item => {
    let sessionId: string | null = null;
    const ref = sessionRef(connection.nodeId!, item.sessionKey);
    if (ref && ref.runtimeId === item.runtime && store.grants.authorize(access, 'messages:read', item)) {
      const encoded = encodeHubSessionId(connection.id, item.sessionKey); if (encoded.length <= 4096) sessionId = encoded;
    }
    return { ...item, sessionId };
  });
  return { action: 'project', target: { ...t }, userId: actor.userId, proof,
    page: { sessions, nextCursor: command.page.nextCursor, sourceCursor: command.page.sourceCursor } };
}
