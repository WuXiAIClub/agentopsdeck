import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { HubPrincipal } from '../hub/identity.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { validLayoutWrite, type LayoutDocument, type LayoutKind } from '../hub/workspace-layouts.js';
import { readJsonBody } from '../utils/http-body.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { AuthRouteReadWait } from '../auth/route-read-wait.js';
import { HubRequestWork } from '../hub/async-request-work.js';
type Awaitable<T> = T | Promise<T>;
export interface HubWorkspaceLayoutsPort {
  get(request: Request, userId: string, kind: LayoutKind): Awaitable<LayoutDocument>;
  save(request: Request, userId: string, kind: LayoutKind, value: LayoutDocument): Awaitable<LayoutDocument | undefined>;
}
export function registerHubWorkspaceLayouts(app: Hono, deps: {
  port: HubWorkspaceLayoutsPort; principal(c: Context): Awaitable<HubPrincipal>;
  synchronousStoreAuthority?(c: Context): HubPrincipal;
  readWait?: AuthRouteReadWait;
}) {
  const base = '/api/hub/v1/workspace/layouts/:kind';
  const work = new HubRequestWork();
  const ownedReads = deps.readWait ? undefined : new AuthRoutePersistence();
  const reads = deps.readWait ?? new AuthRouteReadWait(ownedReads!);
  const recheck = (c: Context, actor: HubPrincipal) => {
    work.check();
    if (!deps.synchronousStoreAuthority) return;
    const current = deps.synchronousStoreAuthority(c);
    if (!current || current.userId !== actor.userId || current.admin !== actor.admin) throw new HTTPException(401, { message: 'Workspace access changed' });
  };
  const run = async <T>(operation: () => Awaitable<T>) => {
    try { return await work.run(operation); }
    catch (error) {
      if (!(error instanceof HubMemberRequestError)) throw error;
      if (error.status === 499) return new Response(JSON.stringify({ error: 'request_cancelled' }), {
        status: 499, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
      throw new HTTPException(error.status, { message: error.status === 503 ? 'Workspace layouts temporarily unavailable' : 'Workspace access changed' });
    }
  };
  app.get(base, c => run(async () => {
    c.header('Cache-Control', 'no-store');
    const actor = await deps.principal(c); recheck(c, actor);
    const kind = c.req.param('kind');
    if (kind !== 'current' && kind !== 'saved') return c.json({ error: 'Unknown layout collection' }, 404);
    let document: LayoutDocument;
    try {
      const result = (await reads.run(c.req.raw, 20, async () => {
        try { return { document: await deps.port.get(c.req.raw, actor.userId, kind) }; }
        catch (error) {
          // Box only trusted refusal codes; arbitrary errors remain sanitized.
          if (error instanceof HubMemberRequestError) return { refusal: error };
          throw error;
        }
      })).value;
      if ('refusal' in result) throw result.refusal;
      document = result.document;
    } catch (error) {
      if (error instanceof HubMemberRequestError) throw error;
      // Response cancellation never releases SQL or replays a saved layout.
      throw new HubMemberRequestError(c.req.raw.signal.aborted ? 499 : 503);
    }
    recheck(c, actor);
    return c.json(document);
  }));
  app.put(base, c => run(async () => {
    c.header('Cache-Control', 'no-store');
    const before = await deps.principal(c); recheck(c, before);
    const kind = c.req.param('kind');
    if (kind !== 'current' && kind !== 'saved') return c.json({ error: 'Unknown layout collection' }, 404);
    const value: unknown = await readJsonBody(c.req.raw, kind === 'current' ? 256 * 1024 : 2 * 1024 * 1024);
    if (!validLayoutWrite(value, kind)) return c.json({ error: 'Invalid layout' }, 400);
    const actor = await deps.principal(c); recheck(c, actor);
    if (actor.userId !== before.userId || actor.admin !== before.admin) throw new HubMemberRequestError(401);
    const saved = await deps.port.save(c.req.raw, actor.userId, kind, value); recheck(c, actor);
    return saved ? c.json(saved) : c.json({ error: 'Layout changed on another device' }, 409);
  }));
  let closing: Promise<void> | undefined;
  return { close: () => closing ??= work.close().then(() => ownedReads?.close()) };
}
