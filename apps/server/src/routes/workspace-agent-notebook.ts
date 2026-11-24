import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createHash } from 'node:crypto';
import type { NotebookFacet } from '../hub/notebook-capabilities.js';
import { validNotebookMove, NotebookMoveConflict } from '../hub/notebook-operations.js';
import { readJsonBody } from '../utils/http-body.js';
import { boundNotebookMove } from './hub-bound-notebook-move.js';
import type { NativeFileWriteDependencies } from './hub-native-file-write.js';
import { fileOperation } from './hub-native-file-write.js';
import type { AsyncWorkspaceNotebookMachine } from '../hub/async-workspace-notebook-machine.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';

const path = '/api/workspace-agent/v1/notebook';
/** Exact machine routes. No card text, cookie or capability can pick a different
 * owner/resource. All asynchronous paths recheck the ORIGINAL capability. */
function registerLimits(app: Hono, authorized: (request: Request, token: string) => boolean | Promise<boolean>) {
  const buckets = new Map<string, { until: number; count: number; active: number }>();
  let active = 0;
  app.use(`${path}/*`, async (c, next) => {
    c.header('Cache-Control', 'no-store'); c.header('Referrer-Policy', 'no-referrer');
    const token = /^Bearer (aod_note_[A-Za-z0-9_-]{43})$/.exec(c.req.header('authorization') ?? '')?.[1];
    if (!token || !await fileOperation(async () => authorized(c.req.raw, token))) return c.json({ error: 'unauthorized' }, 401);
    const now = Date.now(), key = createHash('sha256').update(token).digest('hex');
    for (const [id, value] of buckets) if (now >= value.until && !value.active) buckets.delete(id);
    let bucket = buckets.get(key);
    if (!bucket && buckets.size < 1024) { bucket = { until: now + 60_000, count: 0, active: 0 }; buckets.set(key, bucket); }
    if (!bucket || bucket.count >= 120 || bucket.active >= 2 || active >= 16) { c.header('Retry-After', '60'); return c.json({ error: 'request limit' }, 429); }
    bucket.count++; bucket.active++; active++;
    try { await next(); } finally { bucket.active--; active--; }
  });
}
export type NotebookMachinePort = Pick<AsyncWorkspaceNotebookMachine, 'authorized' | 'read' | 'move'>;
export function registerWorkspaceAgentNotebook(app: Hono, deps: NativeFileWriteDependencies | {
  mode: 'async'; notebookMachine: NotebookMachinePort; fileCardsEnabled?: boolean;
}) {
  if ('mode' in deps && deps.mode === 'async') {
    const port = deps.notebookMachine;
    if ([port?.authorized, port?.read, port?.move].some(method => typeof method !== 'function')) throw Error('Hub notebook machine dependencies unavailable');
    registerLimits(app, (request, token) => port.authorized(request, token));
    const token = (authorization: string | undefined) => {
      const value = /^Bearer (aod_note_[A-Za-z0-9_-]{43})$/.exec(authorization ?? '')?.[1];
      if (!value) throw new HTTPException(403); return value;
    };
    app.get(path, async c => {
      const result = await fileOperation(() => port.read(c.req.raw, token(c.req.header('authorization')), [...new URL(c.req.url).searchParams]));
      return c.json(result.body, result.status);
    });
    const move = async (request: Request, bearer: string, requestId: string, input?: Parameters<NotebookMachinePort['move']>[3]) => {
      try { return await port.move(request, bearer, requestId, input, deps.fileCardsEnabled !== false); }
      catch (error) {
        if (error instanceof HubMemberRequestError && error.status === 409) throw new NotebookMoveConflict('move_conflict');
        return fileOperation(async () => { throw error; });
      }
    };
    app.post(`${path}/moves`, async c => {
      const bearer = token(c.req.header('authorization'));
      if (!await fileOperation(() => port.authorized(c.req.raw, bearer, ['hot:read', 'cold:read', 'move']))) throw new HTTPException(403);
      const body = await readJsonBody(c.req.raw, 8192).then(value => ({value}), error => ({error}));
      // Body parsing is a wait boundary, even for a malformed payload.
      if (!await fileOperation(() => port.authorized(c.req.raw, bearer, ['hot:read', 'cold:read', 'move']))) throw new HTTPException(403);
      if ('error' in body) throw body.error;
      const input = body.value;
      if (!validNotebookMove(input)) return c.json({error: 'Invalid move'}, 400);
      try { return c.json(await move(c.req.raw, bearer, input.requestId, input)); }
      catch (error) { if (error instanceof NotebookMoveConflict) return c.json({error: 'move_conflict'}, 409); throw error; }
    });
    app.get(`${path}/moves/:requestId`, async c => {
      const bearer = token(c.req.header('authorization')), id = c.req.param('requestId');
      if (!await fileOperation(() => port.authorized(c.req.raw, bearer, ['hot:read', 'cold:read', 'move']))) throw new HTTPException(403);
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) return c.json({error: 'Invalid request'}, 400);
      try { const result = await move(c.req.raw, bearer, id); return result ? c.json(result) : c.json({error: 'not found'}, 404); }
      catch (error) { if (error instanceof NotebookMoveConflict) return c.json({error: 'move_conflict'}, 409); throw error; }
    });
    return;
  }
  if (!('hubStore' in deps)) throw Error('Hub notebook legacy dependencies unavailable');
  const caps = deps.hubStore.notebookCapabilities, notes = deps.hubStore.notebooks;
  registerLimits(app, (_request, token) => !!caps.authorized(token));
  const access = (authorization: string | undefined, facets: NotebookFacet[]) => {
    const token = /^Bearer (aod_note_[A-Za-z0-9_-]{43})$/.exec(authorization ?? '')?.[1];
    const grant = token && caps.authorized(token, facets);
    if (!grant) throw new HTTPException(403);
    const read = () => { if (!caps.authorized(token!, facets)) throw new HTTPException(403); };
    return { grant, read };
  };
  app.get(path, c => {
    const params = new URL(c.req.url).searchParams;
    if ([...params.keys()].some(k => !['area', 'q', 'start', 'limit', 'revision'].includes(k))
      || [...params.keys()].some(k => params.getAll(k).length !== 1)) return c.json({ error: 'Invalid read' }, 400);
    const area = params.get('area') ?? 'hot';
    if (!['hot', 'cold', 'both'].includes(area)) return c.json({ error: 'Invalid area' }, 400);
    const facets: NotebookFacet[] = area === 'both' ? ['hot:read', 'cold:read'] : [area === 'cold' ? 'cold:read' : 'hot:read'];
    const { grant } = access(c.req.header('authorization'), facets);
    if (params.has('q')) {
      const query = params.get('q')!;
      if (!query.trim() || query.length > 200 || ['start', 'limit', 'revision'].some(k => params.has(k))) return c.json({ error: 'Invalid search' }, 400);
      // Cold-only must never invoke the hot search. Both areas are independently
      // capped so abundant hot matches cannot starve the archive facet.
      return c.json(notes.searchAreas(grant.owner, grant.resourceId, query, area as 'hot' | 'cold' | 'both'));
    }
    if (area === 'both') return c.json({ error: 'Select one area for a slice' }, 400);
    const start = Number(params.get('start') ?? 0), limit = Number(params.get('limit') ?? 2000);
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 4000) return c.json({ error: 'Invalid range' }, 400);
    const doc = area === 'cold' ? notes.getArchive(grant.owner, grant.resourceId) : notes.get(grant.owner, grant.resourceId);
    if (params.has('revision') && (!/^(0|[1-9][0-9]*)$/.test(params.get('revision')!) || Number(params.get('revision')) !== doc.revision)) return c.json({ error: 'revision_changed' }, 409);
    if (start > doc.text.length) return c.json({ error: 'Invalid range' }, 400);
    const text = doc.text.slice(start, start + limit);
    return c.json({ resourceId: grant.resourceId, area, revision: doc.revision, start, end: start + text.length, total: doc.text.length, text });
  });
  app.post(`${path}/moves`, async c => {
    const { grant, read } = access(c.req.header('authorization'), ['hot:read', 'cold:read', 'move']);
    const input = await readJsonBody(c.req.raw, 8192); read();
    if (!validNotebookMove(input)) return c.json({ error: 'Invalid move' }, 400);
    try {
      const result = await boundNotebookMove(deps, grant.owner, grant.resourceId, input.requestId, read, input)
        ?? notes.move(grant.owner, grant.resourceId, input);
      read(); return c.json(result);
    } catch (error) { if (error instanceof NotebookMoveConflict) return c.json({ error: 'move_conflict' }, 409); throw error; }
  });
  app.get(`${path}/moves/:requestId`, async c => {
    const { grant, read } = access(c.req.header('authorization'), ['hot:read', 'cold:read', 'move']);
    const id = c.req.param('requestId');
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) return c.json({ error: 'Invalid request' }, 400);
    try {
      const result = await boundNotebookMove(deps, grant.owner, grant.resourceId, id, read) ?? notes.moveReceipt(grant.owner, grant.resourceId, id);
      read(); return result ? c.json(result) : c.json({ error: 'not found' }, 404);
    } catch (error) { if (error instanceof NotebookMoveConflict) return c.json({ error: 'move_conflict' }, 409); throw error; }
  });
}
