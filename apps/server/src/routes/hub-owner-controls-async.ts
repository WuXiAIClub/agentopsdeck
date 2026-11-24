import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AsyncHubOwnerControls } from '../hub/async-owner-control.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { HubRequestWork } from '../hub/async-request-work.js';
import { decodeHubSessionId } from '../hub/session-id.js';
import { registerHubMessageRoutes } from '../hub/message-http.js';
import { registerHubQueueRoutes } from '../hub/queue-http.js';
import { registerHubCreationRoutes } from '../hub/creation-http.js';
import { registerHubDeletionRoutes } from '../hub/deletion-http.js';
import { registerHubSettingsRoutes } from '../hub/settings-http.js';
import { registerHubCompactRoutes } from '../hub/compact-http.js';
import { hasBoardCapabilityCredential } from './workspace-agent.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

/** Exact ownership selection, not a wildcard authentication bypass. Native
 * aliases and unrelated Hub routes continue through their original guards. */
export function isAsyncHubOwnerControlRequest(method: string, path: string): boolean {
  const read = method === 'GET' || method === 'HEAD';
  if ((method === 'PATCH' || method === 'DELETE') && /^\/api\/sessions\/[^/]+$/.test(path)) {
    try { return !!decodeHubSessionId(decodeURIComponent(path.slice('/api/sessions/'.length))); }
    catch { return false; }
  }
  const session = /^\/api\/hub\/v1\/sessions\/[^/]+\/(.+)$/.exec(path)?.[1];
  if (session !== undefined) {
    if (method === 'POST' && (session === 'messages' || session === 'compact')) return true;
    if (read && (session === 'goal' || session === 'queue'
      || /^(?:commands|deletion-commands|settings-commands|compact-commands)\/[^/]+$/.test(session)
      || /^queue\/[^/]+\/commands\/[^/]+$/.test(session))) return true;
    return (method === 'PATCH' || method === 'DELETE') && /^queue\/[^/]+$/.test(session);
  }
  const creation = /^\/api\/hub\/v1\/connections\/[^/]+\/agents\/[^/]+\/sessions(.*)$/.exec(path)?.[1];
  return creation !== undefined && (method === 'POST' && creation === ''
    || read && /^\/creation-commands\/[^/]+$/.test(creation));
}

/** All six production chains have no synchronous store/principal/resolver.
 * Hold the whole original HTTP Promise, even body waits and ignored aborts.
 * Effects/receipts remain owned by their original connector/database. */
export function registerAsyncHubOwnerControls(app: Hono, deps: {
  mode: 'async'; controls: Pick<AsyncHubOwnerControls, 'openCurrent' | 'close'>;
  diagnostics?: PerformanceDiagnostics;
}) {
  if (deps.mode !== 'async' || typeof deps.controls?.openCurrent !== 'function'
    || typeof deps.controls?.close !== 'function') throw new Error('hub_owner_control_ports_required');
  const work = new HubRequestWork(), routes = new Hono();
  const checks = new WeakMap<Request, () => PromiseLike<void> | void>();
  const diagnostics = deps.diagnostics ?? performanceDiagnostics;
  const controls: Pick<AsyncHubOwnerControls, 'openCurrent'> = {
    async openCurrent(request, target) {
      work.check();
      const port = await deps.controls.openCurrent(request, target);
      work.check(); checks.set(request, port.check);
      return port;
    },
  };
  routes.use('*', async (c, next) => {
    if (!isAsyncHubOwnerControlRequest(c.req.method, c.req.path)) return next();
    c.header('Cache-Control', 'no-store');
    if (hasBoardCapabilityCredential(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
    const trace = guardedTrace(diagnostics, 'hub-owner-control-http');
    let failed = true;
    const warning = setTimeout(() => trace.reportPending({ pending: work.pending }), 30000);
    warning.unref();
    try {
      await work.run(async () => {
        await next();
        // Include caught body/transport failures: they cannot deliver a stale
        // authorized result after revocation or account/scope replacement.
        work.check(); await checks.get(c.req.raw)?.(); work.check();
      });
      failed = c.res.status >= 500;
    } catch (error) {
      // HubRequestWork already gives shutdown delivery precedence (503).
      // A cancellation without shutdown retains the existing wire status.
      const status = error instanceof HubMemberRequestError || error instanceof HTTPException ? error.status : 503;
      // Native Response supports the existing non-standard cancellation 499;
      // Hono's ContentfulStatusCode intentionally excludes that wire status.
      c.res = Response.json({ error: status === 409
        ? 'Authenticated account or Hub changed; reload before continuing' : 'Control authority unavailable' }, {
        status, headers: { 'cache-control': 'no-store' },
      });
    } finally {
      clearTimeout(warning); checks.delete(c.req.raw); trace.finish(failed);
    }
  });
  const http = { mode: 'async' as const, controls, diagnostics,
    error: (c: import('hono').Context, _error: unknown) => c.json({ error: 'Control unavailable' }, 503) };
  const session = '/api/hub/v1/sessions/:hubSessionId';
  registerHubMessageRoutes(routes, session, http); registerHubQueueRoutes(routes, session, http);
  registerHubCreationRoutes(routes, http); registerHubDeletionRoutes(routes, http);
  registerHubSettingsRoutes(routes, http); registerHubCompactRoutes(routes, http);
  app.route('/', routes);
  const close = createIndependentDrain([() => work.close(), () => deps.controls.close()], 'hub-route-drain', diagnostics);
  return { close, get pending() { return work.pending; } };
}
