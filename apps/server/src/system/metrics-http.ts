import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { publicSystemMetrics, validSystemMetrics, type SystemMetrics } from '@agentopsdeck/shared';
import type { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { MetricsSampler } from './metrics.js';
import type { HubStore } from '../hub/hub-store.js';
import type { HubPrincipal } from '../hub/identity.js';
import type { ConnectorClientResolver } from '../hub/connector-client.js';
import { ConnectorClientError } from '../hub/connector-client.js';
import { ReadRequestOwner, ReadRequestError } from '../lifecycle/read-request-owner.js';
import { AsyncHubMemberRequests, HubMemberRequestError } from '../hub/async-member-request.js';
import type { AsyncConnectorClientResolver } from '../hub/async-connector-client.js';
type Awaitable<T> = T | PromiseLike<T>;
export type MetricsReadAuthority = (c: Context) => Awaitable<() => Awaitable<void>>;
export function registerMetricsRead(app: Hono, path: string,
  sampler: { sample(): Promise<SystemMetrics>; close(): Promise<void> }, authorize: MetricsReadAuthority,
  options: { diagnostics?: PerformanceDiagnostics; requestWaitMs?: number } = {}) {
  const reads = new ReadRequestOwner('system-read-wait', { diagnostics: options.diagnostics, waitMs: options.requestWaitMs });
  app.get(path, async c => {
    c.header('Cache-Control', 'no-store');
    try {
      const result = await reads.run(c.req.raw, async context => {
        const check = (await context.stage(1, () => authorize(c))).value;
        const sampled = await context.stage(2, () => sampler.sample());
        await context.stage(3, check);
        return publicSystemMetrics(sampled.value);
      });
      return c.json(result.value);
    } catch (error) {
      return Response.json({ error: 'Metrics unavailable' }, { headers: { 'Cache-Control': 'no-store' }, status: error instanceof HTTPException ? error.status
        : error instanceof ReadRequestError || error instanceof HubMemberRequestError ? error.status : 503 });
    }
  });
  let closing: Promise<void> | undefined;
  return { close(): Promise<void> {
    return closing ??= Promise.all([reads.close(), sampler.close()]).then(() => undefined);
  } };
}

/** Complete async production chain: original evidence -> owner directory ->
 * original transport -> atomic identity/directory/target-epoch delivery proof.
 * The caller owns requests until these original reads have drained. */
export function registerAsyncHubMetrics(app: Hono, requests: AsyncHubMemberRequests,
  resolve: AsyncConnectorClientResolver, hubId: string, sampler: MetricsSampler,
  options: { diagnostics?: PerformanceDiagnostics; requestWaitMs?: number } = {}) {
  const base = '/api/hub/v1/system/metrics';
  const sources = new ReadRequestOwner('hub-metrics-sources-read', { diagnostics: options.diagnostics, waitMs: options.requestWaitMs });
  const remotes = new ReadRequestOwner('system-read-wait', { diagnostics: options.diagnostics, waitMs: options.requestWaitMs });
  const local = registerMetricsRead(app, `${base}/hub`, sampler, async c => {
    const handle = await requests.begin(c.req.raw);
    if (!handle.principal.admin) throw new HTTPException(403);
    return handle.check;
  }, options);
  app.get(`${base}/sources`, async c => {
    c.header('Cache-Control', 'no-store');
    try {
      const result = await sources.run(c.req.raw, async context => {
        const handle = (await context.stage(41, () => requests.begin(c.req.raw))).value;
        const directory = (await context.stage(42, () => handle.connectionDirectory())).value;
        const visible = [
          ...(handle.principal.admin ? [{ key: 'hub', kind: 'hub', id: hubId, label: 'Hub' }] : []),
          ...directory.connections.filter(v => v.nodeId && v.status !== 'disabled')
            .map(v => ({ key: v.id, kind: 'connector', id: v.nodeId, label: v.label })),
        ];
        await context.stage(43, () => directory.check());
        context.check(); return visible;
      });
      return c.json({ sources: result.value });
    } catch (error) {
      return Response.json({ error: c.req.raw.signal.aborted ? 'request_cancelled' : 'Metrics sources temporarily unavailable' },
        { headers: { 'Cache-Control': 'no-store' }, status: c.req.raw.signal.aborted ? 499 : error instanceof HubMemberRequestError || error instanceof ReadRequestError ? error.status : 503 });
    }
  });
  app.get(`${base}/connectors/:connectionId`, async c => {
    c.header('Cache-Control', 'no-store');
    try {
      const result = await remotes.run(c.req.raw, async context => {
        const handle = (await context.stage(51, () => requests.begin(c.req.raw))).value;
        const directory = (await context.stage(52, () => handle.connectionDirectory())).value;
        const id = c.req.param('connectionId'), connection = directory.connections.find(v => v.id === id);
        if (!connection?.nodeId || connection.status === 'disabled') throw new HTTPException(404);
        const client = (await context.stage(53, () => resolve(c.req.raw, id, { expectedUserId: handle.principal.userId }))).value;
        // Advisory abort ends the HTTP wait, not ownership of the original
        // dispatch/body cancellation ACK. Shutdown must retain both.
        const value = (await context.stage(54, () => client.jsonOriginal<unknown>('/system/metrics', {
          signal: AbortSignal.any([context.signal, AbortSignal.timeout(5000)]),
        }))).value;
        if (!validSystemMetrics(value) || value.source.kind !== 'connector' || value.source.id !== connection.nodeId) throw new HTTPException(502);
        await context.stage(55, () => directory.check(id));
        context.check(); return publicSystemMetrics(value);
      });
      return c.json(result.value);
    } catch (error) {
      return Response.json({ error: 'Metrics unavailable; explicit system:metrics:read permission required' },
        { headers: { 'Cache-Control': 'no-store' }, status: error instanceof HTTPException ? error.status : error instanceof HubMemberRequestError || error instanceof ReadRequestError ? error.status
          : error instanceof ConnectorClientError && [401,403,404].includes(error.status) ? 403 : 503 });
    }
  });
  let closing: Promise<void> | undefined;
  return { close: () => closing ??= Promise.all([local.close(), sources.close(), remotes.close()]).then(() => undefined) };
}

export function registerHubMetrics(app: Hono, store: HubStore, principal: (c: Context) => Awaitable<HubPrincipal>,
  client: ConnectorClientResolver, sampler: MetricsSampler,
  options: { diagnostics?: PerformanceDiagnostics; requestWaitMs?: number } = {}) {
  const base = '/api/hub/v1/system/metrics';
  const sources = new ReadRequestOwner('hub-metrics-sources-read', { diagnostics: options.diagnostics, waitMs: options.requestWaitMs });
  const remotes = new ReadRequestOwner('system-read-wait', { diagnostics: options.diagnostics, waitMs: options.requestWaitMs });
  const local = registerMetricsRead(app, `${base}/hub`, sampler, async c => {
    const actor = await principal(c);
    if (!actor.admin) throw new HTTPException(403);
    const userId = actor.userId;
    return async () => { const current = await principal(c); if (!current.admin || current.userId !== userId) throw new HTTPException(403); };
  }, options);
  app.get(`${base}/sources`, async c => {
    c.header('Cache-Control', 'no-store');
    try {
      const result = await sources.run(c.req.raw, async context => {
        const actor = (await context.stage(41, () => principal(c))).value;
        const userId = actor.userId, admin = actor.admin;
        const generation = store.connectionDirectoryVersion(userId);
        const connections = (await context.stage(42, () => store.listConnectionsAsync(userId))).value;
        const current = (await context.stage(43, () => principal(c))).value;
        if (current.userId !== userId || current.admin !== admin) throw new HTTPException(403);
        if (generation !== store.connectionDirectoryVersion(userId)) throw new HTTPException(503);
        const visible = [
          ...(admin ? [{ key: 'hub', kind: 'hub', id: store.identities.hubId, label: 'Hub' }] : []),
          ...connections.filter(v => v.nodeId && v.status !== 'disabled').map(v => ({ key: v.id, kind: 'connector', id: v.nodeId, label: v.label })),
        ];
        context.check(); return visible;
      });
      return c.json({ sources: result.value });
    } catch (error) {
      if (c.req.raw.signal.aborted) return new Response(JSON.stringify({ error: 'request_cancelled' }), {
        status: 499, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
      return c.json({ error: 'Metrics sources temporarily unavailable' }, error instanceof HTTPException ? error.status : 503);
    }
  });
  app.get(`${base}/connectors/:connectionId`, async c => {
    c.header('Cache-Control', 'no-store');
    try {
      const result = await remotes.run(c.req.raw, async context => {
        const actor = (await context.stage(51, () => principal(c))).value;
        const userId = actor.userId, id = c.req.param('connectionId');
        const generation = store.connectionDirectoryVersion(userId);
        const connection = (await context.stage(52, () => store.getConnection(id, userId))).value;
        const nodeId = connection?.nodeId, status = connection?.status;
        const authority = (await context.stage(53, () => store.connectionAuthority(id, userId))).value;
        if (!nodeId || status === 'disabled' || authority === undefined) throw new HTTPException(404);
        const value = (await context.stage(54, () => client(id, false, userId).json<unknown>('/system/metrics', {
          signal: AbortSignal.any([context.signal, AbortSignal.timeout(5000)]),
        }))).value;
        const latest = (await context.stage(56, () => store.getConnection(id, userId))).value;
        const latestAuthority = (await context.stage(57, () => store.connectionAuthority(id, userId))).value;
        const current = (await context.stage(55, () => principal(c))).value;
        if (current.userId !== userId || latest?.nodeId !== nodeId || latest?.status === 'disabled' || latestAuthority !== authority) throw new HTTPException(403);
        if (generation !== store.connectionDirectoryVersion(userId)) throw new HTTPException(503);
        if (!validSystemMetrics(value) || value.source.kind !== 'connector' || value.source.id !== nodeId) throw new HTTPException(502);
        context.check(); return publicSystemMetrics(value);
      });
      return c.json(result.value);
    } catch (error) {
      return c.json({ error: 'Metrics unavailable; explicit system:metrics:read permission required' },
        error instanceof HTTPException ? error.status : error instanceof ConnectorClientError && [401, 403, 404].includes(error.status) ? 403
          : error instanceof ReadRequestError ? error.status : 503);
    }
  });
  let closing: Promise<void> | undefined;
  return { close(): Promise<void> {
    return closing ??= Promise.all([local.close(), sources.close(), remotes.close()]).then(() => undefined);
  } };
}
