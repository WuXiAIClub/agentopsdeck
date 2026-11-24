import type { DatabaseSync } from 'node:sqlite';
import type { HubPrincipal } from './identity.js';
import { CONNECTION_DISPLAY_VERSION_SQL } from './connection-display-version.js';
import { HUB_CONNECTION_RPC_BYTES, readHubConnectionSnapshot, validHubConnectionSnapshot,
  type HubConnectionSnapshot } from './member-connection-domain.js';

// Fixed original-owner domain. A display generation is NOT a credential epoch:
// both are checked, in the same identity savepoint, at each remote boundary.
export type HubConnectionDirectoryCommand = { action: 'read' }
  | { action: 'version' }
  | { action: 'check'; version: number; target?: { id: string; epoch: number } };
export type HubConnectionDirectoryResult = null
  | { action: 'version'; version: number }
  | { action: 'read'; snapshot: NonNullable<HubConnectionSnapshot>; version: number; epochs: number[] }
  | { action: 'check'; version: number; target?: { id: string; epoch: number }; ok: boolean };
export const HUB_CONNECTION_DIRECTORY_RPC_BYTES = HUB_CONNECTION_RPC_BYTES + 2 * 1024 * 1024;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length
  && keys.every(key => Object.hasOwn(v, key));
const version = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const epoch = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const target = (v: unknown) => object(v) && fields(v, ['id', 'epoch']) && typeof v.id === 'string'
  && !!v.id && Buffer.byteLength(v.id) <= 16_384 && !v.id.includes('\0') && epoch(v.epoch);
export function validHubConnectionDirectoryCommand(v: unknown): v is HubConnectionDirectoryCommand {
  return object(v) && (v.action === 'read' || v.action === 'version' ? fields(v, ['action']) : v.action === 'check'
    && fields(v, v.target === undefined ? ['action', 'version'] : ['action', 'version', 'target'])
    && version(v.version) && (v.target === undefined || target(v.target)));
}
export function validHubConnectionDirectoryResult(v: unknown): v is HubConnectionDirectoryResult {
  try {
    if (v === null) return true;
    if (!object(v) || !version(v.version)) return false;
    if (v.action === 'version') return fields(v, ['action', 'version']);
    if (v.action === 'check') return fields(v, v.target === undefined
      ? ['action', 'version', 'ok'] : ['action', 'version', 'target', 'ok'])
      && typeof v.ok === 'boolean' && (v.target === undefined || target(v.target));
    return v.action === 'read' && fields(v, ['action', 'snapshot', 'version', 'epochs'])
      && v.snapshot !== null && validHubConnectionSnapshot(v.snapshot) && Array.isArray(v.epochs)
      && v.epochs.length === v.snapshot.connections.length && v.epochs.every(epoch)
      && Buffer.byteLength(JSON.stringify(v)) <= HUB_CONNECTION_DIRECTORY_RPC_BYTES;
  } catch { return false; }
}

/** Only inside the original identity savepoint, never a peer writer or cache.
 * Indexed generations/epochs are bounded metadata; no credential is decoded.
 * Unknown/changed facts refuse the whole response without retry or repair. */
export function readHubConnectionDirectory(db: DatabaseSync, principal: HubPrincipal,
  command: HubConnectionDirectoryCommand): NonNullable<HubConnectionDirectoryResult> {
  if (!validHubConnectionDirectoryCommand(command)) throw new Error('hub_connection_directory_unavailable');
  const row = db.prepare(CONNECTION_DISPLAY_VERSION_SQL).get(principal.userId);
  const authority = db.prepare('SELECT version FROM hub_connection_authority_versions WHERE user_id = ?').get(principal.userId);
  const displayVersion = row?.version ?? 0, authorityVersion = authority?.version ?? 0;
  const current = Number(displayVersion) + Number(authorityVersion);
  if (!version(displayVersion) || row && displayVersion === 0
    || !version(authorityVersion) || authority && authorityVersion === 0 || !version(current))
    throw new Error('hub_connection_directory_unavailable');
  if (command.action === 'version') return { action: 'version', version: current };
  const statement = db.prepare(`SELECT authority_version AS epoch FROM env_connections
    WHERE id=? AND owner_user_id=? AND deleted_at IS NULL`);
  const getEpoch = (id: string) => statement.get(id, principal.userId)?.epoch;
  if (command.action === 'check') {
    const ok = current === command.version
      && (command.target === undefined || getEpoch(command.target.id) === command.target.epoch);
    return { ...command, ...(command.target ? { target: { ...command.target } } : {}), ok };
  }
  const snapshot = readHubConnectionSnapshot(db, principal);
  const epochs = snapshot.connections.map(connection => {
    const value = getEpoch(connection.id);
    if (!epoch(value)) throw new Error('hub_connection_directory_unavailable');
    return value;
  });
  const value = { action: 'read' as const, snapshot, version: current, epochs };
  if (!validHubConnectionDirectoryResult(value)) throw new Error('hub_connection_directory_unavailable');
  return value;
}
