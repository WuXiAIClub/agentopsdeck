import type { DatabaseSync } from 'node:sqlite';
import { DeliverySnapshotReadRejected } from './delivery-reader-protocol.js';
import { reportHubReadFailure } from './read-failure-diagnostics.js';

export type CompletionSummaryRead = { owner: string; targets: string[] };
export type CompletionSummaryRow = { target: string; generation: string; latestSequence: number;
  readThrough: number; unread: boolean; coverage: 'observed' | 'gap' };
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const sequence = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const uuid = (v: unknown): v is string => typeof v === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
export function validCompletionSummaryRead(v: unknown): v is CompletionSummaryRead {
  try {
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== 2
      || !Object.hasOwn(v, 'owner') || !Object.hasOwn(v, 'targets')) return false;
    const r = v as CompletionSummaryRead;
    return typeof r.owner === 'string' && r.owner.length > 0 && r.owner.length <= 512
      && !/[\u0000-\u001f\u007f]/.test(r.owner) && Array.isArray(r.targets) && r.targets.length <= 256
      && r.targets.every(digest);
  } catch { return false; }
}
/** Complete display rows in requested order. Never a permission or an ACK. */
export function validCompletionSummaryRows(v: unknown, read: CompletionSummaryRead): v is CompletionSummaryRow[] {
  try {
    if (!validCompletionSummaryRead(read) || !Array.isArray(v) || v.length > 256) return false;
    const order = [...new Set(read.targets)], seen = new Set<string>();
    let previous = -1;
    for (const value of v) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const row = value as CompletionSummaryRow;
      if (Object.keys(row).sort().join() !== 'coverage,generation,latestSequence,readThrough,target,unread'
        || !digest(row.target) || !uuid(row.generation) || !sequence(row.latestSequence) || !sequence(row.readThrough)
        || row.readThrough > row.latestSequence || row.unread !== (row.latestSequence > row.readThrough)
        || row.coverage !== 'observed' && row.coverage !== 'gap' || seen.has(row.target)) return false;
      const index = order.indexOf(row.target);
      if (index <= previous) return false;
      previous = index; seen.add(row.target);
    }
    return Buffer.byteLength(JSON.stringify(v)) <= 128 * 1024;
  } catch { return false; }
}
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function text(v: unknown): string {
  if (!(v instanceof Uint8Array)) throw new DeliverySnapshotReadRejected();
  try { return decoder.decode(v); } catch { throw new DeliverySnapshotReadRejected(); }
}
const boundedText = (column: string, bytes: number) => `CASE WHEN typeof(${column})='text'
  AND length(CAST(${column} AS BLOB))=${bytes} THEN CAST(${column} AS BLOB) ELSE NULL END AS ${column}`;
const boundedSequence = (column: string) => `CASE WHEN typeof(${column})='integer'
  AND ${column}>=0 AND ${column}<=9007199254740991 THEN ${column} ELSE NULL END AS ${column}`;

/** One readonly snapshot, including legacy absence of the lazily created
 * table. No schema creation, pruning, witness/token generation, or writes.
 * Reject the whole summary on corrupt rows; never silently hide unread state. */
export function readCompletionSummary(db: DatabaseSync, read: CompletionSummaryRead): CompletionSummaryRow[] {
  let ownsSnapshot = false;
  try {
    if (!validCompletionSummaryRead(read) || db.isTransaction) throw new DeliverySnapshotReadRejected();
    db.exec('BEGIN'); ownsSnapshot = true;
    const targets = [...new Set(read.targets)];
    let rows: CompletionSummaryRow[] = [];
    if (targets.length && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='completion_targets'").get()) {
      const found = db.prepare(`SELECT ${boundedText('target', 64)},${boundedText('generation', 36)},
        ${boundedSequence('latest')},${boundedSequence('read_through')},
        CASE WHEN typeof(gap)='integer' AND gap IN (0,1) THEN gap ELSE NULL END AS gap
        FROM completion_targets WHERE owner=? AND target IN (${targets.map(() => '?').join(',')}) LIMIT 257`).all(read.owner, ...targets);
      const byTarget = new Map<string, CompletionSummaryRow>();
      for (const row of found) {
        if (row.gap !== 0 && row.gap !== 1) throw new DeliverySnapshotReadRejected();
        const target = text(row.target);
        if (byTarget.has(target)) throw new DeliverySnapshotReadRejected();
        byTarget.set(target, { target, generation: text(row.generation), latestSequence: row.latest as number,
          readThrough: row.read_through as number, unread: Number(row.latest) > Number(row.read_through),
          coverage: row.gap === 1 ? 'gap' : 'observed' });
      }
      rows = targets.flatMap(target => { const row = byTarget.get(target); return row ? [row] : []; });
      if (rows.length !== found.length) throw new DeliverySnapshotReadRejected();
    }
    if (!validCompletionSummaryRows(rows, read)) throw new DeliverySnapshotReadRejected();
    db.exec('COMMIT'); ownsSnapshot = false;
    return rows;
  } catch (error) {
    let rollback: { error: unknown } | undefined;
    if (ownsSnapshot && db.isTransaction) {
      try { db.exec('ROLLBACK'); } catch (error) { rollback = { error }; }
    }
    reportHubReadFailure('hub-completion-summary-read', error, undefined, rollback);
    // Failed cleanup is physical owner failure, never a completed refusal.
    if (rollback) throw rollback.error;
    throw error;
  }
}
