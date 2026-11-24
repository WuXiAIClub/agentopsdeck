import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import type { HubStore } from './hub-store.js';
import type { HubPrincipal } from './identity.js';
import { decodeHubSessionId } from './session-id.js';
import { boundReceivedGrantRows } from './member-received-grants-domain.js';
import { connectionRecoverySnapshot } from '../storage/connection-recovery.js';
import { SessionShareConflict, parseNodeGrantPolicy, type NodeAction, type NodeGrantRecord, type SessionShareOptions } from './node-grants.js';

type Target = { userId: string; sessionId: string };
export type HubOwnedSessionSharingCommand = Target & (
  { action: 'authorize' } | { action: 'list' }
  | { action: 'check'; nodeVersion: number }
  | { action: 'create'; nodeVersion: number; recipientId: string; role: 'observer' | 'collaborator'; options: SessionShareOptions }
  | { action: 'update'; nodeVersion: number; id: string; version: number; role: 'observer' | 'collaborator'; options: SessionShareOptions }
  | { action: 'delete'; nodeVersion: number; id: string; version: number }
);
type Page = { collaborators: NodeGrantRecord[]; candidates: Array<{ id: string; label: string; canChat: boolean }> };
export type HubOwnedSessionSharingResult = null | {
  command: HubOwnedSessionSharingCommand; status: 200 | 201 | 400 | 404 | 409; nodeVersion: number | null;
  page: Page | null; grant: NodeGrantRecord | null; ok: boolean | null; conflict: 'precondition' | 'membership' | 'policy' | null;
};
export const HUB_OWNED_SESSION_SHARING_BYTES = 2 * 1024 * 1024;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && Object.keys(v).every(k => names.includes(k));
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= 16384;
const version = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 1;
const base = ['action','userId','sessionId'];
export function validHubOwnedSessionSharingCommand(v: unknown): v is HubOwnedSessionSharingCommand {
  if (!object(v) || !id(v.userId) || typeof v.sessionId !== 'string' || v.sessionId.length > 4096) return false;
  if (v.action === 'list' || v.action === 'authorize') return fields(v, base);
  if (!version(v.nodeVersion)) return false;
  if (v.action === 'check') return fields(v, [...base,'nodeVersion']);
  if (v.action === 'delete') return fields(v, [...base,'nodeVersion','id','version']) && id(v.id) && version(v.version);
  if ((v.role !== 'observer' && v.role !== 'collaborator') || !object(v.options)
    || Object.keys(v.options).some(k => !['live','queue','media'].includes(k) || typeof (v.options as Record<string,unknown>)[k] !== 'boolean')) return false;
  return v.action === 'create' && fields(v, [...base,'nodeVersion','recipientId','role','options']) && id(v.recipientId)
    || v.action === 'update' && fields(v, [...base,'nodeVersion','id','version','role','options']) && id(v.id) && version(v.version);
}
function validGrant(v: unknown, command: HubOwnedSessionSharingCommand, nodeVersion: number): v is NodeGrantRecord {
  const decoded = decodeHubSessionId(command.sessionId);
  if (!decoded || !object(v) || !fields(v, ['id','userId','version','nodeVersion','revoked','policy'])
    || !id(v.id) || !id(v.userId) || !version(v.version) || v.nodeVersion !== nodeVersion || v.revoked !== false) return false;
  try { const policy = parseNodeGrantPolicy(v.policy);
    return policy.runtime === 'codex' && policy.sessionKey === decoded.remoteSessionKey && policy.agentId === undefined;
  } catch { return false; }
}
function validPage(v: unknown, command: HubOwnedSessionSharingCommand, nodeVersion: number): v is Page {
  if (!object(v) || !fields(v, ['collaborators','candidates']) || !Array.isArray(v.collaborators) || v.collaborators.length > 101
    || !Array.isArray(v.candidates) || v.candidates.length > 500) return false;
  return v.collaborators.every(g => validGrant(g, command, nodeVersion))
    && new Set(v.collaborators.map(g => g.id)).size === v.collaborators.length
    && v.candidates.every(u => object(u) && fields(u, ['id','label','canChat']) && id(u.id)
      && typeof u.label === 'string' && Buffer.byteLength(u.label) <= 65536 && typeof u.canChat === 'boolean')
    && new Set(v.candidates.map(u => u.id)).size === v.candidates.length;
}
export function validHubOwnedSessionSharingResult(v: unknown): v is HubOwnedSessionSharingResult {
  if (v === null) return true;
  if (!object(v) || !fields(v, ['command','status','nodeVersion','page','grant','ok','conflict'])
    || !validHubOwnedSessionSharingCommand(v.command)) return false;
  if ([400,404,409].includes(Number(v.status))) return typeof v.status === 'number' && v.nodeVersion === null && v.page === null
    && v.grant === null && v.ok === null && (v.status === 409 ? ['precondition','membership','policy'].includes(v.conflict as string) : v.conflict === null);
  if (!version(v.nodeVersion) || v.conflict !== null || 'nodeVersion' in v.command && v.nodeVersion !== v.command.nodeVersion) return false;
  if (v.command.action === 'authorize' || v.command.action === 'check') return v.status === 200 && v.page === null && v.grant === null && v.ok === null;
  if (v.command.action === 'list') return v.status === 200 && validPage(v.page, v.command, v.nodeVersion) && v.grant === null && v.ok === null;
  if (v.command.action === 'delete') return v.status === 200 && v.page === null && v.grant === null && typeof v.ok === 'boolean';
  return v.status === (v.command.action === 'create' ? 201 : 200) && v.page === null && v.ok === null && validGrant(v.grant,v.command,v.nodeVersion);
}
export function validHubOwnedSessionSharingReply(command: HubOwnedSessionSharingCommand, v: unknown): v is HubOwnedSessionSharingResult {
  if (!validHubOwnedSessionSharingResult(v)) return false;
  if (v === null) return true;
  if (!isDeepStrictEqual(command, v.command)) return false;
  if (v.status === 400) return ['create','update','delete'].includes(command.action);
  if (v.status === 404) return true;
  if (v.status === 409) return command.action !== 'list' && command.action !== 'authorize'
    && (v.conflict === 'precondition' || ['create','update'].includes(command.action));
  if (command.action !== 'create' && command.action !== 'update') return true;
  const grant = v.grant!;
  if (command.action === 'create' ? grant.userId !== command.recipientId || grant.version !== 1
    : grant.id !== command.id || grant.version !== command.version + 1) return false;
  const actions: NodeAction[] = ['sessions:read','messages:read'];
  if (command.options.live !== false) actions.push('events:read');
  if (command.options.media === true) actions.push('media:read');
  if (command.role === 'collaborator') { actions.push('messages:send'); if (command.options.queue !== false) actions.push('queue:manage'); }
  else if (command.options.queue === true) return false;
  return actions.length === grant.policy.actions.length && actions.every(a => grant.policy.actions.includes(a));
}

