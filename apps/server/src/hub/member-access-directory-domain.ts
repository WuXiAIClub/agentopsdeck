import type { DatabaseSync } from 'node:sqlite';
import type { HubStore, HubUser } from './hub-store.js';
import type { HubPrincipal } from './identity.js';
import { validUserRows } from './delivery-reader-protocol.js';

/** Original management directory only. Display data is not a permission proof.
 * Scope correlates the ACK privately; HTTP never exposes the internal wrapper. */
export type HubAccessDirectory = {
  administrator: boolean;
  connections: ReturnType<HubStore['roles']['connections']>;
  users: HubUser[];
};
export type HubAccessDirectoryResult = { recoveryScope: string; directory: HubAccessDirectory } | null;
export const HUB_ACCESS_DIRECTORY_BYTES = 16 * 1024 * 1024;
export const HUB_ACCESS_DIRECTORY_ROWS = 4096;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length
  && keys.every(k => Object.hasOwn(v, k));
const id = (v: unknown): v is string => typeof v === 'string' && !!v && Buffer.byteLength(v) <= 16_384
  && !/[\x00-\x1f\x7f]/.test(v);
const text = (v: unknown) => typeof v === 'string' && Buffer.byteLength(v) <= 16_384 && !v.includes('\0');
const version = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
export function validHubAccessDirectoryResult(v: unknown): v is HubAccessDirectoryResult {
  try {
    if (v === null) return true;
    if (!object(v) || !fields(v, ['recoveryScope', 'directory']) || typeof v.recoveryScope !== 'string'
      || !/^[a-f0-9]{64}$/.test(v.recoveryScope) || !object(v.directory)
      || !fields(v.directory, ['administrator', 'connections', 'users'])) return false;
    const d = v.directory;
    if (typeof d.administrator !== 'boolean' || !Array.isArray(d.connections)
      || d.connections.length > HUB_ACCESS_DIRECTORY_ROWS || !validUserRows(d.users)
      || d.users.length > HUB_ACCESS_DIRECTORY_ROWS || d.users.some(u => Object.hasOwn(u, 'usage'))) return false;
    const seen = new Set<string>();
    for (const row of d.connections) {
      if (!object(row) || !fields(row, ['id', 'ownerUserId', 'label', 'nodeVersion', 'verified', 'creationReady', 'appointAdministrators', 'owner'])
        || !id(row.id) || !id(row.ownerUserId) || !text(row.label) || !version(row.nodeVersion)
        || ['verified', 'creationReady', 'appointAdministrators', 'owner'].some(k => typeof row[k] !== 'boolean')
        || row.appointAdministrators !== d.administrator || row.creationReady && !row.verified) return false;
      const key = JSON.stringify([row.ownerUserId, row.id]);
      if (seen.has(key)) return false;
      seen.add(key);
    }
    return Buffer.byteLength(JSON.stringify(v)) <= HUB_ACCESS_DIRECTORY_BYTES;
  } catch { return false; }
}
export function validHubAccessDirectoryReply(scope: string, value: unknown) {
  return validHubAccessDirectoryResult(value) && (value === null || value.recoveryScope === scope);
}

/** Bound original scans before calling the original policy, on its complete
 * connection/savepoint. SQL returns numbers only: oversized TEXT is not decoded.
 * Refusal is all-or-nothing, not truncated membership or partial visibility. */
function boundDirectory(db: DatabaseSync) {
  const scans = [
    { table: 'users', columns: ['id', 'label'], rows: HUB_ACCESS_DIRECTORY_ROWS },
    { table: 'env_connections', columns: ['id', 'owner_user_id', 'label', 'connector_url', 'capabilities_json', 'node_id', 'environment_id', 'environment_label'], rows: HUB_ACCESS_DIRECTORY_ROWS },
    { table: 'connector_memberships', columns: ['node_owner', 'connection_id', 'user_id', 'environments'], rows: 65_536 },
    { table: 'node_grants', columns: ['node_owner', 'connection_id', 'user_id'], rows: 65_536 },
    { table: 'hub_execution_issuers', columns: ['owner_id', 'connection_id', 'node_id', 'issuer_id'], rows: 65_536 },
  ] as const;
  let bytes = 0;
  for (const scan of scans) {
    const lengths = scan.columns.map(c => `coalesce(length(CAST(${c} AS BLOB)),0)`);
    // Tables and columns are fixed trusted constants, never RPC/HTTP strings.
    const statement = db.prepare(`SELECT ${lengths.map((e, i) => `${e} AS n${i}`).join(',')} FROM ${scan.table} LIMIT ${scan.rows + 1}`);
    let rows = 0;
    for (const raw of statement.iterate()) {
      if (++rows > scan.rows) throw new Error('hub_access_directory_unavailable');
      for (const [i, column] of scan.columns.entries()) {
        const length = raw['n' + i] as number;
        const maximum = column === 'capabilities_json' ? 65_536 : 16_384;
        if (!Number.isSafeInteger(length) || length < 0 || length > maximum) throw new Error('hub_access_directory_unavailable');
        bytes += length;
        if (bytes > HUB_ACCESS_DIRECTORY_BYTES) throw new Error('hub_access_directory_unavailable');
      }
    }
  }
}
export function readHubAccessDirectory(db: DatabaseSync, store: HubStore, principal: HubPrincipal, recoveryScope: string): Exclude<HubAccessDirectoryResult, null> {
  boundDirectory(db);
  const value = { recoveryScope, directory: { administrator: principal.admin,
    connections: store.roles.connections(principal), users: store.roles.members(principal) } };
  if (!validHubAccessDirectoryResult(value)) throw new Error('hub_access_directory_unavailable');
  return value;
}
