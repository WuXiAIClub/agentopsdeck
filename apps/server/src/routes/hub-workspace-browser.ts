import type { Context, Hono } from 'hono';
import type { HubPrincipal } from '../hub/identity.js';
import type { AuthRouteAuditStore } from '../auth/route-persistence.js';
import type { HubAdministrativeServices } from '../hub/administrative-route-services.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { BrowserWork, type BrowserAuthorize } from '../hub/browser-authorization.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { BrowserError, WorkspaceBrowser, validBrowserAction, type WorkspaceBrowserConfig } from '../hub/workspace-browser.js';
import { readJsonBody } from '../utils/http-body.js';
import { copyOriginalRequest } from '../hub/original-request-scope.js';
import { legacyWorkspaceToolDependencies, validateWorkspaceToolDependencies, type WorkspaceToolRouteDependencies } from './hub-workspace-tool-dependencies.js';

export function registerHubBrowser(app: Hono, deps: WorkspaceToolRouteDependencies<ReturnType<HubAdministrativeServices['createWorkspaceBrowserAccess']>> & {
  config?: WorkspaceBrowserConfig | undefined; service?: WorkspaceBrowser; diagnostics?: PerformanceDiagnostics }) {
  validateWorkspaceToolDependencies(deps);
  const legacy = () => legacyWorkspaceToolDependencies(deps);
  const service = deps.service ?? new WorkspaceBrowser(deps.config), base = '/api/hub/v1/workspace/browser';
  const work = new BrowserWork();
  const deliveries = new WeakMap<Context, object>();
  const deliver = (c: Context, result: { id: string; seq: number }) => { deliveries.set(c, result); return c.json(result); };
  let closed = false;
  const audit = async (record: Parameters<AuthRouteAuditStore['append']>[0]) => {
    try { await (deps.access?.audit ?? legacy().audit).append(record); }
    catch { throw new BrowserError(503, 'browser_audit_unconfirmed'); }
  };
  const handle = (fn: (c: Context, owner: string, valid: BrowserAuthorize, leaseValid: BrowserAuthorize) => Promise<Response>, config = false) => (c: Context) => work.track(async () => {
    c.header('Cache-Control', 'no-store'); c.header('X-Content-Type-Options', 'nosniff');
    const trace = guardedTrace(deps.diagnostics ?? performanceDiagnostics, 'hub-workspace-browser'); trace.add('admitted', 1);
    let failed = true;
    try {
      if (closed) throw new BrowserError(503, 'browser_unavailable');
      if (c.req.raw.signal.aborted) throw new BrowserError(409, 'browser_request_aborted');
      // Keep original evidence, not HTTP lifetime: a successful creation request
      // disconnecting later must not revoke a long-lived browser lease.
      const context = deps.access ? await deps.access.requests.begin(copyOriginalRequest(c.req.raw, { signal: null })) : undefined;
      const principal = context?.principal ?? legacy().principal(c), owner = principal.userId;
      const local = () => !closed && (config || service.enabled(owner));
      const leaseValid: BrowserAuthorize = Object.assign(context ? async () => {
        try { await context.check(); return local(); } catch { return false; }
      } : () => {
        try { const current = legacy().principal(c); return local() && current.userId === owner && current.admin === principal.admin; } catch { return false; }
      }, { current: local });
      const valid: BrowserAuthorize = Object.assign(() => {
        if (c.req.raw.signal.aborted) return false;
        const checked = leaseValid();
        return typeof checked === 'boolean' ? checked : checked.then(ok => ok && !c.req.raw.signal.aborted);
      }, { current: () => local() && !c.req.raw.signal.aborted });
      if (!await valid() || !valid.current!()) throw new BrowserError(403, 'browser_disabled');
      let result: Response, originalError: unknown;
      try { result = await fn(c, owner, valid, leaseValid); }
      catch (error) { originalError = error; throw error; }
      finally {
        // Invalid bodies still belong to the original authority. Preserve the
        // lease/request lifetime split without allowing stale error delivery.
        // A sanitized native capture failure keeps its established 502 wire
        // contract; it contains no screenshot and cannot grant another effect.
        if (context) {
          try { await context.check(); }
          catch (error) { if (!(originalError instanceof BrowserError && originalError.status === 502)) throw error; }
          if (closed) throw new BrowserError(503, 'browser_unavailable');
        }
      }
      if (!await valid() || !valid.current!()) throw new BrowserError(closed ? 503 : 403, 'browser_revoked');
      const original = deliveries.get(c);
      if (original) {
        await service.confirmDelivery(owner, original, valid);
        // Final local fence has no await before response delivery.
        service.assertDelivery(owner, original);
        if (!valid.current!()) throw new BrowserError(closed ? 503 : 403, 'browser_revoked');
      }
      failed = result.status >= 400;
      return result;
    } catch (error) {
      if (error instanceof HubMemberRequestError) return c.json({ error: 'browser_unavailable' }, error.status === 499 ? 503 : error.status);
      if (!(error instanceof BrowserError)) throw error;
      return c.json({ error: error.code }, error.status);
    } finally { deliveries.delete(c); trace.add('settled', 1); trace.finish(failed); }
  });
  app.get(`${base}/config`, handle(async (c, owner) => { const enabled = service.enabled(owner);
    return c.json({ enabled, hosts: enabled ? service.config!.hosts : [] }); }, true));
  app.post(`${base}/sessions`, handle(async (c, owner, valid, leaseValid) => {
    const body = await readJsonBody(c.req.raw, 256);
    if (!body || typeof body !== 'object' || Object.keys(body).length !== 1 || typeof (body as { id?: unknown }).id !== 'string') throw new BrowserError(400, 'invalid_browser_id');
    if (!await valid() || !valid.current!()) throw new BrowserError(403, 'browser_revoked');
    const result = await service.start(owner, (body as { id: string }).id, leaseValid, valid);
    await audit({ event: 'api_authz', outcome: 'success', userId: owner, reason: 'workspace_browser_started' });
    return deliver(c, result);
  }));
  app.get(`${base}/sessions/:id/frame`, handle(async (c, owner, valid) => {
    const hash = c.req.query('hash');
    if (hash && !/^[a-f0-9]{64}$/.test(hash)) throw new BrowserError(400, 'invalid_frame_hash');
    return deliver(c, await service.frame(owner, c.req.param('id')!, hash, valid));
  }));
  app.post(`${base}/sessions/:id/actions`, handle(async (c, owner, valid) => {
    const body = await readJsonBody(c.req.raw, 20_000);
    if (!await valid() || !valid.current!()) throw new BrowserError(403, 'browser_revoked');
    if (!validBrowserAction(body, service.config!.hosts)) throw new BrowserError(400, 'browser_action_invalid');
    const result = await service.act(owner, c.req.param('id')!, body, valid);
    // Never audit URLs, queries, page contents, text or cookies.
    await audit({ event: 'api_authz', outcome: 'success', userId: owner, reason: `workspace_browser_${body.kind}` });
    return deliver(c, result);
  }));
  app.delete(`${base}/sessions/:id`, handle(async (c, owner) => {
    await service.stop(owner, c.req.param('id')!);
    await audit({ event: 'api_authz', outcome: 'success', userId: owner, reason: 'workspace_browser_closed' });
    return c.json({ closed: true });
  }));
  const drain = createIndependentDrain([() => service.close(), () => work.drain(), async () => {
    // Do not retire identity/audit owners until every original HTTP/native owner
    // is done, even when the independent service close phase fails.
    await service.close(); await work.drain(); await deps.access?.close();
  }], 'browser-owner-drain');
  return { close: () => { closed = true; return drain(); } };
}