/** The original complete owner holds identity, node version, role, CAS and
 * mutation settlement on one connection. No native effect or replay. */
export function executeHubOwnedSessionSharingCommand(db: DatabaseSync, store: HubStore, actor: HubPrincipal,
  command: HubOwnedSessionSharingCommand): Exclude<HubOwnedSessionSharingResult,null> {
  if (!validHubOwnedSessionSharingCommand(command) || command.userId !== actor.userId) throw Error('hub_owned_session_sharing_unavailable');
  const request = structuredClone(command);
  const result = (status: Exclude<HubOwnedSessionSharingResult,null>['status'], nodeVersion: number | null = null,
    page: Page | null = null, grant: NodeGrantRecord | null = null, ok: boolean | null = null,
    conflict: Exclude<HubOwnedSessionSharingResult,null>['conflict'] = null) =>
    ({ command: request, status, nodeVersion, page, grant, ok, conflict });
  const decoded = decodeHubSessionId(command.sessionId);
  if (!decoded || !decoded.remoteSessionKey.startsWith('codex:')) return result(404);
  const target = { userId: actor.userId, ownerUserId: actor.userId, connectionId: decoded.connectionId };
  const connection = store.getConnection(target.connectionId,target.ownerUserId);
  if (!connection?.nodeId || connection.status === 'disabled') return result(404);
  const nodeVersion = store.connectionAuthority(target.connectionId,target.ownerUserId)!;
  if ('nodeVersion' in command && command.nodeVersion !== nodeVersion) return result(409,null,null,null,null,'precondition');
  const resource = { runtime: 'codex' as const, sessionKey: decoded.remoteSessionKey };
  if (command.action === 'authorize' || command.action === 'check') return result(200,nodeVersion);
  boundReceivedGrantRows(db); // Bound persisted JSON before original row materialization.
  const rows = () => store.grants.sessionGrants(target,resource).filter(g => g.nodeVersion === nodeVersion);
  if (command.action === 'list') {
    let count=0, bytes=0;
    for (const row of db.prepare(`SELECT length(CAST(users.id AS BLOB)) AS id, length(CAST(users.label AS BLOB)) AS label
      FROM users JOIN connector_memberships member ON member.user_id=users.id
      WHERE member.node_owner=? AND member.connection_id=? AND member.role!='none' AND users.id!=? LIMIT 4097`)
      .iterate(target.ownerUserId,target.connectionId,target.userId)) {
      if (++count > 4096) throw Error('hub_owned_session_sharing_unavailable');
      for (const n of Object.values(row)) if (!Number.isSafeInteger(n) || Number(n)<0 || Number(n)>65536
        || (bytes+=Number(n))>16*1024*1024) throw Error('hub_owned_session_sharing_unavailable');
    }
    return result(200,nodeVersion,{ collaborators: rows(), candidates: store.roles.sessionCandidates(target,resource) });
  }
  const previous = command.action === 'create' ? undefined : rows().find(g => g.id === command.id);
  if (command.action !== 'create' && (!previous || previous.version !== command.version || store.roles.managedGrant(previous.id))) return result(409,null,null,null,null,'precondition');
  const userId = previous?.userId ?? (command.action === 'create' ? command.recipientId : undefined);
  if (typeof userId !== 'string' || !store.getUser(userId) || userId === target.ownerUserId) return result(400);
  const recipient = { ...target,userId };
  if (command.action === 'delete') return result(200,nodeVersion,null,null,store.grants.revoke(recipient,previous!.id,previous!.version));
  if (!store.roles.membership(recipient).version) return result(409,null,null,null,null,'membership');
  try {
    const grant = store.grants.saveSessionAccess(recipient,resource,command.role,command.options,nodeVersion,
      previous ? { id: previous.id,version: previous.version } : undefined);
    const value = result(command.action === 'create' ? 201 : 200,nodeVersion,null,grant);
    if (!validHubOwnedSessionSharingReply(command,value)) throw Error('hub_owned_session_sharing_unavailable');
    return value;
  } catch(error) {
    if (!(error instanceof SessionShareConflict) || connectionRecoverySnapshot(db).state !== 'ready') throw error;
    return result(409,null,null,null,null,'policy');
  }
}
