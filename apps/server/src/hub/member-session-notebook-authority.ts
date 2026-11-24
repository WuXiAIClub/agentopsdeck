import type { HubStore } from './hub-store.js';
import type { HubPrincipal } from './identity.js';
import type { NodeGrantProof } from './node-grants.js';
import { validHubNodeGrantProof } from './member-connector-access-domain.js';
import { validConnectionEpoch } from './member-connection-change-domain.js';
import { decodeHubSessionId } from './session-id.js';
import { sessionRef } from './session-ref.js';

/** An original route proof, not a transported principal. Replacement grants
 * and re-enabled connections never revive an admitted stale command. */
export type HubSessionNotebookAuthority = { kind: 'owner'; sessionId: string; connectionVersion: number }
  | { kind: 'shared'; sessionId: string; ownerUserId: string; proof: NodeGrantProof };
export function validHubSessionNotebookAuthority(value: unknown): value is HubSessionNotebookAuthority {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>, keys = Object.keys(v);
  if (typeof v.sessionId !== 'string' || v.sessionId.length > 4096 || !decodeHubSessionId(v.sessionId)) return false;
  return v.kind === 'owner' ? keys.length === 3 && keys.every(k => ['kind', 'sessionId', 'connectionVersion'].includes(k))
    && validConnectionEpoch(v.connectionVersion)
    : v.kind === 'shared' && keys.length === 4 && keys.every(k => ['kind', 'sessionId', 'ownerUserId', 'proof'].includes(k))
      && typeof v.ownerUserId === 'string' && !!v.ownerUserId && v.ownerUserId.length <= 4096 && validHubNodeGrantProof(v.proof);
}

/** Select the original route proof inside the identity transaction. The target
 * is a session address, never an asserted principal or resource tuple. */
export function selectSessionNotebookAuthority(owner: HubStore, principal: HubPrincipal,
  target: {sessionId: string; ownerUserId: string | null}): {authority: HubSessionNotebookAuthority; resourceId: string} | null {
  const decoded = decodeHubSessionId(target.sessionId);
  if (!decoded) return null;
  const userId = target.ownerUserId ?? principal.userId;
  if (target.ownerUserId !== null) owner.roles.syncAdministrator(principal);
  const connection = owner.getConnection(decoded.connectionId, userId);
  if (!connection || connection.status === 'disabled') return null;
  let ref;
  try { ref = sessionRef(connection.nodeId, decoded.remoteSessionKey); } catch { return null; }
  if (!ref) return null;
  const resourceId = JSON.stringify([userId, ref.nodeId, ref.runtimeId, ref.nativeSessionKey]);
  if (target.ownerUserId === null) {
    const connectionVersion = owner.connectionAuthority(connection.id, userId);
    return connectionVersion === undefined ? null : {resourceId,
      authority: {kind: 'owner', sessionId: target.sessionId, connectionVersion}};
  }
  const proof = owner.grants.authorize({userId: principal.userId, ownerUserId: userId,
    connectionId: connection.id, administrator: principal.admin}, 'messages:read',
    {runtime: ref.runtimeId, sessionKey: decoded.remoteSessionKey});
  return proof ? {resourceId, authority: {kind: 'shared', sessionId: target.sessionId, ownerUserId: userId, proof}} : null;
}

/** Structural reply fence; live authorization always uses the original store. */
export function sessionNotebookResourceMatches(authority: HubSessionNotebookAuthority, resourceId: string): boolean {
  try {
    const tuple: unknown = JSON.parse(resourceId);
    if (!Array.isArray(tuple) || tuple.length !== 4 || JSON.stringify(tuple) !== resourceId
      || !tuple.every(v => typeof v === 'string' && !!v)) return false;
    if (authority.kind === 'shared' && tuple[0] !== authority.ownerUserId) return false;
    const decoded = decodeHubSessionId(authority.sessionId)!;
    const ref = sessionRef(tuple[1], decoded.remoteSessionKey);
    return !!ref && ref.runtimeId === tuple[2] && ref.nativeSessionKey === tuple[3];
  } catch { return false; }
}

/** Only called inside the original identity/CAS savepoint. Resolve the actual
 * node/runtime/key again; never trust a caller-supplied resource tuple. */
export function sessionNotebookAuthorityCurrent(owner: HubStore, principal: HubPrincipal,
  authority: HubSessionNotebookAuthority, resourceId: string): boolean {
  if (!validHubSessionNotebookAuthority(authority)) return false;
  const decoded = decodeHubSessionId(authority.sessionId)!;
  const userId = authority.kind === 'shared' ? authority.ownerUserId : principal.userId;
  const connection = owner.getConnection(decoded.connectionId, userId);
  if (!connection || connection.status === 'disabled') return false;
  let ref;
  try { ref = sessionRef(connection.nodeId, decoded.remoteSessionKey); } catch { return false; }
  if (!ref || resourceId !== JSON.stringify([userId, ref.nodeId, ref.runtimeId, ref.nativeSessionKey])) return false;
  if (authority.kind === 'owner') return owner.connectionAuthority(connection.id, userId) === authority.connectionVersion;
  const proof = authority.proof;
  return proof.ownerUserId === userId && proof.connectionId === connection.id && proof.userId === principal.userId
    && (!proof.administrator || principal.admin) && proof.action === 'messages:read'
    && proof.resource.runtime === ref.runtimeId && proof.resource.sessionKey === decoded.remoteSessionKey
    && owner.grants.revalidate(proof);
}
