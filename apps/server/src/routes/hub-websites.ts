import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { validWebsiteCatalog, validWebsiteId, validWebsiteSnapshot } from '@agentopsdeck/shared';
import { ConnectorClientError } from '../hub/connector-client.js';
import { legacyHubConnectionProxyDeps, resolveHubConnectionProxyClient, validateHubConnectionProxyRouteDeps,
  type HubConnectionProxyRouteDeps } from '../hub/connection-proxy-route-deps.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { HubRequestWork } from '../hub/async-request-work.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';

export function registerHubWebsiteRoutes(app: Hono, deps: HubConnectionProxyRouteDeps) {
  validateHubConnectionProxyRouteDeps(deps);
  const legacy = () => legacyHubConnectionProxyDeps(deps);
  const base = '/api/hub/v1/connections/:connectionId/websites';
  const work = new HubRequestWork();
  for (const operation of ['catalog', ':serviceId/snapshot']) app.get(`${base}/${operation}`, async c => {
    c.header('Cache-Control', 'no-store');
    const trace = guardedTrace(performanceDiagnostics, 'hub-request-authority'); trace.add('step', 86);
    try {
      const response = await work.run(async () => {
      const id = c.req.param('connectionId');
      if (deps.access && !deps.asyncConnectorClient) throw new HTTPException(503);
      const access = deps.access ? await deps.access.begin(c.req.raw, id) : undefined;
      work.check();
      const actor = access ? access.principal : legacy().principal(c);
      const connection = access ? access.connection : legacy().hubStore.getConnection(id, actor.userId);
      if (!connection || connection.status === 'disabled') throw new HTTPException(404);
      const version = access ? undefined : legacy().hubStore.connectionAuthority(id, actor.userId);
      const check = async () => {
        work.check();
        if (access) await access.check();
        else {
          if (legacy().principal(c).userId !== actor.userId) throw new HTTPException(401);
          if (legacy().hubStore.connectionAuthority(id, actor.userId) !== version) throw new HTTPException(403);
        }
        work.check();
        if (c.req.raw.signal.aborted) throw new HubMemberRequestError(499);
      };
      const serviceId = operation === 'catalog' ? undefined : c.req.param('serviceId');
      if (operation !== 'catalog' && !validWebsiteId(serviceId)) throw new HTTPException(404);
      if (c.req.url.includes('?')) throw new HTTPException(400);
      const client = await (async () => {
        try { return await resolveHubConnectionProxyClient(deps, c.req.raw, id, actor.userId); }
        catch (error) { await check(); throw error; }
      })();
      await check(); // Resolver may wait across revocation; no late dispatch.
      let result: unknown;
      try { result = await client.jsonOriginal<unknown>(serviceId ? `/websites/${encodeURIComponent(serviceId)}/snapshot` : '/websites/catalog', { signal: c.req.raw.signal }); }
      catch (error) { await check(); throw error; }
      await check();
      if (serviceId) {
        if (!validWebsiteSnapshot(result, serviceId)) throw new HTTPException(502);
        const { serviceId: selected, label, content, format, fetchedAt } = result;
        return c.json({ serviceId: selected, label, content, format, fetchedAt });
      }
      if (!validWebsiteCatalog(result)) throw new HTTPException(502);
      return c.json({ services: result.services.map(({ id, label }) => ({ id, label })) });
      });
      trace.add('settled', 1); trace.finish(); return response;
    } catch (error) {
      trace.add('deferred', 1); trace.finish(true);
      if (error instanceof HubMemberRequestError) {
        if (error.status === 499) return Response.json({ error: 'Connector website is unavailable.' }, {
          status: 499, headers: { 'Cache-Control': 'no-store' },
        });
        return c.json({ error: 'Connector website is unavailable.' }, error.status);
      }
      if (error instanceof HTTPException) throw error;
      // Remote diagnostics never expose upstream URLs, credentials or HTML.
      // A revoked Connector credential must not log the user out of their Hub.
      const status = error instanceof ConnectorClientError ? error.status === 401 ? 403 : [403, 404, 409, 415, 429, 504].includes(error.status) ? error.status : 502 : 502;
      return c.json({ error: 'Connector website is unavailable.' }, status as 502);
    }
  });
  let closing: Promise<void> | undefined;
  return { close: () => closing ??= work.close().then(() => deps.access?.close()) };
}
