import { createHash } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { validWebsiteId, validWebsiteActions, validWebsiteActionReceipt, WEBSITE_ACTION_ENVELOPE_BYTES, type WebsiteActionReceipt } from '@agentopsdeck/shared';
import { WebsiteAccessStore, WEBSITE_ACCESS_TTL, validWebsiteAccessId } from '../connector/website-access.js';
import { ConnectorClientError, type ConnectorClient } from '../hub/connector-client.js';
import type { AuthRouteAuditStore } from '../auth/route-persistence.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { HubRequestWork } from '../hub/async-request-work.js';
import { hubMemberEvidence } from '../hub/member-owner-domain.js';
import { legacyHubConnectionProxyDeps, resolveHubConnectionProxyClient, validateHubConnectionProxyRouteDeps, type HubConnectionProxyRouteDeps } from '../hub/connection-proxy-route-deps.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';
import { readJsonBody } from '../utils/http-body.js';

type WebsiteActionDeps = (Extract<HubConnectionProxyRouteDeps, {mode: 'async'}> & {audit: Pick<AuthRouteAuditStore, 'append'>}
  | Exclude<HubConnectionProxyRouteDeps, {mode: 'async'}> & {audit?: Pick<AuthRouteAuditStore, 'append'>}) & {closeAccess?: () => Promise<void>};

