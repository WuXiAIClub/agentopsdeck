import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { validBoardUuid, validCardWrite } from '@agentopsdeck/shared';
import type { AsyncHubWorkspaceVisuals } from '../hub/async-workspace-visuals.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { readJsonBody } from '../utils/http-body.js';
import { beginNativeEditorRequest, writeBoundNativeCard, nativeEditorStore, validateNativeEditorPorts, type NativeEditorDependencies } from './hub-native-file-write.js';

export function registerHubWorkspaceCards(app: Hono, deps: NativeEditorDependencies<{
  visuals: Pick<AsyncHubWorkspaceVisuals, 'listCards' | 'getCard' | 'saveCard'>;
}>) {
  validateNativeEditorPorts(deps, [deps.visuals?.listCards, deps.visuals?.getCard, deps.visuals?.saveCard]);
  const base = '/api/hub/v1/workspace/cards';
  const run = async (work: () => Promise<Response>) => {
    try { return await work(); }
    catch (error) {
      if (!(error instanceof HubMemberRequestError)) throw error;
      if (error.status === 499) return new Response(JSON.stringify({ error: 'request_cancelled' }), {
        status: 499, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
      throw new HTTPException(error.status, { message: error.status === 503
        ? 'Workspace card temporarily unavailable' : 'Workspace access changed' });
    }
  };
  const id = (c: Context) => { const value = c.req.param('cardId'); if (!validBoardUuid(value)) throw new HTTPException(404); return value; };
  app.get(base, c => run(async () => {
    const original = await beginNativeEditorRequest(c, deps), user = original.principal;
    const cards = deps.visuals ? await deps.visuals.listCards(c.req.raw, user.userId) : nativeEditorStore(deps).cards.list(user.userId);
    await original.check(); return c.json({ cards });
  }));
  app.get(`${base}/:cardId`, c => run(async () => {
    const original = await beginNativeEditorRequest(c, deps), user = original.principal, resource = id(c);
    const result = deps.visuals ? await deps.visuals.getCard(c.req.raw, user.userId, resource) : nativeEditorStore(deps).cards.get(user.userId, resource);
    await original.check(); if (!result) throw new HTTPException(404); return c.json(result);
  }));
  app.put(`${base}/:cardId`, c => run(async () => {
    const original = await beginNativeEditorRequest(c, deps), user = original.principal, resource = id(c);
    if (deps.editorAccess && !deps.visuals) throw new HTTPException(503);
    const value = await readJsonBody(c.req.raw, 32768);
    await original.check();
    if (!validCardWrite(value)) throw new HTTPException(400);
    const { revision, mutationId, ...content } = value;
    // Native-file admission remains first. An async failure is never a reason
    // to bypass this coordinator or call the local synchronous save again.
    const native = await writeBoundNativeCard(deps, user.userId, resource, { kind: 'metric-card', content, revision, mutationId }, c.req.raw);
    await original.check();
    if (native) {
      const result = deps.visuals ? await deps.visuals.getCard(c.req.raw, user.userId, resource) : nativeEditorStore(deps).cards.get(user.userId, resource);
      await original.check(); return c.json(result);
    }
    const result = deps.visuals ? await deps.visuals.saveCard(c.req.raw, user.userId, resource, value) : nativeEditorStore(deps).cards.save(user.userId, resource, value);
    await original.check();
    return result.status === 'saved' ? c.json(result.document) : c.json({ error: result.status }, result.status === 'limit' ? 429 : 409);
  }));
}
