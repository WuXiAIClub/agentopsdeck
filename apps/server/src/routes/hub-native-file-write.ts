import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { createHash } from 'node:crypto';
import { DEFAULT_HUB_NOTEBOOK_LAYOUT, validHubNotebookLayout } from '@agentopsdeck/shared';
import { workspaceFileCardResource, type WorkspaceFileCardWrite } from '@agentopsdeck/shared';
import type { HubStore } from '../hub/hub-store.js';
import type { HubFileCardService } from '../hub/workspace-card-file-service.js';
import { HubFileBoardError } from '../hub/workspace-board-file-service.js';
import type { AsyncHubNativeFiles } from '../hub/async-native-files.js';
import type { SessionNativeFileProof } from '../hub/member-native-file-domain.js';
import type { Context } from 'hono';
import type { HubPrincipal } from '../hub/identity.js';
import { HubMemberRequestError, type AsyncHubMemberRequests } from '../hub/async-member-request.js';
import { pinOriginalRequestScope } from '../hub/original-request-scope.js';

/** Only registered private visual reads, not nested bindings or machine APIs.
 * Resource IDs are validated by the owning route after async authentication. */
export function isAsyncHubWorkspaceVisualReadRequest(method: string, path: string): boolean {
  return (method === 'GET' || method === 'HEAD')
    && /^\/api\/hub\/v1\/workspace\/(?:cards|drawings|native-drawio)(?:\/[^/]+)?$/.test(path);
}

export async function fileOperation<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (error instanceof HubFileBoardError || error instanceof HubMemberRequestError) {
      // Hono rebuilds res with the exception's status; a 503 placeholder would
      // erase the original cancellation even when res itself carries 499.
      if (error.status === 499) throw new HTTPException(499 as ContentfulStatusCode, {res: new Response(JSON.stringify({error: 'request_cancelled'}), {
        status: 499, headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'},
      })});
      throw new HTTPException(error.status, { message: 'File operation unavailable; no local fallback was saved.' });
    }
    throw error;
  }
}

export type NativeFileWriteDependencies = { hubStore: HubStore; fileCards?: HubFileCardService; fileCardsEnabled?: boolean;
  nativeFiles?: Pick<AsyncHubNativeFiles, 'begin'>; editorAccess?: Pick<AsyncHubMemberRequests, 'begin'> };
export type AsyncNativeEditorDependencies = {
  mode: 'async'; nativeFiles: Pick<AsyncHubNativeFiles, 'begin'>;
  editorAccess: Pick<AsyncHubMemberRequests, 'begin'>; fileCardsEnabled?: boolean;
};
export type NativeEditorDependencies<Ports> = (AsyncNativeEditorDependencies & Ports)
  | (NativeFileWriteDependencies & {mode?: 'legacy'; principal: (c: Context) => HubPrincipal} & Partial<Ports>);

/** Registration fails before any route or timer is installed. Async editor
 * composition never supplies a placeholder store or a fallback principal. */
export function validateNativeEditorPorts(deps: {mode?: 'async' | 'legacy'; nativeFiles?: Pick<AsyncHubNativeFiles, 'begin'>;
  editorAccess?: Pick<AsyncHubMemberRequests, 'begin'>}, methods: unknown[]) {
  if (deps.mode === 'async' && [deps.nativeFiles?.begin, deps.editorAccess?.begin, ...methods].some(method => typeof method !== 'function'))
    throw Error('Hub native editor dependencies unavailable');
}
export function nativeEditorStore(deps: NativeFileWriteDependencies | AsyncNativeEditorDependencies): HubStore {
  if ('hubStore' in deps) return deps.hubStore;
  throw new HTTPException(503); // Explicit legacy-only path, never async fallback.
}

/** The editor's original evidence and incarnation remain pinned across body,
 * file effects and projection reads. A new snapshot is not a replacement for
 * checking that original proof. Legacy compositions retain their old guard. */
export async function beginNativeEditorRequest(c: Context, deps: {
  principal?: ((c: Context) => HubPrincipal) | undefined; editorAccess?: Pick<AsyncHubMemberRequests, 'begin'> | undefined;
}) {
  c.header('Cache-Control', 'no-store');
  if (deps.editorAccess) {
    const original = await fileOperation(() => deps.editorAccess!.begin(c.req.raw));
    const expectedScope = c.req.header('x-agentopsdeck-recovery-scope');
    if (expectedScope !== undefined && expectedScope !== original.recoveryScope) throw new HTTPException(409);
    // The browser marker only detects stale requests. Pin the authenticated
    // server snapshot, never the untrusted header, for downstream file work.
    pinOriginalRequestScope(c.req.raw, original.recoveryScope);
    return {principal: original.principal, check: () => fileOperation(original.check)};
  }
  const resolve = deps.principal;
  if (!resolve) throw new HTTPException(503);
  const principal = resolve(c), {userId, admin} = principal;
  return {principal: {userId, admin}, check: async () => {
    const current = resolve(c);
    if (current.userId !== userId || current.admin !== admin) throw new HTTPException(401);
  }};
}

/** Existing native editors retain their endpoint and mutation identity. A bound
 * resource has exactly one write path: the file service, never a DB fallback.
 * The native revision must be from the editor's original snapshot. */
