import { registerCacheCleaner } from './cache-cleaners.js';
import { BOARD_MAX_BODY_BYTES, BOARD_STATUSES, validBoardWrite, summarizeBoard, type BoardContent, type BoardDocument, type BoardWrite, type BoardSummary, type BoardTask, type BoardStatus } from '@agentopsdeck/shared';
import { workspaceResourceEvents } from './workspace-resource-events.js';
import type { FileBoardBinding } from './workspace-file-board.js';

export type CachedBoardDocument = BoardDocument & { fileBinding?: FileBoardBinding };

export const boardSavedEvent = 'agentopsdeck:board-saved';
export type BoardSavedDetail = { scope: string; summary: BoardSummary };

const boardDocumentCache = new Map<string, CachedBoardDocument>();
const boardSummaryCache = new Map<string, BoardSummary>();
const MAX_CACHED_BOARDS = 64;

function boardCacheKey(scope: string, resourceId: string): string {
  return JSON.stringify([scope, resourceId]);
}

function setBoundedMap<T>(map: Map<string, T>, key: string, value: T, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export function readCachedBoardDocument(scope: string, resourceId: string): CachedBoardDocument | undefined {
  if (!scope || !resourceId) return undefined;
  const cached = boardDocumentCache.get(boardCacheKey(scope, resourceId));
  return cached ? structuredClone(cached) : undefined;
}

export function writeCachedBoardDocument(scope: string, resourceId: string, document: CachedBoardDocument | undefined): void {
  if (!scope || !resourceId) return;
  const key = boardCacheKey(scope, resourceId);
  if (!document) {
    boardDocumentCache.delete(key);
    return;
  }
  const copy = structuredClone(document);
  setBoundedMap(boardDocumentCache, key, copy, MAX_CACHED_BOARDS);
  writeCachedBoardSummary(scope, resourceId, summarizeBoard(copy));
}

export function readCachedBoardSummary(scope: string, resourceId: string): BoardSummary | undefined {
  if (!scope || !resourceId) return undefined;
  const cached = boardSummaryCache.get(boardCacheKey(scope, resourceId));
  return cached ? structuredClone(cached) : undefined;
}

export function writeCachedBoardSummary(scope: string, resourceId: string, summary: BoardSummary | undefined): void {
  if (!scope || !resourceId) return;
  const key = boardCacheKey(scope, resourceId);
  if (!summary) {
    boardSummaryCache.delete(key);
    return;
  }
  const previous = boardSummaryCache.get(key);
  if (previous && summary.revision < previous.revision) return;
  setBoundedMap(boardSummaryCache, key, structuredClone(summary), MAX_CACHED_BOARDS);
}

export function clearCachedBoardDocuments(): void {
  boardDocumentCache.clear();
  boardSummaryCache.clear();
}
registerCacheCleaner(clearCachedBoardDocuments);

export function publishBoardSaved(scope: string, document: BoardDocument) {
  writeCachedBoardDocument(scope, document.resourceId, document);
  window.dispatchEvent(new CustomEvent<BoardSavedDetail>(boardSavedEvent, { detail: { scope, summary: summarizeBoard(document) } }));
  workspaceResourceEvents.receive(scope, { type: 'workspace.revisions', resourceType: 'taskboard', resources: [{ resourceId: document.resourceId, revision: document.revision }] });
}

export const boardDraftKey = (scope: string, id: string) => `agentopsdeck.board-draft.v1:${JSON.stringify([scope, id])}`;
export function parseBoardDraft(raw: string | null): BoardWrite | undefined {
  if (!raw || raw.length > BOARD_MAX_BODY_BYTES) return undefined;
  try { const value: unknown = JSON.parse(raw); return validBoardWrite(value, true) ? value : undefined; } catch { return undefined; }
}
export const boardContentEqual = (a: BoardContent, b: BoardContent) => a.title === b.title && JSON.stringify(a.tasks) === JSON.stringify(b.tasks);
export type BoardTaskDrop = { status: BoardStatus; beforeId?: string };
/** A drop changes one task's column/order, never its identity or content. */
export function moveBoardTask(tasks: BoardTask[], id: string, target: BoardTaskDrop): BoardTask[] {
  const task = tasks.find(item => item.id === id);
  if (!task || !BOARD_STATUSES.includes(target.status) || target.beforeId === id) return tasks;
  // Other columns may be interleaved in storage. A visually unchanged drop must
  // not dirty the board just to normalize that unrelated storage order.
  if (task.status === target.status) {
    const peers = tasks.filter(item => item.status === target.status);
    if (peers[peers.indexOf(task) + 1]?.id === target.beforeId) return tasks;
  }
  const rest = tasks.filter(item => item.id !== id);
  let index: number;
  if (target.beforeId !== undefined) {
    index = rest.findIndex(item => item.id === target.beforeId && item.status === target.status);
    if (index < 0) return tasks;
  } else {
    index = rest.reduce((last, item, i) => item.status === target.status ? i + 1 : last, -1);
    if (index < 0) index = rest.length;
  }
  rest.splice(index, 0, task.status === target.status ? task : { ...task, status: target.status });
  return rest.every((item, i) => item === tasks[i]) ? tasks : rest;
}
/** Keep divergent local content even when another tab advanced the revision. */
export function reconcileBoardDraft(document: BoardDocument, draft: BoardWrite | undefined, mutationId: string) {
  const dirty = !!draft && !boardContentEqual(document, draft);
  return { draft: dirty ? draft : { title: document.title, tasks: document.tasks, revision: document.revision, mutationId },
    dirty, conflict: dirty && draft.revision !== document.revision };
}
