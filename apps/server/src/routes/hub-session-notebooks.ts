import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { HubStore } from '../hub/hub-store.js';
import type { HubPrincipal } from '../hub/identity.js';
import { validNotebookInput } from '../hub/session-notebooks.js';
import { validNotebookMove, NotebookMoveConflict } from '../hub/notebook-operations.js';
import { readJsonBody } from '../utils/http-body.js';
import { sharedSessionAccess } from './hub-shared-access.js';
import { decodeHubSessionId } from '../hub/session-id.js';
import { sessionRef } from '../hub/session-ref.js';
import { DEFAULT_HUB_NOTEBOOK_LAYOUT, validHubNotebookLayout, NOTEBOOK_MAX_CHARS, NOTEBOOK_ARCHIVE_MAX_CHARS, NOTEBOOK_BODY_MAX_BYTES } from '@agentopsdeck/shared';
import { beginNativeEditorRequest, writeBoundNotebook, validateNativeEditorPorts, type AsyncNativeEditorDependencies, type NativeFileWriteDependencies } from './hub-native-file-write.js';
import { boundNotebookMove } from './hub-bound-notebook-move.js';
import { sessionNotebookWriteRoute } from './hub-session-notebook-scope.js';
import { validNotebookCapability, type NotebookAuthority } from '../hub/notebook-capabilities.js';
import { registerWorkspaceAgentNotebook, type NotebookMachinePort } from './workspace-agent-notebook.js';
import type { AsyncHubSessionNotebooks, SessionNotebookRequest } from '../hub/async-session-notebooks.js';
import type { SessionNativeFileProof } from '../hub/member-native-file-domain.js';
import type { HubSessionNotebookAuthority } from '../hub/member-session-notebook-authority.js';
import type { AsyncHubNotebookControl } from '../hub/async-notebook-control.js';
import { notebookControlUuid } from '../hub/member-notebook-control-domain.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { AuthRouteReadWait } from '../auth/route-read-wait.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { validNotebookSnapshot, NOTEBOOK_LAYOUT_PREFIX, DEFAULT_NOTEBOOK_LAYOUT_RESOURCE,
  type NotebookSnapshotRead, type NotebookSnapshot } from '../hub/notebook-snapshot-read.js';

type LegacyNotebookPorts = {
  privateNotebooks?: Pick<AsyncHubSessionNotebooks, 'savePrivate'> & Partial<Pick<AsyncHubSessionNotebooks, 'snapshotPrivate'>>;
  sessionNotebooks?: Pick<AsyncHubSessionNotebooks, 'saveSession'> & Partial<Pick<AsyncHubSessionNotebooks, 'snapshotSession' | 'withSession'>>;
  notebookControl?: Pick<AsyncHubNotebookControl, 'move' | 'receipt' | 'capabilities' | 'issue' | 'revoke'>;
};
type AsyncNotebookPorts = {
  privateNotebooks: Pick<AsyncHubSessionNotebooks, 'savePrivate' | 'snapshotPrivate'>;
  sessionNotebooks: Pick<AsyncHubSessionNotebooks, 'saveSession' | 'snapshotSession' | 'withSession'>;
  notebookControl: NonNullable<LegacyNotebookPorts['notebookControl']>;
  notebookMachine: NotebookMachinePort;
};
type NotebookDependencies = ((AsyncNativeEditorDependencies & AsyncNotebookPorts)
  | (NativeFileWriteDependencies & LegacyNotebookPorts & {mode?: 'legacy'; principal: (c: Context) => HubPrincipal}))
  & {readWait?: AuthRouteReadWait; diagnostics?: PerformanceDiagnostics};