export async function writeBoundNativeCard(deps: NativeFileWriteDependencies | {
  nativeFiles: Pick<AsyncHubNativeFiles, 'begin'>; fileCardsEnabled?: boolean;
}, owner: string, id: string, input: WorkspaceFileCardWrite,
  request?: Request, expectedBinding?: string): Promise<boolean> {
  if (deps.nativeFiles) {
    if (!request) throw new HTTPException(503);
    const port = await deps.nativeFiles.begin(request, {domain: 'card', resourceId: workspaceFileCardResource(input.kind, id)});
    return port.saveEditor(input, deps.fileCardsEnabled !== false, expectedBinding);
  }
  if (!('hubStore' in deps)) throw new HTTPException(503);
  let resource = workspaceFileCardResource(input.kind, id);
  let binding = deps.hubStore.cardFiles.current(owner, resource);
  if (!binding && (input.kind === 'taskboard' || input.kind === 'statuscard')) {
    resource = workspaceFileCardResource(input.kind === 'taskboard' ? 'statuscard' : 'taskboard', id);
    binding = deps.hubStore.cardFiles.current(owner, resource);
    if (binding) input = { ...input, kind: input.kind === 'taskboard' ? 'statuscard' : 'taskboard' };
  }
  if (!binding) return false;
  if (!deps.fileCards || deps.fileCardsEnabled === false) throw new HTTPException(503, { message: 'File editing unavailable; no local copy was saved.' });
  const service = deps.fileCards;
  const receipt = await fileOperation(() => service.write(owner, resource, binding.bindingId, input));
  if (receipt.state !== 'saved') throw new HTTPException(receipt.state === 'conflict' ? 409 : 503, { message: `File save ${receipt.state}; inspect the same mutation before retrying.` });
  // Refresh the projection, not the write. In particular a recovered receipt
  // does not promise that the delayed SSE snapshot has already arrived.
  await fileOperation(() => service.refresh(owner, resource, binding.bindingId));
  return true;
}

/** Legacy notebook autosave has no mutation UUID. Derive an opaque stable ID
 * from its exact CAS request. Identical retries only inspect the durable intent;
 * geometry remains private and is never sent to the Agent. */
export async function writeBoundNotebook(deps: NativeFileWriteDependencies | AsyncNativeEditorDependencies, owner: string, id: string,
  input: { resourceId: string; revision: number; text: string }, layout = false, archive = false,
  request?: Request, styled = false, sessionProof?: SessionNativeFileProof) {
  if (deps.nativeFiles) {
    if (!request) throw new HTTPException(503);
    return fileOperation(async () => {
      const port = await deps.nativeFiles!.begin(request, {domain: 'card', resourceId: workspaceFileCardResource('notebook', id),
        ...(sessionProof ? {sessionProof} : {})});
      return port.saveNotebook(input, archive ? 'cold' : layout ? 'layout' : 'hot', styled, deps.fileCardsEnabled !== false);
    });
  }
  if (!('hubStore' in deps)) throw new HTTPException(503);
  const store = nativeEditorStore(deps);
  const resource = workspaceFileCardResource('notebook', id), binding = store.cardFiles.current(owner, resource);
  if (!binding) return;
  if (archive && store.notebooks.archiveFileBinding(owner, input.resourceId) !== binding.bindingId) return;
  const current = archive ? store.notebooks.getArchive(owner, input.resourceId) : store.notebooks.get(owner, input.resourceId);
  const hex = createHash('sha256').update(JSON.stringify(archive ? [owner, binding.bindingId, input, 'archive'] : [owner, binding.bindingId, input])).digest('hex');
  const mutationId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const existing = deps.hubStore.cardFiles.writeReceipt(owner, binding.bindingId, mutationId);
  let title: string | undefined;
  if (layout) {
    const next: unknown = JSON.parse(input.text), previous: unknown = current.revision ? JSON.parse(current.text) : DEFAULT_HUB_NOTEBOOK_LAYOUT;
    if (!validHubNotebookLayout(next) || !validHubNotebookLayout(previous)) throw new HTTPException(400);
    if (next.title === previous.title && !existing) return; // Existing store permits geometry-only CAS.
    title = next.title || 'Notebook';
  }
  if (!deps.fileCards || deps.fileCardsEnabled === false) throw new HTTPException(503);
  const service = deps.fileCards;
  if (existing) {
    const receipt = await fileOperation(() => service.inspectWrite(owner, resource, binding.bindingId, mutationId));
    if (receipt.state !== 'saved') throw new HTTPException(receipt.state === 'conflict' ? 409 : 503);
    await fileOperation(() => service.refresh(owner, resource, binding.bindingId));
  } else {
    if (current.revision !== input.revision) throw new HTTPException(409);
    const document = deps.hubStore.cardFileProjection.get(owner, resource);
    if (!document || document.kind !== 'notebook') throw new HTTPException(404);
    await writeBoundNativeCard(deps, owner, id, { kind: 'notebook', content: {
      ...document.content, title: title ?? document.content.title, text: layout || archive ? document.content.text : input.text,
      ...(archive ? { archive: input.text } : {}),
    }, revision: document.revision, mutationId });
  }
  if (layout) {
    const projected = deps.hubStore.notebooks.get(owner, input.resourceId);
    const next = JSON.parse(input.text), actual = JSON.parse(projected.text);
    if (JSON.stringify(next) !== JSON.stringify(actual)) {
      // Only the title projection may have advanced this revision. Never merge
      // geometry over another device's move/resize, including on receipt retry.
      if (projected.revision !== input.revision + 1 || actual.title !== next.title) throw new HTTPException(409);
      if (!deps.hubStore.notebooks.save(owner, { ...projected, text: input.text })) throw new HTTPException(409);
    }
  }
  return archive ? deps.hubStore.notebooks.getArchive(owner, input.resourceId) : deps.hubStore.notebooks.get(owner, input.resourceId);
}
