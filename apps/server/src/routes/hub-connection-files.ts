import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { HubStore } from '../hub/hub-store.js';
import type { HubPrincipal } from '../hub/identity.js';
import type { AsyncHubConnectionProxyAccess } from '../hub/async-connection-proxy-access.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { HubRequestWork } from '../hub/async-request-work.js';
import { legacyHubConnectionProxyDeps, resolveHubConnectionProxyClient, validateHubConnectionProxyRouteDeps, type HubConnectionProxyRouteDeps } from '../hub/connection-proxy-route-deps.js';
import { OriginalTransportDrain } from '../connector/transport.js';
import { cancelGuardedBody } from '../connector/guarded-body.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';

/** Exact owner-only C1 domain. No maintenance credential, shared grant, SQL
 * adapter, mutation replay or whole-file buffering at the HTTP boundary. */
export function isHubConnectionFileRequest(method: string, path: string) {
  return ['GET', 'HEAD'].includes(method) && /^\/api\/hub\/v1\/connections\/[^/]+\/(?:agents|models\/[^/]+|files\/(?:roots|git\/roots|git\/[^/]+\/(?:tree|preview)|agents\/[^/]+(?:\/(?:preview|download))?)|issues\/(?:sources|[^/]+\/items))$/.test(path)
    || method === 'POST' && /^\/api\/hub\/v1\/connections\/[^/]+\/files\/agents\/[^/]+\/text$/.test(path);
}

