import type { DatabaseSync } from 'node:sqlite';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { reportHubReadFailure } from './read-failure-diagnostics.js';
import { USER_ROW_LIMIT, USER_BYTE_LIMIT, validUserRead, validUserRows, deliveryReadUnavailable, DeliverySnapshotReadRejected,
  type UserRead, type UserRows } from './delivery-reader-protocol.js';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** One bounded, readonly statement instead of a main-thread N+1 display query.
 * Original TEXT bytes are checked before decoding; never repair/alias IDs. */
export function readUsers(db: DatabaseSync, read: UserRead,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics): UserRows {
  try {
    if (!validUserRead(read)) throw deliveryReadUnavailable();
    // Non-admin SQL never selects another account or its usage metadata.
    const text = (column: string) => `CASE WHEN typeof(${column})='text'
      AND length(CAST(${column} AS BLOB))<=16384 THEN CAST(${column} AS BLOB) ELSE NULL END`;
    const statement = db.prepare(`SELECT ${text('users.id')} AS id, ${text('users.label')} AS label,
      users.created_at, users.updated_at ${read.admin ? ', usage.last_login_at, usage.last_active_at' : ''}
      FROM users ${read.admin ? 'LEFT JOIN hub_user_usage usage ON usage.user_id=users.id' : 'WHERE users.id=?'}
      ORDER BY users.id='default' DESC, users.label COLLATE NOCASE ASC LIMIT ?`);
    const rows = read.admin ? statement.iterate(USER_ROW_LIMIT + 1) : statement.iterate(read.owner, USER_ROW_LIMIT + 1);
    const result: UserRows = []; let bytes = 2;
    for (const raw of rows) {
      if (!(raw.id instanceof Uint8Array) || !(raw.label instanceof Uint8Array)) throw new DeliverySnapshotReadRejected();
      let id: string, label: string;
      try { id = decoder.decode(raw.id); label = decoder.decode(raw.label); }
      catch { throw new DeliverySnapshotReadRejected(); }
      const entry: UserRows[number] = { id, label,
        createdAt: raw.created_at as number, updatedAt: raw.updated_at as number,
        ...(read.admin ? { usage: { lastLoginAt: raw.last_login_at as number | null,
          lastActiveAt: raw.last_active_at as number | null } } : {}) };
      if (!validUserRows([entry], read)) throw new DeliverySnapshotReadRejected();
      bytes += Buffer.byteLength(JSON.stringify(entry)) + (result.length ? 1 : 0);
      if (result.length >= USER_ROW_LIMIT || bytes > USER_BYTE_LIMIT) throw new DeliverySnapshotReadRejected();
      result.push(entry);
    }
    if (!validUserRows(result, read)) throw new DeliverySnapshotReadRejected();
    return result;
  } catch (error) { reportHubReadFailure('hub-users-read', error, diagnostics); throw error; }
}
