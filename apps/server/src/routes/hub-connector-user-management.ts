import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { HubMemberRequestError, type AsyncHubMemberRequests } from '../hub/async-member-request.js';
import type { AsyncConnectorClientResolver } from '../hub/async-connector-client.js';
import { HubRequestWork } from '../hub/async-request-work.js';
import { HubRequestBodies } from '../hub/request-body-work.js';
import { copyOriginalRequest, pinOriginalRequestScope } from '../hub/original-request-scope.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { hasBoardCapabilityCredential } from './workspace-agent.js';
import { registerHubConnectorUserDisplay } from './hub-connector-users.js';
import { proxyHubConnectorUserMutation } from './hub-connector-user-mutation.js';

export function isHubConnectorUserManagementRequest(method: string, path: string): boolean {
  return ['GET', 'HEAD'].includes(method) && path === '/api/hub/v1/connector-users'
    || method === 'POST' && /^\/api\/hub\/v1\/connections\/[^/]+\/connector-users$/.test(path)
    || method === 'PATCH' && /^\/api\/hub\/v1\/connections\/[^/]+\/connector-users\/[^/]+$/.test(path);
}

/** One async-only business package. The private identity lane survives until
 * uploads, original resolvers, remote mutations and delivery checks drain. */
export function registerHubConnectorUserManagement(app: Hono, deps: {
  mode: 'async'; access: Pick<AsyncHubMemberRequests, 'begin' | 'close'>;
  asyncConnectorClient: AsyncConnectorClientResolver;
  presentDirectory: Parameters<typeof registerHubConnectorUserDisplay>[1]['present'];
  presentMutation: Parameters<typeof proxyHubConnectorUserMutation>[1]['present'];
  readError: Parameters<typeof proxyHubConnectorUserMutation>[1]['readError'];
  diagnostics?: PerformanceDiagnostics;
  responseLimits?: { requestBytes: number; retainedBytes: number };
}) {
  if (deps.mode !== 'async' || typeof deps.access?.begin !== 'function' || typeof deps.access.close !== 'function'
    || typeof deps.asyncConnectorClient !== 'function' || typeof deps.presentDirectory !== 'function'
    || typeof deps.presentMutation !== 'function' || typeof deps.readError !== 'function')
    throw Error('hub_connector_user_management_ports_required');
  const routes = new Hono(), work = new HubRequestWork(), bodies = new HubRequestBodies();
  routes.use('*', async (c, next) => {
    if (!isHubConnectorUserManagementRequest(c.req.method, c.req.path)) return next();
    c.header('Cache-Control', 'no-store');
    if (hasBoardCapabilityCredential(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
    const trace = guardedTrace(deps.diagnostics ?? performanceDiagnostics, 'hub-connector-user-http');
    const warning = setTimeout(() => trace.reportPending({ pending: work.pending }), 30_000); warning.unref?.();
    let failed = true;
    try {
      await work.run(async () => {
        const original = copyOriginalRequest(c.req.raw), authority = await deps.access.begin(original);
        work.check();
        const scope = original.headers.get('x-agentopsdeck-recovery-scope');
        if (scope !== null && scope !== authority.recoveryScope) throw new HubMemberRequestError(409);
        pinOriginalRequestScope(c.req.raw, authority.recoveryScope);
        try { await next(); }
        finally { work.check(); await authority.check(); work.check(); }
      });
      failed = c.res.status >= 500;
    } catch (error) {
      const status = error instanceof HubMemberRequestError || error instanceof HTTPException ? error.status : 503;
      c.res = c.json({ error: status === 401 ? 'unauthorized' : status === 409
        ? 'Authenticated account or Hub changed; reload before continuing' : 'hub_connector_users_unavailable' }, status === 499 ? 503 : status);
    } finally { clearTimeout(warning); trace.finish(failed); }
  });
  const display = registerHubConnectorUserDisplay(routes, { mode: 'async', access: deps.access,
    asyncConnectorClient: deps.asyncConnectorClient, present: deps.presentDirectory,
    ...(deps.diagnostics ? { diagnostics: deps.diagnostics } : {}),
    ...(deps.responseLimits ? { responseLimits: deps.responseLimits } : {}) });
  const mutation = { mode: 'async' as const, access: deps.access, asyncConnectorClient: deps.asyncConnectorClient,
    check: () => work.check(),
    present: deps.presentMutation, readError: deps.readError,
    ...(deps.diagnostics ? { diagnostics: deps.diagnostics } : {}),
    readBody: (request: Request, maxBytes: number) => bodies.read(request, maxBytes) };
  routes.post('/api/hub/v1/connections/:connectionId/connector-users', c => proxyHubConnectorUserMutation(c, mutation, 'POST'));
  routes.patch('/api/hub/v1/connections/:connectionId/connector-users/:userId', c => proxyHubConnectorUserMutation(c, mutation, 'PATCH', c.req.param('userId')));
  app.route('/', routes);
  let closing: Promise<void> | undefined;
  return { close: () => {
    if (closing) return closing;
    // Start every freeze/cancel synchronously; then await all original ACKs.
    closing = Promise.allSettled([work.close(), display.close(), bodies.close()]).then(async results => {
      await deps.access.close();
      if (results.some(result => result.status === 'rejected')) throw new HubMemberRequestError(503);
    });
    return closing;
  }, get pending() { return work.pending; } };
}
