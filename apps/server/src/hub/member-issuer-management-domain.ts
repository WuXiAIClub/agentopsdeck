import { createHash } from 'node:crypto';
import type { HubStore } from './hub-store.js';
import type { HubPrincipal } from './identity.js';
import type { IssuerConfigurationTarget } from './execution-issuers.js';

export const HUB_ISSUER_MANAGEMENT_BYTES = 32 * 1024;
type Issuer = { issuerId: string; nodeId: string; version: number; creationAllowed?: true };
type Base = { connectionId: string };
export type HubIssuerManagementCommand = Base & (
  { action: 'read' } | { action: 'disable' } |
  { action: 'prepare'; local: boolean } |
  { action: 'check'; local: boolean; pin: string } |
  { action: 'install'; local: boolean; pin: string; token: string; issuerId: string; creationAllowed: boolean } |
  { action: 'cleanup'; issuerId: string });
export type HubIssuerManagementData = { error: 403 | 404 | 409 } |
  { action: 'read'; hubId: string; admin: boolean; kind: 'local' | 'remote'; issuer: Issuer | null } |
  { action: 'prepare'; hubId: string; pin: string; target: IssuerConfigurationTarget; issuer: Issuer | null } |
  { action: 'check' | 'disable' } | { action: 'install'; issuer: Issuer } |
  { action: 'cleanup'; neverInstalled: boolean };
export type HubIssuerManagementResult = null | { connectionId: string; data: HubIssuerManagementData };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => k in v);
const text = (v: unknown, max = 16384): v is string => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= max && !/[\x00-\x1f\x7f]/.test(v);
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const issuerId = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(v);
const version = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0;
const issuer = (v: unknown) => v === null || object(v) && exact(v, ['issuerId', 'nodeId', 'version', ...('creationAllowed' in v ? ['creationAllowed'] : [])])
  && issuerId(v.issuerId) && text(v.nodeId, 128) && version(v.version) && (!('creationAllowed' in v) || v.creationAllowed === true);
export function validHubIssuerManagementCommand(v: unknown): v is HubIssuerManagementCommand {
  if (!object(v) || !text(v.connectionId)) return false;
  const keys = ['connectionId', 'action'];
  switch (v.action) {
    case 'read': case 'disable': return exact(v, keys);
    case 'prepare': return exact(v, [...keys, 'local']) && typeof v.local === 'boolean';
    case 'check': return exact(v, [...keys, 'local', 'pin']) && typeof v.local === 'boolean' && digest(v.pin);
    case 'install': return exact(v, [...keys, 'local', 'pin', 'token', 'issuerId', 'creationAllowed']) && typeof v.local === 'boolean'
      && digest(v.pin) && text(v.token, 4096) && !/\s/.test(v.token) && issuerId(v.issuerId) && typeof v.creationAllowed === 'boolean';
    case 'cleanup': return exact(v, [...keys, 'issuerId']) && issuerId(v.issuerId);
    default: return false;
  }
}
export function validHubIssuerManagementResult(v: unknown): v is HubIssuerManagementResult {
  if (v === null) return true;
  if (!object(v) || !exact(v, ['connectionId', 'data']) || !text(v.connectionId) || !object(v.data)) return false;
  const d = v.data;
  if ('error' in d) return exact(d, ['error']) && [403, 404, 409].includes(d.error as number);
  switch (d.action) {
    case 'read': return exact(d, ['action', 'hubId', 'admin', 'kind', 'issuer']) && text(d.hubId, 128)
      && typeof d.admin === 'boolean' && ['local', 'remote'].includes(d.kind as string) && issuer(d.issuer);
    case 'prepare': return exact(d, ['action', 'hubId', 'pin', 'target', 'issuer']) && text(d.hubId, 128) && digest(d.pin) && issuer(d.issuer)
      && object(d.target) && exact(d.target, ['nodeId', 'version', 'origin', 'kind']) && text(d.target.nodeId, 128)
      && version(d.target.version) && text(d.target.origin, 4096) && ['local', 'remote'].includes(d.target.kind as string);
    case 'check': case 'disable': return exact(d, ['action']);
    case 'install': return exact(d, ['action', 'issuer']) && d.issuer !== null && issuer(d.issuer);
    case 'cleanup': return exact(d, ['action', 'neverInstalled']) && typeof d.neverInstalled === 'boolean';
    default: return false;
  }
}

/** Only original identity proof reaches this savepoint. No network, callbacks,
 * token issuance, HTTP principal or caller-supplied permission decisions. */
export function executeHubIssuerManagement(store: HubStore, actor: HubPrincipal,
  command: HubIssuerManagementCommand): HubIssuerManagementResult {
  if (!validHubIssuerManagementCommand(command)) throw new Error('hub_issuer_management_unavailable');
  const { connectionId } = command;
  const reply = (data: HubIssuerManagementData): HubIssuerManagementResult => ({ connectionId, data });
  // Cleanup is observation of historical installation, not a new permission.
  // Missing/replaced identity is refused by the outer identity savepoint.
  if (command.action === 'cleanup') {
    if (!actor.admin) return reply({ error: 403 });
    return reply({ action: 'cleanup', neverInstalled: !store.executionIssuers.configurationWasInstalled(actor.userId, connectionId, command.issuerId) });
  }
  const connection = store.getConnection(connectionId, actor.userId);
  if (!connection) return reply({ error: 404 });
  if (command.action === 'read') return reply({ action: 'read', hubId: store.identities.hubId,
    admin: actor.admin, kind: connection.kind, issuer: store.executionIssuers.current(actor.userId, connectionId) ?? null });
  if (command.action === 'disable') { store.executionIssuers.disable(actor.userId, connectionId); return reply({ action: 'disable' }); }
  if (command.local && (!actor.admin || connection.kind !== 'local')) return reply({ error: 403 });
  const target = store.executionIssuers.configurationTarget(actor.userId, connectionId);
  if (!target) return reply({ error: 409 });
  const pin = createHash('sha256').update(JSON.stringify(['issuer-management-v1', actor.userId, actor.admin,
    connectionId, store.identities.hubId, target.nodeId, target.version, target.origin, target.kind])).digest('hex');
  if (command.action === 'prepare') return reply({ action: 'prepare', hubId: store.identities.hubId, pin, target,
    issuer: store.executionIssuers.current(actor.userId, connectionId) ?? null });
  if (command.pin !== pin) return reply({ error: 409 });
  if (command.action === 'check') return reply({ action: 'check' });
  return reply({ action: 'install', issuer: store.executionIssuers.installConfiguration(actor.userId, connectionId,
    command.token, target, command.issuerId, command.creationAllowed) });
}
