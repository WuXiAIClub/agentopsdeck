import type { DatabaseSync } from 'node:sqlite';
import type { HubStore } from './hub-store.js';
import type { HubPrincipal } from './identity.js';
import { parseNodeGrantPolicy, type NodeGrantRecord } from './node-grants.js';
import { decodeHubSessionId } from './session-id.js';
import { sessionRef } from './session-ref.js';
import { boundReceivedGrantRows } from './member-received-grants-domain.js';

/** Private original-version correlation, never a browser execution proof. */
export type HubSessionCollaboratorProof = {
  readId: string; readVersion: number; shareId: string; shareVersion: number; nodeVersion: number;
};
type Target = { userId: string; ownerUserId: string; sessionId: string };
export type HubSessionCollaboratorCommand = Target & (
  { action: 'list' | 'authorize' } | { action: 'check'; proof: HubSessionCollaboratorProof }
);
export type HubSessionCollaboratorPage = {
  collaborators: NodeGrantRecord[]; candidates: Array<{ id: string; label: string; canChat: boolean }>;
};
export type HubSessionCollaboratorResult = null | Target & {
  action: 'list' | 'authorize' | 'check'; status: 200 | 403 | 404;
  proof: HubSessionCollaboratorProof | null; page: HubSessionCollaboratorPage | null;
};
export const HUB_SESSION_COLLABORATOR_BYTES = 2 * 1024 * 1024;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && Object.keys(v).every(k => names.includes(k));
const text = (v: unknown): v is string => typeof v === 'string' && Buffer.byteLength(v) <= 65536;
const id = (v: unknown): v is string => text(v) && v.length > 0 && Buffer.byteLength(v) <= 16384;
const version = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 1;
function validProof(v: unknown): v is HubSessionCollaboratorProof {
  return object(v) && fields(v, ['readId','readVersion','shareId','shareVersion','nodeVersion'])
    && id(v.readId) && id(v.shareId) && version(v.readVersion) && version(v.shareVersion) && version(v.nodeVersion);
}
const sameProof = (a: HubSessionCollaboratorProof, b: HubSessionCollaboratorProof) =>
  a.readId === b.readId && a.readVersion === b.readVersion && a.shareId === b.shareId
    && a.shareVersion === b.shareVersion && a.nodeVersion === b.nodeVersion;
export function validHubSessionCollaboratorCommand(v: unknown): v is HubSessionCollaboratorCommand {
  return object(v) && id(v.userId) && id(v.ownerUserId) && typeof v.sessionId === 'string' && v.sessionId.length <= 4096
    && ((v.action === 'list' || v.action === 'authorize') && fields(v, ['action','userId','ownerUserId','sessionId'])
      || v.action === 'check' && fields(v, ['action','userId','ownerUserId','sessionId','proof']) && validProof(v.proof));
}
function validPage(v: unknown, sessionId: string, proof: HubSessionCollaboratorProof): v is HubSessionCollaboratorPage {
  const decoded = decodeHubSessionId(sessionId);
  if (!decoded) return false;
  if (!object(v) || !fields(v, ['collaborators','candidates']) || !Array.isArray(v.collaborators)
    || v.collaborators.length > 101 || !Array.isArray(v.candidates) || v.candidates.length > 500) return false;
  const grants = new Set<string>(), users = new Set<string>();
  return v.collaborators.every(g => {
    if (!object(g) || !fields(g, ['id','userId','version','nodeVersion','revoked','policy','derived']) || !id(g.id)
      || grants.has(g.id) || !id(g.userId) || !version(g.version) || !version(g.nodeVersion) || g.revoked !== false || g.derived !== true) return false;
    try {
      const policy = parseNodeGrantPolicy(g.policy);
      if (g.nodeVersion !== proof.nodeVersion || policy.runtime !== 'codex'
        || policy.sessionKey !== decoded.remoteSessionKey || policy.agentId !== undefined) return false;
    } catch { return false; }
    grants.add(g.id); return true;
  }) && v.candidates.every(u => {
    if (!object(u) || !fields(u, ['id','label','canChat']) || !id(u.id) || users.has(u.id) || !text(u.label) || typeof u.canChat !== 'boolean') return false;
    users.add(u.id); return true;
  });
}
export function validHubSessionCollaboratorResult(v: unknown): v is HubSessionCollaboratorResult {
  if (v === null) return true;
  if (!object(v) || !fields(v, ['action','userId','ownerUserId','sessionId','status','proof','page'])
    || !validHubSessionCollaboratorCommand({ action: 'list', userId: v.userId, ownerUserId: v.ownerUserId, sessionId: v.sessionId })
    || !['list','authorize','check'].includes(v.action as string)) return false;
  if (v.status === 403 || v.status === 404) return v.proof === null && v.page === null;
  return v.status === 200 && validProof(v.proof) && (v.action !== 'list' ? v.page === null : validPage(v.page, v.sessionId as string, v.proof));
}
export function validHubSessionCollaboratorReply(command: HubSessionCollaboratorCommand, v: unknown): v is HubSessionCollaboratorResult {
  return validHubSessionCollaboratorResult(v) && (v === null || v.action === command.action && v.userId === command.userId
    && v.ownerUserId === command.ownerUserId && v.sessionId === command.sessionId
    && (v.status !== 200 || command.action !== 'check' || sameProof(command.proof, v.proof!)));
}

