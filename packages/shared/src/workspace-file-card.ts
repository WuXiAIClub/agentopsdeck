import { copyBoardTask, validBoardContent, validBoardUuid, type BoardContent } from './workspace-board.js';
import { NOTEBOOK_MAX_CHARS, NOTEBOOK_ARCHIVE_MAX_CHARS } from './session-notebook.js';
import { validCardWrite, type CardContent } from './workspace-card.js';
import { validDrawingContent, drawingContent, type DrawingContent } from './workspace-drawing.js';
import { validNativeDrawioWrite, nativeDrawioContent, type NativeDrawioContent } from './workspace-native-drawio.js';

/** Content/configuration only. Runtime sessions, credentials, terminal input,
 * browser handles and executable commands are deliberately not representable. */
export const WORKSPACE_FILE_CARD_KINDS = ['taskboard', 'statuscard', 'notebook', 'report', 'metric-card', 'drawing',
  'native-drawio', 'website', 'browser', 'research', 'terminal', 'media', 'dashboard'] as const;
export type WorkspaceFileCardKind = typeof WORKSPACE_FILE_CARD_KINDS[number];
export type WorkspaceFileCard =
  | { kind: 'taskboard' | 'statuscard'; content: BoardContent }
  | { kind: 'notebook'; content: { title: string; text: string; archive?: string } }
  | { kind: 'report'; content: { title: string; text: string } }
  | { kind: 'metric-card'; content: CardContent }
  | { kind: 'drawing'; content: DrawingContent }
  | { kind: 'native-drawio'; content: NativeDrawioContent }
  | { kind: 'website'; content: { title: string; connectionId: string; websiteId: string } }
  | { kind: 'browser'; content: { title: string; url: string } }
  | { kind: 'research'; content: { title: string; query: string; sources: { title: string; url: string; excerpt: string }[] } }
  | { kind: 'terminal'; content: { title: string; connectionId: string; targetId: string } }
  | { kind: 'media'; content: { title: string; mediaId: string } }
  | { kind: 'dashboard'; content: { title: string; description: string; items: { label: string; value: string }[] } };
