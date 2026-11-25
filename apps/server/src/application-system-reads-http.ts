import { Hono } from 'hono';
import { createHash, randomUUID } from 'node:crypto';
import { ApplicationCommandScopeError, type createApplicationCommandScopes } from './auth/application-command-scope.js';
import { SessionReadAuthority, type SessionReadActor } from './auth/session-read-authority.js';
import { ConnectorOwnerUnavailable } from './connector/connector-owner-domain.js';
import { EXPECTED_NODE_HEADER } from './connector/node-identity.js';
import { ReadRequestError } from './lifecycle/read-request-owner.js';
import { registerSystemRoutes, SystemRestartFenceError, type SystemReadDependencies } from './routes/system.js';
import { createAntigravityUsageReader } from './antigravity/usage.js';

/** Full original frontend read chain. Native work belongs to the original
 * system owner, even after the bounded Auth/HTTP waiter has ended. */
export function registerApplicationSystemReadsHttp(app: Hono, deps: SystemReadDependencies & {
  observeActor: SessionReadActor;
  available(): boolean;
  commands?: Pick<ReturnType<typeof createApplicationCommandScopes>, 'run'>;
}) {
  let closed = false;
  const readUsage = deps.config.antigravity && createAntigravityUsageReader(deps.config.antigravity);
  const available = () => !closed && deps.available();
  const authority = new SessionReadAuthority(request => {
    if (!available()) throw new ConnectorOwnerUnavailable();
    return deps.observeActor(request);
  }, deps.diagnostics, deps.requestWaitMs);
  const original = new Hono();
  const originals = new WeakMap<Request, () => Promise<void>>();
  const system = registerSystemRoutes(original, { ...deps, readsOnly: true,
    // Do not forward a fence from a structurally compatible caller. Only this
    // composition's original credential/actor checks may enable management.
    restart: deps.commands ? { run: async (request, work) => {
      const check = originals.get(request);
      if (!available() || !check) throw new SystemRestartFenceError(503);
      try {
        return await deps.commands!.run(request, { action: 'settings', runtime: 'openclaw',
          resource: 'gateway-restart', commandKey: randomUUID(),
          payloadDigest: createHash('sha256').update('gateway-restart').digest('hex'),
        }, async scope => {
          await scope.authorize('prepare'); await check(); scope.local();
          return work(async () => {
            await scope.authorize('effect'); await check(); scope.local();
          });
        });
      } catch (error) {
        if (error instanceof ApplicationCommandScopeError || error instanceof ReadRequestError)
          throw new SystemRestartFenceError(error instanceof ReadRequestError ? error.status
            : error.code === 'unauthorized' ? 403 : error.code === 'cancelled' ? 408 : error.code === 'invalid' ? 400 : 503);
        throw error;
      }
    } } : undefined,
  });
  const dispatch = async (c: import('hono').Context) => {
      c.header('Cache-Control', 'no-store');
      if (!available()) return c.json({ error: 'server_draining' }, 503);
      if (c.req.header('x-agentopsdeck-execution-grant') !== undefined || c.req.header(EXPECTED_NODE_HEADER) !== undefined)
        return c.json({ error: 'Invalid local system authority' }, 403);
      // Fresh immutable original user evidence; no private transport token.
      const headers = new Headers();
      for (const name of ['authorization', 'x-agentopsdeck-key', 'x-agentopsdeck-key', 'cookie']) {
        const value = c.req.header(name); if (value !== undefined) headers.set(name, value);
      }
      const request = new Request(c.req.url, { method: c.req.method, headers, signal: c.req.raw.signal });
      const response = c.req.path === '/api/health' ? await original.fetch(request) : await authority.run(request, async check => {
        originals.set(request, check);
        try { return await original.fetch(request); }
        finally { originals.delete(request); }
      });
      // Returning another Hono application's Response does not inherit this
      // context's prepared headers. Apply the cache policy to the actual wire.
      const headersOut = new Headers(response.headers); headersOut.set('Cache-Control', 'no-store');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: headersOut });
  };
  original.get('/api/antigravity/usage', async context => {
    if (!readUsage) return context.json({ usage: null });
    try { return context.json({ usage: await readUsage() }); }
    catch { return context.json({ error: 'antigravity_usage_unavailable' }, 503); }
  });
  for (const route of ['/api/health', '/api/config/debug', '/api/gateway/status', '/api/antigravity/usage']) app.get(route, dispatch);
  if (deps.commands) app.post('/api/gateway/restart', dispatch);
  let closing: Promise<void> | undefined;
  return Object.freeze({ close: () => {
    closed = true;
    // Both admission lanes freeze synchronously; retain physical provider work
    // in addition to any bounded request that already returned a deadline.
    return closing ??= Promise.all([authority.close(), system.close()]).then(() => undefined);
  } });
}
