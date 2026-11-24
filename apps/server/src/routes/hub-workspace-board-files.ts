import type { AsyncHubFileBindingReads } from '../hub/async-file-binding-reads.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { BOARD_MAX_BODY_BYTES, validBoardId, validBoardUuid, validBoardWrite, type BoardContent } from '@agentopsdeck/shared';
import type { HubPrincipal } from '../hub/identity.js';
import type { WorkspaceBoardFiles } from '../hub/workspace-board-files.js';
import { publicFileBoardBinding } from '../hub/workspace-board-files.js';
import { HubFileBoardError, type HubFileBoardService, type HubWorkspaceFileService, type HubWorkspaceFileStore, type WorkspaceFileWrite } from '../hub/workspace-board-file-service.js';
import { ConnectorClientError } from '../hub/connector-client.js';
import { readJsonBody, requireEmptyBody } from '../utils/http-body.js';
import type { AsyncHubNativeFiles } from '../hub/async-native-files.js';
import type { NativeFileWrite } from '../hub/member-native-file-domain.js';

/** Mount only with a fully composed service. Principal always comes from Hub
 * authentication; request bodies cannot select owner, path, URL or authority. */
type AsyncWorkspaceFiles = { mode: 'async'; nativeFiles: Pick<AsyncHubNativeFiles, 'begin'>; enabled?: boolean };
type LegacyWorkspaceFiles<T> = {
  mode?: 'legacy';
  bindingReads?: Pick<AsyncHubFileBindingReads, 'read'>;
  nativeFiles?: Pick<AsyncHubNativeFiles, 'begin'>;
  principal: (c: Context) => HubPrincipal; files: HubWorkspaceFileStore<T>; service: HubWorkspaceFileService<T>; enabled?: boolean;
};

export function registerHubBoardFiles(app: Hono, deps: AsyncWorkspaceFiles | {
  mode?: 'legacy';
  principal: (c: Context) => HubPrincipal;
  bindingReads?: Pick<AsyncHubFileBindingReads, 'read'>;
  nativeFiles?: Pick<AsyncHubNativeFiles, 'begin'>;
  files: WorkspaceBoardFiles;
  service: HubFileBoardService;
  enabled?: boolean;
}) {
  return registerHubWorkspaceFiles<BoardContent>(app, deps, {
    base: '/api/hub/v1/workspace/boards/:boardId/file-binding', parameter: 'boardId',
    validResource: validBoardId, validWrite: validBoardWrite, maxBytes: BOARD_MAX_BODY_BYTES + 4096,
  });
}

