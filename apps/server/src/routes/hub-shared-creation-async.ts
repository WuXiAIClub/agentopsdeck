import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { reply } from '../commands/http.js';
import type { AsyncHubSharedCreationPort, HubSharedCreationRequest } from '../hub/async-shared-creation.js';
import type { AsyncHubCreationDiscovery } from '../hub/async-creation-discovery.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { HubRequestWork } from '../hub/async-request-work.js';
import { readJsonBody } from '../utils/http-body.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { hasBoardCapabilityCredential } from './workspace-agent.js';

const path = '/api/hub/v1/shared/:ownerUserId/connections/:connectionId/agents/:agentId/sessions';
type Discovery = Pick<AsyncHubCreationDiscovery, 'environments' | 'close'>;
export function isAsyncHubSharedCreationRequest(method: string, path: string) {
  const read = method === 'GET' || method === 'HEAD';
  return read && path === '/api/hub/v1/shared/creation-environments'
    || method === 'POST' && /^\/api\/hub\/v1\/shared\/[^/]+\/connections\/[^/]+\/agents\/[^/]+\/sessions$/.test(path)
    || read && /^\/api\/hub\/v1\/shared\/[^/]+\/connections\/[^/]+\/agents\/[^/]+\/sessions\/creation-commands\/[^/]+$/.test(path);
}

// Shared with the explicit transitional composition, not a synchronous fallback.
export function registerSharedCreationDiscovery(app: Hono, discovery: Pick<Discovery, 'environments'>) {
  app.get('/api/hub/v1/shared/creation-environments', async context => {
    context.header('Cache-Control', 'no-store');
    try { return context.json(await discovery.environments(context.req.raw, context.req.query('after') ?? '')); }
    catch (error) {
      if (error instanceof HubMemberRequestError && error.status !== 503) {
        if (error.status === 499) return new Response(null, { status: 499 });
        throw new HTTPException(error.status);
      }
      return context.json({ error: 'Creation environments are temporarily unavailable. Reload to refresh permissions.' }, 503);
    }
  });
}

export function registerSharedCreationCommands(app: Hono, creation: Pick<AsyncHubSharedCreationPort, 'open'>) {
  const open = (context: Context) => {
    context.header('Cache-Control', 'no-store');
    if (context.req.param('agentId') !== 'codex') throw new HTTPException(403);
    return creation.open(context.req.raw, { ownerUserId: context.req.param('ownerUserId')!, connectionId: context.req.param('connectionId')! });
  };
  const refuse = (context: Context, error: unknown) => {
    if (error instanceof HTTPException) throw error;
    if (error instanceof HubMemberRequestError && error.status !== 503) {
      if (error.status === 499) return new Response(null, { status: 499 });
      return context.json({ error: error.status === 409 ? 'Creation command identity conflicts' : 'Shared creation is not authorized' }, error.status);
    }
    return context.json({ error: 'Shared creation temporarily unavailable' }, 503);
  };
  app.get(`${path}/creation-commands/:commandKey`, async context => {
    try {
      const target = await open(context), key = context.req.param('commandKey');
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) return context.json({ error: 'Invalid creation command key' }, 400);
      const receipt = await target.recover(key);
      if (!receipt) return context.json({ error: 'Creation command not found' }, 404);
      return context.json({ command: receipt });
    } catch (error) { return refuse(context, error); }
  });
  app.post(path, async context => {
    try {
      const target = await open(context), raw = await readJsonBody(context.req.raw, 8 * 1024);
      await target.check(); context.req.raw.signal.throwIfAborted();
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['label', 'idempotencyKey'].includes(key))) return context.json({ error: 'Invalid creation payload' }, 400);
      const body = raw as Record<string, unknown>, header = context.req.header('idempotency-key'), key = header ?? body.idempotencyKey;
      if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)
        || (header !== undefined && body.idempotencyKey !== undefined && body.idempotencyKey !== header)) return context.json({ error: 'Consistent creation command key required' }, 400);
      if (typeof body.label !== 'string' || !body.label.trim() || body.label.length > 256) return context.json({ error: 'Session name must contain 1–256 characters' }, 400);
      const receipt = await target.send(key, { label: body.label });
      context.header('X-AgentOpsDeck-Command-Key', key);
      return reply(context, receipt);
    } catch (error) { return refuse(context, error); }
  });
}

/** No store, principal or sync resolver exists in this production composition.
 * The caller delegates these private ports' lifetime, not database ownership. */
export function registerAsyncHubSharedCreation(app: Hono, deps: {
  mode: 'async'; creation: AsyncHubSharedCreationPort; discovery: Discovery; diagnostics?: PerformanceDiagnostics;
}) {
  if (deps.mode !== 'async' || typeof deps.creation?.open !== 'function' || typeof deps.creation?.close !== 'function'
    || typeof deps.discovery?.environments !== 'function' || typeof deps.discovery?.close !== 'function') throw Error('hub_shared_creation_ports_required');
  const work = new HubRequestWork(), child = new Hono(), checks = new WeakMap<Request, HubSharedCreationRequest['check']>();
  const diagnostics = deps.diagnostics ?? performanceDiagnostics;
  child.use('*', async (c, next) => {
    if (!isAsyncHubSharedCreationRequest(c.req.method, c.req.path)) return next();
    c.header('Cache-Control', 'no-store');
    if (hasBoardCapabilityCredential(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
    const trace = guardedTrace(diagnostics, 'hub-shared-creation-http');
    const timer = setTimeout(() => trace.reportPending({ pending: work.pending }), 30000); timer.unref();
    try {
      await work.run(async () => { await next(); work.check(); await checks.get(c.req.raw)?.(); work.check(); });
    } catch (error) {
      const raw = error instanceof HubMemberRequestError || error instanceof HTTPException ? error.status : 503;
      c.res = raw === 499 ? new Response(null, { status: 499 })
        : c.json({ error: 'Shared creation authority unavailable' }, raw);
    } finally { clearTimeout(timer); checks.delete(c.req.raw); trace.finish(c.res.status >= 500); }
  });
  registerSharedCreationDiscovery(child, { async environments(request, after) {
    work.check(); const value = await deps.discovery.environments(request, after); work.check(); return value;
  } });
  registerSharedCreationCommands(child, { async open(request, target) {
    work.check(); const value = await deps.creation.open(request, target); work.check(); checks.set(request, value.check); return value;
  } });
  app.route('/', child);
  const close = createIndependentDrain([() => work.close(), () => deps.creation.close(), () => deps.discovery.close()], 'hub-route-drain', diagnostics);
  return { close, get pending() { return work.pending; } };
}
