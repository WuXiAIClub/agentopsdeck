import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { HISTORY_ASYNC_HEADER, type ChatMessage } from '@agentopsdeck/shared';
import type { HubConnection, HubStore } from '../hub/hub-store.js';
import type { HubPrincipal } from '../hub/identity.js';
import type { AsyncHubConnectionProxyAccess } from '../hub/async-connection-proxy-access.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { HubRequestWork } from '../hub/async-request-work.js';
import { legacyHubConnectionProxyDeps, resolveHubConnectionProxyClient, validateHubConnectionProxyRouteDeps, type HubConnectionProxyRouteDeps } from '../hub/connection-proxy-route-deps.js';
import { ConnectorClientError } from '../hub/connector-client.js';
import { decodeHubSessionId, encodeHubSessionId } from '../hub/session-id.js';
import { mergeMessageIdentities } from '../messages/identity.js';
import { createConditionalHistory } from '../messages/conditional-history.js';
import { stableGatewayRowsRevision } from '../refresh/signature.js';
import { HistoryDiagnostics, timeHistoryAsync, timeHistorySync } from '../storage/history-diagnostics.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';
import { cancelGuardedBody } from '../connector/guarded-body.js';
import { OriginalTransportDrain } from '../connector/transport.js';

/** Own original HTTP work AND returned streaming bodies. No SQL, authority
 * cache, transport retry or whole-file buffering lives at this boundary. */
