import path from 'node:path';
import { lstat } from 'node:fs/promises';
import type { AgentSummary, ChatMessage, SystemMetrics } from '@agentopsdeck/shared';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { ReadRequestError, ReadRequestOwner } from '../lifecycle/read-request-owner.js';
import { inboundMediaReadDirectory } from '../messages/send-message.js';
import { summarizeToolMessage } from '../messages/tool-summary.js';
import { assertEventReplayPage, type EventReplayRead } from '../routes/events.js';
import { registerMetricsRead } from '../system/metrics-http.js';
import type { ChangeSignal } from '../utils/change-signal.js';
import { verifiedFileResponse } from '../utils/file-response.js';
import { mimeTypeFor } from '../utils/mime.js';
import { registerConnectorAgentRoutes } from './agents-http.js';
import { cancelGuardedBody } from './guarded-body.js';
import type { ConnectorReadAuthority } from './read-authority.js';

export type ConnectorPublicReads = {
  authority: ConnectorReadAuthority;
  changes: Pick<ChangeSignal, 'revision' | 'wait'>;
  replay: EventReplayRead;
  agents(): AgentSummary[] | PromiseLike<AgentSummary[]>;
  sampler: { sample(): Promise<SystemMetrics>; close(): Promise<void> };
  connector: { environmentId: string; environmentLabel: string };
  /** Trusted composition configuration, never an HTTP path. */
  mediaRoot?: string | ((name: string) => string);
  diagnostics?: PerformanceDiagnostics;
  waitMs?: number;
};

/** Public read transports, shared by the original runtime and the worker root.
 * No SQL store/token object, no command side effects and no fallback dispatch. */
