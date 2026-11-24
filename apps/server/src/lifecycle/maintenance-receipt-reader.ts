import type { DatabaseSync } from 'node:sqlite';
import { validMaintenanceJob, type MaintenanceJob } from './connector-maintenance.js';

// The owner writes canonical JSON: recoveryRuns is bounded at 24 KiB, and
// archiveBootstrap contains at most 64 bounded session identifiers. 64 KiB
// leaves room for all remaining fields and ordinary whitespace, but never
// materializes an arbitrarily large corrupt record into JavaScript. SQLite's
// TEXT extraction may truncate NUL or replace invalid UTF-8; inspect raw bytes
// and original SQL types instead, for the record and its indexed identities.
const boundedText = (column: string, bytes: number) =>
  `CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB))<=${bytes} THEN CAST(${column} AS BLOB) ELSE NULL END`;
const projection = `${boundedText('id', 200)} id, ${boundedText('node_id', 200)} node_id,
  ${boundedText('stage', 32)} stage, revision, typeof(revision) revision_type,
  ${boundedText('record', 65536)} record`;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
type ReceiptRow = { id: Uint8Array | null; node_id: Uint8Array | null; stage: Uint8Array | null;
  revision: number; revision_type: string; record: Uint8Array | null };
function text(bytes: Uint8Array | null): string {
  if (!(bytes instanceof Uint8Array)) throw new Error('Invalid maintenance journal record');
  try { return decoder.decode(bytes); } catch { throw new Error('Invalid maintenance journal record'); }
}

/** Receipt queries only. Construction never creates/migrates schema, changes
 * durability, repairs state, checks authority or admits business effects. */
export class MaintenanceReceiptReader {
  constructor(private readonly db: DatabaseSync) {}
  private decode(row: ReceiptRow | undefined) {
    if (!row) return undefined;
    let value: unknown;
    try { value = JSON.parse(text(row.record)); } catch { throw new Error('Invalid maintenance journal record'); }
    if (row.revision_type !== 'integer' || !Number.isSafeInteger(row.revision)
      || !validMaintenanceJob(value) || value.id !== text(row.id) || value.nodeId !== text(row.node_id)
      || value.stage !== text(row.stage) || value.revision !== row.revision) throw new Error('Invalid maintenance journal record');
    return value;
  }
  get(id: string): MaintenanceJob | undefined {
    return this.decode(this.db.prepare(`SELECT ${projection} FROM connector_maintenance_jobs WHERE id = ?`).get(id) as ReceiptRow | undefined);
  }
  active(nodeId: string): MaintenanceJob | undefined {
    return this.decode(this.db.prepare(`SELECT ${projection} FROM connector_maintenance_jobs WHERE node_id = ? AND stage NOT IN ('succeeded', 'attention', 'cancelled')`).get(nodeId) as ReceiptRow | undefined);
  }
  unresolved(nodeId: string): MaintenanceJob | undefined {
    return this.decode(this.db.prepare(`SELECT ${projection} FROM connector_maintenance_jobs WHERE node_id = ? AND stage NOT IN ('succeeded', 'cancelled') LIMIT 1`).get(nodeId) as ReceiptRow | undefined);
  }
}