export function registerHubWebsiteActions(app: Hono, deps: WebsiteActionDeps) {
  validateHubConnectionProxyRouteDeps(deps);
  if (deps.mode === 'async' && typeof deps.audit?.append !== 'function')
    throw Error('Async Hub website action audit ports are required before route registration');
  const legacy = () => legacyHubConnectionProxyDeps(deps);
  type Access = { connection: string; remote: string; client: ConnectorClient; valid: () => Promise<boolean>; binding: string; version: unknown;
    service: string; action: string; sent: boolean; receipt: WebsiteActionReceipt; continued?: boolean };
  const leases = new WebsiteAccessStore<Access>(Date.now, { total: 16, perOwner: 4 }), base = '/api/hub/v1/connections/:connectionId/website-actions';
  const work = new HubRequestWork(), cleanup = new HubRequestWork(1024);
  const active = new Set<{ controller: AbortController; valid: () => Promise<boolean> }>();
  let closed = false, scanning = false;
  // No browser polling. Only active writes are checked; retain the original
  // command through cancellation and close instead of stacking timer RPCs.
  let timer: ReturnType<typeof setInterval> | undefined;
  const watchActive = () => {
    if (timer || !active.size) return;
    timer = setInterval(() => {
      if (closed || scanning) return;
      scanning = true;
      void work.run(async () => {
        for (const entry of [...active]) {
          if (closed) break;
          if (!await entry.valid()) entry.controller.abort();
        }
      }).catch(() => {}).finally(() => { scanning = false; });
    }, 250);
    timer.unref();
  };
  const unwatchIdle = () => { if (!active.size && timer) { clearInterval(timer); timer = undefined; } };
  const authorize = async (c: Context) => {
    work.check();
    if (c.req.url.includes('?')) throw new HTTPException(400);
    if (deps.access && !deps.asyncConnectorClient) throw new HubMemberRequestError(503);
    const original = new Request(c.req.url, { headers: new Headers(c.req.raw.headers) });
    const evidence = hubMemberEvidence(original);
    const binding = deps.access ? createHash('sha256').update(JSON.stringify(evidence.accessKey ? { accessKey: evidence.accessKey } : evidence)).digest('hex') : '';
    const id = c.req.param('connectionId')!, authority = deps.access ? await deps.access.begin(original, id) : undefined;
    work.check();
    const owner = authority ? authority.principal.userId : legacy().principal(c).userId;
    const connection = authority ? authority.connection : legacy().hubStore.getConnection(id, owner);
    if (!connection || connection.status === 'disabled') throw new HTTPException(404);
    const version = authority ? authority.epoch : legacy().hubStore.connectionAuthority(id, owner);
    if (version === undefined) throw new HTTPException(404);
    let client: ConnectorClient | undefined;
    const check = async () => {
      work.check();
      if (authority) await authority.checkTarget();
      else if (legacy().principal(c).userId !== owner || legacy().hubStore.connectionAuthority(id, owner) !== version
        || client && legacy().connectorClient(id, false, owner).eventDomain !== client.eventDomain) throw new HTTPException(403);
      work.check();
    };
    let flight: Promise<boolean> | undefined;
    const valid = () => flight ??= (async () => {
      const trace = guardedTrace(performanceDiagnostics, 'hub-request-authority'); trace.add('step', 92);
      try { await check(); trace.add('settled', 1); trace.finish(); return true; }
      catch { trace.add('deferred', 1); trace.finish(true); return false; }
    })().finally(() => { flight = undefined; });
    try { client = await resolveHubConnectionProxyClient(deps, original, id, owner); }
    catch (error) { await check(); throw error; }
    await check();
    if (c.req.raw.signal.aborted) throw new HubMemberRequestError(499);
    return { owner, id, client, binding, version, check, valid };
  };
  const lookup = async (c: Context) => {
    const a = await authorize(c), lease = leases.get(c.req.param('id')!, a.owner), v = lease.value;
    if (v.connection !== a.id || v.binding !== a.binding || v.version !== a.version) throw new HTTPException(404);
    if (!await v.valid()) { leases.remove(lease.id); throw new HTTPException(403); }
    await a.check();
    leases.get(lease.id, a.owner);
    if (c.req.raw.signal.aborted) throw new HubMemberRequestError(499);
    return { ...a, lease };
  };
  const audit = (owner: string, reason: string, value: Access) => (deps.audit ?? legacy().hubStore.identities.audit).append({ event: 'api_authz', outcome: 'success', userId: owner,
    reason: `website_action_${reason}:${value.service}:${value.action}` });
  const discardRemote = (v: Access) => cleanup.run(async () => {
    const trace = guardedTrace(performanceDiagnostics, 'hub-request-authority'); trace.add('step', 93);
    try { await v.client.jsonOriginal(`/website-actions/${v.remote}`, { method: 'DELETE', signal: AbortSignal.timeout(3000) }); trace.add('settled', 1); trace.finish(); }
    catch { trace.add('deferred', 1); trace.finish(true); }
  }).catch(() => {}); // cleanup has no delivery; original I/O is still drained
  const safe = (fn: (c: Context) => Promise<Response> | Response) => async (c: Context) => {
    c.header('Cache-Control', 'no-store'); c.header('X-Content-Type-Options', 'nosniff');
    const trace = guardedTrace(performanceDiagnostics, 'hub-request-authority'); trace.add('step', 91);
    try { const response = await work.run(() => fn(c)); trace.add('settled', 1); trace.finish(); return response; }
    catch (error) {
      trace.add('deferred', 1); trace.finish(true);
      if (error instanceof HubMemberRequestError) return Response.json({ error: 'Website action unavailable. Check its receipt; do not resend an uncertain operation.' },
        { status: error.status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
      if (error instanceof HTTPException) throw error;
      const status = error instanceof ConnectorClientError ? error.status === 401 ? 403 : [403, 404, 409, 410, 413, 429, 504].includes(error.status) ? error.status : 502 : 502;
      return c.json({ error: 'Website action unavailable. Check its receipt; do not resend an uncertain operation.' }, status as 502);
    }
  };
  app.get(`${base}/catalog/:serviceId`, safe(async c => {
    const a = await authorize(c), id = c.req.param('serviceId');
    if (!validWebsiteId(id)) throw new HTTPException(400);
    let result: unknown;
    try { result = await a.client.jsonOriginal<unknown>(`/website-actions/catalog/${id}`, { signal: c.req.raw.signal }); }
    catch (error) { await a.check(); throw error; }
    await a.check();
    if (c.req.raw.signal.aborted) throw new HubMemberRequestError(499);
    if (!validWebsiteActions(result)) throw new HTTPException(502);
    return c.json({ actions: result.actions.map(({ id, label, method, contentType, maxBytes, download, csrf }) => ({ id, label, method, contentType, maxBytes, ...(download ? { download } : {}), ...(csrf ? { csrf } : {}) })), ...(result.session ? { session: true } : {}) });
  }));
  app.post(base, safe(async c => {
    const a = await authorize(c), input = await readJsonBody(c.req.raw, 512).finally(() => a.check()) as { serviceId?: unknown; actionId?: unknown; previousAccessId?: unknown };
    if (c.req.raw.signal.aborted) throw new HubMemberRequestError(499);
    if (!input || Object.keys(input).some(k => !['serviceId', 'actionId', 'previousAccessId'].includes(k)) || !validWebsiteId(input.serviceId) || !validWebsiteId(input.actionId)
      || input.previousAccessId !== undefined && !validWebsiteAccessId(input.previousAccessId)) throw new HTTPException(400);
    const previous = typeof input.previousAccessId === 'string' ? leases.get(input.previousAccessId, a.owner) : undefined;
    if (previous && (previous.value.connection !== a.id || previous.value.service !== input.serviceId || previous.value.binding !== a.binding || previous.value.version !== a.version)) throw new HTTPException(404);
    if (previous) {
      const valid = await previous.value.valid(); await a.check();
      // Re-read after the async boundary: a parallel continuation may already
      // have consumed this slot. Never resurrect or fork a replaced lease.
      leases.get(previous.id, a.owner);
      if (!valid || previous.value.continued || previous.value.receipt.state !== 'completed') throw new HTTPException(409);
    }
    const lease = leases.create(a.owner, { connection: a.id, remote: '', client: a.client, valid: a.valid, binding: a.binding, version: a.version,
      service: input.serviceId, action: input.actionId, sent: false, receipt: { state: 'ready' } }, previous?.expiresAt, previous?.id);
    if (previous) previous.value.continued = true;
    const started = Date.now();
    try {
      await a.check();
      if (c.req.raw.signal.aborted) throw new HubMemberRequestError(499);
      const remote = await a.client.jsonOriginal<{ accessId: string; expiresInMs: number }>('/website-actions', { method: 'POST', body: JSON.stringify({ serviceId: input.serviceId, actionId: input.actionId, ...(previous ? { previousAccessId: previous.value.remote } : {}) }), signal: c.req.raw.signal });
      if (!validWebsiteAccessId(remote?.accessId) || !Number.isSafeInteger(remote.expiresInMs) || remote.expiresInMs <= 0 || remote.expiresInMs > WEBSITE_ACCESS_TTL) throw new HTTPException(502);
      lease.value.remote = remote.accessId; lease.expiresAt = Math.min(lease.expiresAt, started + remote.expiresInMs);
      await a.check();
      if (c.req.raw.signal.aborted) throw new HubMemberRequestError(499);
      leases.get(lease.id, a.owner);
      return c.json({ accessId: lease.id, expiresAt: lease.expiresAt });
    } catch (error) {
      leases.remove(lease.id);
      if (lease.value.remote) await discardRemote(lease.value);
      await a.check(); throw error;
    }
  }));
  app.post(`${base}/:id/execute`, safe(async c => {
    const a = await lookup(c), { owner, lease } = a, v = lease.value;
    const input = await readJsonBody(c.req.raw, WEBSITE_ACTION_ENVELOPE_BYTES).finally(() => a.check()) as { body?: unknown };
    await lookup(c);
    if (!input || Object.keys(input).length !== 1 || typeof input.body !== 'string' || Buffer.byteLength(input.body) > WEBSITE_ACTION_ENVELOPE_BYTES - 32) throw new HTTPException(400);
    if (v.sent) return c.json(v.receipt);
    if (active.size >= 4) throw new HTTPException(429);
    const pending = { controller: new AbortController(), valid: v.valid };
    active.add(pending); watchActive(); v.sent = true; v.receipt = { state: 'pending' };
    try {
      await audit(owner, 'submitted', v);
      await lookup(c);
      const result = await v.client.jsonOriginal<unknown>(`/website-actions/${v.remote}/execute`, { method: 'POST', body: JSON.stringify(input),
        signal: AbortSignal.any([pending.controller.signal, lease.controller.signal, c.req.raw.signal, AbortSignal.timeout(Math.max(1, lease.expiresAt - Date.now()))]) });
      if (!validWebsiteActionReceipt(result)) throw new HTTPException(502);
      v.receipt = result;
    } catch { v.receipt = { state: 'unknown' }; }
    finally { active.delete(pending); unwatchIdle(); }
    await audit(owner, v.receipt.state, v);
    await lookup(c); return c.json(v.receipt);
  }));
  app.get(`${base}/:id`, safe(async c => {
    const { lease } = await lookup(c), v = lease.value;
    let result: unknown;
    try { result = await v.client.jsonOriginal<unknown>(`/website-actions/${v.remote}`, { signal: c.req.raw.signal }); }
    catch (error) { await lookup(c); throw error; }
    await lookup(c);
    if (!validWebsiteActionReceipt(result)) throw new HTTPException(502);
    // A ready remote receipt after an uncertain dispatch is not permission to retry.
    v.receipt = v.sent && result.state === 'ready' ? { state: 'unknown' } : result;
    return c.json(v.receipt);
  }));
  app.delete(`${base}/:id`, safe(async c => {
    const { owner, lease, check } = await lookup(c), v = lease.value;
    leases.remove(lease.id);
    // Publish both independent originals before waiting. A failed audit cannot
    // abandon a transport already sent, and shutdown still owns both ACKs.
    const results = await Promise.allSettled([Promise.resolve().then(() => audit(owner, 'closed', v)), discardRemote(v)]);
    await check();
    if (results[0]!.status === 'rejected') throw new HubMemberRequestError(503);
    return c.json({ closed: true });
  }));
  let closing: Promise<void> | undefined;
  return { close() {
    if (closing) return closing;
    let complete!: () => void, failed!: (error: unknown) => void;
    closing = new Promise<void>((resolve, reject) => { complete = resolve; failed = reject; });
    closed = true; clearInterval(timer);
    for (const entry of active) entry.controller.abort();
    leases.close();
    void work.close().then(() => cleanup.close()).then(() => deps.closeAccess ? deps.closeAccess() : deps.access?.close()).then(complete, failed);
    return closing;
  } };
}
