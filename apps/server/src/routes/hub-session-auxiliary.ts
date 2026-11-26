import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { readInteractionSnapshot, readInteractionSubmission, readInteractionView, validateSessionSkills,
  validateSessionFilePage, validateSessionFileRebuild, fileEntryMessage, type SessionFilePage, type SessionFileRebuild } from '@agentopsdeck/shared';
import type { HubStore } from '../hub/hub-store.js';
import type { HubPrincipal } from '../hub/identity.js';
import type { AsyncHubConnectionProxyAccess } from '../hub/async-connection-proxy-access.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { HubRequestWork } from '../hub/async-request-work.js';
import { legacyHubConnectionProxyDeps, resolveHubConnectionProxyClient, validateHubConnectionProxyRouteDeps, type HubConnectionProxyRouteDeps } from '../hub/connection-proxy-route-deps.js';
import { ConnectorClientError } from '../hub/connector-client.js';
import { decodeHubSessionId, encodeHubSessionId } from '../hub/session-id.js';
import { projectMessageMedia } from '../hub/message-projection.js';
import { readJsonBody } from '../utils/http-body.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';
import { weixinOriginalAction } from '../hub/weixin-bridge.js';

/** One owner for authorization, original transport and final delivery. Remote
 * mutations are never retried, including cancellation or a lost response. */
