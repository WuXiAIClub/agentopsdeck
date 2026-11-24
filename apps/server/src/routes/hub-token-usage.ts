import { createHash } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { tokenUsageRange, validateNativeTokenUsage, validateNativeTokenUsageExport,
  tokenSnapshotSelection, tokenSnapshotRequestId, validateNativeTokenSnapshot } from '@agentopsdeck/shared';
import { decodeHubSessionId } from '../hub/session-id.js';
import { ConnectorClientError } from '../hub/connector-client.js';
import { legacyHubConnectionProxyDeps, resolveHubConnectionProxyClient, validateHubConnectionProxyRouteDeps,
  type HubConnectionProxyRouteDeps } from '../hub/connection-proxy-route-deps.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { HubRequestWork } from '../hub/async-request-work.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';
import { readJsonBody } from '../utils/http-body.js';

/** One admission lifetime for the four native-ledger endpoints. The Connector
 * owns snapshots; a lost POST acknowledgement never authorizes another POST. */
export function registerHubTokenUsage(app: Hono, deps: HubConnectionProxyRouteDeps) {
  validateHubConnectionProxyRouteDeps(deps);
  const legacy = () => legacyHubConnectionProxyDeps(deps);
  const base = '/api/hub/v1/sessions/:hubSessionId/token-usage', work = new HubRequestWork();
  let closing: Promise<void> | undefined;
  const local = (c: Context) => { work.check(); if (c.req.raw.signal.aborted) throw new HubMemberRequestError(499); };
  const authorize = async (c: Context) => {
    local(c);
    // Copy evidence before the first await. Keep its lifetime independent of
    // HTTP cancellation; local() gates effects and delivery, not original work.
    const original = new Request(c.req.url, { headers: new Headers(c.req.raw.headers) });
    const decoded = decodeHubSessionId(c.req.param('hubSessionId') ?? '');
    if (!decoded) throw new HTTPException(404, { message: 'session not found' });
    if (deps.access && !deps.asyncConnectorClient) throw new HubMemberRequestError(503);
    const authority = deps.access ? await deps.access.begin(original, decoded.connectionId) : undefined;
    local(c);
    const principal = authority ? authority.principal : legacy().principal(c);
    const connection = authority ? authority.connection : legacy().hubStore.getConnection(decoded.connectionId, principal.userId);
    if (!connection || connection.status === 'disabled') throw new HTTPException(404, { message: 'session not found' });
    const version = authority ? authority.epoch : legacy().hubStore.connectionAuthority(decoded.connectionId, principal.userId);
    if (version === undefined) throw new HTTPException(404, { message: 'session not found' });
    const check = async () => {
      work.check();
      if (authority) await authority.check();
      else {
        const current = legacy().principal(c);
        if (current.userId !== principal.userId || current.admin !== principal.admin) throw new HubMemberRequestError(401);
        if (legacy().hubStore.connectionAuthority(decoded.connectionId, principal.userId) !== version) throw new HubMemberRequestError(403);
      }
      local(c);
    };
    const verified = async <T>(operation: () => Promise<T>): Promise<T> => {
      try { const result = await operation(); await check(); return result; }
      catch (error) { await check(); throw error; }
    };
    const client = () => verified(async () => {
      await check();
      // Await the original resolver, not a cancellation race. Shutdown must
      // retain this request until an injected/slow resolver actually settles.
      return resolveHubConnectionProxyClient(deps, original, decoded.connectionId, principal.userId);
    });
    return { decoded, check, verified, client };
  };
  const safe = (step: number, handler: (c: Context) => Promise<Response>) => async (c: Context) => {
    c.header('Cache-Control', 'no-store');
    const trace = guardedTrace(performanceDiagnostics, 'hub-request-authority'); trace.add('step', step);
    try { const response = await work.run(() => handler(c)); trace.add('settled', 1); trace.finish(); return response; }
    catch (error) {
      trace.add('deferred', 1); trace.finish(true);
      if (error instanceof HTTPException) throw error;
      const status = error instanceof HubMemberRequestError || error instanceof ConnectorClientError ? error.status : 502;
      if (error instanceof ConnectorClientError && error.source) {
        c.header('X-AgentOpsDeck-Source-Error', error.source.reason);
        if (error.source.canApprove) c.header('X-AgentOpsDeck-Source-Approval', 'available');
      }
      return c.json({ error: error instanceof ConnectorClientError ? error.message
        : error instanceof HubMemberRequestError ? error.message : 'Connector unavailable', status }, status as 502);
    }
  };
  for (const exporting of [false, true]) app.get(base + (exporting ? '/export' : ''), safe(exporting ? 98 : 97, async c => {
    const a = await authorize(c);
    let range;
    try { range = tokenUsageRange(c.req.query('from'), c.req.query('to'), c.req.query('bucketMs')); }
    catch { return c.json({ error: 'Invalid token usage range' }, 400); }
    const query = new URLSearchParams(Object.entries(range).map(([key, value]) => [key, String(value)]));
    const client = await a.client();
    const body = await a.verified(() => client.jsonOriginal<unknown>(
      `/sessions/${encodeURIComponent(a.decoded.remoteSessionKey)}/token-usage${exporting ? '/export' : ''}?${query}`, { signal: c.req.raw.signal }));
    let result, exported;
    try { exported = exporting ? validateNativeTokenUsageExport(body) : undefined; result = exported?.usage ?? validateNativeTokenUsage(body); }
    catch { throw new ConnectorClientError(502, 'Invalid native token usage'); }
    if (!a.decoded.remoteSessionKey.startsWith(`${result.runtime}:`) || result.from !== range.from || result.to !== range.to || result.bucketMs !== range.bucketMs)
      throw new ConnectorClientError(502, 'Mismatched token usage range');
    await a.check();
    return c.json(exported ?? result);
  }));
  for (const creating of [false, true]) app.on(creating ? 'POST' : 'GET', base + `/snapshots${creating ? '' : '/:requestId'}`, safe(creating ? 99 : 100, async c => {
    const a = await authorize(c);
    let selection: ReturnType<typeof tokenSnapshotSelection> | undefined;
    let requestId: string;
    if (creating) {
      const raw = await a.verified(() => readJsonBody(c.req.raw, 1024));
      try { selection = tokenSnapshotSelection(raw); requestId = selection.requestId; }
      catch { return c.json({ error: 'Invalid token snapshot selection' }, 400); }
    } else {
      try { requestId = tokenSnapshotRequestId(c.req.param('requestId')); }
      catch { return c.json({ error: 'Invalid token snapshot request ID' }, 400); }
    }
    const client = await a.client();
    const body = await a.verified(() => client.jsonOriginal<unknown>(
      `/sessions/${encodeURIComponent(a.decoded.remoteSessionKey)}/token-usage/snapshots${selection ? '' : `/${requestId}`}`,
      { signal: c.req.raw.signal, ...(selection ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(selection) } : {}) }));
    let result;
    try {
      result = validateNativeTokenSnapshot(body);
      const usage = result.data.usage;
      const digest = createHash('sha256').update(JSON.stringify(result.data.observations.map(row => row.identity).sort())).digest('hex');
      if (result.requestId !== requestId || !a.decoded.remoteSessionKey.startsWith(`${usage.runtime}:`) || result.memberDigest !== digest
        || selection && (usage.from !== selection.from || usage.to !== selection.to || usage.bucketMs !== selection.bucketMs)) throw Error('Mismatched snapshot');
    } catch { throw new ConnectorClientError(502, 'Invalid token snapshot response; query original request before another creation'); }
    await a.check();
    return c.json(result);
  }));
  return { close: (): Promise<void> => closing ??= work.close().then(() => deps.access?.close()) };
}
