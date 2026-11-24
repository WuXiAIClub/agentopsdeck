import type { DatabaseSync } from 'node:sqlite';
import type { HubConnection } from './hub-store.js';
import type { HubPrincipal } from './identity.js';
import { readUsers } from './user-read.js';
import { validUserRows, USER_BYTE_LIMIT, DeliverySnapshotReadRejected,
  type UserRows } from './delivery-reader-protocol.js';
import { reportHubReadFailure } from './read-failure-diagnostics.js';

export const HUB_CONNECTION_ROW_LIMIT = 65_536;
export const HUB_CONNECTION_BYTE_LIMIT = 8 * 1024 * 1024;
export const HUB_CONNECTION_RPC_BYTES = HUB_CONNECTION_BYTE_LIMIT + USER_BYTE_LIMIT + 16_384;
export type HubConnectionSnapshot = { principal: HubPrincipal; connections: HubConnection[]; users: UserRows } | null;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && Buffer.byteLength(v) <= 16_384 && !v.includes('\0');
const time = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;

/** Parsed transport data only. Descriptor/proxy refusal precedes serialization
 * in the owner client. Neither display labels nor this snapshot grant authority. */
export function validHubConnectionSnapshot(value: unknown): value is HubConnectionSnapshot {
  try {
    if (value === null) return true;
    if (!object(value) || Object.keys(value).length !== 3 || !object(value.principal)
      || Object.keys(value.principal).length !== 2 || !text(value.principal.userId) || !value.principal.userId
      || typeof value.principal.admin !== 'boolean' || !Array.isArray(value.connections)
      || value.connections.length > HUB_CONNECTION_ROW_LIMIT
      || !validUserRows(value.users, { owner: value.principal.userId, admin: value.principal.admin })) return false;
    const seen = new Set<string>();
    for (const row of value.connections) {
      if (!object(row) || Object.keys(row).some(k => !['nodeId', 'id', 'ownerUserId', 'kind', 'label',
        'connectorUrl', 'status', 'environmentId', 'environmentLabel', 'capabilities', 'hasCredential', 'createdAt', 'updatedAt'].includes(k))
        || !text(row.id) || !row.id || seen.has(row.id) || row.ownerUserId !== value.principal.userId
        || (row.kind !== 'local' && row.kind !== 'remote')
        || (row.status !== 'enabled' && row.status !== 'disabled' && row.status !== 'degraded')
        || !text(row.label) || !text(row.connectorUrl) || typeof row.hasCredential !== 'boolean'
        || !time(row.createdAt) || !time(row.updatedAt)
        || ['nodeId', 'environmentId', 'environmentLabel'].some(k => row[k] !== undefined && !text(row[k]))
        || !Array.isArray(row.capabilities) || row.capabilities.some(c => !text(c))) return false;
      seen.add(row.id);
    }
    return Buffer.byteLength(JSON.stringify(value.connections)) <= HUB_CONNECTION_BYTE_LIMIT
      && Buffer.byteLength(JSON.stringify(value)) <= HUB_CONNECTION_RPC_BYTES;
  } catch { return false; }
}

/** Runs inside the original identity savepoint, on the same complete owner.
 * SQL bounds each TEXT/blob before decoding and uses LIMIT+1/iterate rather
 * than unbounded all(). Never reads credential ciphertext or another account's
 * connections. Snapshot refusal is all-or-nothing, not partial visibility. */
export function readHubConnectionSnapshot(db: DatabaseSync, principal: HubPrincipal): Exclude<HubConnectionSnapshot, null> {
  try {
    const columns = ['id', 'owner_user_id', 'kind', 'label', 'connector_url', 'status', 'node_id',
      'environment_id', 'environment_label', 'capabilities_json'];
    const selected = columns.map(column => `CASE WHEN typeof(c.${column})='text'
      AND length(CAST(c.${column} AS BLOB))<=${column === 'capabilities_json' ? 65_536 : 16_384}
      THEN CAST(c.${column} AS BLOB) ELSE NULL END AS ${column}`).join(',');
    const rows = db.prepare(`SELECT ${selected}, c.created_at, c.updated_at,
      c.node_id IS NULL AS node_absent, c.environment_id IS NULL AS environment_absent,
      c.environment_label IS NULL AS environment_label_absent,
      EXISTS(SELECT 1 FROM env_credentials ec WHERE ec.connection_id=c.id AND ec.owner_user_id=c.owner_user_id) AS has_credential
      FROM env_connections c WHERE c.owner_user_id=? AND c.deleted_at IS NULL
      ORDER BY c.kind='local' DESC, c.label COLLATE NOCASE ASC LIMIT ?`).iterate(principal.userId, HUB_CONNECTION_ROW_LIMIT + 1);
    const connections: HubConnection[] = []; let bytes = 2;
    for (const raw of rows) {
      if (connections.length >= HUB_CONNECTION_ROW_LIMIT) throw new DeliverySnapshotReadRejected();
      const decode = (column: string) => {
        if (!(raw[column] instanceof Uint8Array)) throw new DeliverySnapshotReadRejected();
        return decoder.decode(raw[column] as Uint8Array);
      };
      let capabilities: string[] = [];
      const source = decode('capabilities_json');
      // Retain the original legacy JSON fallback and string-only filtering.
      try { const parsed: unknown = JSON.parse(source); if (Array.isArray(parsed)) capabilities = parsed.filter((v): v is string => typeof v === 'string'); } catch { /* Original fallback. */ }
      const row: HubConnection = { id: decode('id'), ownerUserId: decode('owner_user_id'),
        kind: decode('kind') as HubConnection['kind'], label: decode('label'), connectorUrl: decode('connector_url'),
        status: decode('status') as HubConnection['status'],
        ...(raw.node_absent ? {} : { nodeId: decode('node_id') }),
        ...(raw.environment_absent ? {} : { environmentId: decode('environment_id') }),
        ...(raw.environment_label_absent ? {} : { environmentLabel: decode('environment_label') }),
        capabilities, hasCredential: raw.has_credential === 1, createdAt: raw.created_at as number, updatedAt: raw.updated_at as number };
      bytes += Buffer.byteLength(JSON.stringify(row)) + (connections.length ? 1 : 0);
      if (bytes > HUB_CONNECTION_BYTE_LIMIT) throw new DeliverySnapshotReadRejected();
      connections.push(row);
    }
    const result = { principal: { ...principal }, connections, users: readUsers(db, { owner: principal.userId, admin: principal.admin }) };
    if (!validHubConnectionSnapshot(result)) throw new DeliverySnapshotReadRejected();
    return result;
  } catch (error) { reportHubReadFailure('hub-connections-read', error); throw error; }
}
