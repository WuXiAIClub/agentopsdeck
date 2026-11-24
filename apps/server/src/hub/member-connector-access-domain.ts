import { NODE_ACTIONS } from '@agentopsdeck/shared';
import type { HubStore, HubConnection } from './hub-store.js';
import type { HubPrincipal } from './identity.js';
import type { NodeGrantProof } from './node-grants.js';
import { validConnectionEpoch, validHubConnectionTarget, readHubConnectionTarget } from './member-connection-change-domain.js';

/** Fixed original-owner read. Credentials remain in memory on the private
 * worker channel only; no token, principal or grant is a diagnostic field. */
export type HubConnectorAccessCommand = {
  id: string; maintenance: boolean; grant?: NodeGrantProof;
} & ({ action: 'open' } | { action: 'check'; expectedEpoch: number });
export type HubConnectorAccessResult = null | { error: 'missing' | 'changed' | 'denied' }
  | { connection: HubConnection; epoch: number; token: string | null }
  | { ok: true; epoch: number };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && !!v && Buffer.byteLength(v) <= 4096;
export function validHubNodeGrantProof(v: unknown): v is NodeGrantProof {
  if (!object(v) || !Object.keys(v).every(k => ['ownerUserId','connectionId','userId','administrator','grantId','version','nodeVersion','action','resource'].includes(k))) return false;
  if (![v.ownerUserId, v.connectionId, v.userId, v.grantId].every(id)
    || !validConnectionEpoch(v.version) || !validConnectionEpoch(v.nodeVersion)
    || !(NODE_ACTIONS as readonly unknown[]).includes(v.action)
    || (v.administrator !== undefined && typeof v.administrator !== 'boolean') || !object(v.resource)) return false;
  const r = v.resource;
  return Object.keys(r).every(k => ['runtime','agentId','sessionKey'].includes(k))
    && (r.runtime === undefined || r.runtime === 'codex' || r.runtime === 'openclaw')
    && (r.agentId === undefined || id(r.agentId)) && (r.sessionKey === undefined || id(r.sessionKey));
}
export function validHubConnectorAccessCommand(v: unknown): v is HubConnectorAccessCommand {
  return object(v) && Object.keys(v).every(k => ['id','maintenance','grant','action','expectedEpoch'].includes(k))
    && id(v.id) && typeof v.maintenance === 'boolean' && (v.grant === undefined || validHubNodeGrantProof(v.grant))
    && (v.action === 'open' ? !Object.hasOwn(v, 'expectedEpoch') : v.action === 'check' && validConnectionEpoch(v.expectedEpoch));
}
export function validHubConnectorAccessResult(v: unknown): v is HubConnectorAccessResult {
  if (v === null) return true;
  if (!object(v)) return false;
  const keys = Object.keys(v);
  if (keys.length === 1 && ['missing','changed','denied'].includes(String(v.error))) return true;
  if (keys.length === 2 && v.ok === true && validConnectionEpoch(v.epoch)) return true;
  return keys.length === 3 && keys.every(k => ['connection','epoch','token'].includes(k))
    && (v.token === null || typeof v.token === 'string' && !!v.token && Buffer.byteLength(v.token) <= 16_384)
    && validHubConnectionTarget({ connection: v.connection, epoch: v.epoch });
}
export function validHubConnectorAccessReply(command: HubConnectorAccessCommand, value: unknown): boolean {
  if (!validHubConnectorAccessResult(value)) return false;
  if (value === null || 'error' in value) return true;
  return command.action === 'check' ? 'ok' in value && value.epoch === command.expectedEpoch
    : 'connection' in value && value.connection.id === command.id && value.connection.status !== 'disabled'
      && (command.grant === undefined || value.connection.ownerUserId === command.grant.ownerUserId)
      && (value.connection.kind !== 'local' || value.token === null);
}
/** Called only within the original identity savepoint. Never use a caller's
 * userId/admin boolean as authority; revalidate the proof on EVERY delivery. */
export function readHubConnectorAccess(owner: HubStore, principal: HubPrincipal,
  command: HubConnectorAccessCommand): Exclude<HubConnectorAccessResult, null> {
  if (!validHubConnectorAccessCommand(command)) throw new Error('hub_connector_access_unavailable');
  const grant = command.grant;
  if (grant && (command.maintenance || grant.connectionId !== command.id || grant.userId !== principal.userId
    || !!grant.administrator && !principal.admin || !owner.grants.revalidate(grant))) return { error: 'denied' };
  const userId = grant?.ownerUserId ?? principal.userId;
  const target = readHubConnectionTarget(owner, userId, command.id);
  // Initial absence stays private (404). A pinned in-flight target that was
  // deleted/disabled has lost authority (403), never a fresh resolution.
  if ('error' in target || target.connection.status === 'disabled')
    return { error: command.action === 'check' ? 'changed' : 'missing' };
  if (command.action === 'check') return command.expectedEpoch === target.epoch
    ? { ok: true, epoch: target.epoch } : { error: 'changed' };
  // Local process tokens are never persisted/read as remote credentials.
  const token = target.connection.kind === 'local' ? null : command.maintenance
    ? owner.getMaintenanceCredentialToken(command.id, userId) : owner.getCredentialToken(command.id, userId);
  const result = { ...target, token: token ?? null };
  if (!validHubConnectorAccessResult(result)) throw new Error('hub_connector_access_unavailable');
  return result;
}
