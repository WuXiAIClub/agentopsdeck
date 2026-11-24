import type { DatabaseSync } from 'node:sqlite';
import type { HubConnection } from './hub-store.js';
import { validPreferenceRead, DeliverySnapshotReadRejected } from './delivery-reader-protocol.js';
import { CONNECTION_BYTE_LIMIT, CONNECTION_ROW_LIMIT, validConnectionRows } from './connection-read-protocol.js';
import { reportHubReadFailure } from './read-failure-diagnostics.js';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const columns = ['id', 'owner_user_id', 'kind', 'label', 'connector_url', 'status', 'node_id',
  'environment_id', 'environment_label', 'capabilities_json'];
// Bound the entire raw row before allocating TEXT buffers, not ten independent
// 8 MiB fields. A single statement owns one committed readonly snapshot.
const rawBytes = columns.map(column => `coalesce(length(CAST(c.${column} AS BLOB)),0)`).join('+');
const selected = columns.map(column => `CASE WHEN typeof(c.${column})='text'
  AND (${rawBytes})<=${CONNECTION_BYTE_LIMIT} THEN CAST(c.${column} AS BLOB) ELSE NULL END AS ${column}`).join(',');
const query = `SELECT ${selected}, c.created_at, c.updated_at,
  c.node_id IS NULL AS node_absent, c.environment_id IS NULL AS environment_absent,
  c.environment_label IS NULL AS environment_label_absent,
  EXISTS(SELECT 1 FROM env_credentials ec WHERE ec.connection_id=c.id AND ec.owner_user_id=c.owner_user_id) AS has_credential
  FROM env_connections c WHERE c.owner_user_id=? AND c.deleted_at IS NULL
  ORDER BY c.kind='local' DESC,c.label COLLATE NOCASE ASC LIMIT ?`;

/** Complete bounded connection display. No ciphertext, schema changes,
 * transaction ownership, repair or partial visibility on refusal. */
export function readConnections(db: DatabaseSync, owner: string): HubConnection[] {
  try {
    if (!validPreferenceRead({ owner })) throw new DeliverySnapshotReadRejected();
    const connections: HubConnection[] = []; let bytes = 2;
    for (const raw of db.prepare(query).iterate(owner, CONNECTION_ROW_LIMIT + 1)) {
      if (connections.length >= CONNECTION_ROW_LIMIT) throw new DeliverySnapshotReadRejected();
      const decode = (column: string) => {
        if (!(raw[column] instanceof Uint8Array)) throw new DeliverySnapshotReadRejected();
        try { return decoder.decode(raw[column] as Uint8Array); } catch { throw new DeliverySnapshotReadRejected(); }
      };
      const source = decode('capabilities_json'); let capabilities: string[] = [];
      // Match 2.3.7's malformed/non-array JSON fallback and string filtering.
      try { const value: unknown = JSON.parse(source); if (Array.isArray(value)) capabilities = value.filter((v): v is string => typeof v === 'string'); }
      catch { /* Original legacy fallback. */ }
      const row: HubConnection = { id: decode('id'), ownerUserId: decode('owner_user_id'),
        kind: decode('kind') as HubConnection['kind'], label: decode('label'), connectorUrl: decode('connector_url'),
        status: decode('status') as HubConnection['status'],
        nodeId: raw.node_absent ? undefined : decode('node_id'),
        environmentId: raw.environment_absent ? undefined : decode('environment_id'),
        environmentLabel: raw.environment_label_absent ? undefined : decode('environment_label'),
        capabilities, hasCredential: raw.has_credential === 1,
        createdAt: raw.created_at as number, updatedAt: raw.updated_at as number };
      if (!validConnectionRows([row], owner)) throw new DeliverySnapshotReadRejected();
      bytes += Buffer.byteLength(JSON.stringify(row)) + (connections.length ? 1 : 0);
      if (bytes > CONNECTION_BYTE_LIMIT) throw new DeliverySnapshotReadRejected();
      connections.push(row);
    }
    if (!validConnectionRows(connections, owner)) throw new DeliverySnapshotReadRejected();
    return connections;
  } catch (error) { reportHubReadFailure('hub-connections-read', error); throw error; }
}
