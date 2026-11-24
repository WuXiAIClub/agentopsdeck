import type { DatabaseSync } from 'node:sqlite';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { reportHubReadFailure } from './read-failure-diagnostics.js';
import { PREFERENCE_ROW_LIMIT, PREFERENCE_BYTE_LIMIT, validPreferenceRows, DeliverySnapshotReadRejected, type PreferenceRows } from './delivery-reader-protocol.js';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Single readonly statement; oversized/corrupt snapshots fail, never truncate
 * visibility preferences and accidentally disclose a hidden session. */
export function readSessionPreferences(db: DatabaseSync, owner: string,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics): PreferenceRows {
  try { return readPreferenceSnapshot(db, owner); }
  catch (error) { reportHubReadFailure('hub-preference-read', error, diagnostics); throw error; }
}

function readPreferenceSnapshot(db: DatabaseSync, owner: string): PreferenceRows {
  // SQLite's TEXT conversion can truncate NUL or repair invalid UTF-8. Read
  // bounded original bytes, never a prefix/replacement that aliases another ID.
  const rows = db.prepare(`SELECT CASE WHEN typeof(session_id)='text'
    AND length(CAST(session_id AS BLOB))<=16384 THEN CAST(session_id AS BLOB) ELSE NULL END AS session_id,
    hidden, archived, pinned
    FROM session_preferences WHERE user_id = ? LIMIT ?`).iterate(owner, PREFERENCE_ROW_LIMIT + 1);
  const result: PreferenceRows = []; let bytes = 2;
  // Iterate rather than .all(): reserve the complete result wire budget before
  // retaining each row. Iterator cleanup releases the statement on failure.
  for (const raw of rows) {
    const row = raw as { session_id: unknown; hidden: unknown; archived: unknown; pinned: unknown };
    if (!(row.session_id instanceof Uint8Array)
      || [row.hidden, row.archived, row.pinned].some(flag => flag !== null && flag !== 0 && flag !== 1))
      throw new DeliverySnapshotReadRejected();
    let id: string;
    try { id = decoder.decode(row.session_id); } catch { throw new DeliverySnapshotReadRejected(); }
    const entry: PreferenceRows[number] = [id, Object.fromEntries(
      (['hidden', 'archived', 'pinned'] as const).flatMap(field => row[field] === null ? [] : [[field, Boolean(row[field])]]))];
    bytes += Buffer.byteLength(JSON.stringify(entry)) + (result.length ? 1 : 0);
    if (result.length >= PREFERENCE_ROW_LIMIT || bytes > PREFERENCE_BYTE_LIMIT) throw new DeliverySnapshotReadRejected();
    result.push(entry);
  }
  if (!validPreferenceRows(result)) throw new DeliverySnapshotReadRejected();
  return result;
}
