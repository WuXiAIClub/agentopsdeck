import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { validWebsiteId, WEBSITE_ACTION_ENVELOPE_BYTES } from '@agentopsdeck/shared';
import type { ConnectorMachineAuthority } from './machine-authority.js';
import { createMachineEffectDrain } from './machine-authority.js';
import { registerFileRequestOwnership } from './file-authority.js';
import { readJsonBody } from '../utils/http-body.js';
import { WebsiteAccessStore, WEBSITE_ACCESS_TTL, validWebsiteAccessId } from './website-access.js';
import { WebsiteCookieSession } from './website-cookie-session.js';
import { WebsiteActionExecution } from './website-actions.js';
import type { WebsiteService } from './websites.js';

export function registerConnectorWebsiteActions(app: Hono, tokens: ConnectorMachineAuthority, services: WebsiteService[] = [], fetcher: typeof fetch = fetch) {
  const base = '/api/connector/v1/website-actions', leases = new WebsiteAccessStore<WebsiteActionExecution>(Date.now, { total: 16, perOwner: 4 });
  const requests = registerFileRequestOwnership(app, base, undefined, 'connector-machine-services');
  const effects = createMachineEffectDrain();
  let active = 0;
  const actor = async (c: Context) => {
    requests.check(c.req.raw);
    if (!await tokens.authenticate(c.req.raw)) throw new HTTPException(401);
    const result = await tokens.requireScope(c.req.raw, 'websites:act');
    if (!result) throw new HTTPException(403);
    requests.check(c.req.raw);
    if (c.req.url.includes('?')) throw new HTTPException(400);
    c.header('Cache-Control', 'no-store');
    return result;
  };
  app.get(`${base}/catalog/:serviceId`, async c => {
    await actor(c);
    const service = services.find(s => s.id === c.req.param('serviceId'));
    if (!service) throw new HTTPException(404);
    return c.json({ actions: (service.actions ?? []).map(({ path: _path, ...action }) => action), ...(service.session ? { session: true } : {}) });
  });
  app.post(base, async c => {
    await actor(c);
    const input = await readJsonBody(c.req.raw, 512) as { serviceId?: unknown; actionId?: unknown; previousAccessId?: unknown };
    const a = await actor(c);
    if (!input || Object.keys(input).some(k => !['serviceId', 'actionId', 'previousAccessId'].includes(k)) || !validWebsiteId(input.serviceId) || !validWebsiteId(input.actionId)
      || input.previousAccessId !== undefined && !validWebsiteAccessId(input.previousAccessId)) throw new HTTPException(400);
    const service = services.find(s => s.id === input.serviceId), action = service?.actions?.find(a => a.id === input.actionId);
    if (!service || !action) throw new HTTPException(404);
    const previous = typeof input.previousAccessId === 'string' ? leases.get(input.previousAccessId, a.tokenId) : undefined;
    if (previous && (!service.session || previous.value.serviceId !== service.id || previous.value.url !== service.url
      || !previous.value.session || previous.value.receipt.state !== 'completed')) throw new HTTPException(409);
    const deadline = previous?.expiresAt ?? Date.now() + WEBSITE_ACCESS_TTL;
    const session = previous?.value.session ?? (service.session ? new WebsiteCookieSession(new URL(service.url).origin, service.session, deadline) : undefined);
    // Consume the old completed operation synchronously. Two continuations may
    // not fork a cookie session; the new ID cannot replay the old operation.
    const lease = leases.create(a.tokenId, new WebsiteActionExecution(service.url, action, session, service.id), deadline, previous?.id);
    return c.json({ accessId: lease.id, expiresInMs: lease.expiresAt - Date.now() });
  });
  app.get(`${base}/:id`, async c => c.json(leases.get(c.req.param('id'), (await actor(c)).tokenId).value.receipt));
  app.post(`${base}/:id/execute`, async c => {
    const a = await actor(c), lease = leases.get(c.req.param('id'), a.tokenId);
    const input = await readJsonBody(c.req.raw, WEBSITE_ACTION_ENVELOPE_BYTES) as { body?: unknown };
    await actor(c); leases.get(lease.id, a.tokenId);
    if (!input || Object.keys(input).length !== 1 || typeof input.body !== 'string') throw new HTTPException(400);
    if (active >= 4) throw new HTTPException(429);
    active++;
    const watcher = new AbortController();
    const watched = (async () => {
      try {
        while (!watcher.signal.aborted) {
          const revision = tokens.changes.revision;
          if (await tokens.hasScope(a.tokenId, 'websites:act') !== true) { leases.remove(lease.id); break; }
          await tokens.changes.wait(revision, watcher.signal);
        }
      } catch { leases.remove(lease.id); }
    })();
    try {
      const result = await lease.value.execute(input.body, AbortSignal.any([c.req.raw.signal, lease.controller.signal,
        AbortSignal.timeout(Math.max(1, lease.expiresAt - Date.now()))]), fetcher, effects.retain);
      await actor(c); leases.get(lease.id, a.tokenId);
      return c.json(result);
    } finally { watcher.abort(); await watched; active--; }
  });
  app.delete(`${base}/:id`, async c => {
    const lease = leases.get(c.req.param('id'), (await actor(c)).tokenId);
    leases.remove(lease.id); return c.json({ closed: true });
  });
  let closing: Promise<void> | undefined;
  return { close: () => {
    if (closing) return closing;
    const drained = requests.close(); leases.close();
    return closing = (async () => { await drained; await effects.close(); })();
  } };
}
