import { createHash } from 'node:crypto';
import { CARD_TONES, DRAWING_MAX_BODY_BYTES, DRAWING_MAX_DOCUMENTS, drawingContent,
  NATIVE_DRAWIO_MAX_BODY_BYTES, NATIVE_DRAWIO_MAX_DOCUMENTS, nativeDrawioContent, validNativeDrawioWrite,
  validBoardUuid, validCardWrite, validDrawingId, validDrawingWrite, validDrawingContent,
  type CardDocument, type CardSummary, type CardWrite, type DrawingDocument, type DrawingSummary,
  type DrawingWrite, type NativeDrawioDocument, type NativeDrawioSummary, type NativeDrawioWrite } from '@agentopsdeck/shared';
import type { WorkspaceCards } from './workspace-cards.js';
import type { WorkspaceDrawings } from './workspace-drawings.js';
import type { WorkspaceNativeDrawio } from './workspace-native-drawio.js';

/** Fixed user-owned visual documents. Native-file binding IDs, caller user IDs,
 * arbitrary storage methods and projection/import bypasses are not commands. */
export type HubVisualKind = 'card' | 'drawing' | 'native-drawio';
export type HubVisualCommand = { kind: HubVisualKind; action: 'list' }
  | { kind: HubVisualKind; action: 'get'; resourceId: string }
  | { kind: 'card'; action: 'save'; resourceId: string; document: CardWrite }
  | { kind: 'drawing'; action: 'save'; resourceId: string; document: DrawingWrite }
  | { kind: 'native-drawio'; action: 'save'; resourceId: string; document: NativeDrawioWrite };
export type HubVisualResult = null
  | { kind: 'card'; action: 'list'; summaries: CardSummary[] }
  | { kind: 'drawing'; action: 'list'; summaries: DrawingSummary[] }
  | { kind: 'card'; action: 'get'; document: CardDocument | null }
  | { kind: 'drawing'; action: 'get'; document: DrawingDocument }
  | { kind: 'card'; action: 'save'; result: ReturnType<WorkspaceCards['save']> }
  | { kind: 'drawing'; action: 'save'; result: ReturnType<WorkspaceDrawings['save']> }
  | { kind: 'native-drawio'; action: 'list'; summaries: NativeDrawioSummary[] }
  | { kind: 'native-drawio'; action: 'get'; document: NativeDrawioDocument }
  | { kind: 'native-drawio'; action: 'save'; result: ReturnType<WorkspaceNativeDrawio['save']> };
export const HUB_VISUAL_RPC_BYTES = Math.max(DRAWING_MAX_BODY_BYTES, NATIVE_DRAWIO_MAX_BODY_BYTES) + 16_384;
// 8192 point tuples alone contain 24576 JSON nodes. Do not silently lower
// the existing editor/export limit to the generic 16384-node RPC budget.
export const HUB_VISUAL_RPC_NODES = 40_000;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const metadata = (v: Record<string, unknown>) => integer(v.revision)
  && (v.revision === 0 ? v.updatedAt === null : integer(v.updatedAt));