export function registerHubHistoryMedia(app: Hono, deps: HubConnectionProxyRouteDeps & {
  wrap: (message: ChatMessage, session: string, connection: HubConnection) => ChatMessage;
  error: (c: Context, error: unknown) => Response;
  historyDiagnostics: HistoryDiagnostics;
}) {
  validateHubConnectionProxyRouteDeps(deps);
  const legacy = () => legacyHubConnectionProxyDeps(deps);
  const base = '/api/hub/v1', work = new HubRequestWork();
  const conditionalHistory = createConditionalHistory();
  const streams = new Set<{ cancel: () => Promise<void> }>();
  const transports = new Set<OriginalTransportDrain>();

  const begin = async (c: Context, id: string, options?: { sourceApproval?: boolean }) => {
    if (deps.access && !deps.asyncConnectorClient) throw new HubMemberRequestError(503);
    const access = deps.access ? await deps.access.begin(c.req.raw, id) : undefined;
    work.check();
    const actor = access?.principal ?? legacy().principal(c);
    const connection = access?.connection ?? legacy().hubStore.getConnection(id, actor.userId);
    if (!connection || connection.status === 'disabled') throw new HTTPException(404);
    const epoch = access ? undefined : legacy().hubStore.connectionAuthority(id, actor.userId);
    const check = async () => {
      work.check();
      if (access) await access.check();
      else {
        const current = legacy().principal(c);
        if (current.userId !== actor.userId || current.admin !== actor.admin) throw new HTTPException(401);
        if (legacy().hubStore.connectionAuthority(id, actor.userId) !== epoch) throw new HTTPException(403);
      }
      work.check();
      if (c.req.raw.signal.aborted) throw new HubMemberRequestError(499);
    };
    let client;
    try { client = await resolveHubConnectionProxyClient(deps, c.req.raw, id, actor.userId,
      options?.sourceApproval ? { sourceApproval: true, admin: actor.admin } : undefined); }
    catch (error) { await check(); throw error; }
    await check(); // The resolver must not select a new epoch for this request.
    return { connection, check, client };
  };

  const handle = async (c: Context, action: () => Promise<Response>) => {
    c.header('Cache-Control', 'no-store');
    const trace = guardedTrace(performanceDiagnostics, 'hub-request-authority'); trace.add('step', 87);
    try { const result = await work.run(action); trace.add('settled', 1); trace.finish(); return result; }
    catch (error) {
      trace.add('deferred', 1); trace.finish(true);
      if (error instanceof HubMemberRequestError) return new Response(JSON.stringify({ error: 'Connector authority is unavailable', status: error.status }), {
        status: error.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
      if (error instanceof HTTPException) throw error;
      return deps.error(c, error);
    }
  };

  // Cancellation remains owned until the underlying reader acknowledges it.
  // Keep the record through pending pulls, including an unconsumed response.
  const retainMedia = async (response: Response, signal: AbortSignal) => {
    try { work.check(); if (streams.size >= 256) throw new HubMemberRequestError(503); }
    catch (error) {
      if (response.body) {
        try { await response.body.cancel(); } catch { /* Retain original cancellation below. */ }
        await cancelGuardedBody(response.body);
      }
      throw error;
    }
    if (!response.body) return response;
    const source = response.body, reader = source.getReader();
    let output!: ReadableStreamDefaultController<Uint8Array>;
    let ended = false, cancelling: Promise<void> | undefined;
    const remove = () => { signal.removeEventListener('abort', abort); streams.delete(entry); };
    const cancel = () => {
      if (cancelling) return cancelling;
      if (ended) return Promise.resolve();
      ended = true;
      // Publish before cancel can reenter the route close boundary.
      cancelling = Promise.resolve().then(async () => {
        try {
          // An already-errored Web stream skips its underlying cancel hook.
          // The guarded source retains that original cancellation separately.
          try { await reader.cancel(); } catch { /* Await the real ACK below. */ }
          await cancelGuardedBody(source);
        } finally { reader.releaseLock(); remove(); }
      });
      return cancelling;
    };
    const entry = { cancel: async () => {
      if (!ended) output.error(new HubMemberRequestError(503));
      await cancel();
    } };
    const abort = () => { void entry.cancel().catch(() => {}); };
    streams.add(entry);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        output = controller;
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      },
      async pull(controller) {
        try {
          const next = await work.run(() => reader.read());
          if (ended) return;
          if (next.done) { ended = true; reader.releaseLock(); remove(); controller.close(); }
          else controller.enqueue(next.value);
        } catch (error) {
          if (!ended) controller.error(error);
          await cancel();
        }
      },
      cancel,
    }, { highWaterMark: 0 });
    return new Response(body, { status: response.status, headers: response.headers });
  };

  // HTTP abort may finish before dispatch returns. Keep the original transport
  // until its late response/cancel ACK, separately from the response deadline.
  const transport = async <T>(open: (drain: OriginalTransportDrain) => Promise<T>) => {
    work.check();
    if (transports.size >= 256) throw new HubMemberRequestError(503);
    const drain = new OriginalTransportDrain();
    transports.add(drain);
    try { return await open(drain); }
    finally {
      // Streams own future cancellation; this set owns dispatch already in
      // flight, including responses that arrive after the HTTP wait failed.
      void drain.wait().then(() => transports.delete(drain));
    }
  };

  const session = (id: string) => {
    const decoded = decodeHubSessionId(id);
    if (!decoded || encodeHubSessionId(decoded.connectionId, decoded.remoteSessionKey) !== id) throw new HTTPException(404);
    return decoded;
  };
  app.use(`${base}/sessions/:hubSessionId/messages`, deps.historyDiagnostics.middleware());
  app.get(`${base}/sessions/:hubSessionId/messages`, c => handle(c, async () => {
    const id = c.req.param('hubSessionId'), decoded = session(id);
    const access = await begin(c, decoded.connectionId);
    let body;
    try { body = await timeHistoryAsync('connectorWait', () => transport(drain => access.client.messages(decoded.remoteSessionKey,
      c.req.query('limit'), c.req.raw.signal, c.req.query('before'), c.req.header(HISTORY_ASYNC_HEADER) === '1', drain))); }
    catch (error) { await access.check(); throw error; }
    await access.check();
    const messages = timeHistorySync('wrap', () => mergeMessageIdentities(body.messages).map(message => deps.wrap(message, id, access.connection)));
    return conditionalHistory(c, { ...body, messages, revision: body.revision ?? stableGatewayRowsRevision(messages) });
  }));
  app.get(`${base}/sessions/:hubSessionId/messages/:messageId`, c => handle(c, async () => {
    const id = c.req.param('hubSessionId'), decoded = session(id), messageId = c.req.param('messageId');
    const access = await begin(c, decoded.connectionId);
    let body;
    try { body = await transport(drain => access.client.message(decoded.remoteSessionKey, messageId, c.req.raw.signal, drain)); }
    catch (error) { await access.check(); throw error; }
    await access.check();
    if (body.message?.id !== messageId) throw new ConnectorClientError(502, 'Invalid message identity');
    return c.json({ ...body, message: deps.wrap(body.message, id, access.connection) });
  }));
  app.get(`${base}/sessions/:hubSessionId/messages/:messageId/media/:resourceId`, c => handle(c, async () => {
    const decoded = session(c.req.param('hubSessionId'));
    const messageId = c.req.param('messageId'), resourceId = c.req.param('resourceId');
    if (!messageId || messageId.length > 4096 || !/^[a-f0-9]{64}$/.test(resourceId)) throw new HTTPException(404);
    const access = await begin(c, decoded.connectionId, { sourceApproval: true });
    try { return await transport(async drain => retainMedia(await access.client.sessionMedia(decoded.remoteSessionKey, messageId, resourceId,
      c.req.raw.signal, access.check, c.req.header('range'), c.req.header('if-range'), drain), c.req.raw.signal)); }
    catch (error) { await access.check(); throw error; }
  }));
  // Owner-only: no shared/grant path delegates local source approval.
  for (const method of ['POST', 'DELETE'] as const) app.on(method,
    `${base}/sessions/:hubSessionId/messages/:messageId/media/:resourceId/approval`, c => handle(c, async () => {
      const decoded = session(c.req.param('hubSessionId')!);
      const messageId = c.req.param('messageId')!, resourceId = c.req.param('resourceId')!;
      if (!messageId || messageId.length > 4096 || !/^[a-f0-9]{64}$/.test(resourceId)) throw new HTTPException(404);
      const access = await begin(c, decoded.connectionId, { sourceApproval: true });
      let result;
      try { result = await access.client.jsonOriginal<{ ok: boolean }>(
        `/sessions/${encodeURIComponent(decoded.remoteSessionKey)}/messages/${encodeURIComponent(messageId)}/media/${resourceId}/approval`,
        { method, signal: c.req.raw.signal }); }
      catch (error) { await access.check(); throw error; }
      await access.check();
      if (result?.ok !== true) return c.json({ error: 'Source approval was not confirmed' }, 409);
      return c.json({ ok: true });
    }));
  app.get(`${base}/connections/:connectionId/media/inbound/:name`, c => handle(c, async () => {
    const name = safeMediaName(c.req.param('name'));
    if (!name) return c.json({ error: 'invalid media name' }, 400);
    const access = await begin(c, c.req.param('connectionId'));
    try { return await transport(async drain => retainMedia(await access.client.media(name, c.req.raw.signal, access.check,
      c.req.header('range'), c.req.header('if-range'), drain), c.req.raw.signal)); }
    catch (error) { await access.check(); throw error; }
  }));

  let closing: Promise<void> | undefined;
  return { close: () => {
    if (closing) return closing;
    const requests = work.close(); // Seal before any cancellation can reenter.
    closing = (async () => {
      const cancelled = await Promise.allSettled([...streams].map(stream => stream.cancel()));
      await requests;
      await Promise.all([...transports].map(drain => drain.wait()));
      await deps.access?.close(); // Original owner ACKs outlive their HTTP waits.
      if (cancelled.some(result => result.status === 'rejected')) throw Error('hub_media_drain_failed');
    })();
    return closing;
  } };
}

function safeMediaName(value: string) {
  let name: string;
  try { name = decodeURIComponent(value); } catch { return undefined; }
  return name && name === name.replace(/^.*[\\/]/, '') && /^[\w.-]+$/.test(name) ? name : undefined;
}
