import type { DatabaseSync } from 'node:sqlite';
import type { HubStore } from './hub-store.js';
import type { HubPrincipal } from './identity.js';
import { SessionShareConflict, parseNodeGrantPolicy, type NodeAction, type NodeGrantRecord, type SessionShareOptions, type SessionRevocationStatus } from './node-grants.js';
import { connectionRecoverySnapshot } from '../storage/connection-recovery.js';
import { decodeHubSessionId } from './session-id.js';
import { executeHubSessionCollaboratorCommand, validHubSessionCollaboratorCommand, type HubSessionCollaboratorProof } from './member-session-collaborators-domain.js';

type Target = { userId: string; ownerUserId: string; sessionId: string; proof: HubSessionCollaboratorProof };
export type HubSessionSharingCommand = Target & (
  { action: 'create'; recipientId: string; role: 'observer' | 'collaborator'; options: SessionShareOptions }
  | { action: 'update'; id: string; version: number; role: 'observer' | 'collaborator'; options: SessionShareOptions }
  | { action: 'delete'; id: string; version: number }
  | { action: 'revocation'; id: string; version: number }
);
export type HubSessionSharingResult = null | HubSessionSharingCommand & {
  status: 200 | 201 | 400 | 403 | 404 | 409;
  grant: NodeGrantRecord | null; ok: boolean | null;
  revocation?: SessionRevocationStatus;
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && Object.keys(v).every(k => names.includes(k));
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= 16384;
const version = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 1;
const validTarget = (v: Record<string, unknown>) => validHubSessionCollaboratorCommand({
  action: 'check', userId: v.userId, ownerUserId: v.ownerUserId, sessionId: v.sessionId, proof: v.proof,
});
const targetKeys = ['action','userId','ownerUserId','sessionId','proof'];
export function validHubSessionSharingCommand(v: unknown): v is HubSessionSharingCommand {
  if (!object(v) || !validTarget(v)) return false;
  if (v.action === 'delete' || v.action === 'revocation') return fields(v, [...targetKeys,'id','version']) && id(v.id) && version(v.version);
  const options = v.options;
  if (v.role !== 'observer' && v.role !== 'collaborator' || !object(options)
    || Object.keys(options).some(k => !['live','queue','media'].includes(k) || typeof options[k] !== 'boolean')) return false;
  return v.action === 'create' && fields(v, [...targetKeys,'recipientId','role','options']) && id(v.recipientId)
    || v.action === 'update' && fields(v, [...targetKeys,'id','version','role','options']) && id(v.id) && version(v.version);
}
function validGrant(v: unknown, sessionId: string, proof: HubSessionCollaboratorProof): v is NodeGrantRecord {
  const decoded = decodeHubSessionId(sessionId);
  if (!decoded || !object(v) || !fields(v, ['id','userId','version','nodeVersion','revoked','policy','derived'])
    || !id(v.id) || !id(v.userId) || !version(v.version) || v.nodeVersion !== proof.nodeVersion
    || v.revoked !== false || v.derived !== true) return false;
  try {
    const policy = parseNodeGrantPolicy(v.policy);
    return policy.runtime === 'codex' && policy.sessionKey === decoded.remoteSessionKey && policy.agentId === undefined;
  } catch { return false; }
}
export function validHubSessionSharingResult(v: unknown): v is HubSessionSharingResult {
  if (v === null) return true;
  if (!object(v)) return false;
  const { status: _status, grant: _grant, ok: _ok, revocation: _revocation, ...command } = v;
  if (!Object.hasOwn(v, 'status') || !Object.hasOwn(v, 'grant') || !Object.hasOwn(v, 'ok')
    || !validHubSessionSharingCommand(command)) return false;
  const r = v.revocation;
  if (r !== undefined && (!object(r) || !fields(r, ['state','pending','confirmed'])
    || !Number.isSafeInteger(r.pending) || Number(r.pending) < 0 || Number(r.pending) > 10000
    || !Number.isSafeInteger(r.confirmed) || Number(r.confirmed) < 0 || Number(r.confirmed) > 10000
    || Number(r.pending) + Number(r.confirmed) > 10000
    || r.state !== (r.pending === 0 ? 'confirmed' : 'pending'))) return false;
  if (v.status === 400 || v.status === 403 || v.status === 404 || v.status === 409) return v.grant === null && v.ok === null && r === undefined;
  if (v.action === 'revocation') return v.status === 200 && v.grant === null && v.ok === true && r !== undefined;
  if (v.action === 'delete') return v.status === 200 && v.grant === null && typeof v.ok === 'boolean'
    && (v.ok ? r !== undefined : r === undefined);
  if (r !== undefined) return false;
  return v.status === (v.action === 'create' ? 201 : 200) && v.ok === null
    && validGrant(v.grant, v.sessionId as string, v.proof as HubSessionCollaboratorProof);
}
export function validHubSessionSharingReply(command: HubSessionSharingCommand, v: unknown): v is HubSessionSharingResult {
  if (!validHubSessionSharingResult(v)) return false;
  if (v === null) return true;
  if (v.action !== command.action || v.userId !== command.userId || v.ownerUserId !== command.ownerUserId
    || v.sessionId !== command.sessionId || Object.keys(command.proof).some(k =>
      command.proof[k as keyof HubSessionCollaboratorProof] !== v.proof[k as keyof HubSessionCollaboratorProof])) return false;
  if (command.action === 'create') {
    if (v.action !== 'create' || v.recipientId !== command.recipientId) return false;
  } else if (v.action === 'create' || v.id !== command.id || v.version !== command.version) return false;
  if (command.action !== 'delete' && command.action !== 'revocation') {
    if (v.action === 'delete' || v.action === 'revocation' || v.role !== command.role || Object.keys(v.options).length !== Object.keys(command.options).length
      || Object.keys(command.options).some(k => v.options[k as keyof SessionShareOptions] !== command.options[k as keyof SessionShareOptions])) return false;
  }
  // Missing recipient is only possible when creating; negative replies cannot
  // convert an impossible ACK into a definite no-effect result.
  if (v.status === 400) return command.action === 'create';
  if (v.status === 403 || v.status === 404 || v.status === 409) return true;
  if (command.action === 'delete' || command.action === 'revocation') return true;
  const grant = v.grant!;
  if (command.action === 'create' ? grant.userId !== command.recipientId || grant.version !== 1
    : grant.id !== command.id || grant.version !== command.version + 1) return false;
  const actions: NodeAction[] = ['sessions:read','messages:read'];
  if (command.options.live !== false) actions.push('events:read');
  if (command.options.media === true) actions.push('media:read');
  if (command.role === 'collaborator') {
    actions.push('messages:send'); if (command.options.queue !== false) actions.push('queue:manage');
  } else if (command.options.queue === true) return false;
  return actions.length === grant.policy.actions.length && actions.every(a => grant.policy.actions.includes(a));
}

/** Fixed transaction domain on the complete original owner. The identity
 * savepoint surrounds proof, policy, CAS, write/readback AND final settlement.
 * No arbitrary SQL, callback, new writer, native effect or mutation retry. */
export function executeHubSessionSharingCommand(db: DatabaseSync, store: HubStore, actor: HubPrincipal,
  command: HubSessionSharingCommand): Exclude<HubSessionSharingResult, null> {
  if (!validHubSessionSharingCommand(command) || actor.userId !== command.userId) throw new Error('hub_session_sharing_unavailable');
  const { action, userId, ownerUserId, sessionId } = command, proof = { ...command.proof };
  const request: HubSessionSharingCommand = command.action === 'delete' || command.action === 'revocation' ? { ...command, proof }
    : { ...command, proof, options: { ...command.options } };
  const result = (status: Exclude<HubSessionSharingResult, null>['status'], grant: NodeGrantRecord | null = null, ok: boolean | null = null) =>
    ({ ...request, status, grant, ok });
  const current = executeHubSessionCollaboratorCommand(db, store, actor, { action: 'check', userId, ownerUserId, sessionId, proof });
  if (current.status !== 200) return result(current.status);
  const decoded = decodeHubSessionId(sessionId)!;
  const share = store.grants.authorize({ userId, ownerUserId, connectionId: decoded.connectionId, administrator: actor.admin },
    'sessions:share', { runtime: 'codex', sessionKey: decoded.remoteSessionKey }, proof.shareId);
  if (!share || share.version !== proof.shareVersion || share.nodeVersion !== proof.nodeVersion || !store.grants.revalidate(share)) return result(403);
  if (action === 'create' && !store.getUser(command.recipientId)) return result(400);
  try {
    if (action === 'delete' || action === 'revocation') {
      const ok = action === 'revocation' || store.grants.revokeCollaborator(share, command.id, command.version);
      if (!ok) return result(200, null, false);
      const revocation = store.grants.collaboratorRevocation(share, command.id, command.version);
      if (!revocation) { if (action === 'revocation') return result(404); throw new Error('hub_session_sharing_unavailable'); }
      return { ...result(200, null, true), revocation };
    }
    const grant = action === 'create'
      ? store.grants.shareSession(share, command.recipientId, command.role, command.options)
      : store.grants.updateCollaborator(share, command.id, command.version, command.role, command.options);
    const value = result(action === 'create' ? 201 : 200, grant);
    if (!validHubSessionSharingReply(command, value)) throw new Error('hub_session_sharing_unavailable');
    return value;
  } catch (error) {
    // Inner policy refusal is definite ONLY after its original cleanup. The
    // outer identity RELEASE still has to succeed before an ACK can be sent.
    if (!(error instanceof SessionShareConflict) || connectionRecoverySnapshot(db).state !== 'ready') throw error;
    return result(409);
  }
}
