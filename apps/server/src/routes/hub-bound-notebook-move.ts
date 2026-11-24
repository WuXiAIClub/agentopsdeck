import { HTTPException } from 'hono/http-exception';
import type { NativeFileWriteDependencies, AsyncNativeEditorDependencies } from './hub-native-file-write.js';
import { fileOperation, nativeEditorStore } from './hub-native-file-write.js';
import { workspaceFileCardResource } from '@agentopsdeck/shared';
import { moveInput } from '../hub/session-notebooks.js';
import { NotebookMoveConflict, type NotebookMove } from '../hub/notebook-operations.js';
import { HubFileBoardError } from '../hub/workspace-board-file-service.js';
import type { SessionNativeFileProof } from '../hub/member-native-file-domain.js';

/** No new model turn, file path or credential leaves the Hub.
 * Only the original file-write receipt can commit the reserved cold snapshot. */
export async function boundNotebookMove(deps: NativeFileWriteDependencies | AsyncNativeEditorDependencies, user: string, resource: string,
  requestId: string, read: () => void | Promise<void>, input?: NotebookMove, deferLocal = false,
  originalRequest?: Request, nativeCardId?: string, sessionProof?: SessionNativeFileProof) {
  // Session/shared authority has a separate migration boundary. Only a caller
  // which pinned the original private evidence may enter this async branch.
  if (deps.nativeFiles && nativeCardId !== undefined) {
    if (!originalRequest) throw new HTTPException(503);
    return fileOperation(async () => {
      const port = await deps.nativeFiles!.begin(originalRequest, {domain: 'card', resourceId: workspaceFileCardResource('notebook', nativeCardId),
        ...(sessionProof ? {sessionProof} : {})});
      return port.moveNotebook(resource, requestId, input ?? null, deps.fileCardsEnabled !== false);
    });
  }
  if (!('hubStore' in deps)) throw new HTTPException(503);
  const store = nativeEditorStore(deps), notes = store.notebooks;
  const old = notes.boundMove(user, resource, requestId);
  if (!old && input && notes.moveReceipt(user, resource, requestId)) return deferLocal ? undefined : notes.move(user, resource, input);
  if (old && input && old.input !== moveInput(input)) throw new NotebookMoveConflict('Request ID already used');
  if (old?.state === 'conflict') throw new NotebookMoveConflict('Original file move conflicted; no archive change was made');
  if (old?.state === 'saved') return notes.moveReceipt(user, resource, requestId);
  const bindingId = old?.bindingId ?? notes.fileBinding(user, resource);
  if (!bindingId || !input && !old) return;
  if (!deps.fileCards || deps.fileCardsEnabled === false) throw new HTTPException(503);
  const service = deps.fileCards, files = store.cardFiles;
  const binding = files.get(user, bindingId);
  if (!binding || old && binding.resourceId !== old.fileResource) throw new HTTPException(503);
  try {
    if (old) {
      // Recovery is GET-only, including after a process restart. Never recreate
      // a missing intent and never rebase against later Agent edits.
      await service.inspectWrite(user, binding.resourceId, bindingId, requestId);
    } else {
      if (!input) return;
      if (files.writeReceipt(user, bindingId, requestId)) throw new NotebookMoveConflict('Request ID already used');
      const next = notes.plannedMove(user, resource, input);
      const document = deps.hubStore.cardFileProjection.get(user, binding.resourceId);
      if (!document || document.kind !== 'notebook') throw new NotebookMoveConflict('Notebook projection unavailable');
      await service.write(user, binding.resourceId, bindingId, { kind: 'notebook', revision: document.revision,
        mutationId: requestId, content: { ...document.content, text: next.hotText,
          ...(document.content.archive !== undefined ? { archive: next.coldText } : {}) } }, prepare => {
        read();
        return notes.admitBoundMove(user, resource, input, bindingId, binding.resourceId, prepare);
      });
    }
    await read();
    // Current projection may contain a later Agent edit. Do not replace it
    // with the historic move snapshot just to make the revisions look equal.
    const receipt = files.writeReceipt(user, bindingId, requestId);
    if (receipt?.state === 'saved') await service.refresh(user, binding.resourceId, bindingId);
    await read();
    const result = notes.finishBoundMove(user, resource, requestId);
    if (result) return result;
    if (notes.boundMove(user, resource, requestId)?.state === 'conflict') throw new NotebookMoveConflict('Original file move conflicted; no archive change was made');
    throw new HTTPException(503);
  } catch (error) {
    // Once admitted, even an auth/transport error cannot certify rejection.
    // Preserve the UUID in the client; original authority is checked on GET.
    if (notes.boundMove(user, resource, requestId)?.state === 'pending') throw new HTTPException(503, { message: 'Move outcome pending; inspect the original receipt' });
    if (error instanceof HubFileBoardError) throw new HTTPException(error.status);
    throw error;
  }
}
