import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AsyncConnectorClientResolver } from '../hub/async-connector-client.js';
import type { AsyncHubSharedDirectory } from '../hub/async-shared-directory.js';
import type { AsyncHubSharedReadsPort } from '../hub/async-shared-reads.js';
import type { AsyncSharedCommandPort } from '../hub/shared-command-port.js';
import type { HubEventBrokers } from '../hub/event-broker.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { HubRequestWork } from '../hub/async-request-work.js';
import { OriginalTransportDrain } from '../connector/transport.js';
import { cancelGuardedBody } from '../connector/guarded-body.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { hasBoardCapabilityCredential } from './workspace-agent.js';
import { registerHubSharedDirectoryRoutes } from './hub-shared-directory.js';
import { registerHubSharedCommandRoutes } from './hub-shared-commands.js';
import { registerHubSharedReadRoutes } from './hub-shared-reads.js';

/** Deliberately excludes creation, grants and arbitrary shared suffixes. */
export function isAsyncHubSharedSessionRequest(method: string, path: string): boolean {
  const read = method === 'GET' || method === 'HEAD';
  if (read && /^\/api\/hub\/v1\/shared\/[^/]+\/connections\/[^/]+\/grants\/[^/]+\/sessions$/.test(path)) return true;
  const suffix = /^\/api\/hub\/v1\/shared\/[^/]+\/sessions\/[^/]+\/(.+)$/.exec(path)?.[1];
  if (!suffix) return false;
  if (read) return /^(?:state|events\/stream|messages|messages\/[^/]+(?:\/media\/[^/]+)?|queue|commands\/[^/]+(?:\/queue(?:\/commands\/[^/]+)?)?)$/.test(suffix);
  return method === 'POST' && (suffix === 'messages' || suffix === 'voice/admission')
    || (method === 'PATCH' || method === 'DELETE') && /^commands\/[^/]+\/queue$/.test(suffix);
}

/** Complete shared business package. No store, principal, synchronous resolver
 * or fake legacy object is accepted. Close retains HTTP bodies, streams,
 * original transport cancellation and database ACKs independently. */
