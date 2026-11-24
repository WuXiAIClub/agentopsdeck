import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { HubMemberRequestError, type AsyncHubMemberRequests } from '../hub/async-member-request.js';
import type { AsyncHubIssuerManagementPort } from '../hub/async-issuer-management.js';
import type { AsyncHubMaintenancePort } from '../hub/async-maintenance-commands.js';
import type { AsyncHubLifecyclePort } from '../hub/async-lifecycle-commands.js';
import { HubRequestWork } from '../hub/async-request-work.js';
import { copyOriginalRequest, pinOriginalRequestScope } from '../hub/original-request-scope.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { hasBoardCapabilityCredential } from './workspace-agent.js';
import { registerHubExecutionIssuerRoutes } from './hub-execution-issuers.js';
import { registerHubMaintenanceRoutes } from '../hub/maintenance-http.js';
import { registerHubLifecycleRoutes } from '../hub/lifecycle-http.js';

/** Exact external HTTP selection, never a wildcard identity bypass. */
export function isAsyncHubGovernanceRequest(method: string, path: string): boolean {
  const read = method === 'GET' || method === 'HEAD';
  const base = '^/api/hub/v1/connections/[^/]+';
  if (new RegExp(`${base}/execution-issuer$`).test(path)) return read || method === 'PUT' || method === 'DELETE';
  if (new RegExp(`${base}/execution-issuer/local$`).test(path)) return method === 'POST';
  if (new RegExp(`${base}/lifecycle/status$`).test(path)) return read;
  const command = new RegExp(`${base}/(?:update/commands/(?:apply|rollback)|maintenance/commands/(?:pause|resume)|lifecycle/commands/(?:restart|upgrade))(/[^/]+)?$`).exec(path);
  return !!command && (command[1] ? read : method === 'POST');
}

export type HubGovernanceServices = {
  issuerManagement: AsyncHubIssuerManagementPort;
  maintenance: AsyncHubMaintenancePort;
  lifecycle: AsyncHubLifecyclePort;
};

/** Owns complete HTTP/body and original SQL/effect ACKs, never the SQL owner. */
export function registerAsyncHubGovernance(app: Hono, deps: {
  mode: 'async'; access: Pick<AsyncHubMemberRequests, 'begin' | 'close'>;
  services: HubGovernanceServices; diagnostics?: PerformanceDiagnostics;
}) {
  const ports = deps.services;
  if (deps.mode !== 'async' || typeof deps.access?.begin !== 'function' || typeof deps.access.close !== 'function'
    || !ports || [ports.issuerManagement, ports.maintenance, ports.lifecycle].some(port =>
      !port || typeof port.open !== 'function' || typeof port.close !== 'function')) throw Error('hub_governance_ports_required');
  const routes = new Hono(), work = new HubRequestWork(), diagnostics = deps.diagnostics ?? performanceDiagnostics;
  routes.use('*', async (c, next) => {
    if (!isAsyncHubGovernanceRequest(c.req.method, c.req.path)) return next();
    c.header('Cache-Control', 'no-store');
    if (hasBoardCapabilityCredential(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
    const trace = guardedTrace(diagnostics, 'hub-governance-http'); let failed = true;
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
        ? 'Authenticated account or Hub changed; reload before continuing'
        : 'Connector management unavailable; recover the original command before retrying' }, status === 499 ? 503 : status);
    } finally { clearTimeout(warning); trace.finish(failed); }
  });
  registerHubExecutionIssuerRoutes(routes, { mode: 'async', asyncManagement: ports.issuerManagement });
  registerHubMaintenanceRoutes(routes, { mode: 'async', asyncMaintenance: ports.maintenance });
  registerHubLifecycleRoutes(routes, { mode: 'async', asyncLifecycle: ports.lifecycle });
  app.route('/', routes);
  const close = createIndependentDrain([() => work.close(), () => deps.access.close(),
    () => ports.issuerManagement.close(), () => ports.maintenance.close(), () => ports.lifecycle.close()], 'hub-route-drain', diagnostics);
  return { close, get pending() { return work.pending; } };
}
