import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { BOARD_MAX_BODY_BYTES, validBoardId, validBoardUuid, validBoardWrite } from '@agentopsdeck/shared';
import type { HubPrincipal } from '../hub/identity.js';
import { readJsonBody } from '../utils/http-body.js';
import { validBoardCapabilityInput } from '../hub/workspace-board-capabilities.js';
import { beginNativeEditorRequest, writeBoundNativeCard, nativeEditorStore, validateNativeEditorPorts, type NativeEditorDependencies } from './hub-native-file-write.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthRouteReadWait } from '../auth/route-read-wait.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { validWorkspaceBoardResult, type WorkspaceBoardRead } from '../hub/workspace-board-snapshot-read.js';
import type { BoardDocument, BoardSummary } from '@agentopsdeck/shared';
import type { AsyncHubWorkspaceBoards } from '../hub/async-workspace-boards.js';
import type { AsyncHubWorkspaceBoardCapabilities } from '../hub/async-workspace-board-capabilities.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';

/** Only the complete async board package may own its original member proof.
 * Unknown suffixes and machine endpoints must retain the parent guard. */
export function isAsyncHubWorkspaceBoardRequest(method: string, path: string): boolean {
  if (method === 'GET' || method === 'HEAD') return path === '/api/hub/v1/workspace/boards'
    || /^\/api\/hub\/v1\/workspace\/boards\/[^/]+(?:\/(?:summary|capabilities|audit))?$/.test(path);
  if (method === 'PUT') return /^\/api\/hub\/v1\/workspace\/boards\/[^/]+$/.test(path);
  if (method === 'POST') return /^\/api\/hub\/v1\/workspace\/boards\/[^/]+\/capabilities$/.test(path);
  return method === 'DELETE' && /^\/api\/hub\/v1\/workspace\/boards\/[^/]+\/capabilities\/[^/]+$/.test(path);
}