const mutation = '00000000-0000-4000-8000-000000000000';
export function validHubVisualCommand(v: unknown): v is HubVisualCommand {
  if (!record(v) || !['card', 'drawing', 'native-drawio'].includes(String(v.kind))) return false;
  if (v.action === 'list') return exact(v, ['kind', 'action']);
  if (!(v.kind === 'card' ? validBoardUuid(v.resourceId) : validDrawingId(v.resourceId))) return false;
  if (v.action === 'get') return exact(v, ['kind', 'action', 'resourceId']);
  return v.action === 'save' && exact(v, ['kind', 'action', 'resourceId', 'document'])
    && (v.kind === 'card' ? validCardWrite(v.document) : v.kind === 'drawing' ? validDrawingWrite(v.document) : validNativeDrawioWrite(v.document));
}
function document(kind: HubVisualKind, v: unknown): boolean {
  if (!record(v) || !metadata(v)) return false;
  const { resourceId, revision, updatedAt: _time, ...content } = v;
  if (kind === 'card') return exact(v, ['resourceId', 'revision', 'updatedAt', 'title', 'value', 'detail', 'tone', 'progress']) && validBoardUuid(resourceId)
    && validCardWrite({ ...content, revision: 0, mutationId: mutation });
  if (kind === 'native-drawio') return exact(v, ['resourceId', 'revision', 'updatedAt', 'format', 'version', 'title', 'xml'])
    && validDrawingId(resourceId) && validNativeDrawioWrite({ ...content, revision: 0, mutationId: mutation });
  return validDrawingId(resourceId) && Object.keys(content).every(k => ['format', 'version', 'title', 'nodes', 'edges', 'strokes'].includes(k))
    && validDrawingContent(content);
}
function summary(kind: HubVisualKind, v: unknown): boolean {
  if (!record(v) || !metadata(v) || typeof v.title !== 'string' || !v.title.trim()) return false;
  return kind === 'card' ? exact(v, ['resourceId', 'title', 'tone', 'revision', 'updatedAt'])
    && validBoardUuid(v.resourceId) && v.title.length <= 120 && CARD_TONES.includes(v.tone as never)
    : exact(v, ['resourceId', 'title', 'revision', 'updatedAt']) && validDrawingId(v.resourceId) && v.title.length <= 160;
}
export function validHubVisualResult(v: unknown): v is HubVisualResult {
  if (v === null) return true;
  if (!record(v) || v.kind !== 'card' && v.kind !== 'drawing' && v.kind !== 'native-drawio') return false;
  if (v.action === 'list') return exact(v, ['kind', 'action', 'summaries']) && Array.isArray(v.summaries)
    && v.summaries.length <= (v.kind === 'card' ? 64 : v.kind === 'drawing' ? DRAWING_MAX_DOCUMENTS : NATIVE_DRAWIO_MAX_DOCUMENTS)
    && v.summaries.every(s => summary(v.kind as HubVisualKind, s))
    && new Set(v.summaries.map(s => s.resourceId)).size === v.summaries.length;
  if (v.action === 'get') return exact(v, ['kind', 'action', 'document'])
    && (v.kind === 'card' && v.document === null || document(v.kind, v.document));
  if (v.action !== 'save' || !exact(v, ['kind', 'action', 'result']) || !record(v.result)) return false;
  return v.result.status === 'saved' ? exact(v.result, ['status', 'document']) && document(v.kind, v.result.document)
    : exact(v.result, ['status']) && ['conflict', 'mutation-reused', 'limit', 'file-managed'].includes(String(v.result.status));
}
const contentHash = (kind: HubVisualKind, v: CardWrite | DrawingWrite | NativeDrawioWrite | CardDocument | DrawingDocument | NativeDrawioDocument) => {
  const content = kind === 'native-drawio' ? nativeDrawioContent(v as NativeDrawioWrite) : kind === 'drawing' ? drawingContent(v as DrawingWrite)
    : (({ title, value, detail, tone, progress }: CardWrite) => ({ title, value, detail, tone, progress }))(v as CardWrite);
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
};
export type HubVisualExpectation = { kind: HubVisualKind; action: HubVisualCommand['action']; resourceId?: string; revision?: number; contentHash?: string };
export function hubVisualExpectation(command: HubVisualCommand): HubVisualExpectation {
  return { kind: command.kind, action: command.action,
    ...(command.action === 'list' ? {} : { resourceId: command.resourceId }),
    ...(command.action === 'save' ? { revision: command.document.revision + 1, contentHash: contentHash(command.kind, command.document) } : {}) };
}
export function validHubVisualReply(expected: HubVisualExpectation, v: unknown): v is HubVisualResult {
  if (!validHubVisualResult(v)) return false;
  if (v === null) return true;
  if (v.kind !== expected.kind || v.action !== expected.action) return false;
  if (v.action === 'get') return v.document === null || v.document.resourceId === expected.resourceId;
  if (v.action === 'save' && v.result.status === 'saved') return v.result.document.resourceId === expected.resourceId
    && v.result.document.revision === expected.revision && contentHash(v.kind, v.result.document) === expected.contentHash;
  return true;
}
export function executeHubVisual(cards: WorkspaceCards, drawings: WorkspaceDrawings, native: WorkspaceNativeDrawio, userId: string, command: HubVisualCommand): HubVisualResult {
  if (command.kind === 'native-drawio') {
    if (command.action === 'list') return { kind: 'native-drawio', action: 'list', summaries: native.list(userId) };
    if (command.action === 'get') return { kind: 'native-drawio', action: 'get', document: native.get(userId, command.resourceId) };
    return { kind: 'native-drawio', action: 'save', result: native.save(userId, command.resourceId, command.document) };
  }
  if (command.kind === 'card') {
    if (command.action === 'list') return { kind: 'card', action: 'list', summaries: cards.list(userId) };
    if (command.action === 'get') return { kind: 'card', action: 'get', document: cards.get(userId, command.resourceId) ?? null };
    return { kind: 'card', action: 'save', result: cards.save(userId, command.resourceId, command.document) };
  }
  if (command.action === 'list') return { kind: 'drawing', action: 'list', summaries: drawings.list(userId) };
  if (command.action === 'get') return { kind: 'drawing', action: 'get', document: drawings.get(userId, command.resourceId) };
  return { kind: 'drawing', action: 'save', result: drawings.save(userId, command.resourceId, command.document) };
}
