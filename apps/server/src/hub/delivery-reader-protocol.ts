import type { HubDeliveryEvent } from './hub-store.js';

export type DeliveryReaderConfig = { file: string; dev: number; ino: number };
export type DeliveryRead = { owner: string; cursor?: string | undefined; domains: [string, string][] };
export type DeliveryPage = { reset: boolean; cursor: string | undefined; events: HubDeliveryEvent[] };
export const deliveryReadUnavailable = () => Error('hub_delivery_read_unavailable');
const completedSnapshotRefusals = new WeakSet<object>();
/** A completed display-only read refused its complete snapshot. Not SQL,
 * identity, transport or owner failure; never a partial visibility result. */
export class DeliverySnapshotReadRejected extends Error {
  constructor() { super('hub_delivery_read_unavailable'); completedSnapshotRefusals.add(this); }
}
/** Do not inspect exception properties/prototypes: SQLite or diagnostic tests
 * can throw arbitrary objects. Only our completed-refusal instances qualify. */
export function isDeliverySnapshotReadRejected(error: unknown): boolean {
  return typeof error === 'object' && error !== null && completedSnapshotRefusals.has(error);
}
export type PreferenceRead = { owner: string };
export type WorkspaceRevisionRead = { owner: string };
export const WORKSPACE_REVISION_TYPES = ['taskboard', 'taskboard-binding', 'drawing', 'native-drawio',
  'metric-card', 'card-file-binding', 'card-configuration', 'report'] as const;
export type WorkspaceRevisionType = typeof WORKSPACE_REVISION_TYPES[number];
export type WorkspaceRevisions = Record<WorkspaceRevisionType, { resourceId: string; revision: number }[]>;
export const WORKSPACE_REVISION_ROW_LIMIT = 65_536;
export const WORKSPACE_REVISION_BYTE_LIMIT = 8 * 1024 * 1024;
export function validWorkspaceRevisionRead(value: unknown): value is WorkspaceRevisionRead {
  try { return validPreferenceRead(value); } catch { return false; }
}
/** Display invalidations only: not an authorization or a write/receipt proof. */
export function validWorkspaceRevisions(value: unknown): value is WorkspaceRevisions {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== WORKSPACE_REVISION_TYPES.length) return false;
    let count = 0;
    for (const type of WORKSPACE_REVISION_TYPES) {
      const rows = (value as WorkspaceRevisions)[type];
      if (!Object.hasOwn(value, type) || !Array.isArray(rows) || (count += rows.length) > WORKSPACE_REVISION_ROW_LIMIT) return false;
      const seen = new Set<string>();
      for (const row of rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== 2
          || !Object.hasOwn(row, 'resourceId') || !Object.hasOwn(row, 'revision')
          || !identifier(row.resourceId) || seen.has(row.resourceId)
          || !Number.isSafeInteger(row.revision) || row.revision < 0) return false;
        seen.add(row.resourceId);
      }
    }
    return Buffer.byteLength(JSON.stringify(value)) <= WORKSPACE_REVISION_BYTE_LIMIT;
  } catch { return false; }
}
export type PreferenceRows = [string, Partial<Record<'hidden' | 'archived' | 'pinned', boolean>>][];
/** Display-only scope. Never use these rows as a permission proof. */
export type UserRead = { owner: string; admin: boolean };
export type UserRows = { id: string; label: string; createdAt: number; updatedAt: number;
  usage?: { lastLoginAt: number | null; lastActiveAt: number | null } }[];
