import type { Hono } from 'hono';
import { ConnectorUsersRequestError, type ConnectorUsersRequestPort } from './async-users-request.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { normalizeConnectorUserLabel } from './users-format.js';

/** Shared wire format for the synchronous and eventual complete async root.
 * Reads/retries here never send a user message or repeat an unknown SQL write. */
export function registerConnectorUsersHttp(app: Hono, base: string, users: ConnectorUsersRequestPort,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30_000) {
  // HTTP settlement is not COMMIT evidence. An observation deadline never
  // cancels accepted work, replaces its owner, or retries an unknown write.
  const observe = async (step: 1 | 2 | 3, work: () => Promise<Response>): Promise<Response> => {
    const trace = guardedTrace(diagnostics, 'connector-users-http'); trace.add('step', step);
    const timer = setTimeout(() => trace.reportPending({ pending: 1 }),
      Number.isFinite(warningMs) && warningMs > 0 ? warningMs : 30_000);
    timer.unref();
    let status = 503;
    try {
      let response: Response;
      try { response = await work(); }
      catch (error) {
        response = Response.json({ error: 'connector_storage_unavailable' },
          { status: error instanceof ConnectorUsersRequestError ? error.status : 503 });
      }
      status = response.status; return response;
    } finally {
      clearTimeout(timer); trace.add('settled', 1);
      if (status >= 500) trace.add('unknown', 1);
      else if (status >= 400) trace.add('deferred', 1);
      trace.finish(status >= 400);
    }
  };
  app.get(`${base}/users`, c => observe(1, async () => {
    c.header('Cache-Control', 'no-store');
    const result = await users.list(c.req.raw);
    if (!result.authorized) return c.json({ error: 'missing users:read scope' }, 403);
    return c.json({ users: result.value, updatedAt: Date.now() });
  }));
  app.post(`${base}/users`, c => observe(2, async () => {
    c.header('Cache-Control', 'no-store');
    if (!await users.authorize(c.req.raw, 'users:write')) return c.json({ error: 'missing users:write scope' }, 403);
    const body: unknown = await c.req.json().catch(() => ({}));
    const label = body && typeof body === 'object' ? (body as { label?: unknown }).label : undefined;
    if (typeof label !== 'string' || !label.trim()) return c.json({ error: 'label is required' }, 400);
    const result = await users.create(c.req.raw, normalizeConnectorUserLabel(label));
    if (!result.authorized) return c.json({ error: 'missing users:write scope' }, 403);
    return c.json({ user: result.value, updatedAt: Date.now() }, 201);
  }));
  app.patch(`${base}/users/:userId`, c => observe(3, async () => {
    c.header('Cache-Control', 'no-store');
    if (!await users.authorize(c.req.raw, 'users:write')) return c.json({ error: 'missing users:write scope' }, 403);
    const body: unknown = await c.req.json().catch(() => ({}));
    const label = body && typeof body === 'object' ? (body as { label?: unknown }).label : undefined;
    if (typeof label !== 'string' || !label.trim()) return c.json({ error: 'label is required' }, 400);
    const result = await users.update(c.req.raw, c.req.param('userId'), normalizeConnectorUserLabel(label));
    if (!result.authorized) return c.json({ error: 'missing users:write scope' }, 403);
    if (!result.value) return c.json({ error: 'connector user not found' }, 404);
    return c.json({ user: result.value, updatedAt: Date.now() });
  }));
}
