import type { DatabaseSync } from 'node:sqlite';
import { DeliverySnapshotReadRejected } from './delivery-reader-protocol.js';
import { validLayoutWrite, type LayoutDocument, type LayoutKind } from './workspace-layouts.js';
import { reportHubReadFailure } from './read-failure-diagnostics.js';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export function validWorkspaceLayout(value: unknown, kind: LayoutKind): value is LayoutDocument {
  if (kind !== 'current' && kind !== 'saved') return false;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as LayoutDocument;
  return Object.keys(v).length === 2 && Object.hasOwn(v, 'revision') && Object.hasOwn(v, 'content')
    && (v.revision === 0 && v.content === null || v.revision > 0 && validLayoutWrite(v, kind));
}

/** Display only. Bound original bytes before allocation; preserve the content
 * exactly, never normalize, repair, truncate or turn a bad row into absence. */
export function readWorkspaceLayout(db: DatabaseSync, owner: string, kind: LayoutKind): LayoutDocument {
  try {
    if (kind !== 'current' && kind !== 'saved') throw new DeliverySnapshotReadRejected();
    const row = db.prepare(`SELECT revision, CASE WHEN typeof(content)='text'
      AND length(CAST(content AS BLOB))<=? THEN CAST(content AS BLOB) ELSE NULL END AS content
      FROM hub_workspace_layouts WHERE user_id=? AND kind=?`).get(
      kind === 'current' ? 65_536 : 1_048_576, owner, kind) as { revision: unknown; content: unknown } | undefined;
    if (!row) return { revision: 0, content: null };
    if (!(row.content instanceof Uint8Array)) throw new DeliverySnapshotReadRejected();
    let content: string;
    try { content = decoder.decode(row.content); } catch { throw new DeliverySnapshotReadRejected(); }
    const value = { revision: row.revision, content };
    if (!validWorkspaceLayout(value, kind)) throw new DeliverySnapshotReadRejected();
    return value;
  } catch (error) { reportHubReadFailure('hub-workspace-layout-read', error); throw error; }
}
