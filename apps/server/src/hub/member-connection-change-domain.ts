import { normalizeConnectorUrl, type HubConnection, type HubStore } from './hub-store.js';
import { validHubConnectionSnapshot } from './member-connection-domain.js';
import { types } from 'node:util';
import { isNodeId } from '../connector/node-identity.js';

export const HUB_CONNECTION_CHANGE_BYTES = 262_144;
export type HubConnectionCreate = { id?: string; label?: string; connectorUrl: string; token?: string;
  environmentId?: string; environmentLabel?: string; capabilities?: string[]; enabled?: boolean };
export type HubConnectionPatch = { label?: string; environmentId?: string; environmentLabel?: string; enabled?: boolean };
export type HubConnectionChange = { action: 'create'; configuration: HubConnectionCreate }
  | { action: 'patch'; id: string; expectedEpoch: number; configuration: HubConnectionPatch }
  | { action: 'maintenance'; id: string; expectedEpoch: number; token: string }
  | { action: 'pin'; id: string; expectedEpoch: number; nodeId: string }
  | { action: 'delete'; id: string; expectedEpoch: number };
export type HubConnectionTarget = { connection: HubConnection; epoch: number } | { error: 'missing' } | null;
export type HubConnectionChangeResult = HubConnectionTarget | { error: 'changed' } | { ok: boolean; epoch?: number };
export type HubConnectionReplyExpectation = { action: 'create'; id?: string }
  | { action: 'target' | 'patch' | 'maintenance' | 'delete' | 'pin'; id: string };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && Buffer.byteLength(v) <= 16_384;
export const validConnectionEpoch = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 1;
const id = (v: unknown): v is string => text(v) && !!v && Buffer.byteLength(v) <= 4096 && !/[\x00-\x1f\x7f]/.test(v);

/** Capture optional configuration without executing user code. Explicit
 * undefined fields behave like absent JSON fields; array holes never do. */
export function copyHubConnectionConfiguration(value: unknown): HubConnectionCreate | HubConnectionPatch {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('invalid_connection_configuration');
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (keys.length > 8 || keys.some(k => typeof k !== 'string')) throw new Error('invalid_connection_configuration');
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const d = descriptors[key]!;
    if (!d.enumerable || !Object.hasOwn(d, 'value')) throw new Error('invalid_connection_configuration');
    if (d.value === undefined) continue;
    if (key !== 'capabilities') { result[key] = d.value; continue; }
    const array = d.value;
    if (!array || typeof array !== 'object' || types.isProxy(array) || !Array.isArray(array) || Object.getPrototypeOf(array) !== Array.prototype)
      throw new Error('invalid_connection_configuration');
    const entries: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(array), length = entries['length']!.value;
    if (!Number.isSafeInteger(length) || length > 128 || Reflect.ownKeys(entries).length !== length + 1) throw new Error('invalid_connection_configuration');
    const copied: string[] = [];
    for (let n = 0; n < length; n++) {
      const item = entries[String(n)];
      if (!item || !Object.hasOwn(item, 'value') || !text(item.value)) throw new Error('invalid_connection_configuration');
      copied.push(item.value);
    }
    result[key] = copied;
  }
  return result as HubConnectionCreate | HubConnectionPatch;
}

/** Parsed transport data only. Caller/owner descriptor-safe cloning precedes
 * this validator. No account, role, SQL, callback or authorization bit. */
