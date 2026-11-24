import type { Hono } from 'hono';
import { validWebsiteId } from '@agentopsdeck/shared';
import type { ConnectorFileAuthority } from './file-authority.js';
import { fileAuthorityPending, registerFileRequestOwnership } from './file-authority.js';
import { readWebsiteSnapshot, WebsiteReadError, type WebsiteService } from './websites.js';
import { createMachineEffectDrain } from './machine-authority.js';

export function registerConnectorWebsiteRoutes(app: Hono, tokens: ConnectorFileAuthority, services: WebsiteService[] = [], fetcher: typeof fetch = fetch) {
  const base = '/api/connector/v1/websites';
  const requests = registerFileRequestOwnership(app, base, undefined, 'connector-machine-services');
  const controller = new AbortController();
  const effects = createMachineEffectDrain();
  let active = 0;
  app.use(`${base}/*`, async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const authentication = tokens.authenticate(c.req.raw);
    if (!(fileAuthorityPending(authentication) ? await authentication : authentication)) return c.json({ error: 'unauthorized' }, 401);
    if (!services.length) return c.json({ error: 'No websites are configured on this Connector.' }, 409);
    const permission = tokens.requireScope(c.req.raw, 'websites:read');
    const actor = fileAuthorityPending(permission) ? await permission : permission;
    if (!actor) return c.json({ error: 'Website access requires websites:read.' }, 403);
    requests.check(c.req.raw); await next();
    if (await tokens.hasScope(actor.tokenId, 'websites:read') !== true) c.res = c.json({ error: 'Website access was revoked.' }, 403);
  });
  app.get(`${base}/catalog`, c => c.json({ services: services.map(({ id, label }) => ({ id, label })) }));
  app.get(`${base}/:serviceId/snapshot`, async c => {
    const id = c.req.param('serviceId');
    const service = validWebsiteId(id) ? services.find(s => s.id === id) : undefined;
    if (!service) return c.json({ error: 'Website not found.' }, 404);
    if (c.req.url.includes('?')) return c.json({ error: 'Website parameters are not accepted.' }, 400);
    if (active >= 4) return c.json({ error: 'Website snapshot capacity reached. Retry explicitly.' }, 429);
    active++;
    try { return c.json(await readWebsiteSnapshot(service, AbortSignal.any([controller.signal, c.req.raw.signal]), fetcher, effects.retain)); }
    catch (error) { return c.json({ error: error instanceof WebsiteReadError ? error.message : 'Website read failed.' }, error instanceof WebsiteReadError ? error.status : 502); }
    finally { active--; }
  });
  let closing: Promise<void> | undefined;
  return { close() {
    if (closing) return closing;
    controller.abort();
    const drained = requests.close();
    return closing = (async () => { await drained; await effects.close(); })();
  } };
}
