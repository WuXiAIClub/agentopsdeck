import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { WorkspacePreferences } from '@agentopsdeck/shared';
import { AuthRoutePersistence, type Awaitable } from '../auth/route-persistence.js';
import type { HubPrincipal } from '../hub/identity.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { workspacePreferencesSchema } from '../hub/workspace-preferences.js';
import { readJsonBody } from '../utils/http-body.js';
import { AuthRouteReadWait } from '../auth/route-read-wait.js';
import { HubRequestWork } from '../hub/async-request-work.js';

export type HubWorkspacePreferencesPort = {
  get(request: Request, userId: string): Awaitable<WorkspacePreferences>;
  save(request: Request, userId: string, document: WorkspacePreferences): Awaitable<WorkspacePreferences | undefined>;
};
/** Awaited port, not permission caching or runtime activation. The same
 * 2.3.7 JSON, 8MiB request limit, no-store header and 409 reload contract remain.
 * An async owner must additionally check SQL authority and CAS atomically. */
export function registerHubWorkspacePreferences(app: Hono, deps: {
  port: HubWorkspacePreferencesPort; principal(c: Context): Awaitable<HubPrincipal>;
  /** Required by the default synchronous facade: keep its original live
   * request check in the SAME task as storage access. An async port must still
   * prove SQL scope and CAS inside its owner; this callback cannot replace it. */
  synchronousStoreAuthority?(c: Context): HubPrincipal;
  readWait?: AuthRouteReadWait;
}) {
  const base = '/api/hub/v1/workspace/preferences';
  const work = new HubRequestWork();
  const ownedReads = deps.readWait ? undefined : new AuthRoutePersistence();
  const reads = deps.readWait ?? new AuthRouteReadWait(ownedReads!);
  const recheck = (c: Context, actor: HubPrincipal) => {
    work.check();
    if (!deps.synchronousStoreAuthority) return;
    const current = deps.synchronousStoreAuthority(c);
    if (!current || current.userId !== actor.userId || current.admin !== actor.admin)
      throw new HTTPException(401, { message: 'Workspace access changed' });
  };
  const run = async <T>(operation: () => Awaitable<T>) => {
    try { return await work.run(operation); }
    catch (error) {
      if (error instanceof HubMemberRequestError) {
        // 499 is deliberately not in Hono's standard status union. Retain the
        // owner cancellation classification without converting it into a 500.
        if (error.status === 499) return new Response(JSON.stringify({ error: 'request_cancelled' }), {
          status: 499, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
        throw new HTTPException(error.status, {
          message: error.status === 503 ? 'Workspace preferences temporarily unavailable' : 'Workspace access changed',
        });
      }
      throw error;
    }
  };
  app.get(base, c => run(async () => {
    c.header('Cache-Control', 'no-store');
    const actor = await deps.principal(c);
    recheck(c, actor);
    let document: WorkspacePreferences;
    try {
      const result = (await reads.run(c.req.raw, 20, async () => {
        try { return { document: await deps.port.get(c.req.raw, actor.userId) }; }
        catch (error) {
          // The shared persistence guard intentionally sanitizes thrown owner
          // errors. Preserve only our trusted domain classification as a boxed
          // read outcome; arbitrary exceptions still pass through that guard.
          if (error instanceof HubMemberRequestError) return { refusal: error };
          throw error;
        }
      })).value;
      if ('refusal' in result) throw result.refusal;
      document = result.document;
    }
    catch (error) {
      if (error instanceof HubMemberRequestError) throw error;
      // The original readonly owner retains pending SQL after response abort.
      // No empty preferences, write replay or browser draft replacement.
      throw new HubMemberRequestError(c.req.raw.signal.aborted ? 499 : 503);
    }
    recheck(c, actor);
    return c.json(document);
  }));
  app.put(base, c => run(async () => {
    c.header('Cache-Control', 'no-store');
    const before = await deps.principal(c); recheck(c, before);
    const body = workspacePreferencesSchema.safeParse(await readJsonBody(c.req.raw, 8 * 1024 * 1024));
    if (!body.success) return c.json({ error: 'Invalid workspace preferences' }, 400);
    // Recheck after consuming the body, exactly as the original HTTP path.
    const actor = await deps.principal(c);
    if (actor.userId !== before.userId || actor.admin !== before.admin) throw new HubMemberRequestError(401);
    recheck(c, actor);
    const saved = await deps.port.save(c.req.raw, actor.userId, body.data);
    // A delivery refusal does not undo or replay an already admitted CAS.
    recheck(c, actor);
    return saved ? c.json(saved) : c.json({ error: 'Workspace changed in another tab. Reload before editing.' }, 409);
  }));
  let closing: Promise<void> | undefined;
  return { close: () => closing ??= work.close().then(() => ownedReads?.close()) };
}