export function registerHubSessionAuxiliary(app: Hono, deps: HubConnectionProxyRouteDeps & {
  error: (c: Context, error: unknown) => Response;
}) {
  validateHubConnectionProxyRouteDeps(deps);
  const legacy = () => legacyHubConnectionProxyDeps(deps);
  const base = '/api/hub/v1/sessions/:hubSessionId', work = new HubRequestWork();
  const begin = async (c: Context) => {
    const id = c.req.param('hubSessionId')!, decoded = decodeHubSessionId(id);
    if (!decoded || encodeHubSessionId(decoded.connectionId, decoded.remoteSessionKey) !== id) throw new HTTPException(404);
    if (deps.access && !deps.asyncConnectorClient) throw new HubMemberRequestError(503);
    const access = deps.access ? await deps.access.begin(c.req.raw, decoded.connectionId) : undefined;
    work.check();
    const actor = access?.principal ?? legacy().principal(c);
    const connection = access?.connection ?? legacy().hubStore.getConnection(decoded.connectionId, actor.userId);
    if (!connection || connection.status === 'disabled') throw new HTTPException(404);
    const epoch = access ? undefined : legacy().hubStore.connectionAuthority(decoded.connectionId, actor.userId);
    const check = async () => {
      work.check();
      if (access) await access.check();
      else {
        if (legacy().principal(c).userId !== actor.userId) throw new HTTPException(401);
        if (legacy().hubStore.connectionAuthority(decoded.connectionId, actor.userId) !== epoch) throw new HTTPException(403);
      }
      work.check();
      if (c.req.raw.signal.aborted) throw new HubMemberRequestError(499);
    };
    let client;
    try { client = await resolveHubConnectionProxyClient(deps, c.req.raw, decoded.connectionId, actor.userId); }
    catch (error) { await check(); throw error; }
    await check();
    const json = async <T>(path: string, init: RequestInit = {}) => {
      await check();
      let value: T;
      const original = weixinOriginalAction(c.req.raw);
      try { value = original?.command.operation === 'answer'
        ? (await client.weixinActionOriginal(original.command, original.observe, c.req.raw.signal)).body as T
        : await client.jsonOriginal<T>(`/sessions/${encodeURIComponent(decoded.remoteSessionKey)}${path}`,
          { ...init, signal: c.req.raw.signal }); }
      catch (error) { await check(); throw error; }
      await check();
      return value;
    };
    return { id, decoded, client, json };
  };
  const handle = (c: Context, action: () => Promise<Response>) => {
    c.header('Cache-Control', 'no-store');
    const trace = guardedTrace(performanceDiagnostics, 'hub-request-authority'); trace.add('step', 88);
    return work.run(action).then(response => { trace.add('settled', 1); trace.finish(); return response; }, error => {
      trace.add('deferred', 1); trace.finish(true);
      if (error instanceof HubMemberRequestError) return new Response(JSON.stringify({ error: 'Connector authority is unavailable', status: error.status }), {
        status: error.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
      if (error instanceof HTTPException) throw error;
      return deps.error(c, error);
    });
  };

  app.post(`${base}/recovery`, c => handle(c, async () => {
    const access = await begin(c), body = await readJsonBody(c.req.raw, 1024);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1
      || !('expectedRunId' in body) || typeof body.expectedRunId !== 'string' || !body.expectedRunId.length
      || body.expectedRunId.length > 512 || /[\x00-\x1f\x7f]/.test(body.expectedRunId)) return c.json({ error: 'Invalid execution identity' }, 400);
    const result = await access.json<unknown>('/recovery', { method: 'POST', body: JSON.stringify(body) });
    if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 1
      || !('requested' in result) || result.requested !== true) throw new ConnectorClientError(502, 'Invalid recovery response');
    return c.json({ requested: true });
  }));
  app.post(`${base}/background-terminals/stop`, c => handle(c, async () => {
    const access = await begin(c), body = await readJsonBody(c.req.raw, 1024);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1
      || !('expectedRunId' in body) || typeof body.expectedRunId !== 'string' || !body.expectedRunId.length
      || body.expectedRunId.length > 512 || /[\x00-\x1f\x7f]/.test(body.expectedRunId)) return c.json({ error: 'Invalid execution identity' }, 400);
    const result = await access.json<unknown>('/background-terminals/stop', { method: 'POST', body: JSON.stringify(body) });
    if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 1
      || !('stopped' in result) || result.stopped !== true) throw new ConnectorClientError(502, 'Invalid background terminal stop response');
    return c.json({ stopped: true });
  }));
  app.get(`${base}/interactions`, c => handle(c, async () => {
    const access = await begin(c), body = readInteractionSnapshot(await access.json<unknown>('/interactions'));
    if (!body || body.requests.some(v => v.request.sessionKey !== access.decoded.remoteSessionKey
      || access.client.expectedNodeId && v.request.nodeId !== access.client.expectedNodeId)) throw new ConnectorClientError(502, 'Invalid interaction snapshot');
    return c.json(body);
  }));
  app.patch(`${base}/interaction-mode`, c => handle(c, async () => {
    const access = await begin(c), body = await readJsonBody(c.req.raw, 128);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1
      || !('mode' in body) || body.mode !== 'automatic' && body.mode !== 'interactive') return c.json({ error: 'Invalid interaction mode' }, 400);
    const result = await access.json<{ mode?: unknown }>('/interaction-mode', { method: 'PATCH', body: JSON.stringify(body) });
    if (result?.mode !== body.mode) throw new ConnectorClientError(502, 'Invalid interaction mode receipt');
    return c.json({ mode: result.mode });
  }));
  app.post(`${base}/interactions/:requestId/answer`, c => handle(c, async () => {
    const access = await begin(c), requestId = c.req.param('requestId');
    const body = readInteractionSubmission(await readJsonBody(c.req.raw, 40_000));
    if (!body || requestId.length > 256) return c.json({ error: 'Invalid interaction answer' }, 400);
    const result = readInteractionView(await access.json<unknown>(`/interactions/${encodeURIComponent(requestId)}/answer`,
      { method: 'POST', body: JSON.stringify(body) }));
    if (!result || result.request.requestId !== requestId || result.request.runId !== body.runId
      || result.request.sessionKey !== access.decoded.remoteSessionKey
      || access.client.expectedNodeId && result.request.nodeId !== access.client.expectedNodeId) throw new ConnectorClientError(502, 'Invalid interaction receipt');
    return c.json(result);
  }));
  app.get(`${base}/skills`, c => handle(c, async () => {
    const access = await begin(c), body = await access.json<unknown>('/skills');
    try { return c.json(validateSessionSkills(body)); }
    catch { throw new ConnectorClientError(502, 'Invalid skills discovery'); }
  }));
  app.get(`${base}/files`, c => handle(c, async () => {
    const access = await begin(c), cursor = c.req.query('cursor');
    if (cursor !== undefined && (!cursor.length || cursor.length > 1024)) return c.json({ error: 'Invalid file cursor' }, 400);
    const body = await access.json<SessionFilePage>(`/files${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
    let page: SessionFilePage;
    try { page = validateSessionFilePage(body); } catch { throw new ConnectorClientError(502, 'Invalid file index'); }
    return c.json({ ...page, entries: page.entries.map(entry => ({ ...entry,
      media: entry.kind === 'deleted' ? undefined : projectMessageMedia(fileEntryMessage(entry, access.decoded.remoteSessionKey),
        access.decoded.remoteSessionKey, `/api/hub/v1/sessions/${encodeURIComponent(access.id)}`)?.find(media => media.sourceReference?.path === entry.path),
    })) });
  }));
  const rebuild = (c: Context) => handle(c, async () => {
    const access = await begin(c), id = c.req.param('jobId');
    if (id && !/^[a-f0-9-]{36}$/.test(id)) return c.json({ error: 'Invalid file rebuild ID' }, 400);
    let step: number | undefined;
    if (id && c.req.method === 'POST') {
      const body = await readJsonBody(c.req.raw, 256);
      if (!body || typeof body !== 'object' || !('step' in body) || !Number.isSafeInteger(body.step)
        || Number(body.step) < 0 || Number(body.step) > 10_000) return c.json({ error: 'Invalid file rebuild step' }, 400);
      step = Number(body.step);
    }
    const progress = await access.json<SessionFileRebuild>(`/files/rebuild${id ? `/${id}` : ''}`, {
      method: c.req.method, ...(step !== undefined ? { body: JSON.stringify({ step }), headers: { 'content-type': 'application/json' } } : {}),
    });
    try { return c.json(validateSessionFileRebuild(progress)); }
    catch { throw new ConnectorClientError(502, 'Invalid file rebuild progress'); }
  });
  app.post(`${base}/files/rebuild`, rebuild);
  app.post(`${base}/files/rebuild/:jobId`, rebuild);
  app.delete(`${base}/files/rebuild/:jobId`, rebuild);

  let closing: Promise<void> | undefined;
  return { close: () => closing ??= work.close().then(() => deps.access?.close()) };
}