/** One original identity savepoint. Listing includes administrator maintenance;
 * checking pins the captured grants and MUST NOT maintain/reissue them again. */
export function executeHubSessionCollaboratorCommand(db: DatabaseSync, store: HubStore, actor: HubPrincipal,
  command: HubSessionCollaboratorCommand): Exclude<HubSessionCollaboratorResult, null> {
  if (!validHubSessionCollaboratorCommand(command) || command.userId !== actor.userId) throw new Error('hub_session_collaborators_unavailable');
  const { action, userId, ownerUserId, sessionId } = command;
  const result = (status: 200 | 403 | 404, proof: HubSessionCollaboratorProof | null = null, page: HubSessionCollaboratorPage | null = null) =>
    ({ action, userId, ownerUserId, sessionId, status, proof, page });
  boundReceivedGrantRows(db); // Numeric lengths before legacy SELECT*/JSON materialization.
  if (action !== 'check') store.roles.syncAdministrator(actor);
  const decoded = decodeHubSessionId(sessionId);
  if (!decoded) return result(404);
  const connection = store.getConnection(decoded.connectionId, ownerUserId);
  let ref;
  try { ref = sessionRef(connection?.nodeId, decoded.remoteSessionKey); } catch {}
  if (!connection || connection.status === 'disabled' || !ref) return result(404);
  const target = { userId, ownerUserId, connectionId: connection.id, administrator: actor.admin };
  const resource = { runtime: ref.runtimeId, sessionKey: decoded.remoteSessionKey };
  const read = store.grants.authorize(target, 'messages:read', resource, action === 'check' ? command.proof.readId : undefined);
  if (!read) return result(action === 'check' ? 403 : 404);
  const share = store.grants.authorize(target, 'sessions:share', resource, action === 'check' ? command.proof.shareId : undefined);
  if (!share || !store.grants.revalidate(read) || !store.grants.revalidate(share) || !store.grants.ownedSession(share)) return result(403);
  const proof = { readId: read.grantId, readVersion: read.version, shareId: share.grantId, shareVersion: share.version, nodeVersion: share.nodeVersion };
  if (read.nodeVersion !== proof.nodeVersion || action === 'check' && !sameProof(command.proof, proof)) return result(403);
  if (action !== 'list') return result(200, proof);
  // sessionCandidates() materializes user labels. Preflight numeric lengths,
  // including filtered candidates, before the original ordered SELECT.
  let count = 0, bytes = 0;
  for (const row of db.prepare(`SELECT length(CAST(users.id AS BLOB)) AS id, length(CAST(users.label AS BLOB)) AS label
    FROM users JOIN connector_memberships member ON member.user_id=users.id
    WHERE member.node_owner=? AND member.connection_id=? AND member.role!='none' AND users.id!=? LIMIT 4097`)
    .iterate(ownerUserId, connection.id, userId)) {
    if (++count > 4096) throw new Error('hub_session_collaborators_unavailable');
    for (const n of Object.values(row)) if (!Number.isSafeInteger(n) || Number(n) < 0 || Number(n) > 65536
      || (bytes += Number(n)) > 16 * 1024 * 1024) throw new Error('hub_session_collaborators_unavailable');
  }
  const page = { collaborators: store.grants.collaborators(share), candidates: store.roles.sessionCandidates(share, share.resource) };
  return result(200, proof, page);
}