export const USER_ROW_LIMIT = 65_536;
export const USER_BYTE_LIMIT = 8 * 1024 * 1024;
export function validUserRead(value: unknown): value is UserRead {
  try {
    const r = value as UserRead | null;
    return !!r && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).length === 2
      && identifier(r.owner) && typeof r.admin === 'boolean';
  } catch { return false; }
}
export function validUserRows(value: unknown, read?: UserRead): value is UserRows {
  try {
    if (!Array.isArray(value) || value.length > USER_ROW_LIMIT || (read && !read.admin && value.length > 1)) return false;
    const seen = new Set<string>(), timestamp = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
    for (const row of value) {
      if (!row || typeof row !== 'object' || Array.isArray(row)
        || Object.keys(row).some(key => !['id', 'label', 'createdAt', 'updatedAt', 'usage'].includes(key))
        || !identifier(row.id) || seen.has(row.id) || typeof row.label !== 'string' || row.label.length > 4096
        || row.label.includes('\0') || !timestamp(row.createdAt) || !timestamp(row.updatedAt)) return false;
      seen.add(row.id);
      if (read && !read.admin && (row.id !== read.owner || Object.hasOwn(row, 'usage'))) return false;
      if (Object.hasOwn(row, 'usage')) {
        const usage = row.usage;
        if (!usage || typeof usage !== 'object' || Array.isArray(usage) || Object.keys(usage).length !== 2
          || !['lastLoginAt', 'lastActiveAt'].every(key => Object.hasOwn(usage, key)
            && (usage[key] === null || timestamp(usage[key])))) return false;
      } else if (read?.admin) return false;
    }
    return Buffer.byteLength(JSON.stringify(value)) <= USER_BYTE_LIMIT;
  } catch { return false; }
}
export const PREFERENCE_ROW_LIMIT = 65_536;
export const PREFERENCE_BYTE_LIMIT = 8 * 1024 * 1024;
export function validPreferenceRead(value: unknown): value is PreferenceRead {
  const r = value as PreferenceRead | null;
  return !!r && typeof r === 'object' && !Array.isArray(r)
    && Object.keys(r).length === 1 && identifier(r.owner);
}
export function validPreferenceRows(value: unknown): value is PreferenceRows {
  try {
    if (!Array.isArray(value) || value.length > PREFERENCE_ROW_LIMIT) return false;
    const seen = new Set<string>();
    for (const row of value) {
      if (!Array.isArray(row) || row.length !== 2 || !identifier(row[0]) || seen.has(row[0])) return false;
      seen.add(row[0]);
      const flags = row[1];
      if (!flags || typeof flags !== 'object' || Array.isArray(flags)
        || Object.entries(flags).some(([key, flag]) => !['hidden', 'archived', 'pinned'].includes(key) || typeof flag !== 'boolean')) return false;
    }
    return Buffer.byteLength(JSON.stringify(value)) <= PREFERENCE_BYTE_LIMIT;
  } catch { return false; }
}
const identifier = (value: unknown, allowEmpty = false): value is string => typeof value === 'string'
  && (allowEmpty || value.length > 0) && value.length <= 4096 && !/[\0\r\n]/.test(value);

// Bounded metadata, not arbitrary SQL or an authorization callback. Domain
// visibility remains owned by the original broker and is rechecked after IO.
export function validDeliveryRead(value: unknown): value is DeliveryRead {
  return deliveryReadMetadataBytes(value) !== undefined;
}

/** UTF-8 wire metadata, not character count or an estimate of total JS heap. */
export function deliveryReadMetadataBytes(value: unknown): number | undefined {
  try {
    const r = value as DeliveryRead | null;
    if (!(!!r && typeof r === 'object' && !Array.isArray(r)
      && Object.keys(r).every(key => ['owner', 'cursor', 'domains'].includes(key))
      && identifier(r.owner)
      && (r.cursor === undefined || identifier(r.cursor, true))
      && Array.isArray(r.domains) && r.domains.length <= 4096
      && r.domains.every(pair => Array.isArray(pair) && pair.length === 2
        && pair.every(item => identifier(item)))
      && new Set(r.domains.map(pair => pair[0])).size === r.domains.length)) return undefined;
    const bytes = Buffer.byteLength(JSON.stringify(r));
    return bytes <= 1024 * 1024 ? bytes : undefined;
  } catch { return undefined; }
}

export function validDeliveryPage(value: unknown): value is DeliveryPage {
  try {
  const r = value as DeliveryPage | null;
  return !!r && typeof r === 'object' && !Array.isArray(r)
    && Object.keys(r).length === 3 && typeof r.reset === 'boolean'
    && Object.hasOwn(r, 'cursor') && (r.cursor === undefined || identifier(r.cursor, true))
    && Array.isArray(r.events) && r.events.length <= 16 && (!r.reset || r.events.length === 0)
    && r.events.every(event => event && typeof event === 'object' && !Array.isArray(event)
      && identifier(event.id) && identifier(event.envConnectionId)
      && typeof event.type === 'string' && typeof event.ts === 'number' && Number.isFinite(event.ts)
      && Object.hasOwn(event, 'payload'))
    && Buffer.byteLength(JSON.stringify(r.events)) <= 524288 + 17;
  } catch { return false; }
}
