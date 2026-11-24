import { createHash } from 'node:crypto';
import { BOARD_MAX_BODY_BYTES, BOARD_MAX_TASKS, copyBoardTask, validBoardId, validBoardContent, validBoardWrite,
  validBoardUuid, type BoardDocument, type BoardSummary, type BoardWrite } from '@agentopsdeck/shared';
import type { BoardSaveResult } from './workspace-boards.js';
import type { publicFileBoardBinding } from './workspace-board-files.js';

export type HubBoardSnapshot = { document: BoardDocument; binding: ReturnType<typeof publicFileBoardBinding> | null };

/** Fixed private-board operations only. No caller user ID, SQL, binding ID,
 * import-file bypass or callback. The complete Hub owner remains the writer. */
export type HubBoardCommand = { action: 'list' }
  | { action: 'get' | 'summary' | 'snapshot'; resourceId: string }
  | { action: 'save'; resourceId: string; document: BoardWrite };
export type HubBoardResult = null | { action: 'list'; summaries: BoardSummary[] }
  | { action: 'get'; document: BoardDocument }
  | ({ action: 'snapshot' } & HubBoardSnapshot)
  | { action: 'summary'; summary: BoardSummary }
  | { action: 'save'; result: BoardSaveResult };
// The existing HTTP bound covers all escaped legal documents. Credentials and
// the command envelope need additional space; never truncate task content.
export const HUB_BOARD_RPC_BYTES = BOARD_MAX_BODY_BYTES + 16_384;
export const HUB_BOARD_RPC_NODES = 16_384;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const metadata = (v: Record<string, unknown>) => validBoardId(v.resourceId) && integer(v.revision)
  && (v.updatedAt === null ? v.revision === 0 : integer(v.updatedAt) && Number(v.revision) > 0);
export function validHubBoardCommand(v: unknown): v is HubBoardCommand {
  if (!object(v)) return false;
  if (v.action === 'list') return fields(v, ['action']);
  if (!validBoardId(v.resourceId)) return false;
  return v.action === 'save' ? fields(v, ['action', 'resourceId', 'document']) && validBoardWrite(v.document)
    : (v.action === 'get' || v.action === 'summary' || v.action === 'snapshot') && fields(v, ['action', 'resourceId']);
}
export function validHubBoardDocument(v: unknown): v is BoardDocument {
  return object(v) && fields(v, ['title', 'tasks', 'resourceId', 'revision', 'updatedAt'])
    && validBoardContent(v) && metadata(v);
}
function summary(v: unknown): v is BoardSummary {
  if (!object(v) || !fields(v, ['title', 'resourceId', 'revision', 'updatedAt', 'counts']) || !metadata(v)
    || !validBoardContent({ title: v.title, tasks: [] }) || !object(v.counts) || !fields(v.counts, ['todo', 'doing', 'done'])) return false;
  const counts = Object.values(v.counts);
  return counts.every(integer) && counts.reduce((n, c) => n + Number(c), 0) <= BOARD_MAX_TASKS;
}
export function validHubBoardResult(v: unknown): v is HubBoardResult {
  if (v === null) return true;
  if (!object(v)) return false;
  if (v.action === 'get') return fields(v, ['action', 'document']) && validHubBoardDocument(v.document);
  if (v.action === 'snapshot') return fields(v, ['action', 'document', 'binding']) && validHubBoardDocument(v.document)
    && (v.binding === null || object(v.binding) && fields(v.binding, ['bindingId', 'resourceId', 'sessionId', 'state', 'problem'])
      && validBoardUuid(v.binding.bindingId) && v.binding.resourceId === v.document.resourceId
      && typeof v.binding.sessionId === 'string' && v.binding.sessionId.length > 0 && v.binding.sessionId.length <= 8192
      && ['prepared', 'active', 'revoked'].includes(String(v.binding.state))
      && (v.binding.problem === null || typeof v.binding.problem === 'string' && v.binding.problem.length <= 8192));
  if (v.action === 'summary') return fields(v, ['action', 'summary']) && summary(v.summary);
  // 64 stored boards plus the implicit unsaved default board.
  if (v.action === 'list') return fields(v, ['action', 'summaries']) && Array.isArray(v.summaries)
    && v.summaries.length <= 65 && v.summaries.every(summary)
    && new Set(v.summaries.map(s => s.resourceId)).size === v.summaries.length;
  if (v.action !== 'save' || !fields(v, ['action', 'result']) || !object(v.result)) return false;
  return v.result.status === 'saved' ? fields(v.result, ['status', 'document']) && validHubBoardDocument(v.result.document)
    : fields(v.result, ['status']) && ['conflict', 'mutation-reused', 'limit', 'file-managed'].includes(String(v.result.status));
}
// Retain only correlation metadata, not credentials or the full task document.
export type HubBoardReplyExpectation = { action: HubBoardCommand['action']; resourceId?: string; revision?: number; contentHash?: string };
const contentHash = (v: Pick<BoardDocument, 'title' | 'tasks'>) => createHash('sha256')
  .update(JSON.stringify({ title: v.title, tasks: v.tasks.map(copyBoardTask) })).digest('hex');
export function hubBoardReplyExpectation(command: HubBoardCommand): HubBoardReplyExpectation {
  return { action: command.action, ...(command.action === 'list' ? {} : { resourceId: command.resourceId }),
    ...(command.action === 'save' ? { revision: command.document.revision + 1, contentHash: contentHash(command.document) } : {}) };
}
export function validHubBoardReply(expected: HubBoardReplyExpectation, value: unknown): value is HubBoardResult {
  if (!validHubBoardResult(value)) return false;
  if (value === null) return true;
  if (value.action !== expected.action) return false;
  if (value.action === 'get' || value.action === 'snapshot') return value.document.resourceId === expected.resourceId;
  if (value.action === 'summary') return value.summary.resourceId === expected.resourceId;
  if (value.action === 'save' && value.result.status === 'saved') return value.result.document.resourceId === expected.resourceId
    && value.result.document.revision === expected.revision && contentHash(value.result.document) === expected.contentHash;
  return true;
}
