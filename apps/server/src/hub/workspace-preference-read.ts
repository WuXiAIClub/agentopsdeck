import type { DatabaseSync } from 'node:sqlite';
import type { WorkspacePreferences } from '@agentopsdeck/shared';
import { DeliverySnapshotReadRejected } from './delivery-reader-protocol.js';
import { workspacePreferencesSchema } from './workspace-preferences.js';
import { reportHubReadFailure } from './read-failure-diagnostics.js';

export const WORKSPACE_PREFERENCE_BYTES = 8 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Read-only display snapshot. The original writer still owns authorization
 * and CAS; neither this document nor its revision is a grant or commit proof. */
export function validWorkspacePreferences(value: unknown): value is WorkspacePreferences {
  try {
    return workspacePreferencesSchema.safeParse(value).success
      && Buffer.byteLength(JSON.stringify(value)) <= WORKSPACE_PREFERENCE_BYTES;
  } catch { return false; }
}

export function readWorkspacePreferences(db: DatabaseSync, owner: string): WorkspacePreferences {
  try {
    // Bound original bytes before allocating or parsing. Invalid UTF-8, BLOB,
    // NUL and oversized documents refuse the whole snapshot, never a prefix.
    const row = db.prepare(`SELECT revision, CASE WHEN typeof(document)='text'
      AND length(CAST(document AS BLOB))<=? THEN CAST(document AS BLOB) ELSE NULL END AS document
      FROM hub_workspace_preferences WHERE user_id=?`).get(WORKSPACE_PREFERENCE_BYTES, owner) as
      { revision: unknown; document: unknown } | undefined;
    if (!row) return { revision: 0, groups: [], sessions: {} };
    if (!(row.document instanceof Uint8Array) || !Number.isSafeInteger(row.revision)
      || (row.revision as number) < 1 || (row.revision as number) >= Number.MAX_SAFE_INTEGER)
      throw new DeliverySnapshotReadRejected();
    let document: unknown;
    try { document = JSON.parse(decoder.decode(row.document)); }
    catch { throw new DeliverySnapshotReadRejected(); }
    if (!document || typeof document !== 'object' || Array.isArray(document)
      || Object.keys(document).some(key => !['groups', 'sessions', 'ungroupedCollapsed'].includes(key)))
      throw new DeliverySnapshotReadRejected();
    const value = { ...document, revision: row.revision };
    if (!validWorkspacePreferences(value)) throw new DeliverySnapshotReadRejected();
    // Keep the original stored JSON, including legacy whitespace/case in
    // display fields. Schema parsing validates; it must not normalize reads.
    return value;
  } catch (error) { reportHubReadFailure('hub-workspace-preferences-read', error); throw error; }
}
