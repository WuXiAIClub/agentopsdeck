import type { DatabaseSync } from 'node:sqlite';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { reportHubReadFailure } from './read-failure-diagnostics.js';
import { deliveryReadUnavailable, validDeliveryRead, validDeliveryPage, type DeliveryRead, type DeliveryPage } from './delivery-reader-protocol.js';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const identifierBytes = 16384; // At most 4096 UTF-16 units, checked again after strict decoding.
function text(value: unknown, identifier = false, allowEmpty = false): string {
  if (!(value instanceof Uint8Array)) throw deliveryReadUnavailable();
  const decoded = decoder.decode(value);
  if (identifier && (decoded.length > 4096 || (!allowEmpty && !decoded.length) || /[\0\r\n]/.test(decoded))) throw deliveryReadUnavailable();
  return decoded;
}
function identifierMetadata(encoding: unknown, bytes: unknown, allowEmpty = false) {
  return encoding === 'text' && typeof bytes === 'number' && Number.isSafeInteger(bytes)
    && bytes >= (allowEmpty ? 0 : 1) && bytes <= identifierBytes;
}

/** Read one bounded prefix in the caller's original snapshot. Metadata comes
 * first: legacy/unpageable bodies never enter the payload query or JS heap.
 * A blocked first row is a read failure, not idle, a reset or permission to
 * skip/delete facts. A valid prefix may advance once before that refusal. */
export function readDeliveryPage(db: DatabaseSync, read: DeliveryRead,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics): DeliveryPage {
  if (!validDeliveryRead(read)) throw deliveryReadUnavailable();
  const ownSnapshot = !db.isTransaction;
  try {
    if (ownSnapshot) db.exec('BEGIN');
    const { owner, cursor, domains } = read;
    const start = cursor ? db.prepare('SELECT rowid AS seq FROM hub_events WHERE id=? AND owner_user_id=?').get(cursor, owner) : undefined;
    let value: DeliveryPage;
    if (cursor && !start) {
      const latest = db.prepare(`SELECT rowid AS seq, typeof(id) AS encoding, length(CAST(id AS BLOB)) AS bytes
        FROM hub_events WHERE owner_user_id=? ORDER BY rowid DESC LIMIT 1`).get(owner);
      let latestCursor: string | undefined;
      if (latest) {
        if (!identifierMetadata(latest.encoding, latest.bytes)) throw deliveryReadUnavailable();
        latestCursor = text(db.prepare('SELECT CAST(id AS BLOB) AS id FROM hub_events WHERE owner_user_id=? AND rowid=?').get(owner, latest.seq!)?.id, true);
      }
      value = { reset: true, cursor: latestCursor, events: [] };
    } else {
      const after = start?.seq ?? 0;
      const metadata = db.prepare(`SELECT rowid AS seq,
        typeof(id) AS id_encoding, length(CAST(id AS BLOB)) AS id_bytes,
        typeof(connection_id) AS connection_encoding, length(CAST(connection_id AS BLOB)) AS connection_bytes,
        typeof(stream_domain) AS domain_encoding, length(CAST(stream_domain AS BLOB)) AS domain_bytes,
        typeof(payload_json) AS encoding,
        length(CAST(payload_json AS BLOB)) AS bytes FROM hub_events
        WHERE owner_user_id=? AND rowid>? ORDER BY rowid LIMIT 16`).all(owner, after) as
        { seq: number; encoding: string; bytes: number | null;
          id_encoding: string; id_bytes: number | null; connection_encoding: string; connection_bytes: number | null;
          domain_encoding: string; domain_bytes: number | null }[];
      let bytes = 0, count = 0, last: number | undefined;
      for (const row of metadata) {
        if (!identifierMetadata(row.id_encoding, row.id_bytes) || !identifierMetadata(row.connection_encoding, row.connection_bytes)
          || !identifierMetadata(row.domain_encoding, row.domain_bytes, true)
          || row.encoding !== 'text' || typeof row.bytes !== 'number' || !Number.isSafeInteger(row.bytes)
          || row.bytes <= 0 || row.bytes > 524288 - bytes) break;
        bytes += row.bytes; last = row.seq; count++;
      }
      if (metadata.length && last === undefined) throw deliveryReadUnavailable();
      // SQLite's native TEXT conversion may truncate NULs and replace invalid
      // UTF-8. Read original bytes instead; corruption must never alias an
      // identity, become a valid JSON prefix, or advance a hidden cursor.
      const rows = last === undefined ? [] : db.prepare(`SELECT CAST(id AS BLOB) AS id, CAST(connection_id AS BLOB) AS connection_id,
        CAST(stream_domain AS BLOB) AS stream_domain, CAST(payload_json AS BLOB) AS payload_json
        FROM hub_events WHERE owner_user_id=? AND rowid>? AND rowid<=? ORDER BY rowid`).all(owner, after, last);
      if (rows.length !== count) throw deliveryReadUnavailable();
      const visible = new Map(domains);
      const decoded = rows.map(row => {
        const id = text(row.id, true), connection = text(row.connection_id, true), domain = text(row.stream_domain, true, true);
        const event = JSON.parse(text(row.payload_json));
        if (!event || event.id !== id || event.envConnectionId !== connection) throw deliveryReadUnavailable();
        return { id, connection, domain, event };
      });
      const nextCursor = decoded.at(-1)?.id ?? cursor;
      // Validate even invisible rows before permission filtering. There is no
      // authorization or permission to silently skip damaged original facts.
      if (!validDeliveryPage({ reset: false, cursor: nextCursor, events: decoded.map(row => row.event) })) throw deliveryReadUnavailable();
      value = { reset: false, cursor: nextCursor, events: decoded.filter(row => visible.get(row.connection) === row.domain).map(row => row.event) };
    }
    if (!validDeliveryPage(value)) throw deliveryReadUnavailable();
    if (ownSnapshot) db.exec('COMMIT');
    return value;
  } catch (error) {
    let rollback: { error: unknown } | undefined;
    if (ownSnapshot && db.isTransaction) {
      try { db.exec('ROLLBACK'); } catch (error) {
        // The original caller owns retirement, never a replacement connection.
        rollback = { error };
      }
    }
    reportHubReadFailure('hub-delivery-read', error, diagnostics, rollback);
    throw deliveryReadUnavailable();
  }
}
