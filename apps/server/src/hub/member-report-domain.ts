import { WORKSPACE_FILE_CARD_MAX_BYTES, parseWorkspaceFileCardResource, validWorkspaceFileCard,
  validWorkspaceFileCardWrite, type WorkspaceFileCard, type WorkspaceFileCardWrite } from '@agentopsdeck/shared';
import type { HubStore } from './hub-store.js';

/** Native Hub-only save. A file binding conflict never admits an external effect. */
export type HubReportCommand = { resourceId: string; document: WorkspaceFileCardWrite };
export type HubReportResult = null | ({ resourceId: string } & (
  { status: 'saved'; document: WorkspaceFileCard & { revision: number } }
  | { status: 'conflict' | 'limit' | 'binding-conflict' }));
export const HUB_REPORT_RPC_BYTES = WORKSPACE_FILE_CARD_MAX_BYTES + 16_384;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, fields: string[]) => Object.keys(v).sort().join(',') === fields.sort().join(',');
export function validHubReportCommand(v: unknown): v is HubReportCommand {
  return record(v) && exact(v, ['resourceId', 'document']) && parseWorkspaceFileCardResource(v.resourceId)?.kind === 'report'
    && validWorkspaceFileCardWrite(v.document) && v.document.kind === 'report';
}
export function validHubReportResult(v: unknown): v is HubReportResult {
  if (v === null) return true;
  if (!record(v) || parseWorkspaceFileCardResource(v.resourceId)?.kind !== 'report') return false;
  if (v.status !== 'saved') return exact(v, ['resourceId', 'status']) && ['conflict', 'limit', 'binding-conflict'].includes(String(v.status));
  return exact(v, ['resourceId', 'status', 'document']) && record(v.document)
    && exact(v.document, ['kind', 'content', 'revision']) && v.document.kind === 'report'
    && Number.isSafeInteger(v.document.revision) && Number(v.document.revision) >= 0
    && validWorkspaceFileCard({ kind: v.document.kind, content: v.document.content });
}
export function validHubReportReply(resourceId: string, v: unknown): v is HubReportResult {
  // Original identical-mutation receipts return the CURRENT projection, which
  // may include later saves. Do not impose input revision+1 or content hash.
  return validHubReportResult(v) && (v === null || v.resourceId === resourceId);
}
export function executeHubReport(store: Pick<HubStore, 'cardFiles' | 'cardFileProjection'>, userId: string, command: HubReportCommand): HubReportResult {
  const { resourceId, document } = command, ref = parseWorkspaceFileCardResource(resourceId)!;
  if (store.cardFiles.current(userId, resourceId)) return { resourceId, status: 'binding-conflict' };
  const status = store.cardFileProjection.saveReport(userId, ref.id, document);
  if (status !== 'saved') return { resourceId, status };
  return { resourceId, status, document: store.cardFileProjection.get(userId, resourceId)! };
}