export function registerHubWorkspaceBoardRoutes(app: Hono, deps: NativeEditorDependencies<{
  boards: Pick<AsyncHubWorkspaceBoards, 'save' | 'get' | 'snapshot' | 'list' | 'summary'>;
  capabilities: Pick<AsyncHubWorkspaceBoardCapabilities, 'list' | 'issue' | 'revoke' | 'events'>;
}> & {readWait?: AuthRouteReadWait; diagnostics?: PerformanceDiagnostics}) {
  validateNativeEditorPorts(deps, [deps.boards?.save, deps.boards?.get, deps.boards?.snapshot,
    deps.boards?.list, deps.boards?.summary, deps.capabilities?.list, deps.capabilities?.issue,
    deps.capabilities?.revoke, deps.capabilities?.events]);
  const diagnostics = deps.diagnostics ?? performanceDiagnostics;
  const reads = deps.readWait ?? new AuthRouteReadWait(new AuthRoutePersistence(diagnostics), diagnostics);
  const run = async (work: () => Promise<Response>) => {
    try { return await work(); }
    catch (error) {
      if (!(error instanceof HubMemberRequestError)) throw error;
      if (error.status === 499) return new Response(JSON.stringify({ error: 'request_cancelled' }), {
        status: 499, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
      throw new HTTPException(error.status, { message: error.status === 503
        ? 'Workspace board temporarily unavailable' : 'Workspace access changed' });
    }
  };
  const changed = () => {
    const trace = guardedTrace(diagnostics, 'hub-workspace-board-read'); trace.add('step', 3);
    trace.add('changed', 1); trace.add('settled', 1); trace.add('deferred', 1); trace.finish(true);
  };
  const snapshot = async (c: Context, mode: WorkspaceBoardRead['mode'], id: string | null) => {
    c.header('Cache-Control', 'no-store');
    if (deps.mode === 'async') return run(async () => {
      const original = await beginNativeEditorRequest(c, deps), actor = original.principal;
      if (mode === 'document') {
        const value = await deps.boards.snapshot(c.req.raw, actor.userId, id!);
        await original.check();
        return c.json({...value.document, ...(value.binding ? {fileBinding: value.binding} : {})});
      }
      const value = mode === 'list' ? await deps.boards.list(c.req.raw, actor.userId)
        : await deps.boards.summary(c.req.raw, actor.userId, id!);
      await original.check();
      return mode === 'list' ? c.json({boards: value}) : c.json(value);
    });
    const principal = deps.principal(c), actor = { userId: principal.userId, admin: principal.admin };
    // Native projection and binding are still owned by the original writer.
    // Do not combine an old board snapshot with a newly changed binding.
    const binding = mode === 'document' ? deps.hubStore.boardFiles.current(actor.userId, id!) : undefined;
    const bindingVersion = JSON.stringify(binding);
    const request: WorkspaceBoardRead = { owner: actor.userId, mode, resourceId: id };
    let value;
    try {
      value = (await reads.run(c.req.raw, 65, () => deps.hubStore.workspaceBoardAsync(request))).value;
      if (!validWorkspaceBoardResult(value, request)) throw Error('workspace_board_read_unavailable');
    }
    catch {
      if (c.req.raw.signal.aborted) return new Response(JSON.stringify({ error: 'request_cancelled' }), {
        status: 499,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
      return c.json({ error: 'workspace_board_read_unavailable' }, 503);
    }
    let current: HubPrincipal;
    try { current = deps.principal(c); }
    catch { changed(); throw new HTTPException(401); }
    if (current.userId !== actor.userId || current.admin !== actor.admin) {
      changed();
      throw new HTTPException(401);
    }
    if (mode === 'document' && bindingVersion !== JSON.stringify(deps.hubStore.boardFiles.current(actor.userId, id!))) {
      changed();
      return c.json({ error: 'workspace_board_read_unavailable' }, 503);
    }
    return mode === 'list' ? c.json({ boards: value as BoardSummary[] })
      : mode === 'summary' ? c.json(value as BoardSummary)
      : c.json({ ...value as BoardDocument, ...(binding ? { fileBinding: publicFileBoardBinding(binding) } : {}) });
  };
  const resource = (c: Context) => {
    c.header('Cache-Control', 'no-store');
    const id = c.req.param('boardId');
    if (!validBoardId(id)) throw new HTTPException(404);
    return id;
  };
  app.get('/api/hub/v1/workspace/boards', c => snapshot(c, 'list', null));
  app.get('/api/hub/v1/workspace/boards/:boardId/summary', c => snapshot(c, 'summary', resource(c)));
  app.get('/api/hub/v1/workspace/boards/:boardId/capabilities', c => run(async () => {
    const id = resource(c), original = await beginNativeEditorRequest(c, deps), actor = original.principal;
    const capabilities = deps.capabilities ? await deps.capabilities.list(c.req.raw, actor.userId, id)
      : nativeEditorStore(deps).boardCapabilities.list(actor.userId, id);
    await original.check();
    return c.json({ capabilities });
  }));
  app.post('/api/hub/v1/workspace/boards/:boardId/capabilities', c => run(async () => {
    const id = resource(c), original = await beginNativeEditorRequest(c, deps), actor = original.principal;
    const input = await readJsonBody(c.req.raw, 16 * 1024);
    await original.check();
    if (!validBoardCapabilityInput(input)) return c.json({ error: 'Invalid board capability' }, 400);
    const issued = deps.capabilities ? await deps.capabilities.issue(c.req.raw, actor.userId, id, input)
      : nativeEditorStore(deps).boardCapabilities.issue(actor.userId, id, input);
    await original.check();
    return issued ? c.json(issued, 201) : c.json({ error: 'Board tasks, expiry or capability quota not available' }, 409);
  }));
  app.delete('/api/hub/v1/workspace/boards/:boardId/capabilities/:capabilityId', c => run(async () => {
    const id = resource(c), original = await beginNativeEditorRequest(c, deps), actor = original.principal;
    if (!validBoardUuid(c.req.param('capabilityId'))) return c.json({ error: 'not found' }, 404);
    const revoked = deps.capabilities ? await deps.capabilities.revoke(c.req.raw, actor.userId, id, c.req.param('capabilityId'))
      : nativeEditorStore(deps).boardCapabilities.revoke(actor.userId, id, c.req.param('capabilityId'));
    await original.check();
    return revoked
      ? c.json({ revoked: true }) : c.json({ error: 'not found' }, 404);
  }));
  app.get('/api/hub/v1/workspace/boards/:boardId/audit', c => run(async () => {
    const id = resource(c), original = await beginNativeEditorRequest(c, deps), actor = original.principal,
      before = Number(c.req.query('before') ?? Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(before) || before < 1) return c.json({ error: 'Invalid audit cursor' }, 400);
    const events = deps.capabilities ? await deps.capabilities.events(c.req.raw, actor.userId, id, before)
      : nativeEditorStore(deps).boardCapabilities.events(actor.userId, id, before);
    await original.check();
    return c.json({ events });
  }));
  app.get('/api/hub/v1/workspace/boards/:boardId', c => snapshot(c, 'document', resource(c)));
  app.put('/api/hub/v1/workspace/boards/:boardId', c => run(async () => {
    const id = resource(c), original = await beginNativeEditorRequest(c, deps), actor = original.principal;
    if (deps.editorAccess && !deps.boards) throw new HTTPException(503);
    const input = await readJsonBody(c.req.raw, BOARD_MAX_BODY_BYTES);
    await original.check();
    if (!validBoardWrite(input)) return c.json({ error: 'Invalid task board' }, 400);
    const { revision, mutationId, ...content } = input;
    if (await writeBoundNativeCard(deps, actor.userId, id, { kind: 'taskboard', content, revision, mutationId }, c.req.raw)) {
      await original.check();
      // Native coordinator remains authoritative; this only awaits reading
      // its committed projection, never retries the native write.
      const document = deps.boards ? await deps.boards.get(c.req.raw, actor.userId, id)
        : nativeEditorStore(deps).boards.get(actor.userId, id);
      await original.check();
      return c.json(document);
    }
    await original.check();
    const result = deps.boards ? await deps.boards.save(c.req.raw, actor.userId, id, input)
      : nativeEditorStore(deps).boards.save(actor.userId, id, input);
    await original.check();
    return result.status === 'saved' ? c.json(result.document)
      : c.json({ error: result.status }, result.status === 'limit' ? 429 : 409);
  }));
}
import { publicFileBoardBinding } from '../hub/workspace-board-files.js';