export function validHubConnectionChange(value: unknown): value is HubConnectionChange {
  try {
    if (!object(value)) return false;
    const keys = Object.keys(value);
    if (value.action === 'create' || value.action === 'patch') {
      const create = value.action === 'create', fields = create ? ['action', 'configuration'] : ['action', 'id', 'expectedEpoch', 'configuration'];
      if (keys.length !== fields.length || keys.some(k => !fields.includes(k)) || !object(value.configuration)
        || !create && (!id(value.id) || !validConnectionEpoch(value.expectedEpoch))) return false;
      const c = value.configuration;
      const allowed = create ? ['id', 'label', 'connectorUrl', 'token', 'environmentId', 'environmentLabel', 'capabilities', 'enabled']
        : ['label', 'environmentId', 'environmentLabel', 'enabled'];
      if (Object.keys(c).some(k => !allowed.includes(k)) || ['label', 'environmentId', 'environmentLabel', 'token'].some(k => c[k] !== undefined && !text(c[k]))
        || c.enabled !== undefined && typeof c.enabled !== 'boolean') return false;
      if (create && (!text(c.connectorUrl) || !normalizeConnectorUrl(c.connectorUrl)
        || normalizeConnectorUrl(c.connectorUrl) === 'local://aod-connector' || c.id !== undefined && (typeof c.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(c.id))
        || c.capabilities !== undefined && (!Array.isArray(c.capabilities) || c.capabilities.length > 128 || c.capabilities.some(v => !text(v))))) return false;
    } else if (value.action === 'maintenance' || value.action === 'delete' || value.action === 'pin') {
      const fields = value.action === 'delete' ? ['action', 'id', 'expectedEpoch'] : ['action', 'id', 'expectedEpoch', value.action === 'pin' ? 'nodeId' : 'token'];
      if (keys.length !== fields.length || keys.some(k => !fields.includes(k)) || !id(value.id) || !validConnectionEpoch(value.expectedEpoch)
        || value.action === 'pin' && !isNodeId(value.nodeId)
        || value.action === 'maintenance' && (!text(value.token) || !value.token.trim())) return false;
    } else return false;
    return Buffer.byteLength(JSON.stringify(value)) <= HUB_CONNECTION_CHANGE_BYTES;
  } catch { return false; }
}
export function validHubConnectionTarget(value: unknown): value is HubConnectionTarget {
  try {
    if (value === null) return true;
    if (!object(value)) return false;
    if (Object.keys(value).length === 1 && value.error === 'missing') return true;
    if (Object.keys(value).sort().join() !== 'connection,epoch' || !validConnectionEpoch(value.epoch) || !object(value.connection)) return false;
    return validHubConnectionSnapshot({ principal: { userId: value.connection.ownerUserId, admin: false }, connections: [value.connection], users: [] })
      && Buffer.byteLength(JSON.stringify(value)) <= HUB_CONNECTION_CHANGE_BYTES;
  } catch { return false; }
}
export function validHubConnectionChangeResult(value: unknown): value is HubConnectionChangeResult {
  if (validHubConnectionTarget(value)) return true;
  if (!object(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && value.error === 'changed' || keys.every(k => k === 'ok' || k === 'epoch')
    && typeof value.ok === 'boolean' && (value.epoch === undefined ? keys.length === 1 : keys.length === 2 && value.ok === true && validConnectionEpoch(value.epoch));
}
/** Correlate a parsed result with the original fixed command. A well-formed
 * result for another action or target is still an unconfirmed original effect.
 * This contains no credentials, configuration or caller authorization. */
export function hubConnectionReplyExpectation(change: HubConnectionChange): HubConnectionReplyExpectation {
  return change.action === 'create'
    ? { action: change.action, ...(change.configuration.id === undefined ? {} : { id: change.configuration.id }) }
    : { action: change.action, id: change.id };
}
export function validHubConnectionReply(expected: HubConnectionReplyExpectation, value: unknown): boolean {
  if (!validHubConnectionChangeResult(value)) return false;
  if (value === null) return true;
  if ('error' in value) return value.error === 'missing'
    || value.error === 'changed' && expected.action !== 'target' && expected.action !== 'create';
  if (expected.action === 'target' || expected.action === 'create' || expected.action === 'patch' || expected.action === 'pin')
    return 'connection' in value && (expected.id === undefined || value.connection.id === expected.id);
  return 'ok' in value && (expected.action === 'delete' ? Object.keys(value).length === 1
    : value.ok === true && 'epoch' in value && validConnectionEpoch(value.epoch));
}
/** Only inside the complete original identity savepoint. Returned epochs are
 * durable versions, not clocks. This result is neither a COMMIT receipt nor
 * permission to replay a mutation after an ACK fault. */
export function readHubConnectionTarget(owner: HubStore, userId: string, connectionId: string): Exclude<HubConnectionTarget, null> {
  const connection = owner.getConnection(connectionId, userId);
  if (!connection) return { error: 'missing' };
  const epoch = owner.connectionAuthority(connectionId, userId);
  if (!validConnectionEpoch(epoch)) throw new Error('hub_connection_epoch_unavailable');
  const result = { connection, epoch };
  if (!validHubConnectionTarget(result)) throw new Error('hub_connection_target_unavailable');
  return result;
}
export function executeHubConnectionChange(owner: HubStore, userId: string, change: HubConnectionChange): Exclude<HubConnectionChangeResult, null> {
  if (!validHubConnectionChange(change)) throw new Error('hub_connection_configuration_unavailable');
  let connection: HubConnection | undefined;
  if (change.action === 'create') {
    const c = change.configuration;
    connection = owner.upsertConnection({ id: c.id, ownerUserId: userId, kind: 'remote', label: c.label ?? 'Remote Connector',
      connectorUrl: normalizeConnectorUrl(c.connectorUrl)!, status: c.enabled === false ? 'disabled' : 'enabled',
      environmentId: c.environmentId, environmentLabel: c.environmentLabel,
      capabilities: c.capabilities ?? ['sessions', 'messages', 'events', 'media'], credentialToken: c.token });
  } else {
    const pin = readHubConnectionTarget(owner, userId, change.id);
    if ('error' in pin) return pin;
    if (pin.epoch !== change.expectedEpoch) return { error: 'changed' };
    const existing = pin.connection;
    if (change.action === 'pin') {
      if (existing.status === 'disabled' || existing.nodeId && existing.nodeId !== change.nodeId) return { error: 'changed' };
      owner.pinConnectionNode(existing.id, userId, change.expectedEpoch, change.nodeId);
      return readHubConnectionTarget(owner, userId, existing.id);
    }
    if (change.action === 'delete') return { ok: owner.deleteConnection(existing.id, userId) };
    if (change.action === 'maintenance') {
      owner.updateMaintenanceCredential(existing.id, change.token.trim(), userId);
      const epoch = owner.connectionAuthority(existing.id, userId);
      if (!validConnectionEpoch(epoch)) throw new Error('hub_connection_epoch_unavailable');
      return { ok: true, epoch };
    }
    const c = change.configuration, label = c.label?.trim() ?? existing.label;
    const environmentLabel = c.environmentLabel?.trim() ?? existing.environmentLabel;
    const environmentId = c.environmentId?.trim() ?? existing.environmentId;
    if ((environmentId || existing.environmentId) === existing.environmentId
      && (c.enabled === undefined || (c.enabled ? 'enabled' : 'disabled') === existing.status)) {
      connection = owner.renameConnection(existing.id, { label: label || existing.label, environmentLabel }, userId);
    } else connection = owner.upsertConnection({ id: existing.id, ownerUserId: userId, kind: existing.kind,
      label: label || existing.label, connectorUrl: existing.connectorUrl, status: c.enabled === undefined ? existing.status : c.enabled ? 'enabled' : 'disabled',
      environmentId, environmentLabel: environmentLabel || undefined, capabilities: existing.capabilities }, { preserveCredential: true });
  }
  return connection ? readHubConnectionTarget(owner, userId, connection.id) : { error: 'missing' };
}
