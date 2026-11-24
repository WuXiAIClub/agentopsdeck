import type { Context, Hono } from 'hono';
import { CONNECTOR_SCOPES, type ConnectorScope, type ConnectorTokenStore } from '../auth/connector-token.js';
import { readJsonBody } from '../utils/http-body.js';
import { synchronousAuthorizationCall } from '../auth/synchronous-authorization.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { AuthPersistenceError } from '../auth/private-store.js';

/** Operator-only provisioning, never promoted from a normal Connector scope. */
export function registerConnectorTokenRoutes(app: Hono, deps: {
  tokens: ConnectorTokenStore; isAuthorizedRequest: (request: Request) => boolean; diagnostics?: PerformanceDiagnostics;
}) {
  const path = '/api/connector/v1/tokens';
  const diagnostics = deps.diagnostics ?? performanceDiagnostics;
  function storage<T>(step: 1 | 2 | 3, work: () => T): T {
    const trace = diagnostics.start('connector-token-storage'); trace.add('step', step);
    let failed = true;
    try { const value = work(); trace.add('settled', 1); failed = false; return value; }
    catch { trace.add('unknown', 1); throw new AuthPersistenceError(); }
    finally { trace.finish(failed); }
  }
  // Provisioning is still a synchronous authority/effect boundary. Awaiting a
  // boolean here would cache permission across the final persistent mutation.
  function authorizationFailure(c: Context) {
    try {
      if (!synchronousAuthorizationCall(deps.isAuthorizedRequest, [c.req.raw], undefined, undefined, diagnostics))
        return c.json({ error: 'unauthorized' }, 401);
    } catch { return c.json({ error: 'auth_persistence_failed' }, 503); }
    return undefined;
  }
  app.get(path, (c) => {
    c.header('Cache-Control', 'no-store');
    const refusal = authorizationFailure(c); if (refusal) return refusal;
    try { return c.json({ tokens: storage(1, () => deps.tokens.list()) }); }
    catch { return c.json({ error: 'Token storage unavailable' }, 503); }
  });
  app.post(path, async (c) => {
    c.header('Cache-Control', 'no-store');
    const initialRefusal = authorizationFailure(c); if (initialRefusal) return initialRefusal;
    const raw = await readJsonBody(c.req.raw, 8 * 1024);
    const finalRefusal = authorizationFailure(c); if (finalRefusal) return finalRefusal;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return c.json({ error: 'Invalid token configuration' }, 400);
    const body = raw as Record<string, unknown>;
    if (Object.keys(body).some(key => !['label', 'scopes', 'delegationHubId'].includes(key))
      || (body.label !== undefined && (typeof body.label !== 'string' || body.label.length > 256))
      || (body.scopes !== undefined && (!Array.isArray(body.scopes) || !body.scopes.length
        || body.scopes.length > CONNECTOR_SCOPES.length
        || body.scopes.some(scope => !CONNECTOR_SCOPES.includes(scope as ConnectorScope))))
      || (body.delegationHubId !== undefined && (typeof body.delegationHubId !== 'string'
        || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(body.delegationHubId)
        || !Array.isArray(body.scopes) || !body.scopes.includes('messages:send') || !body.scopes.includes('execution:delegate')))) {
      return c.json({ error: 'Invalid token configuration' }, 400);
    }
    try {
      return c.json(storage(2, () => deps.tokens.create({ label: body.label as string ?? 'Hub connector token',
        ...(body.scopes ? { scopes: body.scopes as ConnectorScope[] } : {}),
        ...(body.delegationHubId !== undefined ? { delegationHubId: body.delegationHubId as string } : {}) })), 201);
    } catch { return c.json({ error: 'Token storage unavailable' }, 503); }
  });
  app.delete(`${path}/:id`, (c) => {
    c.header('Cache-Control', 'no-store');
    const refusal = authorizationFailure(c); if (refusal) return refusal;
    try {
      const ok = storage(3, () => deps.tokens.revoke(c.req.param('id')));
      return c.json({ ok }, ok ? 200 : 404);
    } catch { return c.json({ error: 'Token storage unavailable' }, 503); }
  });
}