export function registerAsyncHubSharedSessions(app: Hono, deps: {
  mode: 'async'; directory: Pick<AsyncHubSharedDirectory, 'sessions' | 'close'>;
  reads: AsyncHubSharedReadsPort; commands: AsyncSharedCommandPort;
  connector: AsyncConnectorClientResolver; brokers: HubEventBrokers;
  diagnostics?: PerformanceDiagnostics;
}) {
  if (deps.mode !== 'async' || typeof deps.directory?.sessions !== 'function'
    || typeof deps.directory?.close !== 'function' || typeof deps.reads?.open !== 'function'
    || typeof deps.reads?.close !== 'function' || typeof deps.commands?.open !== 'function'
    || typeof deps.commands?.close !== 'function' || typeof deps.connector !== 'function') throw Error('hub_shared_session_ports_required');
  const work = new HubRequestWork(), routes = new Hono(), controller = new AbortController();
  const checks = new WeakMap<Request, () => void | PromiseLike<void>>();
  const streams = new Set<{ cancel(): Promise<void> }>(), transports = new Set<OriginalTransportDrain>();
  const diagnostics = deps.diagnostics ?? performanceDiagnostics;
  const transport = async <T>(open: (drain: OriginalTransportDrain) => Promise<T>): Promise<T> => {
    work.check();
    if (transports.size >= 256) throw new HubMemberRequestError(503);
    const drain = new OriginalTransportDrain(); transports.add(drain);
    try { return await open(drain); }
    finally { void drain.wait().then(() => transports.delete(drain)); }
  };
  const retainMedia = async (response: Response, signal: AbortSignal) => {
    try { work.check(); if (streams.size >= 256) throw new HubMemberRequestError(503); }
    catch (error) {
      if (response.body) {
        try { await response.body.cancel(); } catch { /* Original hook below. */ }
        await cancelGuardedBody(response.body);
      }
      throw error;
    }
    if (!response.body) return response;
    const source = response.body, reader = source.getReader();
    let output!: ReadableStreamDefaultController<Uint8Array>, ended = false, cancelling: Promise<void> | undefined;
    const remove = () => { signal.removeEventListener('abort', abort); streams.delete(entry); };
    const cancel = (): Promise<void> => {
      if (cancelling) return cancelling;
      if (ended) return Promise.resolve();
      ended = true;
      cancelling = Promise.resolve().then(async () => {
        try {
          try { await reader.cancel(); } catch { /* An errored stream can skip its hook. */ }
          await cancelGuardedBody(source);
        } finally { reader.releaseLock(); remove(); }
      });
      return cancelling;
    };
    const entry = { cancel: async () => { if (!ended) output.error(new HubMemberRequestError(503)); await cancel(); } };
    const abort = () => { void entry.cancel().catch(() => {}); };
    streams.add(entry);
    const body = new ReadableStream<Uint8Array>({
      start(out) { output = out; signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); },
      async pull(out) {
        try {
          const next = await work.run(() => reader.read());
          if (ended) return;
          if (next.done) { ended = true; reader.releaseLock(); remove(); out.close(); }
          else out.enqueue(next.value);
        } catch (error) { if (!ended) out.error(error); await cancel(); }
      },
      cancel,
    }, { highWaterMark: 0 });
    return new Response(body, { status: response.status, headers: response.headers });
  };
  routes.use('*', async (c, next) => {
    if (!isAsyncHubSharedSessionRequest(c.req.method, c.req.path)) return next();
    c.header('Cache-Control', 'no-store');
    if (hasBoardCapabilityCredential(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
    const trace = guardedTrace(diagnostics, 'hub-shared-session-http'); let failed = true;
    const warning = setTimeout(() => trace.reportPending({ pending: work.pending }), 30_000); warning.unref();
    try {
      await work.run(async () => { await next(); work.check(); await checks.get(c.req.raw)?.(); work.check(); });
      failed = c.res.status >= 500;
    } catch (error) {
      // A failed final delivery fence must not orphan a response already
      // opened by the handler (notably media/SSE headers).
      try { await c.res.body?.cancel(); } catch { /* Original stream owner retains its ACK. */ }
      const raw = error instanceof HubMemberRequestError || error instanceof HTTPException ? error.status : 503;
      c.res = c.json({ error: raw === 409 ? 'Authenticated account or Hub changed; reload before continuing' : 'Shared resource unavailable' }, raw === 499 ? 503 : raw);
    } finally { clearTimeout(warning); checks.delete(c.req.raw); trace.finish(failed); }
  });
  registerHubSharedDirectoryRoutes(routes, { mode: 'async', asyncDirectory: deps.directory });
  registerHubSharedCommandRoutes(routes, { mode: 'async', asyncSharedCommands: {
    async open(request, target) {
      work.check(); const port = await deps.commands.open(request, target); work.check(); checks.set(request, port.read); return port;
    }, close: () => deps.commands.close(),
  } });
  registerHubSharedReadRoutes(routes, { mode: 'async', asyncSharedReads: {
    async open(request, target) {
      work.check(); const port = await deps.reads.open(request, target); work.check(); checks.set(request, port.read); return port;
    }, close: () => deps.reads.close(),
  }, asyncConnectorClient: deps.connector, brokers: deps.brokers, lifetime: { work, signal: controller.signal, transport, retainMedia } });
  app.route('/', routes);
  const drain = createIndependentDrain([
    () => work.close(),
    async () => { controller.abort(); await Promise.all([...streams].map(stream => stream.cancel())); },
    async () => { while (transports.size) await Promise.all([...transports].map(item => item.wait())); },
    () => deps.directory.close(), () => deps.reads.close(), () => deps.commands.close(),
  ], 'hub-route-drain', diagnostics);
  return { close: drain, get pending() { return work.pending + streams.size + transports.size; } };
}