export function registerConnectorPublicReads(app: Hono, base: string, deps: ConnectorPublicReads) {
  const diagnostics = deps.diagnostics ?? performanceDiagnostics;
  const connector = { ...deps.connector };
  const mediaRoot = deps.mediaRoot ?? inboundMediaReadDirectory;
  const reads = new ReadRequestOwner('connector-event-stream', { diagnostics, waitMs: deps.waitMs, limit: 128 });
  const mediaReads = new ReadRequestOwner('connector-event-projection', { diagnostics, waitMs: deps.waitMs, limit: 64 });
  const agents = registerConnectorAgentRoutes(app, { tokens: deps.authority, agents: () => deps.agents(),
    diagnostics, ...(deps.waitMs === undefined ? {} : { requestWaitMs: deps.waitMs }) });
  let closed = false, closing: Promise<void> | undefined;
  const metrics = registerMetricsRead(app, `${base}/system/metrics`, deps.sampler, async c => {
    if (closed) throw new HTTPException(503);
    const handle = await deps.authority.begin(c.req.raw, 'system:metrics:read');
    return async () => { if (closed) throw new HTTPException(503); await handle.check(); };
  }, { diagnostics, ...(deps.waitMs === undefined ? {} : { requestWaitMs: deps.waitMs }) });
  type Lifetime = { controller: AbortController; drained: Promise<void>; finish(): void };
  const streams = new Set<Lifetime>(), media = new Set<Lifetime>();
  function lifetime(set: Set<Lifetime>, request: Request): Lifetime {
    const controller = new AbortController();
    let resolve!: () => void, finished = false;
    const abort = () => controller.abort();
    const entry: Lifetime = { controller, drained: new Promise<void>(yes => { resolve = yes; }), finish() {
      if (finished) return;
      finished = true; request.signal.removeEventListener('abort', abort);
      set.delete(entry); resolve();
    } };
    set.add(entry); request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    return entry;
  }
  const responseError = (error: unknown) => error instanceof HTTPException ? error.status
    : error instanceof ReadRequestError ? error.status : 503;

  app.get(`${base}/media/inbound/:name`, async c => {
    c.header('Cache-Control', 'no-store');
    if (closed || media.size >= 64) return c.json({ error: 'Connector media unavailable' }, 503);
    const entry = lifetime(media, c.req.raw);
    const request = new Request(c.req.raw, { signal: entry.controller.signal });
    let handedOff = false;
    let opened: Response | undefined;
    try {
      const result = await mediaReads.run(request, async context => {
        const { value: handle } = await context.stage(1, () => deps.authority.begin(request, 'media:read'));
        let name: string;
        try { name = decodeURIComponent(c.req.param('name')); } catch { throw new HTTPException(400); }
        if (!name || name !== path.basename(name) || !/^[\w.-]+$/.test(name)) throw new HTTPException(400);
        const filePath = path.join(typeof mediaRoot === 'function' ? mediaRoot(name) : mediaRoot, name);
        const { value: info } = await context.stage(2, () => lstat(filePath).catch(() => { throw new HTTPException(404); }));
        await context.stage(3, () => handle.check(context.signal));
        if (!info.isFile()) throw new HTTPException(404);
        if (info.size > 64 * 1024 * 1024) throw new HTTPException(413);
        const { value: response } = await context.stage(4, async () => {
          const response = await verifiedFileResponse({
            filePath, name, mimeType: mimeTypeFor(name), size: info.size, info, request,
            authorize: async signal => { await handle.check(signal); },
          });
          opened = response;
          if (context.signal.aborted || entry.controller.signal.aborted || closed) {
            if (response.body) await cancelGuardedBody(response.body);
            throw new HTTPException(503);
          }
          return response;
        });
        // Never orphan an opened file when shutdown/deadline wins delivery.
        if (context.signal.aborted || entry.controller.signal.aborted || closed) {
          if (response.body) await cancelGuardedBody(response.body);
          throw new HTTPException(503);
        }
        return response;
      });
      const response = result.value;
      if (!response.body) return response;
      const body = trackBody(response.body, entry);
      handedOff = true;
      return new Response(body, { status: response.status, headers: response.headers });
    } catch (error) {
      const status = responseError(error);
      return c.json({ error: status === 403 ? 'missing media:read scope' : status === 400 ? 'invalid media name'
        : status === 404 ? 'media not found' : status === 413 ? 'media exceeds size limit' : 'Connector media unavailable' },
      status as 400 | 403 | 404 | 408 | 413 | 503);
    } finally {
      if (!handedOff) {
        entry.controller.abort();
        try { if (opened?.body) await cancelGuardedBody(opened.body); }
        finally { entry.finish(); }
      }
    }
  });

  function trackBody(source: ReadableStream<Uint8Array>, entry: Lifetime) {
    const reader = source.getReader();
    let stopping: Promise<void> | undefined, pulling: Promise<void> | undefined;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stop = () => {
      if (stopping) return stopping;
      stopping = Promise.resolve().then(async () => {
        try {
          await Promise.all([reader.cancel().catch(() => {}), cancelGuardedBody(source), pulling]);
        } finally { reader.releaseLock(); entry.finish(); }
      });
      return stopping;
    };
    const abort = () => { controller.error(new Error('Connector media interrupted')); void stop().catch(() => {}); };
    const body = new ReadableStream<Uint8Array>({
      start(output) {
        controller = output; entry.controller.signal.addEventListener('abort', abort, { once: true });
        if (entry.controller.signal.aborted) abort();
      },
      pull(output) {
        const original = (async () => {
          try {
            const next = await reader.read();
            if (stopping) return;
            if (next.done) {
              entry.controller.signal.removeEventListener('abort', abort);
              reader.releaseLock(); entry.finish(); output.close();
            } else output.enqueue(next.value);
          } catch (error) {
            if (!stopping) {
              output.error(new Error(error instanceof HTTPException && error.status === 403
                ? 'Connector media authorization changed' : 'Connector media unavailable'));
              void stop().catch(() => {});
            }
          }
        })();
        pulling = original;
        return original;
      },
      cancel() { entry.controller.signal.removeEventListener('abort', abort); return stop(); },
    }, { highWaterMark: 0 });
    return body;
  }

  app.get(`${base}/events/stream`, async c => {
    c.header('Cache-Control', 'no-store');
    if (closed) return c.json({ error: 'Connector event streams are closed' }, 503);
    if (streams.size >= 128) {
      const trace = guardedTrace(diagnostics, 'connector-event-stream');
      trace.add('step', 0); trace.add('pending', streams.size); trace.add('deferred', 1); trace.finish(true);
      return c.json({ error: 'Connector event stream capacity exceeded' }, 503);
    }
    const entry = lifetime(streams, c.req.raw), { controller } = entry;
    const request = new Request(c.req.raw, { signal: controller.signal });
    let handle;
    try {
      handle = (await reads.run(request, async context =>
        (await context.stage(1, () => deps.authority.begin(request, 'events:read'))).value)).value;
      if (closed || controller.signal.aborted) throw new HTTPException(503);
    } catch (error) {
      entry.finish();
      const status = responseError(error);
      return c.json({ error: status === 403 ? 'missing events:read scope' : 'Connector event streams are closed' },
        status as 403 | 408 | 503);
    }
    const authority = handle;
    const trace = guardedTrace(diagnostics, 'connector-event-stream'); let failed = false;
    c.header('X-Accel-Buffering', 'no');
    const response = streamSSE(c, async stream => {
      const abort = () => stream.abort();
      controller.signal.addEventListener('abort', abort, { once: true });
      stream.onAbort(() => controller.abort());
      const check = async () => {
        await reads.run(request, async context => { await context.stage(1, () => authority.check(context.signal)); });
        if (closed || controller.signal.aborted) throw new HTTPException(503);
      };
      const write: typeof stream.writeSSE = async message => {
        await check();
        const timer = setTimeout(() => {
          failed = true; trace.add('timedOut', 1); trace.reportPending({ step: 1, pending: 1, timedOut: 1 });
          controller.abort();
        }, 10_000);
        try { await stream.writeSSE(message); } finally { clearTimeout(timer); }
      };
      let heartbeatAt = 0;
      try {
        if (controller.signal.aborted) { abort(); return; }
        let lastId: string | null = c.req.header('last-event-id') ?? c.req.query('lastEventId') ?? null;
        while (!stream.aborted && !controller.signal.aborted) {
          const revision = deps.changes.revision, authorityRevision = deps.authority.changes.revision;
          await check();
          const after = lastId;
          const { value: page } = await reads.run(request, async context => {
            const { value } = await context.stage(2, () => deps.replay(after));
            assertEventReplayPage(value, after); return value;
          });
          await check();
          if (Date.now() >= heartbeatAt) { await write({ event: 'heartbeat', data: '' }); heartbeatAt = Date.now() + 10_000; }
          if (lastId === null) lastId = page.cursor ?? null;
          if (!page.known) {
            lastId = page.cursor ?? null;
            await write({ ...(lastId ? { id: lastId } : {}), event: 'stream.reset',
              data: JSON.stringify({ type: 'stream.reset', ts: Date.now(), payload: { reason: 'cursor_expired' } }) });
          }
          for (const event of page.events) {
            const payload = (event.type === 'message.created' || event.type === 'message.updated')
              && event.payload && typeof event.payload === 'object' && 'role' in event.payload
              ? summarizeToolMessage(event.payload as ChatMessage) : event.payload;
            await write({ id: event.id, event: event.type, data: JSON.stringify({ ...event, payload, connector }) });
            trace.add('records', 1); lastId = event.id;
          }
          if (lastId !== (page.cursor ?? null)) continue;
          const wait = new AbortController();
          const cancel = () => wait.abort();
          controller.signal.addEventListener('abort', cancel, { once: true });
          if (controller.signal.aborted) wait.abort();
          try {
            await Promise.race([
              deps.changes.wait(revision, wait.signal, Math.max(0, heartbeatAt - Date.now())),
              deps.authority.changes.wait(authorityRevision, wait.signal),
            ]);
          } finally { wait.abort(); controller.signal.removeEventListener('abort', cancel); }
        }
      } catch { failed = failed || !controller.signal.aborted && !closed; controller.abort(); }
      finally {
        controller.signal.removeEventListener('abort', abort); controller.abort();
        trace.add('step', 3); trace.add('settled', 1); trace.finish(failed); entry.finish();
      }
    });
    response.headers.set('Cache-Control', 'no-store');
    return response;
  });
  return { close(): Promise<void> {
    if (closing) return closing;
    // Publish before abort/diagnostic callbacks can reenter close.
    let resolve!: () => void, reject!: (error: unknown) => void;
    closing = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    closed = true;
    const accepted = [...streams, ...media];
    const drains = [reads.close(), mediaReads.close(), agents.close(), metrics.close()];
    for (const entry of accepted) entry.controller.abort();
    void Promise.all([...drains, ...accepted.map(entry => entry.drained)]).then(() => resolve(), reject);
    return closing;
  } };
}
