import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AsyncHubMemberRequests } from '../hub/async-member-request.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { normalizeConnectorUrl, type HubConnection } from '../hub/hub-store.js';
import type { HubConnectionCreate, HubConnectionPatch } from '../hub/member-connection-change-domain.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

type Action = 'create' | 'patch' | 'delete' | 'maintenance';
type Authority = Awaited<ReturnType<AsyncHubMemberRequests['begin']>>;
type Target = Awaited<ReturnType<Authority['connection']>>;

/** Awaited HTTP boundary for the existing complete Hub owner, not activation.
 * Every effect keeps its original credential/scope/epoch proof in the worker's
 * savepoint. This facade owns neither a writer nor worker close/restart rights.
 * Display failure does not turn a settled create into a duplicate-save prompt. */
export function registerAsyncHubConnectionMutations(app: Hono, deps: {
  requests: Pick<AsyncHubMemberRequests, 'begin'>;
  present(connection: HubConnection, users: Array<{ id: string; label: string }>): unknown;
  diagnostics?: PerformanceDiagnostics;
  warningMs?: number;
}) {
  const diagnostics = deps.diagnostics ?? performanceDiagnostics;
  const warningMs = deps.warningMs ?? 30_000;
  if (!Number.isSafeInteger(warningMs) || warningMs < 1 || warningMs > 2_147_483_647)
    throw new Error('Invalid connection mutation warning interval');
  let closed = false;
  const run = async (c: Context, action: Action) => {
    c.header('Cache-Control', 'no-store');
    // One credential snapshot for both effect and optional decoration. A body
    // await or diagnostic callback must not switch the latter to another login.
    const raw = c.req.raw;
    const request = new Request(raw.url, { headers: new Headers(raw.headers), signal: raw.signal });
    const trace = guardedTrace(diagnostics, 'hub-connection-mutation');
    // Same stable HTTP phase IDs as the original synchronous facade.
    let step = 1, failed = true, effectStarted = false;
    let authority: Authority | undefined;
    const current = async () => {
      if (closed) throw new HubMemberRequestError(503);
      await authority?.check();
      if (closed) throw new HubMemberRequestError(503);
    };
    const warning = setTimeout(() => trace.reportPending({ step, pending: 1 }), warningMs);
    warning.unref();
    const missing = () => c.json(action === 'delete' ? { ok: false } : { error: 'connection not found' }, 404);
    try {
      await current();
      authority = await deps.requests.begin(request);
      await current();
      const id = action === 'maintenance' ? c.req.param('connectionId') : c.req.param('id');
      let target: Target | undefined;
      if (action !== 'create') {
        if (!id) return missing();
        target = await authority.connection(id);
      }
      step = 2;
      const body: unknown = action === 'delete' ? {} : await c.req.json().catch(() => ({}));
      step = 3;
      await current();
      await target?.check();
      if (!body || typeof body !== 'object' || Array.isArray(body))
        return c.json({ error: 'invalid connection configuration' }, 400);
      const b = body as Record<string, unknown>;
      const url = action === 'create' && typeof b.connectorUrl === 'string' ? normalizeConnectorUrl(b.connectorUrl) : undefined;
      if (action === 'create' && (!url || url === 'local://aod-connector'))
        return c.json({ error: 'valid remote connectorUrl is required' }, 400);
      if (action === 'create' && (['id', 'label', 'token', 'environmentId', 'environmentLabel']
        .some(key => b[key] !== undefined && typeof b[key] !== 'string')
        || b.capabilities !== undefined && !Array.isArray(b.capabilities)))
        return c.json({ error: 'invalid connection configuration' }, 400);
      if (action === 'maintenance' && (typeof b.token !== 'string' || !b.token.trim()))
        return c.json({ error: 'token is required' }, 400);
      const configuration: HubConnectionCreate | HubConnectionPatch = action === 'create' ? {
        connectorUrl: url!,
        capabilities: Array.isArray(b.capabilities) ? b.capabilities.filter((v): v is string => typeof v === 'string')
          : ['sessions', 'messages', 'events', 'media'],
        // Preserve legacy enabled semantics; unrelated frontend fields ignored.
        enabled: b.enabled !== false,
        ...Object.fromEntries(['id', 'label', 'token', 'environmentId', 'environmentLabel']
          .filter(key => b[key] !== undefined).map(key => [key, b[key]])),
      } : {
        ...Object.fromEntries(['label', 'environmentId', 'environmentLabel']
          .filter(key => typeof b[key] === 'string').map(key => [key, b[key]])),
        ...(typeof b.enabled === 'boolean' ? { enabled: b.enabled } : {}),
      };
      await current();
      step = 4; effectStarted = true;
      trace.add('admitted', 1); // Facade invocation, not a SQL COMMIT receipt.
      const result = action === 'create' ? await authority.createConnection(configuration as HubConnectionCreate)
        : action === 'patch' ? await target!.patch(configuration)
          : action === 'maintenance' ? await target!.maintenance((b.token as string).trim()) : await target!.delete();
      trace.add('settled', 1);
      step = 5;
      await current();
      if (!result || 'error' in result) throw new HubMemberRequestError(503);
      if (action === 'delete') {
        if (!('ok' in result)) throw new HubMemberRequestError(503);
        failed = false; return c.json({ ok: result.ok }, result.ok ? 200 : 404);
      }
      const savedId = 'connection' in result ? result.connection.id : id!;
      const delivery = await authority.connection(savedId);
      if (delivery.epoch !== result.epoch) throw new HubMemberRequestError(409);
      if (action === 'maintenance') {
        await delivery.check(); await current(); failed = false;
        return c.json({ ok: true, hasMaintenanceCredential: true, updatedAt: Date.now() });
      }
      if (!('connection' in result)) throw new HubMemberRequestError(503);
      let users: Array<{ id: string; label: string }> = [], displayFailed = false;
      try {
        // Isolate optional decoration's sticky read refusal from the original
        // admitted mutation's delivery proof. Both still use original headers.
        const display = await deps.requests.begin(request);
        if (display.recoveryScope !== authority.recoveryScope
          || display.principal.userId !== authority.principal.userId
          || display.principal.admin !== authority.principal.admin) throw new HubMemberRequestError(401);
        users = (await display.connections()).users;
      }
      catch { displayFailed = true; trace.add('deferred', 1); }
      step = 6;
      await delivery.check(); await current();
      failed = displayFailed;
      return c.json({ connection: deps.present(result.connection, users), updatedAt: Date.now() }, action === 'create' ? 201 : 200);
    } catch (error) {
      if (step === 4 && effectStarted && (!(error instanceof HubMemberRequestError) || error.status === 503))
        trace.add('unknown', 1);
      try { await current(); } catch (denial) { error = denial; }
      if (error instanceof HTTPException) throw error;
      if (error instanceof HubMemberRequestError) {
        if (error.status === 404) return missing();
        const message = error.status === 409 ? 'Connection changed; reload before saving'
          : error.status === 401 ? 'unauthorized' : error.status === 403 ? 'forbidden'
            : error.status === 499 ? 'request_cancelled' : error.status === 400 ? 'invalid connection configuration' : 'hub_connections_unavailable';
        return new Response(JSON.stringify({ error: message }), { status: error.status,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
      }
      return c.json({ error: 'hub_connections_unavailable' }, 503);
    } finally { clearTimeout(warning); trace.add('step', step); trace.finish(failed); }
  };
  const base = '/api/hub/v1/connections';
  app.post(base, c => run(c, 'create'));
  app.patch(`${base}/:id`, c => run(c, 'patch'));
  app.delete(`${base}/:id`, c => run(c, 'delete'));
  app.put(`${base}/:connectionId/maintenance-credential`, c => run(c, 'maintenance'));
  return { close() { closed = true; } };
}
