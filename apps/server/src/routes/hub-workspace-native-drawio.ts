import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { NATIVE_DRAWIO_MAX_BODY_BYTES, nativeDrawioEditorUrl, validDrawingId, validNativeDrawioWrite } from '@agentopsdeck/shared';
import type { AsyncHubWorkspaceVisuals } from '../hub/async-workspace-visuals.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { readJsonBody } from '../utils/http-body.js';
import { beginNativeEditorRequest, writeBoundNativeCard, nativeEditorStore, validateNativeEditorPorts, type NativeEditorDependencies } from './hub-native-file-write.js';

export function registerHubNativeDrawioRoutes(app: Hono, deps: NativeEditorDependencies<{
  visuals: Pick<AsyncHubWorkspaceVisuals, 'listNativeDrawio' | 'getNativeDrawio' | 'saveNativeDrawio'>;
}> & {editorUrl?: string | undefined}) {
  validateNativeEditorPorts(deps, [deps.visuals?.listNativeDrawio, deps.visuals?.getNativeDrawio, deps.visuals?.saveNativeDrawio]);
  const base = '/api/hub/v1/workspace/native-drawio';
  const run = async (work: () => Promise<Response>) => {
    try { return await work(); }
    catch (error) {
      if (!(error instanceof HubMemberRequestError)) throw error;
      if (error.status === 499) return new Response(JSON.stringify({ error: 'request_cancelled' }), {
        status: 499, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
      throw new HTTPException(error.status, { message: error.status === 503
        ? 'Native drawing temporarily unavailable' : 'Workspace access changed' });
    }
  };
  const resource = (c: Context) => {
    c.header('Cache-Control', 'no-store');
    const id = c.req.param('drawingId');
    if (!validDrawingId(id)) throw new HTTPException(404);
    return id;
  };
  app.get(`${base}/config`, c => run(async () => {
    const original = await beginNativeEditorRequest(c, deps); await original.check();
    return c.json({ editorUrl: nativeDrawioEditorUrl(deps.editorUrl) ?? null });
  }));
  app.get(base, c => run(async () => {
    const original = await beginNativeEditorRequest(c, deps), user = original.principal;
    const drawings = deps.visuals ? await deps.visuals.listNativeDrawio(c.req.raw, user.userId) : nativeEditorStore(deps).nativeDrawio.list(user.userId);
    await original.check(); return c.json({ drawings });
  }));
  app.get(`${base}/:drawingId`, c => run(async () => {
    const original = await beginNativeEditorRequest(c, deps), user = original.principal, id = resource(c);
    const result = deps.visuals ? await deps.visuals.getNativeDrawio(c.req.raw, user.userId, id) : nativeEditorStore(deps).nativeDrawio.get(user.userId, id);
    await original.check(); return c.json(result);
  }));
  app.put(`${base}/:drawingId`, c => run(async () => {
    const original = await beginNativeEditorRequest(c, deps), user = original.principal, id = resource(c);
    if (deps.editorAccess && !deps.visuals) throw new HTTPException(503);
    const input = await readJsonBody(c.req.raw, NATIVE_DRAWIO_MAX_BODY_BYTES);
    await original.check();
    if (!validNativeDrawioWrite(input)) return c.json({ error: 'Invalid native drawing' }, 400);
    const { revision, mutationId, ...content } = input;
    const native = await writeBoundNativeCard(deps, user.userId, id, { kind: 'native-drawio', content, revision, mutationId }, c.req.raw);
    await original.check();
    if (native) {
      const result = deps.visuals ? await deps.visuals.getNativeDrawio(c.req.raw, user.userId, id) : nativeEditorStore(deps).nativeDrawio.get(user.userId, id);
      await original.check(); return c.json(result);
    }
    const result = deps.visuals ? await deps.visuals.saveNativeDrawio(c.req.raw, user.userId, id, input) : nativeEditorStore(deps).nativeDrawio.save(user.userId, id, input);
    await original.check();
    return result.status === 'saved' ? c.json(result.document) : c.json({ error: result.status }, result.status === 'limit' ? 429 : 409);
  }));
}
