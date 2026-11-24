import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { validWebsiteId } from '@agentopsdeck/shared';
import type { ConnectorMachineAuthority } from './machine-authority.js';
import { createMachineEffectDrain, settleMachineWork } from './machine-authority.js';
import { registerFileRequestOwnership } from './file-authority.js';
import { readJsonBody } from '../utils/http-body.js';
import type { WebsiteService } from './websites.js';
import { WebsiteAccessStore, readWebsiteResource } from './website-access.js';
import { registerConnectorWebsiteSockets } from './website-sockets-http.js';

export function registerConnectorWebsiteAccess(app: Hono, tokens: ConnectorMachineAuthority, services: WebsiteService[] = [], fetcher: typeof fetch = fetch) {
  const base = '/api/connector/v1/website-access', leases = new WebsiteAccessStore<WebsiteService>();
  const requests = registerFileRequestOwnership(app, base, undefined, 'connector-machine-services');
  const sockets = registerConnectorWebsiteSockets(app, tokens, leases);
  const effects = createMachineEffectDrain();
  let active = 0;
  const authorize = async (c: Context) => {
    requests.check(c.req.raw);
    if (!await tokens.authenticate(c.req.raw)) throw new HTTPException(401);
    const actor = await tokens.requireScope(c.req.raw, 'websites:browse');
    if (!actor) throw new HTTPException(403);
    requests.check(c.req.raw);
    if (c.req.url.includes('?')) throw new HTTPException(400);
    c.header('Cache-Control', 'no-store');
    return actor;
  };
  app.post(base, async c => {
    await authorize(c);
    const input = await readJsonBody(c.req.raw, 256) as { serviceId?: unknown };
    const actor = await authorize(c);
    if (!input || Object.keys(input).length !== 1 || !validWebsiteId(input.serviceId)) throw new HTTPException(400);
    const service = services.find(s => s.id === input.serviceId && s.browse);
    if (!service) throw new HTTPException(404);
    const lease = leases.create(actor.tokenId, service);
    // Relative lifetime avoids relying on synchronized Hub/Connector wall clocks.
    return c.json({ accessId: lease.id, serviceId: service.id, expiresInMs: Math.max(0, lease.expiresAt - Date.now()) });
  });
  app.post(`${base}/:accessId/resource`, async c => {
    const actor = await authorize(c), lease = leases.get(c.req.param('accessId'), actor.tokenId);
    const input = await readJsonBody(c.req.raw, 8192) as { path?: unknown };
    await authorize(c); leases.get(lease.id, actor.tokenId);
    if (!input || Object.keys(input).length !== 1 || typeof input.path !== 'string') throw new HTTPException(400);
    if (active >= 4) throw new HTTPException(429);
    active++;
    const signal = AbortSignal.any([c.req.raw.signal, lease.controller.signal, AbortSignal.timeout(Math.max(1, lease.expiresAt - Date.now()))]);
    // Token changes wake this wait immediately; no polling and no listener after completion.
    const watcher = new AbortController();
    const watch = async () => {
      try {
        while (!watcher.signal.aborted) {
          const revision = tokens.changes.revision;
          if (await tokens.hasScope(actor.tokenId, 'websites:browse') !== true) { leases.remove(lease.id); break; }
          await tokens.changes.wait(revision, watcher.signal);
        }
      } catch { leases.remove(lease.id); } // Listener capacity failure must fail closed.
    };
    const watched = watch();
    try {
      const resource = await readWebsiteResource(lease.value, input.path, signal, fetcher, effects.retain);
      await authorize(c); leases.get(lease.id, actor.tokenId);
      return c.json(resource);
    } finally { watcher.abort(); await watched; active--; }
  });
  app.delete(`${base}/:accessId`, async c => {
    const actor = await authorize(c), lease = leases.get(c.req.param('accessId'), actor.tokenId);
    leases.remove(lease.id);
    return c.json({ closed: true });
  });
  let closing: Promise<void> | undefined;
  return { close: () => {
    if (closing) return closing;
    const drained = requests.close(); leases.close();
    return closing = settleMachineWork([(async () => { await drained; await effects.close(); })(), sockets.close()]);
  } };
}
