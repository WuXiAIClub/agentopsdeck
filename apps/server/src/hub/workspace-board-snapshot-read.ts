import type { DatabaseSync } from 'node:sqlite';
import { BOARD_MAX_BODY_BYTES, BOARD_MAX_TASKS, validBoardContent, validBoardId, summarizeBoard,
  type BoardDocument, type BoardSummary } from '@agentopsdeck/shared';
import { DeliverySnapshotReadRejected } from './delivery-reader-protocol.js';
import { reportHubReadFailure } from './read-failure-diagnostics.js';

export type WorkspaceBoardRead = { owner: string; mode: 'list' | 'summary' | 'document'; resourceId: string | null };
export type WorkspaceBoardReadResult = BoardDocument | BoardSummary | BoardSummary[];
const empty = (resourceId: string): BoardDocument => ({ resourceId, title: 'Task board', tasks: [], revision: 0, updatedAt: null });
const integer = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const keys = (v: object, expected: string) => Object.keys(v).sort().join() === expected;
export function validWorkspaceBoardRead(value: unknown): value is WorkspaceBoardRead {
  try {
    const r = value as WorkspaceBoardRead;
    return !!r && typeof r === 'object' && !Array.isArray(r) && keys(r, 'mode,owner,resourceId')
      && typeof r.owner === 'string' && r.owner.length > 0 && r.owner.length <= 512 && !/[\u0000-\u001f\u007f]/.test(r.owner)
      && (r.mode === 'list' ? r.resourceId === null : (r.mode === 'summary' || r.mode === 'document') && validBoardId(r.resourceId));
  } catch { return false; }
}
function metadata(v: BoardDocument | BoardSummary): boolean {
  return validBoardId(v.resourceId) && typeof v.title === 'string' && !!v.title.trim() && v.title.length <= 120
    && integer(v.revision) && v.revision < Number.MAX_SAFE_INTEGER
    && (v.revision === 0 ? v.updatedAt === null : integer(v.updatedAt));
}
function document(v: unknown): v is BoardDocument {
  if (!v || typeof v !== 'object' || Array.isArray(v) || !keys(v, 'resourceId,revision,tasks,title,updatedAt')) return false;
  const d = v as BoardDocument;
  return metadata(d) && validBoardContent(d) && (d.revision !== 0 || d.title === 'Task board' && d.tasks.length === 0);
}
function summary(v: unknown): v is BoardSummary {
  if (!v || typeof v !== 'object' || Array.isArray(v) || !keys(v, 'counts,resourceId,revision,title,updatedAt')) return false;
  const s = v as BoardSummary, c = s.counts;
  return metadata(s) && !!c && typeof c === 'object' && !Array.isArray(c) && keys(c, 'doing,done,todo')
    && integer(c.todo) && integer(c.doing) && integer(c.done) && c.todo + c.doing + c.done <= BOARD_MAX_TASKS
    && (s.revision !== 0 || s.title === 'Task board' && c.todo + c.doing + c.done === 0);
}
/** Exact display DTOs only. No task bodies in catalog/summary replies. */
export function validWorkspaceBoardResult(value: unknown, read: WorkspaceBoardRead): value is WorkspaceBoardReadResult {
  try {
    if (!validWorkspaceBoardRead(read)) return false;
    if (read.mode === 'list') {
      if (!Array.isArray(value) || value.length < 1 || value.length > 65 || !value.every(summary)) return false;
      const seen = new Set<string>();
      let previous: BoardSummary | undefined;
      for (const row of value) {
        if (seen.has(row.resourceId)) return false;
        seen.add(row.resourceId);
        if (row.revision === 0) {
          if (row.resourceId !== 'default' || seen.size !== 1) return false;
        } else {
          if (previous && (row.updatedAt! > previous.updatedAt!
            || row.updatedAt === previous.updatedAt && row.resourceId <= previous.resourceId)) return false;
          previous = row;
        }
      }
      return seen.has('default') && Buffer.byteLength(JSON.stringify(value)) <= 128 * 1024;
    }
    if (read.mode === 'document') {
      if (!document(value)) return false;
    } else if (!summary(value)) return false;
    return value.resourceId === read.resourceId && Buffer.byteLength(JSON.stringify(value)) <= BOARD_MAX_BODY_BYTES + 1024;
  } catch { return false; }
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const columns = `CASE WHEN typeof(resource_id)='text' AND length(CAST(resource_id AS BLOB))<=36
  THEN CAST(resource_id AS BLOB) ELSE NULL END AS resourceId,
  CASE WHEN typeof(content)='text' AND length(CAST(content AS BLOB))<=${BOARD_MAX_BODY_BYTES}
  THEN CAST(content AS BLOB) ELSE NULL END AS content,
  CASE WHEN typeof(revision)='integer' THEN revision ELSE NULL END AS revision,
  CASE WHEN typeof(updated_at)='integer' THEN updated_at ELSE NULL END AS updatedAt`;
function decode(row: Record<string, unknown>): BoardDocument {
  if (!(row.content instanceof Uint8Array) || !(row.resourceId instanceof Uint8Array)) throw new DeliverySnapshotReadRejected();
  let content: unknown, resourceId: string;
  try { content = JSON.parse(decoder.decode(row.content)); resourceId = decoder.decode(row.resourceId); }
  catch { throw new DeliverySnapshotReadRejected(); }
  if (!content || typeof content !== 'object' || Array.isArray(content) || !keys(content, 'tasks,title')) throw new DeliverySnapshotReadRejected();
  const d = { ...content, resourceId, revision: row.revision, updatedAt: row.updatedAt };
  if (!document(d) || d.revision < 1) throw new DeliverySnapshotReadRejected();
  return d;
}
/** One readonly snapshot; stream at most 64 stored boards, one bounded body at
 * a time. Never initialize stores, change bindings, repair rows or write receipts. */
export function readWorkspaceBoard(db: DatabaseSync, read: WorkspaceBoardRead): WorkspaceBoardReadResult {
  let owns = false;
  try {
    if (!validWorkspaceBoardRead(read) || db.isTransaction) throw new DeliverySnapshotReadRejected();
    db.exec('BEGIN'); owns = true;
    let result: WorkspaceBoardReadResult;
    if (read.mode === 'list') {
      const rows: BoardSummary[] = [];
      for (const row of db.prepare(`SELECT ${columns} FROM hub_workspace_boards WHERE user_id=?
        ORDER BY updated_at DESC,resource_id LIMIT 65`).iterate(read.owner)) {
        if (rows.length === 64) throw new DeliverySnapshotReadRejected();
        rows.push(summarizeBoard(decode(row)));
      }
      if (!rows.some(row => row.resourceId === 'default')) rows.unshift(summarizeBoard(empty('default')));
      result = rows;
    } else {
      const rows = db.prepare(`SELECT ${columns} FROM hub_workspace_boards WHERE user_id=? AND resource_id=? LIMIT 2`)
        .all(read.owner, read.resourceId!);
      if (rows.length > 1) throw new DeliverySnapshotReadRejected();
      const value = rows.length ? decode(rows[0]!) : empty(read.resourceId!);
      result = read.mode === 'document' ? value : summarizeBoard(value);
    }
    if (!validWorkspaceBoardResult(result, read)) throw new DeliverySnapshotReadRejected();
    db.exec('COMMIT'); owns = false;
    return result;
  } catch (error) {
    let rollback: { error: unknown } | undefined;
    if (owns && db.isTransaction) { try { db.exec('ROLLBACK'); } catch (error) { rollback = { error }; } }
    reportHubReadFailure('hub-workspace-board-read', error, undefined, rollback);
    if (rollback) throw rollback.error;
    throw error;
  }
}
