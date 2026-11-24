import {createHash} from 'node:crypto';
import {DEFAULT_HUB_NOTEBOOK_LAYOUT, NOTEBOOK_ARCHIVE_MAX_CHARS, NOTEBOOK_MAX_CHARS,
  validBoardUuid, validHubNotebookLayout, type SessionNotebookDocument, type WorkspaceFileCardWrite} from '@agentopsdeck/shared';
import type {HubStore} from './hub-store.js';
import {validNotebookInput} from './session-notebooks.js';

export type NativeNotebookAutosave = {mode: 'autosave'; document: {resourceId: string; revision: number; text: string};
  area: 'hot' | 'cold' | 'layout'; styled: boolean; mutationId: string};
export class NativeNotebookAutosaveConflict extends Error {}
const conflict = (): never => {throw new NativeNotebookAutosaveConflict('Notebook autosave conflict');};
export function validNativeNotebookAutosave(v: Record<string, unknown>): v is Record<string, unknown> & NativeNotebookAutosave {
  if (Object.keys(v).length !== 5 || v.mode !== 'autosave' || !validBoardUuid(v.mutationId) || typeof v.styled !== 'boolean'
    || !['hot', 'cold', 'layout'].includes(String(v.area))
    || !validNotebookInput(v.document, v.area === 'cold' ? NOTEBOOK_ARCHIVE_MAX_CHARS : NOTEBOOK_MAX_CHARS)) return false;
  if (v.area !== 'layout') return true;
  try {return validHubNotebookLayout(JSON.parse(v.document.text));} catch {return false;}
}
/** Keep the legacy JSON property ordering and byte-for-byte UUID algorithm.
 * Do not normalize the original three-field request before hashing. */
export function nativeNotebookMutation(user: string, bindingId: string,
  document: NativeNotebookAutosave['document'], area: NativeNotebookAutosave['area']): string {
  const hex = createHash('sha256').update(JSON.stringify(area === 'cold'
    ? [user, bindingId, document, 'archive'] : [user, bindingId, document])).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function original(owner: HubStore, user: string, resource: string, bindingId: string, request: NativeNotebookAutosave) {
  const ref = owner.cardFileProjection.notebookRef(user, resource);
  if (!ref || request.document.resourceId !== (request.area === 'layout' ? ref.layoutId : ref.textId)
    || request.mutationId !== nativeNotebookMutation(user, bindingId, request.document, request.area)) return conflict();
  const current = request.area === 'cold' ? owner.notebooks.getArchive(user, request.document.resourceId)
    : owner.notebooks.get(user, request.document.resourceId);
  return {ref, current};
}
/** Called only in the original identity/savepoint. Null explicitly means the
 * original private archive/geometry CAS, never an effect failure fallback. */
export function planNativeNotebookAutosave(owner: HubStore, user: string, resource: string,
  bindingId: string, request: NativeNotebookAutosave): {document: WorkspaceFileCardWrite | null; receipt: boolean} {
  const {ref, current} = original(owner, user, resource, bindingId, request);
  if (request.area === 'cold' && owner.notebooks.archiveFileBinding(user, ref.textId) !== bindingId) return {document: null, receipt: false};
  if (owner.notebooks.fileBinding(user, request.document.resourceId) !== bindingId && request.area !== 'cold') return conflict();
  if (request.area !== 'layout' && !request.styled
    && (/data-agentopsdeck-note\s*=/.test(request.document.text) || /data-agentopsdeck-note\s*=/.test(current.text))) return conflict();
  // Receipt recovery precedes current revision/capability and does not rebuild
  // a historical write from a newer Agent projection.
  if (owner.cardFiles.writeReceipt(user, bindingId, request.mutationId)) return {document: null, receipt: true};
  let title: string | undefined;
  if (request.area === 'layout') {
    let next: unknown, previous: unknown;
    try {next = JSON.parse(request.document.text); previous = current.revision ? JSON.parse(current.text) : DEFAULT_HUB_NOTEBOOK_LAYOUT;} catch {return conflict();}
    if (!validHubNotebookLayout(next) || !validHubNotebookLayout(previous)) return conflict();
    if (next.title === previous.title) return {document: null, receipt: false};
    title = next.title || 'Notebook';
  }
  if (current.revision !== request.document.revision) return conflict();
  const doc = owner.cardFileProjection.get(user, resource);
  if (doc?.kind !== 'notebook') return conflict();
  return {receipt: false, document: {kind: 'notebook', revision: doc.revision, mutationId: request.mutationId,
    content: {...doc.content, title: title ?? doc.content.title,
      text: request.area === 'hot' ? request.document.text : doc.content.text,
      ...(request.area === 'cold' ? {archive: request.document.text} : {})}}};
}
export function finishNativeNotebookAutosave(owner: HubStore, user: string, resource: string,
  bindingId: string, request: NativeNotebookAutosave): SessionNotebookDocument {
  const {ref, current} = original(owner, user, resource, bindingId, request);
  if ((request.area === 'cold' ? owner.notebooks.archiveFileBinding(user, ref.textId)
    : owner.notebooks.fileBinding(user, request.document.resourceId)) !== bindingId) return conflict();
  if (owner.cardFiles.writeReceipt(user, bindingId, request.mutationId)?.state !== 'saved') return conflict();
  if (request.area === 'layout') {
    let next: unknown, actual: unknown;
    try { next = JSON.parse(request.document.text); actual = JSON.parse(current.text); } catch { return conflict(); }
    if (!validHubNotebookLayout(next) || !validHubNotebookLayout(actual)) return conflict();
    if (JSON.stringify(next) !== JSON.stringify(actual)) {
      if (!validHubNotebookLayout(actual) || current.revision !== request.document.revision + 1 || actual.title !== next.title) return conflict();
      const saved = owner.notebooks.save(user, {...current, text: request.document.text});
      if (!saved) return conflict();
      return saved;
    }
  }
  return current;
}
