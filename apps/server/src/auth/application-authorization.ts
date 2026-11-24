import type { Hono } from 'hono';
import type { HubPrincipal } from '../hub/identity.js';
import { copyHubPrincipal } from '../hub/request-authority.js';
import { hasBoardCapabilityCredential, isWorkspaceAgentRequest } from '../routes/workspace-agent.js';
import type { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { fingerprintRequest } from './security.js';
import { AuthPersistenceError } from './private-store.js';
import { AuthRoutePersistence, type AuthRouteAuditStore, type Awaitable } from './route-persistence.js';
import { AuthReadCancelledError, AuthRouteReadWait } from './route-read-wait.js';
import type { RequestAuthorization } from './awaited-request-authorization.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';

/** Production HTTP observations, never permission callbacks for an SQL
 * transaction. Its original domain must STILL check current authority inside
 * the mutation. Awaited reads cannot be used as cached grants or worker RPC
 * callbacks. The application retains its original owners until root migration.
 */
export function registerApplicationAuthorization(app: Hono, deps: {
  hasHub: boolean;
  principal: (request: Request) => Awaitable<HubPrincipal | undefined>;
  authorize: RequestAuthorization;
  recordActivity: (request: Request) => Awaitable<void>;
  audit: AuthRouteAuditStore;
  signedStream: (request: Request) => boolean;
  allowedBrowserOrigin: (origin: string, request: Request) => boolean;
  diagnostics?: PerformanceDiagnostics;
  readWaitMs?: number;
}) {
  const persistence = new AuthRoutePersistence(deps.diagnostics);
  const reads = new AuthRouteReadWait(persistence, deps.diagnostics, deps.readWaitMs);
  const principal = async (request: Request) => {
    const { value } = await reads.run(request, 6, () => deps.principal(request));
    if (value === undefined) return undefined;
    const proof = copyHubPrincipal(value);
    if (!proof) throw new AuthPersistenceError();
    return proof;
  };
  app.use('/api/*', async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const origin = c.req.header('origin');
      if ((origin && !deps.allowedBrowserOrigin(origin, c.req.raw))
        || (!origin && c.req.header('sec-fetch-site') === 'cross-site')) return c.json({ error: 'untrusted request origin' }, 403);
    }
    // Capability endpoints retain origin/drain protection and their own
    // original machine authority. Never reinterpret them as Hub membership.
    if (deps.hasHub && isWorkspaceAgentRequest(c.req.raw)) return next();
    if (hasBoardCapabilityCredential(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
    try {
      const actor = await principal(c.req.raw);
      const path = c.req.path;
      if (actor && !actor.admin) {
        const hubSession = ['PATCH', 'DELETE'].includes(c.req.method)
          && /^\/api\/sessions\/[^/]+(?:\/(?:visibility|archive|pin))?$/.test(path);
        const publicAuth = ['/api/auth/status', '/api/auth/login', '/api/auth/logout'].includes(path);
        if (!path.startsWith('/api/hub/v1/') && !hubSession && !publicAuth && path !== '/api/health') return c.json({ error: 'forbidden' }, 403);
      }
      if (actor && c.req.method !== 'OPTIONS' && path !== '/api/health' && !path.startsWith('/api/connector/v1/')) {
        // A write ACK is never subject to an HTTP read deadline. Abort cannot
        // release its budget, replay it or let the request reach the handler.
        const activity = await persistence.run(30, async () => {
          try { await deps.recordActivity(c.req.raw); return { cancelled: false }; }
          catch (error) {
            // The domain only emits 499 for a cancelled read, before dispatch
            // or after the ORIGINAL write has settled successfully. Preserve
            // that known outcome across the persistence boundary. An aborted
            // request with a lost write ACK must still be unknown/503.
            if (error instanceof HubMemberRequestError && error.status === 499) return { cancelled: true };
            throw error;
          }
        });
        if (activity.value.cancelled) throw new AuthReadCancelledError();
        const current = await principal(c.req.raw);
        if (!current || current.userId !== actor.userId || current.admin !== actor.admin) return c.json({ error: 'unauthorized' }, 401);
      }
      if (c.req.method === 'OPTIONS' || path === '/api/health' || path.startsWith('/api/auth/') || path.startsWith('/api/connector/v1/')) return next();
      // Hub's original principal already embodies its administrator/member
      // decision. Do not run a second, differently scoped grant or treat an
      // unresolved Promise as true. Standalone authority remains independent.
      const allowed = deps.hasHub ? actor !== undefined
        : (await reads.run(c.req.raw, 6, () => deps.authorize(c.req.raw))).value === true;
      if (allowed || deps.signedStream(c.req.raw) === true) return next();
      await persistence.run(14, () => deps.audit.append({
        event: 'api_authz', outcome: 'failure', ...fingerprintRequest(c.req.raw), reason: 'missing_or_invalid_access_key',
      }));
      if (c.req.raw.signal.aborted) throw new AuthReadCancelledError();
      return c.json({ error: 'unauthorized' }, 401);
    } catch (error) {
      if (error instanceof AuthReadCancelledError)
        return c.json({ error: 'request_cancelled' }, 408);
      // A failed lookup is not a confirmed bad key. No fallback capability,
      // false auth-failure audit or framework log of a private SQL exception.
      return c.json({ error: 'auth_persistence_failed' }, 503);
    }
  });
  return { get pending() { return persistence.pending; }, close: () => persistence.close() };
}
