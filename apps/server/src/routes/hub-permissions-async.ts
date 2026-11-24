import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { HubAdministrativeServices } from '../hub/administrative-route-services.js';
import { HubMemberRequestError, type AsyncHubMemberRequests } from '../hub/async-member-request.js';
import { HubRequestWork } from '../hub/async-request-work.js';
import { copyOriginalRequest, pinOriginalRequestScope } from '../hub/original-request-scope.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { hasBoardCapabilityCredential } from './workspace-agent.js';
import { registerHubRoleAccessRoutes } from './hub-role-access.js';
import { registerHubNodeGrantRoutes } from './hub-node-grants.js';
import { registerHubSessionSharingRoutes } from './hub-session-sharing.js';
import { registerHubOwnedSessionSharingRoutes } from './hub-owned-session-sharing.js';

/** Exact external HTTP selection. No wildcard auth bypass or internal actor conversion. */
export function isAsyncHubPermissionRequest(method: string, path: string): boolean {
  const read = method === 'GET' || method === 'HEAD';
  if (read && (path === '/api/hub/v1/access/directory' || path === '/api/hub/v1/shared/grants')) return true;
  if ((read || method === 'PUT') && (/^\/api\/hub\/v1\/access\/users\/[^/]+\/hub-role$/.test(path)
    || /^\/api\/hub\/v1\/access\/[^/]+\/connections\/[^/]+\/members\/[^/]+$/.test(path))) return true;
  const collection = /^(?:\/api\/hub\/v1\/connections\/[^/]+\/grants|\/api\/hub\/v1\/shared\/[^/]+\/sessions\/[^/]+\/collaborators|\/api\/hub\/v1\/sessions\/[^/]+\/collaborators)(\/[^/]+)?$/.exec(path);
  return !!collection && (collection[1] ? method === 'PUT' || method === 'DELETE' : read || method === 'POST');
}

type PermissionPorts = Pick<HubAdministrativeServices, 'roles' | 'memberships' | 'directory' | 'grants'
  | 'received' | 'collaborators' | 'sharing' | 'ownedSharing'>;

/** One complete permission-management boundary. The SQL owner remains owned
 * by startup; each accepted HTTP body and original command ACK drains here. */
export function registerAsyncHubPermissions(app: Hono, deps: {
  mode: 'async'; access: Pick<AsyncHubMemberRequests, 'begin' | 'close'>;
  services: PermissionPorts; diagnostics?: PerformanceDiagnostics;
}) {
  const ports = deps.services;
  const required = { roles: ['authorize', 'read', 'set'], memberships: ['authorize', 'read', 'set'],
    directory: ['read'], grants: ['begin'], received: ['received'], collaborators: ['collaborators'],
    sharing: ['begin'], ownedSharing: ['begin'] } as const;
  if (deps.mode !== 'async' || typeof deps.access?.begin !== 'function' || typeof deps.access.close !== 'function') throw Error('hub_permission_ports_required');
  for (const key of Object.keys(required) as (keyof PermissionPorts)[]) {
    const port = ports?.[key];
    if (!port || typeof port.close !== 'function'
      || required[key].some(method => typeof (port as unknown as Record<string, unknown>)[method] !== 'function')) throw Error('hub_permission_ports_required');
  }
  const routes = new Hono(), work = new HubRequestWork(), diagnostics = deps.diagnostics ?? performanceDiagnostics;
  routes.use('*', async (c, next) => {
    if (!isAsyncHubPermissionRequest(c.req.method, c.req.path)) return next();
    c.header('Cache-Control', 'no-store');
    if (hasBoardCapabilityCredential(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
    const trace = guardedTrace(diagnostics, 'hub-permission-http'); let failed = true;
    const warning = setTimeout(() => trace.reportPending({ pending: work.pending }), 30_000); warning.unref();
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
      c.res = c.json({ error: status === 401 ? 'Unauthorized' : status === 409
        ? 'Authenticated account or Hub changed; reload before continuing' : 'Permissions unavailable; reload the saved state before retrying' }, status === 499 ? 503 : status);
    } finally { clearTimeout(warning); trace.finish(failed); }
  });
  registerHubRoleAccessRoutes(routes, { mode: 'async', asyncRoles: ports.roles,
    asyncMemberships: ports.memberships, asyncDirectory: ports.directory });
  registerHubNodeGrantRoutes(routes, { mode: 'async', asyncGrants: ports.grants, asyncReceived: ports.received });
  registerHubSessionSharingRoutes(routes, { mode: 'async', asyncCollaborators: ports.collaborators, asyncSharing: ports.sharing });
  registerHubOwnedSessionSharingRoutes(routes, { mode: 'async', asyncOwnedSharing: ports.ownedSharing });
  app.route('/', routes);
  const close = createIndependentDrain([() => work.close(), () => deps.access.close(),
    ...Object.keys(required).map(key => () => ports[key as keyof PermissionPorts].close())], 'hub-route-drain', diagnostics);
  return { close, get pending() { return work.pending; } };
}
