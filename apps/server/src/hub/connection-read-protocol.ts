import type { HubConnection } from './hub-store.js';

export const CONNECTION_ROW_LIMIT = 65_536;
export const CONNECTION_BYTE_LIMIT = 8 * 1024 * 1024;
const fields = ['nodeId', 'id', 'ownerUserId', 'kind', 'label', 'connectorUrl', 'status',
  'environmentId', 'environmentLabel', 'capabilities', 'hasCredential', 'createdAt', 'updatedAt'];

/** Display-only, never a credential, permission or execution proof. Preserve
 * legacy long labels; the complete byte budget, not an arbitrary label cap,
 * bounds this transport. Worker replies must retain the admitted owner. */
export function validConnectionRows(value: unknown, owner?: string): value is HubConnection[] {
  try {
    if (!Array.isArray(value) || value.length > CONNECTION_ROW_LIMIT) return false;
    const seen = new Set<string>();
    const text = (v: unknown): v is string => typeof v === 'string' && !v.includes('\0');
    const timestamp = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
    for (const row of value) {
      if (!row || typeof row !== 'object' || Array.isArray(row)
        || Object.keys(row).some(key => !fields.includes(key))
        || !text(row.id) || !row.id || seen.has(row.id) || !text(row.ownerUserId) || !row.ownerUserId
        || (owner !== undefined && row.ownerUserId !== owner)
        || !['local', 'remote'].includes(row.kind) || !['enabled', 'disabled', 'degraded'].includes(row.status)
        || !text(row.label) || !text(row.connectorUrl) || typeof row.hasCredential !== 'boolean'
        || !timestamp(row.createdAt) || !timestamp(row.updatedAt)
        || ['nodeId', 'environmentId', 'environmentLabel'].some(key => row[key] !== undefined && !text(row[key]))
        || !Array.isArray(row.capabilities) || row.capabilities.some((v: unknown) => !text(v))) return false;
      seen.add(row.id);
    }
    return Buffer.byteLength(JSON.stringify(value)) <= CONNECTION_BYTE_LIMIT;
  } catch { return false; }
}
