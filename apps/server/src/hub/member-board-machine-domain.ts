import { BOARD_MAX_BODY_BYTES, BOARD_MAX_CHARS, BOARD_STATUSES, validBoardId, validBoardUuid } from '@agentopsdeck/shared';
import { validBoardAgentWrite, type BoardAgentWrite, type BoardAgentResult } from './workspace-board-capabilities.js';
import { validBoardAgentRead, type BoardAgentRead, type selectBoardRead } from './workspace-board-read.js';

/** Machine proof never becomes a human principal. Original capability scope,
 * binding, expiry, CAS, receipts and audit remain on the original connection. */
export type HubBoardMachineCommand = { action: 'authorized'; token: string }
  | { action: 'read'; token: string; query: BoardAgentRead }
  | { action: 'update'; token: string; document: BoardAgentWrite };
export type HubBoardMachineRead = ReturnType<typeof selectBoardRead> | { error: 'invalid_read' } | null;
export type HubBoardMachineResult = { action: 'authorized'; authorized: boolean }
  | { action: 'read'; snapshot: HubBoardMachineRead }
  | { action: 'update'; result: BoardAgentResult };
export const HUB_BOARD_MACHINE_RPC_BYTES = BOARD_MAX_BODY_BYTES + 16_384;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const integer = (v: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): v is number =>
  Number.isSafeInteger(v) && Number(v) >= minimum && Number(v) <= maximum;
export function validHubBoardMachineCommand(v: unknown): v is HubBoardMachineCommand {
  if (!object(v) || typeof v.token !== 'string' || !/^aod_board_[A-Za-z0-9_-]{43}$/.test(v.token)) return false;
  switch (v.action) {
    case 'authorized': return keys(v, ['action', 'token']);
    case 'read': return keys(v, ['action', 'token', 'query']) && validBoardAgentRead(v.query);
    case 'update': return keys(v, ['action', 'token', 'document']) && validBoardAgentWrite(v.document);
    default: return false;
  }
}
function snapshot(v: unknown): v is HubBoardMachineRead {
  if (v === null) return true;
  if (!object(v)) return false;
  if ('error' in v) return keys(v, ['error']) && ['invalid_read', 'revision_changed'].includes(String(v.error));
  if (!keys(v, ['resourceId', 'revision', 'tasks'], ['page', 'unchanged']) || !validBoardId(v.resourceId)
    || !integer(v.revision, 1) || !Array.isArray(v.tasks) || v.tasks.length > 200) return false;
  let text = 0;
  const ids = new Set<string>();
  for (const task of v.tasks) {
    if (!object(task) || !keys(task, ['id', 'title'], ['status', 'detail']) || !validBoardUuid(task.id)
      || ids.has(task.id) || typeof task.title !== 'string' || task.title.length > 240
      || ('status' in task && !BOARD_STATUSES.includes(task.status as never))
      || ('detail' in task && (typeof task.detail !== 'string' || task.detail.length > 4000))) return false;
    ids.add(task.id); text += task.title.length + (typeof task.detail === 'string' ? task.detail.length : 0);
  }
  if (text > BOARD_MAX_CHARS) return false;
  if ('unchanged' in v) return v.unchanged === true && v.tasks.length === 0 && !('page' in v);
  if (!('page' in v)) return true;
  const p = v.page;
  return object(p) && keys(p, ['offset', 'limit', 'total', 'nextOffset']) && integer(p.offset, 0, 200)
    && integer(p.limit, 1, 50) && integer(p.total, 0, 200) && v.tasks.length <= p.limit
    && v.tasks.length === Math.min(p.limit, Math.max(0, p.total - p.offset))
    && p.nextOffset === (p.offset + v.tasks.length < p.total ? p.offset + v.tasks.length : null);
}
export function validHubBoardMachineResult(v: unknown): v is HubBoardMachineResult {
  if (!object(v)) return false;
  switch (v.action) {
    case 'authorized': return keys(v, ['action', 'authorized']) && typeof v.authorized === 'boolean';
    case 'read': return keys(v, ['action', 'snapshot']) && snapshot(v.snapshot);
    case 'update': {
      if (!keys(v, ['action', 'result']) || !object(v.result)) return false;
      const r = v.result;
      return r.status === 'saved' ? keys(r, ['status', 'revision', 'mutationId']) && integer(r.revision, 1) && validBoardUuid(r.mutationId)
        : keys(r, ['status']) && ['denied', 'invalid', 'conflict', 'mutation-reused', 'limit'].includes(String(r.status));
    }
    default: return false;
  }
}
/** Retain selectors/IDs only, never the bearer or update text in a waiter. */
export type HubBoardMachineReplyExpectation = { action: HubBoardMachineCommand['action']; mutationId?: string; revision?: number; query?: BoardAgentRead };
export function hubBoardMachineReplyExpectation(v: HubBoardMachineCommand): HubBoardMachineReplyExpectation {
  return { action: v.action, ...(v.action === 'update' ? { mutationId: v.document.mutationId, revision: v.document.revision + 1 } : {}),
    ...(v.action === 'read' ? { query: { ...v.query, ...(v.query.taskIds ? { taskIds: [...v.query.taskIds] } : {}) } } : {}) };
}
export function validHubBoardMachineReply(expected: HubBoardMachineReplyExpectation, v: unknown): v is HubBoardMachineResult {
  if (!validHubBoardMachineResult(v) || v.action !== expected.action) return false;
  if (v.action === 'update') return v.result.status !== 'saved'
    || v.result.mutationId === expected.mutationId && v.result.revision === expected.revision;
  if (v.action !== 'read' || v.snapshot === null) return true;
  const query = expected.query!;
  if ('error' in v.snapshot) return v.snapshot.error !== 'revision_changed' || query.revision !== undefined;
  const s = v.snapshot;
  if (query.revision !== undefined && s.revision !== query.revision) return false;
  if ('unchanged' in s) return query.ifRevision === s.revision;
  if (query.ifRevision === s.revision) return false;
  if (Object.keys(query).length) {
    if (!('page' in s) || s.page.offset !== (query.offset ?? 0) || s.page.limit !== (query.limit ?? 20)) return false;
    if (!query.includeDetail && s.tasks.some(t => 'detail' in t)) return false;
  } else if ('page' in s) return false;
  return s.tasks.every(t => (!query.taskIds || query.taskIds.includes(t.id)) && (!query.status || t.status === query.status));
}
