import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { validRemoteCommand, validRemoteSnapshot, type RemoteOutcome } from '@agentopsdeck/shared';
import type { HubPrincipal } from '../hub/identity.js';
import type { AuthRouteAuditStore } from '../auth/route-persistence.js';
import type { HubAdministrativeServices } from '../hub/administrative-route-services.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';
import { performanceDiagnostics, type PerformanceDiagnostics, type PerformanceTrace } from '../diagnostics/performance.js';
import { WorkspaceRemote, RemoteError } from '../hub/workspace-remote.js';
import { readJsonBody } from '../utils/http-body.js';
import { legacyWorkspaceToolDependencies, validateWorkspaceToolDependencies, type WorkspaceToolRouteDependencies } from './hub-workspace-tool-dependencies.js';

export function registerHubRemoteRoutes(app: Hono, deps: WorkspaceToolRouteDependencies<ReturnType<HubAdministrativeServices['createWorkspaceRemoteAccess']>> & {
  service?: WorkspaceRemote; diagnostics?: PerformanceDiagnostics }) {
  validateWorkspaceToolDependencies(deps);
  const legacy = () => legacyWorkspaceToolDependencies(deps);
  const service = deps.service ?? new WorkspaceRemote(), base = '/api/hub/v1/workspace/remote';
  const scopes = new WeakMap<Context, { user: string; check: () => void | Promise<void> }>();
  const work = new Set<Promise<void>>();
  let closed = false;
  const track = async <T>(run: () => Promise<T>) => {
    let release!: () => void;
    const retained = new Promise<void>(resolve => { release = resolve; });
    work.add(retained);
    try { return await run(); } finally { work.delete(retained); release(); }
  };
  const scope = (c: Context) => {
    const value = scopes.get(c);
    if (closed || !value) throw new HTTPException(503);
    return value;
  };
  const audit = async (record: Parameters<AuthRouteAuditStore['append']>[0]) => {
    try { await (deps.access?.audit ?? legacy().audit).append(record); }
    catch { throw new HTTPException(503, { res: Response.json({ error: 'remote_unavailable' }, { status: 503 }) }); }
  };
  app.use(`${base}/*`, async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (closed) return c.json({ error: 'remote_unavailable' }, 503);
    return track(async () => {
      let trace: PerformanceTrace | undefined;
      try { trace = (deps.diagnostics ?? performanceDiagnostics).start('hub-workspace-remote'); trace.add('admitted', 1); } catch { /* Observation only. */ }
      try {
        if (deps.access) {
          const context = await deps.access.requests.begin(c.req.raw);
          if (closed) throw new HTTPException(503);
          scopes.set(c, { user: context.principal.userId, check: async () => {
            if (closed) throw new HTTPException(503);
            try { await context.check(); }
            catch (error) {
              const status = error instanceof HubMemberRequestError && error.status !== 499 ? error.status : 503;
              throw new HTTPException(status, { res: Response.json({ error: 'remote_unavailable' }, { status }) });
            }
            if (closed) throw new HTTPException(503);
          } });
        } else {
          const user = legacy().principal(c).userId;
          scopes.set(c, { user, check: () => {
            if (closed) throw new HTTPException(503);
            if (legacy().principal(c).userId !== user) throw new HTTPException(401);
          } });
        }
        await next();
        // Hono also returns here after parsing/business errors. Do not deliver
        // an error from stale authority after a held request body or audit ACK.
        await scope(c).check();
      } catch (e) {
        if (e instanceof HubMemberRequestError) { c.res = c.json({ error: 'remote_unavailable' }, e.status === 499 ? 503 : e.status); return c.res; }
        if (e instanceof RemoteError) { c.res = c.json({ error: e.code }, e.status); return c.res; }
        throw e;
      } finally {
        scopes.delete(c);
        try { trace?.add('settled', 1); trace?.finish(c.res.status >= 400); } catch { /* Observation only. */ }
      }
    });
  });
  const read = async (c: Context, user: string) => {
    const body = await readJsonBody(c.req.raw, 64 * 1024);
    await scope(c).check();
    if (scope(c).user !== user || c.req.raw.signal.aborted) throw new HTTPException(401);
    return body;
  };
  const token = (c: Context) => c.req.header('X-Workspace-Host') ?? '';
  app.get(`${base}/devices`, c => c.json({ devices: service.list(scope(c).user) }));
  app.post(`${base}/devices`, async c => {
    const user = scope(c).user, body = await read(c, user);
    if (!validRemoteSnapshot(body)) return c.json({ error: 'invalid_remote_snapshot' }, 400);
    const result = service.create(user, body);
    await audit({ event: 'api_authz', outcome: 'success', userId: user, reason: 'workspace_remote_enabled' });
    await scope(c).check();
    return c.json(result);
  });
  app.put(`${base}/devices/:id`, async c => {
    const user = scope(c).user, body = await read(c, user);
    if (!validRemoteSnapshot(body)) return c.json({ error: 'invalid_remote_snapshot' }, 400);
    return c.json(service.update(user, c.req.param('id'), token(c), body));
  });
  app.delete(`${base}/devices/:id`, async c => {
    const user = scope(c).user;
    service.remove(user, c.req.param('id'));
    await audit({ event: 'api_authz', outcome: 'success', userId: user, reason: 'workspace_remote_disabled' });
    await scope(c).check();
    return c.json({ ok: true });
  });
  const authorized = (c: Context) => async () => { try { await scope(c).check(); return !c.req.raw.signal.aborted; } catch { return false; } };
  app.get(`${base}/devices/:id/receive`, async c => {
    const user = scope(c).user;
    const command = await service.poll(user, c.req.param('id'), token(c), c.req.raw.signal, authorized(c));
    return c.json({ command });
  });
  app.post(`${base}/devices/:id/commands`, async c => {
    const user = scope(c).user, body = await read(c, user);
    if (!validRemoteCommand(body)) return c.json({ error: 'invalid_remote_command' }, 400);
    const auth = authorized(c), result = await service.command(user, c.req.param('id'), body, c.req.raw.signal, auth);
    if (!await auth()) throw new HTTPException(401);
    await audit({ event: 'api_authz', outcome: result === 'applied' ? 'success' : 'failure', userId: user, reason: `workspace_remote_${body.action}_${result}` });
    await scope(c).check();
    return c.json({ result });
  });
  app.post(`${base}/devices/:id/ack`, async c => {
    const user = scope(c).user, body = await read(c, user);
    if (!body || typeof body !== 'object' || Object.keys(body).length !== 2) return c.json({ error: 'invalid_remote_ack' }, 400);
    const { id, result } = body as { id?: unknown; result?: unknown };
    if (typeof id !== 'string' || !['applied', 'occupied', 'unavailable', 'unknown'].includes(String(result))) return c.json({ error: 'invalid_remote_ack' }, 400);
    service.acknowledge(user, c.req.param('id'), token(c), id, result as RemoteOutcome);
    return c.json({ ok: true });
  });
  const drain = createIndependentDrain([async () => {
    await service.close();
    while (work.size) await Promise.all([...work]);
    await deps.access?.close();
  }], 'hub-route-drain', deps.diagnostics ?? performanceDiagnostics);
  return { close() { closed = true; return drain(); } };
}