export function registerHubConnectionFiles(app: Hono, deps: HubConnectionProxyRouteDeps & {
  error: (c: Context, error: unknown) => Response;
}) {
  validateHubConnectionProxyRouteDeps(deps);
  const legacy = () => legacyHubConnectionProxyDeps(deps);
  const base = '/api/hub/v1/connections/:connectionId', work = new HubRequestWork();
  const streams = new Set<{ cancel: () => Promise<void> }>(), transports = new Set<OriginalTransportDrain>();
  const begin = async (c: Context) => {
    if (deps.access && !deps.asyncConnectorClient) throw new HubMemberRequestError(503);
    const id = c.req.param('connectionId')!;
    const original = deps.access ? await deps.access.begin(c.req.raw, id) : undefined;
    work.check();
    const actor = original?.principal ?? legacy().principal(c);
    const connection = original?.connection ?? legacy().hubStore.getConnection(id, actor.userId);
    if (!connection || connection.status === 'disabled') throw new HTTPException(404);
    const epoch = original ? undefined : legacy().hubStore.connectionAuthority(id, actor.userId);
    const check = async () => {
      work.check();
      if (original) await original.check();
      else {
        if (legacy().principal(c).userId !== actor.userId) throw new HTTPException(401);
        if (legacy().hubStore.connectionAuthority(id, actor.userId) !== epoch) throw new HTTPException(403);
      }
      work.check();
      if (c.req.raw.signal.aborted) throw new HubMemberRequestError(499);
    };
    let client;
    try { client = await resolveHubConnectionProxyClient(deps, c.req.raw, id, actor.userId); }
    catch (error) { await check(); throw error; }
    await check();
    return { client, check };
  };
  const admitted = new WeakMap<Context, Awaited<ReturnType<typeof begin>>>();
  const handle = async (c: Context, action: () => Promise<Response>) => {
    c.header('Cache-Control', 'no-store');
    const trace = guardedTrace(performanceDiagnostics, 'hub-request-authority'); trace.add('step', 89);
    try {
      const result = await work.run(async () => {
        // Authenticate before parsing bodies/queries, just as the old owner
        // middleware did. A single original proof owns the whole request.
        admitted.set(c, await begin(c));
        try { return await action(); } finally { admitted.delete(c); }
      });
      trace.add('settled', 1); trace.finish(); return result;
    }
    catch (error) {
      trace.add('deferred', 1); trace.finish(true);
      if (error instanceof HubMemberRequestError) return new Response(JSON.stringify({ error: 'Connector authority is unavailable', status: error.status }), {
        status: error.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
      if (error instanceof HTTPException) throw error;
      return deps.error(c, error);
    }
  };
  const json = async (c: Context, path: string, body?: unknown) => {
    const access = admitted.get(c)!;
    await access.check();
    let result;
    try { result = await access.client.jsonResponseOriginal<unknown>(`/${path}`, { method: c.req.method === 'POST' ? 'POST' : 'GET', signal: c.req.raw.signal,
      ...(c.req.method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) } : {}) }); }
    catch (error) { await access.check(); throw error; }
    await access.check();
    return c.json(result.body as never, result.status as 200);
  };

  // Read the authenticated original Request, not a middleware replacement:
  // private recovery pins are intentionally attached to Request identity.
  // Own stalled upload cancellation just like a returned download, including
  // its original cancel ACK. Content-Length is only an early rejection hint.
  const text = async (c: Context) => {
    const limit = 2 * 1024 * 1024, source = c.req.raw.body;
    if (!source) return '';
    work.check();
    if (streams.size >= 256) throw new HubMemberRequestError(503);
    const signal = c.req.raw.signal, reader = source.getReader();
    const tooLarge = () => new HTTPException(413, { res: c.json({ error: 'Text write too large' }, 413) });
    let ended = false, cancelling: Promise<void> | undefined;
    const remove = () => { signal.removeEventListener('abort', abort); streams.delete(entry); reader.releaseLock(); };
    const cancel = () => {
      if (cancelling) return cancelling;
      if (ended) return Promise.resolve();
      ended = true;
      cancelling = Promise.resolve().then(() => reader.cancel()).finally(remove);
      return cancelling;
    };
    const entry = { cancel };
    const abort = () => { void cancel().catch(() => {}); };
    streams.add(entry); signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) { await cancel(); throw new HubMemberRequestError(499); }
      if (Number(c.req.header('content-length')) > limit) throw tooLarge();
      let size = 0, result = '';
      const decoder = new TextDecoder();
      for (;;) {
        const next = await reader.read();
        work.check();
        if (signal.aborted) throw new HubMemberRequestError(499);
        if (next.done) { result += decoder.decode(); ended = true; remove(); return result; }
        size += next.value.byteLength;
        if (size > limit) throw tooLarge();
        result += decoder.decode(next.value, { stream: true });
      }
    } catch (error) { await cancel(); throw error; }
  };

  // Returned bodies own cancellation independently of their completed HTTP
  // handler. Keep original reader ACKs, including an already-errored source.
  const retain = async (response: Response, signal: AbortSignal) => {
    try { work.check(); if (streams.size >= 256) throw new HubMemberRequestError(503); }
    catch (error) {
      if (response.body) { try { await response.body.cancel(); } catch { /* original ACK below */ } await cancelGuardedBody(response.body); }
      throw error;
    }
    if (!response.body) return response;
    const source = response.body, reader = source.getReader();
    let output!: ReadableStreamDefaultController<Uint8Array>, ended = false, cancelling: Promise<void> | undefined;
    const remove = () => { signal.removeEventListener('abort', abort); streams.delete(entry); };
    const cancel = () => {
      if (cancelling) return cancelling;
      if (ended) return Promise.resolve();
      ended = true;
      cancelling = Promise.resolve().then(async () => {
        try { try { await reader.cancel(); } catch { /* original ACK below */ } await cancelGuardedBody(source); }
        finally { reader.releaseLock(); remove(); }
      });
      return cancelling;
    };
    const entry = { cancel: async () => { if (!ended) output.error(new HubMemberRequestError(503)); await cancel(); } };
    const abort = () => { void entry.cancel().catch(() => {}); };
    streams.add(entry);
    const body = new ReadableStream<Uint8Array>({
      start(controller) { output = controller; signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); },
      async pull(controller) {
        try {
          const next = await work.run(() => reader.read());
          if (ended) return;
          if (next.done) { ended = true; reader.releaseLock(); remove(); controller.close(); }
          else controller.enqueue(next.value);
        } catch (error) { if (!ended) controller.error(error); await cancel(); }
      }, cancel,
    }, { highWaterMark: 0 });
    return new Response(body, { status: response.status, headers: response.headers });
  };

  app.get(`${base}/agents`, c => handle(c, () => json(c, 'agents')));
  app.get(`${base}/models/:runtime`, c => handle(c, async () => {
    const runtime = c.req.param('runtime');
    if (!['codex', 'openclaw', 'claude-code', 'ghcp'].includes(runtime)) return c.json({ error: 'Unsupported model catalog' }, 400);
    return json(c, `models/${runtime}`);
  }));
  for (const path of ['files/roots', 'files/git/roots', 'issues/sources']) app.get(`${base}/${path}`, c => handle(c, () => json(c, path)));
  app.get(`${base}/issues/:sourceId/items`, c => handle(c, async () => {
    const id = c.req.param('sourceId'), query = c.req.queries();
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || Object.keys(query).some(k => !['state', 'cursor', 'kind'].includes(k))
      || !['issue', 'work_item'].includes(c.req.query('kind') ?? 'issue') || Object.values(query).some(v => v.length !== 1)
      || !['', 'all', 'open', 'closed'].includes(c.req.query('state') ?? '')
      || c.req.query('cursor') !== undefined && !/^[a-f0-9-]{36}$/.test(c.req.query('cursor')!)) return c.json({ error: 'Invalid issue query' }, 400);
    return json(c, `issues/${encodeURIComponent(id)}/items?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, v[0]!]))}`);
  }));
  for (const operation of ['tree', 'preview']) app.get(`${base}/files/git/:repositoryRef/${operation}`, c => handle(c, async () => {
    const ref = c.req.param('repositoryRef'), query = c.req.queries(), preview = operation === 'preview';
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(ref) || preview && !query.pathToken
      || Object.keys(query).some(key => !(preview ? ['pathToken'] : ['pathToken', 'cursor']).includes(key))
      || Object.values(query).some(values => values.length !== 1 || !/^[a-f0-9-]{36}$/.test(values[0]!))) return c.json({ error: 'Invalid tree query' }, 400);
    return json(c, `files/git/${encodeURIComponent(ref)}/${operation}?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, v[0]!]))}`);
  }));
  app.post(`${base}/files/agents/:agentId/text`, c => handle(c, async () => {
      const agent = c.req.param('agentId');
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(agent)) return c.json({ error: 'Invalid agent ID' }, 400);
      const raw = await text(c);
      let body: unknown;
      try { body = JSON.parse(raw); } catch { return c.json({ error: 'Invalid JSON' }, 400); }
      return json(c, `files/agents/${encodeURIComponent(agent)}/text`, body);
    }));
  for (const operation of ['', '/preview', '/download']) app.get(`${base}/files/agents/:agentId${operation}`, c => handle(c, async () => {
    const agent = c.req.param('agentId');
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(agent)) return c.json({ error: 'Invalid agent ID' }, 400);
    const path = c.req.query('path') ?? '';
    if (operation !== '/download') {
      const sourcePath = operation === '' ? c.req.query('sourcePath') : undefined;
      return json(c, `files/agents/${encodeURIComponent(agent)}${operation}?${new URLSearchParams({ path, ...(sourcePath === undefined ? {} : { sourcePath }) })}`);
    }
    const access = admitted.get(c)!;
    await access.check();
    if (transports.size >= 256) throw new HubMemberRequestError(503);
    const drain = new OriginalTransportDrain(); transports.add(drain);
    try { return await retain(await access.client.workspaceFile(agent, path, c.req.raw.signal, access.check, drain), c.req.raw.signal); }
    catch (error) { await access.check(); throw error; }
    finally { void drain.wait().then(() => transports.delete(drain)); }
  }));

  let closing: Promise<void> | undefined;
  return { close: () => {
    if (closing) return closing;
    const requests = work.close();
    closing = (async () => {
      const cancelled = await Promise.allSettled([...streams].map(stream => stream.cancel()));
      await requests;
      await Promise.all([...transports].map(drain => drain.wait()));
      await deps.access?.close();
      if (cancelled.some(result => result.status === 'rejected')) throw Error('hub_connection_files_drain_failed');
    })();
    return closing;
  } };
}
