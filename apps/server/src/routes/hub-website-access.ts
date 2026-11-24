import { createHash } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { validWebsiteId } from '@agentopsdeck/shared';
import { WebsiteAccessStore, WEBSITE_ACCESS_TTL, validWebsiteAccessId, validWebsiteResource } from '../connector/website-access.js';
import { ConnectorClientError, type ConnectorClient } from '../hub/connector-client.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { HubRequestWork } from '../hub/async-request-work.js';
import { hubMemberEvidence } from '../hub/member-owner-domain.js';
import { legacyHubConnectionProxyDeps, resolveHubConnectionProxyClient, validateHubConnectionProxyRouteDeps, type HubConnectionProxyRouteDeps } from '../hub/connection-proxy-route-deps.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';
import { readJsonBody } from '../utils/http-body.js';
import type { WebsiteGateway } from '../hub/website-gateway.js';
import { validWebsiteSocketFrame, type WebsiteSocketFrame } from '../connector/website-sockets.js';

type Access = { connectionId: string; serviceId: string; remoteId: string; version: unknown; binding: string;
  client: ConnectorClient; check: () => Promise<void>; remoteClose?: Promise<unknown> };

/** JSON-only control plane. Upstream documents remain on the isolated listener. */
export function registerHubWebsiteAccess(app: Hono, deps: HubConnectionProxyRouteDeps & {
  gateway?: WebsiteGateway; closeAccess?: () => Promise<void> }) {
  validateHubConnectionProxyRouteDeps(deps);
  const legacy = () => legacyHubConnectionProxyDeps(deps);
  const base = '/api/hub/v1/connections/:connectionId/website-access', leases = new WebsiteAccessStore<Access>();
  const work = new HubRequestWork(1024), cleanup = new HubRequestWork(1024);
  let closing: Promise<void> | undefined;
  // Local credential/epoch failures take precedence over the remote transport
  // mapping (where upstream 401 deliberately remains 403 for compatibility).
  const verified = async <T>(check: () => Promise<void>, operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); } catch (error) { await check(); throw error; }
  };
  const authorize = async (c: Context) => {
    work.check();
    if (c.req.url.includes('?')) throw new HTTPException(400);
    if (deps.access && !deps.asyncConnectorClient) throw new HubMemberRequestError(503);
    // Original evidence survives the HTTP response; its abort signal does not.
    const original = new Request(c.req.url, { headers: new Headers(c.req.raw.headers) }), evidence = hubMemberEvidence(original);
    const binding = deps.access ? createHash('sha256').update(JSON.stringify(evidence.accessKey ? { accessKey: evidence.accessKey } : evidence)).digest('hex') : '';
    const connectionId = c.req.param('connectionId')!, authority = deps.access ? await deps.access.begin(original, connectionId) : undefined;
    work.check();
    const owner = authority ? authority.principal.userId : legacy().principal(c).userId;
    const connection = authority ? authority.connection : legacy().hubStore.getConnection(connectionId, owner);
    if (!connection || connection.status === 'disabled') throw new HTTPException(404);
    const version = authority ? authority.epoch : legacy().hubStore.connectionAuthority(connectionId, owner);
    if (version === undefined) throw new HTTPException(404);
    let client: ConnectorClient | undefined, flight: Promise<void> | undefined;
    const check = () => flight ??= (async () => {
      work.check();
      if (authority) await authority.checkTarget();
      else if (legacy().principal(c).userId !== owner) throw new HTTPException(401);
      else if (legacy().hubStore.connectionAuthority(connectionId, owner) !== version
        || client && legacy().connectorClient(connectionId, false, owner).eventDomain !== client.eventDomain) throw new HTTPException(403);
      work.check();
    })().finally(() => { flight = undefined; });
    client = await verified(check, () => resolveHubConnectionProxyClient(deps, original, connectionId, owner));
    await check(); c.req.raw.signal.throwIfAborted();
    return { owner, connectionId, client, version, binding, check };
  };
  const lookup = async (c: Context) => {
    const a = await authorize(c), lease = leases.get(c.req.param('accessId')!, a.owner);
    if (lease.value.connectionId !== a.connectionId || lease.value.binding !== a.binding) throw new HTTPException(404);
    if (lease.value.version !== a.version || lease.value.client.eventDomain !== a.client.eventDomain) { leases.remove(lease.id); throw new HTTPException(403); }
    await lease.value.check(); await a.check(); leases.get(lease.id, a.owner);
    c.req.raw.signal.throwIfAborted();
    return { ...a, lease };
  };
  const dispose = (value: Access) => value.remoteClose ??= cleanup.run(async () => {
    const trace = guardedTrace(performanceDiagnostics, 'hub-request-authority'); trace.add('step', 96);
    try { await value.client.jsonOriginal(`/website-access/${value.remoteId}`, { method: 'DELETE', signal: AbortSignal.timeout(3000) }); trace.add('settled', 1); trace.finish(); }
    catch (error) { trace.add('deferred', 1); trace.finish(true); throw error; }
  });
  const safe = (fn: (c: Context) => Promise<Response>) => async (c: Context) => {
    c.header('Cache-Control', 'no-store'); c.header('X-Content-Type-Options', 'nosniff');
    const trace = guardedTrace(performanceDiagnostics, 'hub-request-authority'); trace.add('step', 94);
    try { const response = await work.run(() => fn(c)); trace.add('settled', 1); trace.finish(); return response; }
    catch (error) {
      trace.add('deferred', 1); trace.finish(true);
      if (error instanceof HTTPException) throw error;
      const status = error instanceof HubMemberRequestError ? error.status : error instanceof ConnectorClientError
        ? error.status === 401 ? 403 : [403, 404, 409, 410, 413, 415, 429, 504].includes(error.status) ? error.status : 502 : 502;
      return Response.json({ error: 'Connector website access is unavailable' }, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
  };
  app.post(base, safe(async c => {
    const a = await authorize(c), input = await readJsonBody(c.req.raw, 256).finally(() => a.check()) as { serviceId?: unknown };
    await a.check(); c.req.raw.signal.throwIfAborted();
    if (!input || Object.keys(input).length !== 1 || !validWebsiteId(input.serviceId)) throw new HTTPException(400);
    const lease = leases.create(a.owner, { connectionId: a.connectionId, serviceId: input.serviceId, remoteId: '',
      version: a.version, binding: a.binding, client: a.client, check: a.check });
    lease.controller.signal.addEventListener('abort', () => { if (lease.value.remoteId) void dispose(lease.value).catch(() => {}); }, { once: true });
    const startedAt = Date.now();
    try {
      const remote = await verified(a.check, () => a.client.jsonOriginal<{ accessId: string; serviceId: string; expiresInMs: number }>('/website-access', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: c.req.raw.signal }));
      // Own a valid late ACK even when another field or authority is invalid.
      if (validWebsiteAccessId(remote?.accessId)) lease.value.remoteId = remote.accessId;
      if (!lease.value.remoteId || remote.serviceId !== input.serviceId || !Number.isSafeInteger(remote.expiresInMs)
        || remote.expiresInMs <= 0 || remote.expiresInMs > WEBSITE_ACCESS_TTL) throw new HTTPException(502);
      lease.expiresAt = Math.min(lease.expiresAt, startedAt + remote.expiresInMs);
      await a.check(); c.req.raw.signal.throwIfAborted(); leases.get(lease.id, a.owner);
      return c.json({ accessId: lease.id, serviceId: input.serviceId, expiresAt: lease.expiresAt });
    } catch (error) {
      leases.remove(lease.id);
      if (lease.value.remoteId) await dispose(lease.value).catch(() => {});
      throw error;
    }
  }));
  app.post(`${base}/:accessId/resource`, safe(async c => {
    const a = await lookup(c), input = await readJsonBody(c.req.raw, 8192).finally(() => a.check()) as { path?: unknown };
    await a.check(); leases.get(a.lease.id, a.owner); c.req.raw.signal.throwIfAborted();
    if (!input || Object.keys(input).length !== 1 || typeof input.path !== 'string' || input.path.length > 4096) throw new HTTPException(400);
    const signal = AbortSignal.any([c.req.raw.signal, a.lease.controller.signal, AbortSignal.timeout(Math.max(1, a.lease.expiresAt - Date.now()))]);
    const result = await verified(a.check, () => a.lease.value.client.jsonOriginal<unknown>(`/website-access/${a.lease.value.remoteId}/resource`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal }));
    await a.lease.value.check(); await a.check(); leases.get(a.lease.id, a.owner); signal.throwIfAborted();
    if (!validWebsiteResource(result)) throw new HTTPException(502);
    return c.json({ status: result.status, contentType: result.contentType, bodyBase64: result.bodyBase64 });
  }));
  app.post(`${base}/:accessId/browser`, safe(async c => {
    const a = await lookup(c), { lease } = a, gateway = deps.gateway;
    if (!gateway) throw new HTTPException(409, { message: 'Isolated website gateway is not configured' });
    if (c.req.header('origin') !== gateway.config.parentOrigin) throw new HTTPException(403);
    const input = await readJsonBody(c.req.raw, 32).finally(() => a.check());
    if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).length) throw new HTTPException(400);
    const check = async () => {
      work.check(); await lease.value.check(); work.check(); leases.get(lease.id, a.owner); lease.controller.signal.throwIfAborted();
    };
    await check(); c.req.raw.signal.throwIfAborted();
    const visit = await gateway.open({ key: lease.id, owner: a.owner, expiresAt: lease.expiresAt,
      signal: lease.controller.signal, authorize: () => work.run(check),
      connect: (path, protocols, signal) => work.run(async () => {
        await check(); signal.throwIfAborted();
        const root = `/website-access/${lease.value.remoteId}/sockets`;
        let socketId: string | undefined, closed: Promise<void> | undefined;
        const close = () => {
          if (!socketId) return Promise.resolve();
          if (!closed) {
            signal.removeEventListener('abort', abort);
            closed = cleanup.run(async () => {
              const trace = guardedTrace(performanceDiagnostics, 'hub-request-authority'); trace.add('step', 95);
              try { await lease.value.client.jsonOriginal(`${root}/${socketId}`, { method: 'DELETE', signal: AbortSignal.timeout(1000) }); trace.add('settled', 1); trace.finish(); }
              catch { trace.add('deferred', 1); trace.finish(true); }
            }).catch(() => {});
          }
          return closed;
        };
        const abort = () => { void close(); };
        try {
          const opened = await verified(check, () => lease.value.client.jsonOriginal<{ socketId: string; protocol: string }>(root, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, protocols }), signal }));
          if (!validWebsiteAccessId(opened?.socketId)) throw new HTTPException(502);
          socketId = opened.socketId; signal.addEventListener('abort', abort, { once: true });
          await check(); signal.throwIfAborted();
          if (typeof opened.protocol !== 'string' || (opened.protocol ? !protocols.includes(opened.protocol) : protocols.length > 0)) throw new HTTPException(502);
          return { protocol: opened.protocol, close,
            read: (readSignal: AbortSignal) => work.run(async () => {
              await check(); readSignal.throwIfAborted();
              const output = await verified(check, () => lease.value.client.websiteSocketOutput<{ frames: WebsiteSocketFrame[] }>(lease.value.remoteId, socketId!, readSignal));
              await check(); readSignal.throwIfAborted();
              if (!output || !Array.isArray(output.frames) || output.frames.length > 64 || !output.frames.every(validWebsiteSocketFrame)) throw new HTTPException(502);
              return { frames: output.frames };
            }),
            send: (frame: WebsiteSocketFrame, writeSignal: AbortSignal) => work.run(async () => {
              await check(); writeSignal.throwIfAborted();
              if (!validWebsiteSocketFrame(frame)) throw new HTTPException(400);
              const sent = await verified(check, () => lease.value.client.jsonOriginal<{ sent: boolean }>(`${root}/${socketId}/input`, {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(frame), signal: writeSignal }));
              await check(); writeSignal.throwIfAborted();
              if (sent?.sent !== true) throw new HTTPException(502);
            }) };
        } catch (error) { await close(); throw error; }
      }),
      read: (path, signal) => work.run(async () => {
        await check(); signal.throwIfAborted();
        const resource = await verified(check, () => lease.value.client.jsonOriginal<unknown>(`/website-access/${lease.value.remoteId}/resource`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }), signal }));
        await check(); signal.throwIfAborted();
        if (!validWebsiteResource(resource)) throw new HTTPException(502);
        return resource;
      }) });
    await a.check(); c.req.raw.signal.throwIfAborted();
    return c.json({ url: visit.url, expiresInMs: Math.max(0, visit.expiresAt - Date.now()) });
  }));
  app.delete(`${base}/:accessId`, safe(async c => {
    const a = await lookup(c); leases.remove(a.lease.id);
    await dispose(a.lease.value); await a.check(); c.req.raw.signal.throwIfAborted();
    return c.json({ closed: true });
  }));
  return { close: (): Promise<void> => {
    if (closing) return closing;
    let finish!: () => void, fail!: (error: unknown) => void;
    closing = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    const draining = work.close(); leases.close();
    void (async () => {
      await draining; await cleanup.close();
      if (deps.closeAccess) await deps.closeAccess(); else await deps.access?.close();
    })().then(finish, fail);
    return closing;
  } };
}
