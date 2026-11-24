import { WORKSPACE_FILE_CARD_MAX_BYTES, parseWorkspaceFileCardResource, validWorkspaceFileCard, validNativeDrawioWrite,
  NOTEBOOK_MAX_CHARS, NOTEBOOK_ARCHIVE_MAX_CHARS,
  type WorkspaceFileCard } from '@agentopsdeck/shared';
import type { WorkspaceCardFileProjection } from './workspace-card-files.js';

/** Read the original native projection, never import, bind, save or execute. */
export type HubProjectionCommand = { resourceId: string };
export type HubProjectionResult = null | { resourceId: string; document: (WorkspaceFileCard & { revision: number }) | null };
export const HUB_PROJECTION_RESULT_BYTES = WORKSPACE_FILE_CARD_MAX_BYTES + 16_384;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function validHubProjectionCommand(v: unknown): v is HubProjectionCommand {
  return record(v) && Object.keys(v).join(',') === 'resourceId' && !!parseWorkspaceFileCardResource(v.resourceId);
}
export function validHubProjectionResult(v: unknown): v is HubProjectionResult {
  if (v === null) return true;
  if (!record(v) || Object.keys(v).sort().join(',') !== 'document,resourceId') return false;
  const ref = parseWorkspaceFileCardResource(v.resourceId);
  if (!ref) return false;
  if (v.document === null) return true;
  if (!record(v.document) || Object.keys(v.document).sort().join(',') !== 'content,kind,revision') return false;
  if (v.document.kind !== ref.kind || !Number.isSafeInteger(v.document.revision) || Number(v.document.revision) < 0) return false;
  // Native notebook storage permits NULs. Reading original facts is not an
  // Agent-file import/write; keep native limits without weakening file writes.
  if (ref.kind === 'notebook' || ref.kind === 'report') {
    const content = v.document.content;
    return record(content) && Object.keys(content).every(key => ['title', 'text', ...(ref.kind === 'notebook' ? ['archive'] : [])].includes(key))
      && typeof content.title === 'string' && content.title.length <= 120
      && typeof content.text === 'string' && content.text.length <= NOTEBOOK_MAX_CHARS
      && (!Object.hasOwn(content, 'archive') || typeof content.archive === 'string' && content.archive.length <= NOTEBOOK_ARCHIVE_MAX_CHARS);
  }
  // The original XML domain permits 1 MiB with JSON escaping; do not lower
  // that limit to the Agent-file serialization cap when reading native data.
  if (ref.kind === 'native-drawio') return record(v.document.content)
    && Object.keys(v.document.content).sort().join(',') === 'format,title,version,xml'
    && validNativeDrawioWrite({ ...v.document.content, revision: 0, mutationId: '00000000-0000-4000-8000-000000000000' });
  return validWorkspaceFileCard({ kind: v.document.kind, content: v.document.content });
}
export function validHubProjectionReply(expected: HubProjectionCommand, v: unknown): v is HubProjectionResult {
  return validHubProjectionResult(v) && (v === null || v.resourceId === expected.resourceId);
}
export function executeHubProjection(projection: WorkspaceCardFileProjection, userId: string, command: HubProjectionCommand): HubProjectionResult {
  return { resourceId: command.resourceId, document: projection.get(userId, command.resourceId) ?? null };
}
