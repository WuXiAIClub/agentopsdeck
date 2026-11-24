import { BOARD_STATUSES, validBoardUuid, type BoardStatus } from '@agentopsdeck/shared';

/** Read selectors never grant access. Apply only after capability projection. */
export type BoardAgentRead = {
  status?: BoardStatus; taskIds?: string[]; includeDetail?: boolean;
  limit?: number; offset?: number; revision?: number; ifRevision?: number;
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
export function validBoardAgentRead(v: unknown): v is BoardAgentRead {
  return object(v) && Object.keys(v).every(k => ['status', 'taskIds', 'includeDetail', 'limit', 'offset', 'revision', 'ifRevision'].includes(k))
    && (!('status' in v) || BOARD_STATUSES.includes(v.status as BoardStatus))
    && (!('taskIds' in v) || Array.isArray(v.taskIds) && v.taskIds.length > 0 && v.taskIds.length <= 50
      && v.taskIds.every(validBoardUuid) && new Set(v.taskIds).size === v.taskIds.length)
    && (!('includeDetail' in v) || typeof v.includeDetail === 'boolean')
    && (!('limit' in v) || integer(v.limit, 1, 50)) && (!('offset' in v) || integer(v.offset, 0, 200))
    && (!('revision' in v) || integer(v.revision, 1)) && (!('ifRevision' in v) || integer(v.ifRevision, 1))
    && (!(Number(v.offset) > 0) || 'revision' in v)
    && (!('ifRevision' in v) || !('revision' in v) && !(Number(v.offset) > 0));
}
export const boardReadSchema = { type: 'object', additionalProperties: false, properties: {
  status: { type: 'string', enum: [...BOARD_STATUSES] },
  taskIds: { type: 'array', minItems: 1, maxItems: 50, uniqueItems: true, items: { type: 'string', format: 'uuid' } },
  includeDetail: { type: 'boolean', description: 'Default false for filtered/paged reads. Request details only for selected task IDs.' },
  limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 20 for nonempty input; empty input preserves legacy full read.' },
  offset: { type: 'integer', minimum: 0, maximum: 200, description: 'Use nextOffset from the previous page; a positive offset requires its revision.' },
  revision: { type: 'integer', minimum: 1, description: 'Pin pages to this revision; a conflict requires explicitly restarting the read.' },
  ifRevision: { type: 'integer', minimum: 1, description: 'Same-query refresh: omit tasks if unchanged. Not a per-task delta or a polling instruction.' },
} };
export type BoardAgentSnapshot = { resourceId: string; revision: number; tasks: { id: string; title: string; status?: BoardStatus; detail?: string }[] };
export function selectBoardRead(snapshot: BoardAgentSnapshot, query: BoardAgentRead) {
  if (!Object.keys(query).length) return snapshot;
  if (query.revision !== undefined && query.revision !== snapshot.revision) return { error: 'revision_changed' as const };
  if (query.ifRevision === snapshot.revision) return { resourceId: snapshot.resourceId, revision: snapshot.revision, tasks: [], unchanged: true as const };
  const matches = snapshot.tasks.filter(task => (!query.taskIds || query.taskIds.includes(task.id)) && (!query.status || task.status === query.status));
  const offset = query.offset ?? 0, limit = query.limit ?? 20;
  const tasks = matches.slice(offset, offset + limit).map(({ detail, ...task }) => query.includeDetail && detail !== undefined ? { ...task, detail } : task);
  return { resourceId: snapshot.resourceId, revision: snapshot.revision, tasks,
    page: { offset, limit, total: matches.length, nextOffset: offset + tasks.length < matches.length ? offset + tasks.length : null } };
}
