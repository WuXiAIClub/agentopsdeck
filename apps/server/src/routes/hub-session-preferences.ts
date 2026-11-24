import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { HubPrincipal } from '../hub/identity.js';
import type { HubSessionPreferenceChange } from '../hub/member-session-preference-domain.js';
import { decodeHubSessionId, encodeHubSessionId } from '../hub/session-id.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';
type Awaitable<T> = T | Promise<T>;
export interface HubSessionPreferencesPort {
  set(request: Request, userId: string, change: HubSessionPreferenceChange): Awaitable<void>;
}
export function registerHubSessionPreferences(app: Hono, deps: {
  port: HubSessionPreferencesPort; principal(c: Context): Awaitable<HubPrincipal>;
  synchronousStoreAuthority?(c: Context): HubPrincipal;
}) {
  const recheck = (c: Context, actor: HubPrincipal) => {
    const current = deps.synchronousStoreAuthority?.(c);
    if (deps.synchronousStoreAuthority && (!current || current.userId !== actor.userId || current.admin !== actor.admin)) throw new HTTPException(401);
  };
  for (const [path, field] of [['visibility', 'hidden'], ['archive', 'archived'], ['pin', 'pinned']] as const) {
    app.patch('/api/sessions/:hubSessionId/' + path, async (c, next) => {
      const sessionKey = c.req.param('hubSessionId')!;
      const decoded = decodeHubSessionId(sessionKey);
      if (!decoded || encodeHubSessionId(decoded.connectionId, decoded.remoteSessionKey) !== sessionKey) return next();
      c.header('Cache-Control', 'no-store');
      try {
        const actor = await deps.principal(c);
        const body = await c.req.json().catch(() => ({})) as Record<string, unknown> | null;
        // Preserve original false-only opt-out, including missing/malformed JSON.
        const value = body?.[field] !== false;
        recheck(c, actor);
        const trace = performanceDiagnostics.start('auth-route-persistence');
        trace.add('step', 29);
        const warning = setTimeout(() => trace.reportPending({ pending: 1, step: 29 }), 30_000);
        warning.unref();
        let failed = true, dispatched = false;
        try {
          recheck(c, actor); // Observation must not open a stale permission gap.
          dispatched = true;
          await deps.port.set(c.req.raw, actor.userId, { sessionKey, field, value });
          trace.add('settled', 1); failed = false;
        } catch (error) { trace.add(dispatched ? 'unknown' : 'deferred', 1); throw error; }
        finally { clearTimeout(warning); trace.finish(failed); }
        recheck(c, actor);
        const current = await deps.principal(c);
        if (!current || current.userId !== actor.userId || current.admin !== actor.admin) throw new HTTPException(401);
        recheck(c, actor);
        return c.json({ ok: true, sessionKey, [field]: value, updatedAt: Date.now() });
      } catch (error) {
        if (!(error instanceof HubMemberRequestError)) throw error;
        if (error.status === 499) return new Response(JSON.stringify({ error: 'request_cancelled' }), {
          status: 499, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
        throw new HTTPException(error.status, { message: 'Session preference temporarily unavailable' });
      }
    });
  }
}
