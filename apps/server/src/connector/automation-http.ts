import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import type { AutomationConfiguration } from '../commands/automation-configuration.js';
import { AutomationStoreConflict } from '../commands/automation-store.js';
import { readJsonBody } from '../utils/http-body.js';
import type { ConnectorAutomationHost } from './automation-host.js';

/** Config/original receipts only. There is intentionally no HTTP completion,
 * trigger, retry or dispatch endpoint. Tokens cannot manufacture native facts. */
export function registerConnectorAutomation(app: Hono, base: string, deps: {
  tokens: ConnectorTokenStore; host: ConnectorAutomationHost; nodeId: string;
}) {
  const actor = (c: Context) => {
    c.header('Cache-Control', 'no-store');
    const principal = deps.tokens.authenticate(c.req.raw);
    if (!principal) throw new HTTPException(401);
    if (!deps.tokens.hasScope(principal.tokenId, 'automation:manage')
      || !deps.tokens.hasScope(principal.tokenId, 'messages:send')) throw new HTTPException(403);
    return principal.tokenId;
  };
  const safe = (handler: (c: Context) => Promise<Response> | Response) => async (c: Context) => {
    try { return await handler(c); }
    catch (error) {
      if (error instanceof HTTPException) throw error;
      if (error instanceof AutomationStoreConflict) return c.json({ error: 'automation_conflict' }, error.message === 'forbidden' ? 403 : 409);
      return c.json({ error: 'automation_unavailable' }, 503);
    }
  };
  app.get(base, safe(c => {
    const owner = actor(c), service = deps.host.service(owner);
    return c.json({ ownerId: owner, connectionId: deps.nodeId, rules: service.store.list(owner) });
  }));
  app.get(`${base}/configuration/:requestId`, safe(c => {
    const owner = actor(c), receipt = deps.host.service(owner).config.original(owner, c.req.param('requestId')!);
    return receipt ? c.json(receipt) : c.json({ error: 'not_found' }, 404);
  }));
  app.post(`${base}/configuration/:requestId`, safe(async c => {
    const owner = actor(c), requestId = c.req.param('requestId')!;
    const input = await readJsonBody(c.req.raw, 48 * 1024);
    if (actor(c) !== owner) throw new HTTPException(403);
    const receipt = deps.host.service(owner).config.configure(owner, requestId, input as AutomationConfiguration);
    return c.json(receipt);
  }));
}