export type WorkspaceFileCardDocument = WorkspaceFileCard & { version: 1 };
export type WorkspaceFileCardWrite = WorkspaceFileCard & { revision: number; mutationId: string };
export const WORKSPACE_FILE_CARD_MAX_BYTES = 2 * 1024 * 1024;
const uuid = '00000000-0000-4000-8000-000000000001';
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).sort().join(',') === [...names].sort().join(',');
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !v.includes('\0');
const title = (v: unknown): v is string => text(v, 120) && !!v.trim();
const id = (v: unknown): v is string => text(v, 512) && !/[\s\u0000-\u001f]/.test(v);
const url = (v: unknown): v is string => {
  if (!text(v, 4096)) return false;
  if (!v) return true;
  try { const parsed = new URL(v); return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password; } catch { return false; }
};
export function validWorkspaceFileCard(value: unknown): value is WorkspaceFileCard {
  if (!record(value) || !keys(value, ['kind', 'content']) || !record(value.content)) return false;
  const c = value.content;
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > WORKSPACE_FILE_CARD_MAX_BYTES) return false;
  } catch { return false; }
  switch (value.kind) {
    case 'taskboard': case 'statuscard': return keys(c, ['title', 'tasks']) && validBoardContent(c);
    case 'notebook': return (keys(c, ['title', 'text']) || keys(c, ['title', 'text', 'archive']))
      && title(c.title) && text(c.text, NOTEBOOK_MAX_CHARS)
      && (!('archive' in c) || text(c.archive, NOTEBOOK_ARCHIVE_MAX_CHARS));
    case 'report': return keys(c, ['title', 'text']) && title(c.title) && text(c.text, NOTEBOOK_MAX_CHARS);
    case 'metric-card': return validCardWrite({ ...c, revision: 0, mutationId: uuid }) && keys(c, ['title', 'value', 'detail', 'tone', 'progress']);
    case 'drawing': return validDrawingContent(c) && Object.keys(c).every(k => ['format', 'version', 'title', 'nodes', 'edges', 'strokes'].includes(k));
    case 'native-drawio': return keys(c, ['format', 'version', 'title', 'xml']) && validNativeDrawioWrite({ ...c, revision: 0, mutationId: uuid });
    case 'website': return keys(c, ['title', 'connectionId', 'websiteId']) && title(c.title) && id(c.connectionId) && id(c.websiteId);
    case 'browser': return keys(c, ['title', 'url']) && title(c.title) && url(c.url);
    case 'terminal': return keys(c, ['title', 'connectionId', 'targetId']) && title(c.title) && id(c.connectionId) && id(c.targetId);
    case 'media': return keys(c, ['title', 'mediaId']) && title(c.title) && id(c.mediaId);
    case 'research': return keys(c, ['title', 'query', 'sources']) && title(c.title) && text(c.query, 2000)
      && Array.isArray(c.sources) && c.sources.length <= 40 && c.sources.every(s => record(s) && keys(s, ['title', 'url', 'excerpt'])
        && text(s.title, 240) && url(s.url) && !!s.url && text(s.excerpt, 4000));
    case 'dashboard': return keys(c, ['title', 'description', 'items']) && title(c.title) && text(c.description, 4000)
      && Array.isArray(c.items) && c.items.length <= 64 && c.items.every(i => record(i) && keys(i, ['label', 'value']) && text(i.label, 120) && text(i.value, 2000));
    default: return false;
  }
}
/** Canonical field order makes semantically identical JSON share a source hash. */
export function workspaceFileCardContent(value: WorkspaceFileCard): WorkspaceFileCard {
  const c = value.content;
  switch (value.kind) {
    case 'taskboard': case 'statuscard': return { kind: value.kind, content: { title: value.content.title, tasks: value.content.tasks.map(copyBoardTask) } };
    case 'drawing': return { kind: value.kind, content: drawingContent(value.content) };
    case 'native-drawio': return { kind: value.kind, content: nativeDrawioContent(value.content) };
    default: {
      const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted) : record(v)
        ? Object.fromEntries(Object.keys(v).sort().map(key => [key, sorted(v[key])])) : v;
      return { kind: value.kind, content: sorted(c) } as WorkspaceFileCard;
    }
  }
}

export function validWorkspaceFileCardWrite(value: unknown): value is WorkspaceFileCardWrite {
  if (!record(value) || !keys(value, ['kind', 'content', 'revision', 'mutationId'])) return false;
  return Number.isSafeInteger(value.revision) && (value.revision as number) >= 0 && (value.revision as number) < Number.MAX_SAFE_INTEGER
    && validBoardUuid(value.mutationId)
    && validWorkspaceFileCard({ kind: value.kind, content: value.content });
}

/** Identity, not a file path. Native projection adapters validate the ID in the
 * owning namespace; private notebook IDs still require their own authorization. */
export function workspaceFileCardResource(kind: WorkspaceFileCardKind, id: string): string {
  const result = JSON.stringify([kind, id]);
  if (!parseWorkspaceFileCardResource(result)) throw new Error('Invalid file card resource');
  return result;
}
export function parseWorkspaceFileCardResource(value: unknown): { kind: WorkspaceFileCardKind; id: string } | undefined {
  if (typeof value !== 'string' || value.length > 4096) return;
  try {
    const parts: unknown = JSON.parse(value);
    if (!Array.isArray(parts) || parts.length !== 2 || !WORKSPACE_FILE_CARD_KINDS.includes(parts[0])
      || typeof parts[1] !== 'string' || !parts[1] || /[\u0000-\u001f\u007f]/.test(parts[1]) || JSON.stringify(parts) !== value) return;
    return { kind: parts[0], id: parts[1] };
  } catch { return; }
}
export function validWorkspaceFileCardResource(value: unknown): value is string { return !!parseWorkspaceFileCardResource(value); }
