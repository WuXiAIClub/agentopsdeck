import type { Context, Hono } from 'hono';
import type { Dispatch } from '../connector/transport.js';
import { readJsonBody } from '../utils/http-body.js';
import { HTTPException } from 'hono/http-exception';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import type { AsyncHubIssuerManagementPort } from '../hub/async-issuer-management.js';
import { requireLegacyHubRoute, type LegacyHubRouteDependencies, type AsyncOnlyHubRouteDependencies } from './hub-legacy-dependencies.js';

export type LocalExecutionOperator = {
  create: (hubId: string, createSessions?: boolean) => { token: string; record: { id: string } };
  revoke: (id: string) => boolean;
};

type IssuerDependencies = {
  local?: { connectionId: string; dispatch: Dispatch } | undefined;
  operator?: LocalExecutionOperator | undefined;
  asyncManagement?: AsyncHubIssuerManagementPort | undefined;
} & (LegacyHubRouteDependencies | AsyncOnlyHubRouteDependencies & { asyncManagement: AsyncHubIssuerManagementPort });
export function registerHubExecutionIssuerRoutes(app: Hono, input: IssuerDependencies) {
  if (input.mode === 'async' && (typeof input.asyncManagement?.open !== 'function'
    || typeof input.asyncManagement.close !== 'function')) throw Error('hub_issuer_management_ports_required');
  const path = '/api/hub/v1/connections/:connectionId/execution-issuer';
  if (input.asyncManagement) {
    const management = input.asyncManagement;
    const handle = (run: (c: Context) => Promise<Response>) => async (c: Context) => {
      c.header('Cache-Control', 'no-store');
      try { return await run(c); }
      catch (error) {
        if (error instanceof HubMemberRequestError && error.status === 499) return new Response(null, { status: 499, headers: { 'cache-control': 'no-store' } });
        if (error instanceof HubMemberRequestError) return c.json({ error: error.status === 404 ? 'connection not found'
          : error.status === 401 ? 'unauthorized' : error.status === 403 ? 'Local operator setup unavailable'
          : 'Issuer configuration could not be verified or saved' }, error.status as 400 | 401 | 403 | 404 | 409 | 503);
        if (error instanceof HTTPException) throw error;
        return c.json({ error: 'Issuer configuration could not be verified or saved' }, 409);
      }
    };
    app.get(path, handle(async c => {
      const request = await management.open(c.req.raw, c.req.param('connectionId') ?? '');
      return c.json(await request.read());
    }));
    app.put(path, handle(async c => {
      const request = await management.open(c.req.raw, c.req.param('connectionId') ?? '');
      await request.read(); // Preserve owner connection 404 before body validation.
      const raw = await readJsonBody(c.req.raw, 8 * 1024);
      await request.check();
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => key !== 'token')
        || typeof (raw as { token?: unknown }).token !== 'string') return c.json({ error: 'Invalid issuer configuration' }, 400);
      return c.json(await request.configure((raw as { token: string }).token));
    }));
    app.delete(path, handle(async c => {
      const request = await management.open(c.req.raw, c.req.param('connectionId') ?? '');
      await request.disable(); return c.json({ ok: true });
    }));
    app.post(`${path}/local`, handle(async c => {
      const request = await management.open(c.req.raw, c.req.param('connectionId') ?? '');
      try {
        if (!(await request.read()).localSetupAllowed) return c.json({ error: 'Local operator setup unavailable' }, 403);
      } catch (error) {
        if (error instanceof HubMemberRequestError && error.status === 404) return c.json({ error: 'Local operator setup unavailable' }, 403);
        throw error;
      }
      const raw = await readJsonBody(c.req.raw, 1024);
      await request.check();
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)
        || Object.keys(raw).some(key => !['confirm', 'nodeVersion', 'createSessions'].includes(key))
        || ('createSessions' in raw && typeof raw.createSessions !== 'boolean')
        || (raw as { confirm?: unknown }).confirm !== true) return c.json({ error: 'Explicit setup confirmation required' }, 400);
      const body = raw as { nodeVersion?: unknown; createSessions?: boolean };
      const result = await request.provision(body.nodeVersion, body.createSessions === true);
      return c.json({ issuer: result.issuer }, result.status);
    }));
    return;
  }
  const deps = { ...requireLegacyHubRoute(input), local: input.local, operator: input.operator };
  const pending = new Set<string>();
  const canProvision = (c: Context, id: string) => Boolean(deps.operator && deps.local?.connectionId === id
    && deps.principal(c).admin && deps.hubStore.getConnection(id, deps.principal(c).userId)?.kind === 'local');
  app.get(path, (c) => {
    c.header('Cache-Control', 'no-store');
    const userId = deps.principal(c).userId, id = c.req.param('connectionId');
    if (!deps.hubStore.getConnection(id, userId)) return c.json({ error: 'connection not found' }, 404);
    return c.json({ hubId: deps.hubStore.identities.hubId, localSetupAllowed: canProvision(c, id),
      issuer: deps.hubStore.executionIssuers.current(userId, id) ?? null });
  });
  app.post(`${path}/local`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const id = c.req.param('connectionId'), userId = deps.principal(c).userId;
    const authorize = () => {
      if (!canProvision(c, id) || deps.principal(c).userId !== userId) throw new HTTPException(403, { message: 'Local operator setup unavailable' });
    };
    authorize();
    const raw = await readJsonBody(c.req.raw, 1024);
    authorize();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['confirm', 'nodeVersion', 'createSessions'].includes(key))
      || ('createSessions' in raw && typeof raw.createSessions !== 'boolean')
      || (raw as { confirm?: unknown }).confirm !== true) return c.json({ error: 'Explicit setup confirmation required' }, 400);
    if ((raw as { nodeVersion?: unknown }).nodeVersion !== deps.hubStore.connectionAuthority(id, userId)) {
      return c.json({ error: 'Node authority changed; refresh before setup' }, 409);
    }
    if (pending.has(id)) return c.json({ error: 'Setup in progress; refresh before continuing' }, 409);
    const existing = deps.hubStore.executionIssuers.current(userId, id);
    const createSessions = (raw as { createSessions?: boolean }).createSessions === true;
    if (existing && (!createSessions || existing.creationAllowed)) return c.json({ issuer: existing });
    pending.add(id);
    let created: ReturnType<LocalExecutionOperator['create']> | undefined;
    try {
      created = deps.operator!.create(deps.hubStore.identities.hubId, createSessions);
      const issuer = await deps.hubStore.executionIssuers.configure(userId, id, created.token, authorize, deps.local, c.req.raw.signal, createSessions);
      return c.json({ issuer }, 201);
    } catch {
      if (created && deps.hubStore.executionIssuers.current(userId, id)?.issuerId !== created.record.id) deps.operator!.revoke(created.record.id);
      return c.json({ error: 'Local execution setup was not confirmed. Refresh before continuing.' }, 409);
    } finally { pending.delete(id); }
  });
  app.put(path, async (c) => {
    c.header('Cache-Control', 'no-store');
    const userId = deps.principal(c).userId, id = c.req.param('connectionId');
    if (!deps.hubStore.getConnection(id, userId)) return c.json({ error: 'connection not found' }, 404);
    const raw = await readJsonBody(c.req.raw, 8 * 1024);
    deps.principal(c);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => key !== 'token')
      || typeof (raw as { token?: unknown }).token !== 'string') return c.json({ error: 'Invalid issuer configuration' }, 400);
    try {
      const issuer = await deps.hubStore.executionIssuers.configure(userId, id, (raw as { token: string }).token,
        () => { deps.principal(c); }, deps.local, c.req.raw.signal);
      return c.json({ hubId: deps.hubStore.identities.hubId, issuer });
    } catch {
      deps.principal(c);
      // Upstream/vault errors can contain secrets. A failed setup never enables
      // shared execution, even when its read-only verification ACK was lost.
      return c.json({ error: 'Issuer configuration could not be verified or saved' }, 409);
    }
  });
  app.delete(path, (c) => {
    c.header('Cache-Control', 'no-store');
    const userId = deps.principal(c).userId, id = c.req.param('connectionId');
    if (!deps.hubStore.getConnection(id, userId)) return c.json({ error: 'connection not found' }, 404);
    deps.hubStore.executionIssuers.disable(userId, id);
    return c.json({ ok: true });
  });
}
