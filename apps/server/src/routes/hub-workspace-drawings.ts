import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { DRAWING_MAX_BODY_BYTES, validDrawingId, validDrawingWrite } from '@agentopsdeck/shared';
import type { AsyncHubWorkspaceVisuals } from '../hub/async-workspace-visuals.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { readJsonBody } from '../utils/http-body.js';
import { beginNativeEditorRequest, writeBoundNativeCard, nativeEditorStore, validateNativeEditorPorts, type NativeEditorDependencies } from './hub-native-file-write.js';

export function registerHubWorkspaceDrawingRoutes(app: Hono, deps: NativeEditorDependencies<{
  visuals: Pick<AsyncHubWorkspaceVisuals, 'listDrawings' | 'getDrawing' | 'saveDrawing'>;
}>) {
  validateNativeEditorPorts(deps, [deps.visuals?.listDrawings, deps.visuals?.getDrawing, deps.visuals?.saveDrawing]);
  const base = '/api/hub/v1/workspace/drawings';
  const run = async (work: () => Promise<Response>) => {
    try { return await work(); }
    catch (error) {
      if (!(error instanceof HubMemberRequestError)) throw error;
      if (error.status === 499) return new Response(JSON.stringify({ error: 'request_cancelled' }), {
        status: 499, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
      throw new HTTPException(error.status, { message: error.status === 503
        ? 'Workspace drawing temporarily unavailable' : 'Workspace access changed' });
    }
  };
  const id = (c: Context) => { const value = c.req.param('drawingId'); if (!validDrawingId(value)) throw new HTTPException(404); return value; };
  app.get(base, c => run(async () => {
    const original = await beginNativeEditorRequest(c, deps), user = original.principal;
    const drawings = deps.visuals ? await deps.visuals.listDrawings(c.req.raw, user.userId) : nativeEditorStore(deps).drawings.list(user.userId);
    await original.check(); return c.json({ drawings });
  }));
  app.get(`${base}/:drawingId`, c => run(async () => {
    const original = await beginNativeEditorRequest(c, deps), user = original.principal, resource = id(c);
    const result = deps.visuals ? await deps.visuals.getDrawing(c.req.raw, user.userId, resource) : nativeEditorStore(deps).drawings.get(user.userId, resource);
    await original.check(); return c.json(result);
  }));
  app.put(`${base}/:drawingId`, c => run(async () => {
    const original = await beginNativeEditorRequest(c, deps), user = original.principal, resource = id(c);
    if (deps.editorAccess && !deps.visuals) throw new HTTPException(503);
    const input = await readJsonBody(c.req.raw, DRAWING_MAX_BODY_BYTES);
    await original.check();
    if (!validDrawingWrite(input)) return c.json({ error: 'Invalid drawing' }, 400);
    const { revision, mutationId, ...content } = input;
    const native = await writeBoundNativeCard(deps, user.userId, resource, { kind: 'drawing', content, revision, mutationId }, c.req.raw);
    await original.check();
    if (native) {
      const result = deps.visuals ? await deps.visuals.getDrawing(c.req.raw, user.userId, resource) : nativeEditorStore(deps).drawings.get(user.userId, resource);
      await original.check(); return c.json(result);
    }
    const result = deps.visuals ? await deps.visuals.saveDrawing(c.req.raw, user.userId, resource, input) : nativeEditorStore(deps).drawings.save(user.userId, resource, input);
    await original.check();
    return result.status === 'saved' ? c.json(result.document) : c.json({ error: result.status }, result.status === 'limit' ? 429 : 409);
  }));
}
