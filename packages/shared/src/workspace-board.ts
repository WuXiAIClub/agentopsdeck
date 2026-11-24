/** Hub-private workspace content. Never a native Agent session or a notebook. */
export const BOARD_MAX_TASKS = 200;
export const BOARD_MAX_CHARS = 256_000;
// JSON can escape each content character into six bytes; leave room for task IDs/keys.
export const BOARD_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const BOARD_STATUSES = ['todo', 'doing', 'done'] as const;
export type BoardStatus = typeof BOARD_STATUSES[number];
export const BOARD_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type BoardPriority = typeof BOARD_PRIORITIES[number];
export type BoardTask = { id: string; title: string; detail: string; status: BoardStatus;
  tags?: string[]; priority?: BoardPriority; dueDate?: string };
/** Stable optional-field order is also used for mutation fingerprints and file hashes. */
export function copyBoardTask(task: BoardTask): BoardTask {
  return { id: task.id, title: task.title, detail: task.detail, status: task.status,
    ...(task.tags !== undefined ? { tags: [...task.tags] } : {}),
    ...(task.priority !== undefined ? { priority: task.priority } : {}),
    ...(task.dueDate !== undefined ? { dueDate: task.dueDate } : {}) };
}
const taskFields = new Set(['id', 'title', 'detail', 'status', 'tags', 'priority', 'dueDate']);
/** Calendar date, intentionally not a timestamp: never shifts with client timezone. */
export function validBoardDueDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value.startsWith('0000')) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}
export type BoardContent = { title: string; tasks: BoardTask[] };
export type BoardDocument = BoardContent & { resourceId: string; revision: number; updatedAt: number | null };
export type BoardSummary = Omit<BoardDocument, 'tasks'> & { counts: Record<BoardStatus, number> };
export function summarizeBoard(document: BoardDocument): BoardSummary {
  const counts = { todo: 0, doing: 0, done: 0 };
  for (const task of document.tasks) counts[task.status]++;
  const { tasks: _, ...metadata } = document;
  return { ...metadata, counts };
}
export type BoardWrite = BoardContent & { revision: number; mutationId: string };
export const validBoardUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export const validBoardId = (value: unknown): value is string => value === 'default' || validBoardUuid(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function validBoardContent(value: unknown, draft = false): value is BoardContent {
  if (!object(value) || typeof value.title !== 'string' || (!draft && !value.title.trim()) || value.title.length > 120
    || !Array.isArray(value.tasks) || value.tasks.length > BOARD_MAX_TASKS) return false;
  const ids = new Set<string>();
  let chars = value.title.length;
  for (const task of value.tasks) {
    if (!object(task) || Object.keys(task).some(key => !taskFields.has(key)) || !validBoardUuid(task.id) || ids.has(task.id)
      || typeof task.title !== 'string' || (!draft && !task.title.trim()) || task.title.length > 240
      || typeof task.detail !== 'string' || task.detail.length > 4000
      || !BOARD_STATUSES.includes(task.status as BoardStatus)
      || ('tags' in task && (!Array.isArray(task.tags) || task.tags.length > 8
        || task.tags.some(tag => typeof tag !== 'string' || !draft && (!tag.trim() || tag !== tag.trim()) || tag.length > 32 || /[\u0000-\u001f\u007f]/.test(tag))
        || !draft && new Set(task.tags).size !== task.tags.length))
      || ('priority' in task && !BOARD_PRIORITIES.includes(task.priority as BoardPriority))
      || ('dueDate' in task && !validBoardDueDate(task.dueDate))) return false;
    ids.add(task.id); chars += task.title.length + task.detail.length
      + ((task.tags as string[] | undefined)?.reduce((sum, tag) => sum + tag.length, 0) ?? 0)
      + (typeof task.priority === 'string' ? task.priority.length : 0) + (typeof task.dueDate === 'string' ? task.dueDate.length : 0);
  }
  return chars <= BOARD_MAX_CHARS;
}
export function validBoardWrite(value: unknown, draft = false): value is BoardWrite {
  return object(value) && Object.keys(value).length === 4
    && validBoardUuid(value.mutationId) && Number.isSafeInteger(value.revision)
    && (value.revision as number) >= 0 && (value.revision as number) < Number.MAX_SAFE_INTEGER && validBoardContent(value, draft);
}