export function registerHubSessionNotebookRoutes(app: Hono, deps: NotebookDependencies) {
  validateNativeEditorPorts(deps, [deps.privateNotebooks?.savePrivate, deps.privateNotebooks?.snapshotPrivate,
    deps.sessionNotebooks?.saveSession, deps.sessionNotebooks?.snapshotSession, deps.sessionNotebooks?.withSession,
    deps.notebookControl?.move, deps.notebookControl?.receipt, deps.notebookControl?.capabilities,
    deps.notebookControl?.issue, deps.notebookControl?.revoke,
    ...(deps.mode === 'async' ? [deps.notebookMachine?.authorized, deps.notebookMachine?.read, deps.notebookMachine?.move] : [])]);
  const legacy = () => { if (deps.mode === 'async') throw new HTTPException(503); return deps; };
  const diagnostics = deps.diagnostics ?? performanceDiagnostics;
  const reads = deps.readWait ?? new AuthRouteReadWait(new AuthRoutePersistence(diagnostics), diagnostics);
  const privateSave = async (c: Context, actor: HubPrincipal,
    document: { resourceId: string; revision: number; text: string }, area: 'hot' | 'cold' | 'layout', originalCheck?: () => Promise<void>) => {
    const userId = actor.userId, admin = actor.admin;
    if (deps.privateNotebooks) {
      let result;
      try { result = await deps.privateNotebooks.savePrivate(c.req.raw, actor.userId, document, area,
        c.req.header('x-agentopsdeck-notebook-format') === 'styled-markdown-v1'); }
      catch (error) {
        if (!(error instanceof HubMemberRequestError)) throw error;
        if (error.status === 499) return new Response(JSON.stringify({ error: 'request_cancelled' }), {
          status: 499, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
        throw new HTTPException(error.status, { message: error.status === 503
          ? 'Notebook temporarily unavailable' : 'Notebook access changed' });
      }
      if (originalCheck) await originalCheck();
      else {
        const current = legacy().principal(c);
        if (current.userId !== userId || current.admin !== admin) throw new HTTPException(401);
      }
      if (result.status === 'format') throw new HTTPException(409, {
        message: 'Refresh AgentOpsDeck before editing this formatted notebook',
      });
      return result.status === 'saved' ? c.json(result.document) : c.json({ error: 'Notebook changed in another tab' }, 409);
    }
    // Fixture-only composition without the production command port. A failed
    // admitted command must never reach this original synchronous path.
    const saved = area === 'cold' ? legacy().hubStore.notebooks.saveArchive(actor.userId, document)
      : legacy().hubStore.notebooks.save(actor.userId, document);
    return saved ? c.json(saved) : c.json({ error: 'Notebook changed in another tab' }, 409);
  };
  const snapshot = async (c: Context, actor: HubPrincipal, scope: Omit<NotebookSnapshotRead, 'owner'>, recheck?: () => void | Promise<void>): Promise<NotebookSnapshot | Response> => {
    c.header('Cache-Control', 'no-store');
    // Retain primitives, never a mutable principal supplied by middleware.
    const userId = actor.userId, admin = actor.admin, request = { owner: userId, ...scope };
    let value;
    try {
      value = (await reads.run(c.req.raw, 71, () => legacy().hubStore.notebookSnapshotAsync(request))).value;
      if (!validNotebookSnapshot(value, request)) throw Error('notebook_snapshot_read_unavailable');
    } catch {
      return c.req.raw.signal.aborted ? new Response(JSON.stringify({ error: 'request_cancelled' }), {
        status: 499, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      }) : c.json({ error: 'notebook_snapshot_read_unavailable' }, 503);
    }
    const changed = () => {
      const trace = guardedTrace(diagnostics, 'hub-notebook-snapshot-read'); trace.add('step', 3);
      trace.add('changed', 1); trace.add('settled', 1); trace.add('deferred', 1); trace.finish(true);
    };
    let current: HubPrincipal;
    try { current = legacy().principal(c); } catch { changed(); throw new HTTPException(401); }
    if (current.userId !== userId || current.admin !== admin) { changed(); throw new HTTPException(401); }
    try { await recheck?.(); } catch (error) { changed(); throw error; }
    return value;
  };
  const documentScope = (resourceId: string, archive = false): Omit<NotebookSnapshotRead, 'owner'> => ({
    mode: archive ? 'cold' : 'hot', resourceId, after: null, query: null, includeArchive: false,
  });
  // All private read/control routes switch as one composed package. Rejected
  // owner commands never call the legacy snapshot or synchronous principal.
  const asyncPrivate = !!(deps.privateNotebooks?.snapshotPrivate && deps.editorAccess && deps.notebookControl && deps.nativeFiles);
  const asyncSession = !!(deps.sessionNotebooks?.snapshotSession && deps.editorAccess && deps.notebookControl && deps.nativeFiles);
  const asyncSessionWrites = asyncSession && !!deps.sessionNotebooks?.withSession;
  const sessionRequests = new WeakMap<Context, SessionNotebookRequest>();
  const sessionSnapshot = async (c: Context, shared: boolean, mode: 'hot' | 'cold' | 'search', query: string | null = null, includeArchive = false) => {
    c.header('Cache-Control', 'no-store');
    const sessionId = c.req.param('sessionId')!, ownerUserId = shared ? c.req.param('ownerUserId')! : null;
    if (sessionId.length > 4096 || !decodeHubSessionId(sessionId)
      || ownerUserId !== null && (!ownerUserId || ownerUserId.length > 4096)) throw new HTTPException(404);
    try { return await deps.sessionNotebooks!.snapshotSession!(c.req.raw, {sessionId, ownerUserId, mode, query, includeArchive}); }
    catch (error) {
      if (!(error instanceof HubMemberRequestError)) throw error;
      if (error.status === 499) return new Response(JSON.stringify({error: 'request_cancelled'}), {
        status: 499, headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'},
      });
      throw new HTTPException(error.status, {message: error.status === 503
        ? 'Notebook temporarily unavailable' : error.status === 404 ? 'Session not found' : 'Notebook access changed'});
    }
  };
  const privateSnapshot = async (c: Context, scope: Omit<NotebookSnapshotRead, 'owner'>,
    selected?: {actor: HubPrincipal; read: () => void | Promise<void>}) => {
    if (!asyncPrivate) return snapshot(c, selected?.actor ?? legacy().principal(c), scope, selected?.read);
    const original: {actor: HubPrincipal; read: () => void | Promise<void>} = selected
      ?? await beginNativeEditorRequest(c, deps).then(v => ({actor: v.principal, read: v.check}));
    return control(c, original.actor, original.read,
      () => deps.privateNotebooks!.snapshotPrivate!(c.req.raw, original.actor.userId, scope), true);
  };
  registerWorkspaceAgentNotebook(app, deps.mode === 'async'
    ? {mode: 'async', notebookMachine: deps.notebookMachine, ...(deps.fileCardsEnabled !== undefined ? {fileCardsEnabled: deps.fileCardsEnabled} : {})} : deps);
  const control = async <T>(c: Context, actor: HubPrincipal, read: () => void | Promise<void>, work: () => Promise<T>, original = false): Promise<T | Response> => {
    const userId = actor.userId, admin = actor.admin;
    let value: T;
    try { value = await work(); }
    catch (error) {
      if (!(error instanceof HubMemberRequestError)) throw error;
      if (error.status === 499) return new Response(JSON.stringify({ error: 'request_cancelled' }), {
        status: 499, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
      throw new HTTPException(error.status, { message: error.status === 503
        ? 'Notebook temporarily unavailable' : 'Notebook access changed' });
    }
    await read();
    if (original) return value;
    const current = legacy().principal(c);
    if (current.userId !== userId || current.admin !== admin) throw new HTTPException(401);
    return value;
  };
  type OperationAccess = {actor: HubPrincipal; resourceId: string; read: () => void | Promise<void>;
    authority?: NotebookAuthority; notebookAuthority?: HubSessionNotebookAuthority; original: boolean;
    request: Request; nativeCardId?: string; nativeProof?: SessionNativeFileProof};
  const operations = (path: string, access: (c: Context) => { actor: HubPrincipal; resourceId: string; read: () => void;
    authority?: NotebookAuthority; notebookAuthority?: HubSessionNotebookAuthority }, grants = true,
    privateMove?: (c: Context) => {resourceId: string; nativeCardId: string}, sessionShared?: boolean) => {
    // Only a missing fixture port permits the original synchronous path.
    // Rejection/unknown write outcomes never fall back or replay a mutation.
    const port = deps.notebookControl;
    const operationAccess = async (c: Context): Promise<OperationAccess> => {
      const scope = sessionRequests.get(c);
      if (scope) return {actor: scope.principal, resourceId: scope.resourceId, read: scope.check,
        notebookAuthority: scope.authority, request: scope.request, original: true,
        ...(scope.authority.kind === 'owner' ? {nativeCardId: `session:${scope.authority.sessionId}`,
          nativeProof: {authority: scope.authority, resourceId: scope.resourceId}} : {})};
      if (privateMove && asyncPrivate) {
        const selected = privateMove(c), original = await beginNativeEditorRequest(c, deps);
        return {...selected, actor: original.principal, read: original.check, original: true, request: c.req.raw};
      }
      return {...access(c), original: false, request: c.req.raw};
    };
    // Existing move-only compositions keep their original migration boundary.
    const moveAccess = async (c: Context): Promise<OperationAccess> => {
      if (privateMove && !asyncPrivate && deps.nativeFiles && deps.editorAccess && port) {
        const selected = privateMove(c), original = await beginNativeEditorRequest(c, deps);
        return {...selected, actor: original.principal, read: original.check, original: true, request: c.req.raw};
      }
      return operationAccess(c);
    };
    if (grants) {
      app.get(`${path}/capabilities`, async c => {
        const { actor, resourceId, read, notebookAuthority, original, request } = await operationAccess(c); c.header('Cache-Control', 'no-store');
        const capabilities = port ? await control(c, actor, read, () => port.capabilities(request, actor.userId, resourceId, notebookAuthority), original)
          : legacy().hubStore.notebookCapabilities.list(actor.userId, resourceId);
        return capabilities instanceof Response ? capabilities : c.json({ capabilities });
      });
      app.post(`${path}/capabilities`, async c => {
        const selected = await operationAccess(c), { actor, resourceId, read, notebookAuthority, original, request } = selected;
        const authority = 'authority' in selected ? selected.authority : undefined;
        c.header('Cache-Control', 'no-store');
        const input = await readJsonBody(c.req.raw, 4096); await read();
        if (!validNotebookCapability(input)) return c.json({ error: 'Invalid notebook capability' }, 400);
        const result = port ? await control(c, actor, read, () => port.issue(request, actor.userId, resourceId, input, notebookAuthority), original)
          : legacy().hubStore.notebookCapabilities.issue(actor.userId, resourceId, input, authority ?? null);
        if (result instanceof Response) return result;
        return result ? c.json(result, 201) : c.json({ error: 'Notebook, expiry or quota unavailable' }, 409);
      });
      app.delete(`${path}/capabilities/:capabilityId`, async c => {
        const { actor, resourceId, read, notebookAuthority, original, request } = await operationAccess(c); c.header('Cache-Control', 'no-store');
        const id = c.req.param('capabilityId');
        if (port && !notebookControlUuid(id)) return c.json({ error: 'not found' }, 404);
        const revoked = port ? await control(c, actor, read, () => port.revoke(request, actor.userId, resourceId, id, notebookAuthority), original)
          : legacy().hubStore.notebookCapabilities.revoke(actor.userId, resourceId, id);
        if (revoked instanceof Response) return revoked;
        return revoked
          ? c.json({ revoked: true }) : c.json({ error: 'not found' }, 404);
      });
    }
    app.get(`${path}/search`, async c => {
      c.header('Cache-Control', 'no-store');
      const query = c.req.query('q') ?? '', cold = c.req.query('archive');
      if (asyncSession && sessionShared !== undefined) {
        if (!query.trim() || query.length > 200 || (cold !== undefined && cold !== '1')) return c.json({error: 'Invalid search'}, 400);
        const value = await sessionSnapshot(c, sessionShared, 'search', query, cold === '1');
        return value instanceof Response ? value : c.json(value.search);
      }
      const selected = await operationAccess(c), { actor, resourceId, read } = selected;
      if (!query.trim() || query.length > 200 || (cold !== undefined && cold !== '1')) return c.json({ error: 'Invalid search' }, 400);
      const scope = {mode: 'search' as const, resourceId, after: null, query, includeArchive: cold === '1'};
      const value = selected.original ? await privateSnapshot(c, scope, {actor, read}) : await snapshot(c, actor, scope, read);
      return value instanceof Response ? value : c.json(value.search);
    });
    app.get(`${path}/moves/:requestId`, async c => {
      c.header('Cache-Control', 'no-store');
      const { actor, resourceId, read, notebookAuthority, nativeCardId, nativeProof, original, request } = await moveAccess(c);
      const requestId = c.req.param('requestId')!;
      if (port && !notebookControlUuid(requestId)) return c.json({ error: 'Receipt not found' }, 404);
      try {
        const result = (original && notebookAuthority?.kind === 'shared' ? undefined
          : await boundNotebookMove(deps, actor.userId, resourceId, requestId, read, undefined, !!port, request, nativeCardId, nativeProof))
          ?? (port ? await control(c, actor, read, () => port.receipt(request, actor.userId, resourceId, requestId, notebookAuthority), original)
            : legacy().hubStore.notebooks.moveReceipt(actor.userId, resourceId, requestId));
        if (result instanceof Response) return result;
        await read();
        return result ? c.json(result) : c.json({ error: 'Receipt not found' }, 404);
      } catch (error) { if (error instanceof NotebookMoveConflict) return c.json({ error: error.message }, 409); throw error; }
    });
    app.post(`${path}/moves`, async c => {
      c.header('Cache-Control', 'no-store');
      const { actor, resourceId, read, notebookAuthority, nativeCardId, nativeProof, original, request } = await moveAccess(c), body = await readJsonBody(c.req.raw, 8192);
      await read();
      if (!validNotebookMove(body)) return c.json({ error: 'Invalid move' }, 400);
      try {
        const result = (original && notebookAuthority?.kind === 'shared' ? undefined
          : await boundNotebookMove(deps, actor.userId, resourceId, body.requestId, read, body, !!port, request, nativeCardId, nativeProof))
          ?? (port ? await control(c, actor, read, () => port.move(request, actor.userId, resourceId, body, notebookAuthority), original)
            : legacy().hubStore.notebooks.move(actor.userId, resourceId, body));
        if (result instanceof Response) return result;
        await read(); return c.json(result);
      }
      catch (error) { if (error instanceof NotebookMoveConflict) return c.json({ error: error.message }, 409); throw error; }
    });
  };
  const requireStyleSupport = (c: Context, userId: string, resourceId: string, text: string, archive = false) => {
    // A stale pre-rich-text tab must not silently flatten new inline formatting.
    // Layout documents do not contain note text and deliberately bypass this.
    const format = c.req.header('x-agentopsdeck-notebook-format');
    if (format === 'styled-markdown-v2') return;
    const current = archive ? legacy().hubStore.notebooks.getArchive(userId, resourceId) : legacy().hubStore.notebooks.get(userId, resourceId);
    if (format === 'styled-markdown-v1' && !/data-agentopsdeck-note\s*=\s*["']v2;/i.test(text + '\n' + current.text)) return;
    if (/data-agentopsdeck-note\s*=/.test(text) || /data-agentopsdeck-note\s*=/.test(current.text)) {
      throw new HTTPException(409, { message: 'Refresh AgentOpsDeck before editing this formatted notebook' });
    }
  };
  // One private notebook per authenticated user in this Hub database. The
  // tagged resource cannot collide with session resource tuples (four fields).
  const globalResource = JSON.stringify(['hub-notebook', 1]);
  const layoutPrefix = NOTEBOOK_LAYOUT_PREFIX;
  const defaultLayout = DEFAULT_NOTEBOOK_LAYOUT_RESOURCE;
  app.get('/api/hub/v1/notebooks', async c => {
    c.header('Cache-Control', 'no-store');
    const after = c.req.query('after') ?? '';
    if (after.length > 200 || after && !after.startsWith(layoutPrefix)) return c.json({ error: 'Invalid notebook cursor' }, 400);
    const value = await privateSnapshot(c, { mode: 'layouts', resourceId: null, after, query: null, includeArchive: false });
    if (value instanceof Response) return value;
    const rows = value.documents;
    const nextCursor = rows.length === 100 ? rows.at(-1)!.resourceId : null;
    const items = rows.filter(row => row.resourceId !== defaultLayout);
    if (!after) {
      const d = value.defaultDocument!;
      items.unshift(d.revision ? d : { ...d, text: JSON.stringify(DEFAULT_HUB_NOTEBOOK_LAYOUT) });
    }
    return c.json({ items, nextCursor });
  });
  for (const kind of ['text', 'layout', 'archive']) {
    const layout = kind === 'layout', archive = kind === 'archive';
    const path = `/api/hub/v1/notebooks/:notebookId${layout ? '/layout' : archive ? '/archive' : ''}`;
    const resource = (c: Context) => {
      c.header('Cache-Control', 'no-store');
      const id = c.req.param('notebookId');
      if (id !== 'default' && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id ?? '')) throw new HTTPException(404);
      return layout ? JSON.stringify(['hub-notebook-layout', 1, id]) : id === 'default' ? globalResource : JSON.stringify(['hub-notebook', 1, id]);
    };
    if (kind === 'text') operations(path, c => {
      const principal = legacy().principal(c), actor = { userId: principal.userId, admin: principal.admin }, resourceId = resource(c);
      return { actor, resourceId, read: () => {
        const current = legacy().principal(c);
        if (current.userId !== actor.userId || current.admin !== actor.admin) throw new HTTPException(401);
      } };
    }, true, c => ({resourceId: resource(c), nativeCardId: `hub:${c.req.param('notebookId')}`}));
    app.get(path, async c => {
      const resourceId = resource(c);
      const value = await privateSnapshot(c, documentScope(resourceId, archive));
      if (value instanceof Response) return value;
      const d = value.documents[0]!;
      return c.json(layout && !d.revision ? { ...d, text: JSON.stringify(DEFAULT_HUB_NOTEBOOK_LAYOUT) } : d);
    });
    app.put(path, async c => {
      const resourceId = resource(c), original = await beginNativeEditorRequest(c, deps), actor = original.principal;
      const body = await readJsonBody(c.req.raw, NOTEBOOK_BODY_MAX_BYTES);
      await original.check();
      if (!validNotebookInput(body, archive ? NOTEBOOK_ARCHIVE_MAX_CHARS : NOTEBOOK_MAX_CHARS)) return c.json({ error: 'Invalid notebook' }, 400);
      if (body.resourceId !== resourceId) return c.json({ error: 'Notebook resource changed' }, 409);
      if (layout) {
        let parsed: unknown; try { parsed = JSON.parse(body.text); } catch { /* invalid */ }
        if (!validHubNotebookLayout(parsed)) return c.json({ error: 'Invalid notebook layout' }, 400);
      }
      else if (!deps.nativeFiles) requireStyleSupport(c, actor.userId, resourceId, body.text, archive);
      if (archive) {
        const projected = await writeBoundNotebook(deps, actor.userId, `hub:${c.req.param('notebookId')}`, body, false, true,
          c.req.raw, c.req.header('x-agentopsdeck-notebook-format') === 'styled-markdown-v1');
        await original.check();
        if (projected) return c.json(projected);
        return privateSave(c, actor, body, 'cold', original.check);
      }
      const projected = await writeBoundNotebook(deps, actor.userId, `hub:${c.req.param('notebookId')}`, body, layout, false,
        c.req.raw, c.req.header('x-agentopsdeck-notebook-format') === 'styled-markdown-v1');
      await original.check();
      if (projected) return c.json(projected);
      return privateSave(c, actor, body, layout ? 'layout' : 'hot', original.check);
    });
  }
  app.get('/api/hub/v1/notebook', async c => {
    c.header('Cache-Control', 'no-store');
    const value = await privateSnapshot(c, documentScope(globalResource));
    return value instanceof Response ? value : c.json(value.documents[0]!);
  });
  app.put('/api/hub/v1/notebook', async c => {
    c.header('Cache-Control', 'no-store');
    const original = await beginNativeEditorRequest(c, deps), actor = original.principal;
    const body = await readJsonBody(c.req.raw, NOTEBOOK_BODY_MAX_BYTES);
    await original.check();
    if (!validNotebookInput(body)) return c.json({ error: 'Invalid notebook' }, 400);
    if (body.resourceId !== globalResource) return c.json({ error: 'Notebook resource changed' }, 409);
    if (!deps.nativeFiles) requireStyleSupport(c, actor.userId, globalResource, body.text);
    const projected = await writeBoundNotebook(deps, actor.userId, 'hub:default', body, false, false,
      c.req.raw, c.req.header('x-agentopsdeck-notebook-format') === 'styled-markdown-v1');
    await original.check();
    if (projected) return c.json(projected);
    return privateSave(c, actor, body, 'hot', original.check);
  });
  for (const shared of [false, true]) for (const archive of [false, true]) {
    const path = (shared ? '/api/hub/v1/shared/:ownerUserId/sessions/:sessionId/notebook' : '/api/hub/v1/sessions/:sessionId/notebook') + (archive ? '/archive' : '');
    if (!archive && asyncSessionWrites) {
      const scoped: Parameters<typeof app.use>[1] = async (c, next) => {
        if (sessionRequests.has(c) || !sessionNotebookWriteRoute(c.req.method, c.req.path)) return next();
        c.header('Cache-Control', 'no-store');
        const sessionId = c.req.param('sessionId')!, ownerUserId = shared ? c.req.param('ownerUserId')! : null;
        if (!sessionId || sessionId.length > 4096 || !decodeHubSessionId(sessionId)
          || ownerUserId !== null && (!ownerUserId || ownerUserId.length > 4096)) throw new HTTPException(404);
        try {
          return await deps.sessionNotebooks!.withSession!(c.req.raw, {sessionId, ownerUserId}, async scope => {
            sessionRequests.set(c, scope);
            try { await next(); return c.res; }
            finally { sessionRequests.delete(c); }
          });
        } catch (error) {
          if (!(error instanceof HubMemberRequestError)) throw error;
          if (error.status === 499) return new Response(JSON.stringify({error: 'request_cancelled'}), {
            status: 499, headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'},
          });
          throw new HTTPException(error.status, {message: error.status === 503
            ? 'Notebook temporarily unavailable' : error.status === 404 ? 'Session not found' : 'Notebook access changed'});
        }
      };
      app.use(path, scoped);
      app.use(`${path}/*`, scoped);
    }
    const access = (c: Context) => {
      c.header('Cache-Control', 'no-store');
      const principal = legacy().principal(c), actor = { userId: principal.userId, admin: principal.admin };
      if (shared) {
        const session = sharedSessionAccess(c, legacy());
        const { nodeId, runtimeId, nativeSessionKey } = session.ref;
        return { actor, read: session.read, notebookAuthority: { kind: 'shared', sessionId: session.target.sessionId,
          ownerUserId: session.target.ownerUserId, proof: session.readProof } satisfies HubSessionNotebookAuthority,
          resourceId: JSON.stringify([session.target.ownerUserId, nodeId, runtimeId, nativeSessionKey]) };
      }
      // Owner routes use the existing owner directory authority, not a synthetic
      // shared grant. This also supports Hermes without expanding sharing policy.
      const decoded = decodeHubSessionId(c.req.param('sessionId')!);
      if (!decoded || c.req.param('sessionId')!.length > 4096) throw new HTTPException(404);
      const store = legacy().hubStore, connection = store.getConnection(decoded.connectionId, actor.userId);
      let ref;
      try { ref = sessionRef(connection?.nodeId, decoded.remoteSessionKey); } catch { throw new HTTPException(404); }
      if (!connection || connection.status === 'disabled' || !ref) throw new HTTPException(404);
      const version = store.connectionAuthority(connection.id, actor.userId);
      if (version === undefined) throw new HTTPException(403);
      const read = () => {
        if (legacy().principal(c).userId !== actor.userId) throw new HTTPException(401);
        const current = store.getConnection(connection.id, actor.userId);
        if (!current || current.status === 'disabled' || current.nodeId !== ref.nodeId || store.connectionAuthority(connection.id, actor.userId) !== version) throw new HTTPException(403);
      };
      return { actor, read, authority: { connectionId: connection.id, version },
        notebookAuthority: { kind: 'owner', sessionId: c.req.param('sessionId')!, connectionVersion: version } satisfies HubSessionNotebookAuthority,
        resourceId: JSON.stringify([actor.userId, ref.nodeId, ref.runtimeId, ref.nativeSessionKey]) };
    };
    if (!archive) operations(path, access, !shared, undefined, shared);
    app.get(path, async c => {
      if (asyncSession) {
        const value = await sessionSnapshot(c, shared, archive ? 'cold' : 'hot');
        return value instanceof Response ? value : c.json(value.documents[0]!);
      }
      const { actor, resourceId, read } = access(c);
      const value = await snapshot(c, actor, documentScope(resourceId, archive), read);
      return value instanceof Response ? value : c.json(value.documents[0]!);
    });
    app.put(path, async c => {
      const scope = sessionRequests.get(c);
      const { actor, read, resourceId, notebookAuthority } = scope
        ? {actor: scope.principal, read: scope.check, resourceId: scope.resourceId, notebookAuthority: scope.authority}
        : access(c);
      const request = scope?.request ?? c.req.raw;
      const body = await readJsonBody(c.req.raw, NOTEBOOK_BODY_MAX_BYTES);
      await read(); // Revalidate original proof and identity after the body await.
      if (!validNotebookInput(body, archive ? NOTEBOOK_ARCHIVE_MAX_CHARS : NOTEBOOK_MAX_CHARS)) return c.json({ error: 'Invalid notebook' }, 400);
      if (body.resourceId !== resourceId) return c.json({ error: 'Notebook resource changed' }, 409);
      if (!scope) requireStyleSupport(c, actor.userId, resourceId, body.text, archive);
      const projected = !shared ? await writeBoundNotebook(deps, actor.userId, `session:${c.req.param('sessionId')}`, body, false, archive,
        request, c.req.header('x-agentopsdeck-notebook-format') === 'styled-markdown-v1',
        scope ? {authority: scope.authority, resourceId} : undefined) : undefined;
      await read();
      if (projected) return c.json(projected);
      const port = deps.sessionNotebooks;
      if (port) {
        const result = await control(c, actor, read, () => port.saveSession(request, actor.userId, body,
          archive ? 'cold' : 'hot', c.req.header('x-agentopsdeck-notebook-format') === 'styled-markdown-v1', notebookAuthority), !!scope);
        if (result instanceof Response) return result;
        if (result.status === 'denied') throw new HTTPException(403, { message: 'Notebook access changed' });
        if (result.status === 'format') throw new HTTPException(409, {
          message: 'Refresh AgentOpsDeck before editing this formatted notebook',
        });
        return result.status === 'saved' ? c.json(result.document) : c.json({ error: 'Notebook changed in another tab' }, 409);
      }
      // Fixture-only composition: errors from an admitted production command
      // never reach this original synchronous path or replay its write.
      const saved = archive ? legacy().hubStore.notebooks.saveArchive(actor.userId, body) : legacy().hubStore.notebooks.save(actor.userId, body);
      return saved ? c.json(saved) : c.json({ error: 'Notebook changed in another tab' }, 409);
    });
  }
}