export function registerHubWorkspaceFiles<T>(app: Hono, deps: (AsyncWorkspaceFiles | LegacyWorkspaceFiles<T>) & {
  bindingDomain?: 'board' | 'card';
}, protocol: {
  base: string; parameter: string; validResource(value: unknown): value is string;
  validWrite(value: unknown): value is WorkspaceFileWrite<T>; maxBytes: number;
}) {
  if (deps.mode === 'async' && (!deps.nativeFiles || typeof deps.nativeFiles.begin !== 'function'))
    throw Error('Hub native file dependencies unavailable');
  const base = protocol.base;
  const resource = async (c: Context) => {
    const board = c.req.param(protocol.parameter);
    if (!protocol.validResource(board) || c.req.url.includes('?')) throw new HTTPException(400);
    if (deps.nativeFiles) {
      const port = await deps.nativeFiles.begin(c.req.raw, {domain: deps.bindingDomain ?? 'board', resourceId: board});
      return {...port, board, valid: () => {},
        write: (id: string, input: WorkspaceFileWrite<T>) => port.write(id, {mode: 'ordinary', input: input as unknown as NativeFileWrite})};
    }
    // The async branch above returns its complete original operation port.
    // Never manufacture a legacy file store to satisfy registration types.
    if (deps.mode === 'async') throw Error('Hub native file dependencies unavailable');
    const source = deps;
    const actor = source.principal(c), owner = actor.userId, admin = actor.admin;
    return { board, valid: () => {
      const actor = source.principal(c);
      if (actor.userId !== owner || actor.admin !== admin) throw new HTTPException(401);
    },
      current: () => source.bindingReads ? source.bindingReads.read(c.req.raw, owner, {domain: source.bindingDomain ?? 'board', action: 'current', resourceId: board})
        : source.files.current(owner, board),
      get: (id: string) => source.bindingReads ? source.bindingReads.read(c.req.raw, owner, {domain: source.bindingDomain ?? 'board', action: 'get', resourceId: board, bindingId: id})
        : source.files.get(owner, id),
      writable: () => source.service.writable(owner, board),
      write: (id: string, input: WorkspaceFileWrite<T>) => source.service.write(owner, board, id, input),
      inspectWrite: (id: string, mutationId: string) => source.service.inspectWrite(owner, board, id, mutationId),
      bind: (input: {requestId: string; sessionId: string; revision: number}) => source.service.bind(owner, board, input),
      inspect: (id: string) => source.service.inspect(owner, board, id),
      cancel: (id: string) => source.service.cancel(owner, board, id),
      revoke: (id: string) => source.service.revoke(owner, board, id),
    };
  };
  const safe = (handler: (c: Context) => Promise<Response> | Response) => async (c: Context) => {
    c.header('Cache-Control', 'no-store');
    try { return await handler(c); }
    catch (error) {
      const status = error instanceof HTTPException ? error.status
        : error instanceof HubMemberRequestError ? error.status
        : error instanceof HubFileBoardError ? error.status
          : error instanceof ConnectorClientError && [400, 401, 403, 404, 409, 429, 503].includes(error.status)
            ? error.status as 400 | 401 | 403 | 404 | 409 | 429 | 503 : 503;
      const body = { error: 'File binding unavailable. Inspect the original operation; no message was sent.' };
      if (status === 499) return new Response(JSON.stringify(body), {
        status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
      return c.json(body, status);
    }
  };
  app.get(base, safe(async c => {
    const r = await resource(c);
    const current = await r.current(); r.valid();
    return c.json({ enabled: deps.enabled !== false, binding: current ? publicFileBoardBinding(current) : null });
  }));
  app.get(`${base}/capabilities`, safe(async c => {
    const r = await resource(c);
    const writable = deps.enabled !== false && await r.writable(); r.valid();
    return c.json({ writable });
  }));
  app.post(`${base}/:id/writes`, safe(async c => {
    if (deps.enabled === false) throw new HTTPException(503);
    const r = await resource(c), id = c.req.param('id')!;
    if (!validBoardUuid(id)) throw new HTTPException(400);
    const input = await readJsonBody(c.req.raw, protocol.maxBytes); r.valid();
    if (!protocol.validWrite(input)) throw new HTTPException(400);
    const receipt = await r.write(id, input); r.valid();
    return c.json({ receipt });
  }));
  app.get(`${base}/:id/writes/:mutationId`, safe(async c => {
    const r = await resource(c), id = c.req.param('id')!, mutationId = c.req.param('mutationId')!;
    if (!validBoardUuid(id) || !validBoardUuid(mutationId)) throw new HTTPException(400);
    const receipt = await r.inspectWrite(id, mutationId); r.valid();
    return c.json({ receipt });
  }));
  app.post(base, safe(async c => {
    if (deps.enabled === false) throw new HTTPException(503);
    const r = await resource(c), input = await readJsonBody(c.req.raw, 4096); r.valid();
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).sort().join(',') !== 'requestId,revision,sessionId'
      || !('requestId' in input) || !validBoardUuid(input.requestId)
      || !('sessionId' in input) || typeof input.sessionId !== 'string'
      || !('revision' in input) || typeof input.revision !== 'number') throw new HTTPException(400);
    const binding = await r.bind({ requestId: input.requestId, sessionId: input.sessionId, revision: input.revision });
    r.valid();
    return c.json({ binding: publicFileBoardBinding(binding) }, binding.state === 'prepared' ? 202 : 200);
  }));
  app.get(`${base}/:id`, safe(async c => {
    const r = await resource(c), id = c.req.param('id')!;
    if (!validBoardUuid(id)) throw new HTTPException(400);
    const binding = deps.enabled === false
      ? await r.get(id) : await r.inspect(id); r.valid();
    if (!binding || binding.resourceId !== r.board) throw new HTTPException(404);
    return c.json({ binding: publicFileBoardBinding(binding) });
  }));
  app.post(`${base}/:id/cancel`, safe(async c => {
    const r = await resource(c), id = c.req.param('id')!;
    if (!validBoardUuid(id)) throw new HTTPException(400);
    await requireEmptyBody(c.req.raw); r.valid();
    const result = await r.cancel(id); r.valid();
    return c.json({cancelled: result.cancelled, cleanup: result.cleanup});
  }));
  app.delete(`${base}/:id`, safe(async c => {
    const r = await resource(c), id = c.req.param('id')!;
    if (!validBoardUuid(id)) throw new HTTPException(400);
    await requireEmptyBody(c.req.raw); r.valid();
    const result = await r.revoke(id); r.valid();
    if (!result.binding) throw new HTTPException(404);
    return c.json({binding: publicFileBoardBinding(result.binding), cleanup: result.cleanup});
  }));
}
