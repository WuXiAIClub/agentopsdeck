import { createHash, randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AuthRouteAuditStore } from '../auth/route-persistence.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { HubRequestWork } from '../hub/async-request-work.js';
import { hubMemberEvidence } from '../hub/member-owner-domain.js';
import { legacyHubConnectionProxyDeps, resolveHubConnectionProxyClient, validateHubConnectionProxyRouteDeps, type HubConnectionProxyRouteDeps } from '../hub/connection-proxy-route-deps.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';
import { ConnectorClientError, type ConnectorClient } from '../hub/connector-client.js';
import { terminalId, terminalSize, terminalUuid } from '../connector/terminals.js';
import { readJsonBody } from '../utils/http-body.js';

export function registerHubTerminals(app: Hono, deps: HubConnectionProxyRouteDeps & {
  audit: Pick<AuthRouteAuditStore, 'append'>; closeAccess?: () => Promise<void> }) {
  validateHubConnectionProxyRouteDeps(deps);
  if (deps.mode === 'async' && typeof deps.audit?.append !== 'function')
    throw Error('Async Hub terminal audit ports are required before route registration');
  const legacy = () => legacyHubConnectionProxyDeps(deps);
  type Lease = { id: string; remote: string; owner: string; connection: string; target: string; binding: string; version: unknown; client: ConnectorClient; valid: () => Promise<boolean>; controller: AbortController; seen: number; created: number };
  const leases = new Map<string, Lease>(), base = '/api/hub/v1/connections/:connectionId/terminals';
  const work = new HubRequestWork(), cleanup = new HubRequestWork(1024);
  let activeStarts = 0, closed = false;
  const pendingOwners = new Map<string, number>();
  const audit = (owner: string, reason: string, target: string) => deps.audit.append({ event: 'api_authz', outcome: 'success', userId: owner, reason: `${reason}:${target}` });
  const remove = (lease: Lease, reason: string) => {
    if (!leases.delete(lease.id)) return Promise.resolve();
    lease.controller.abort();
    // Publish cleanup ownership before either transport or audit can reenter
    // close(). DELETE is best effort once; Connector expiry remains independent.
    return cleanup.run(async () => {
      const trace = guardedTrace(performanceDiagnostics, 'hub-request-authority'); trace.add('step', 90);
      const results = await Promise.allSettled([
        Promise.resolve().then(() => lease.client.jsonOriginal(`/terminals/${lease.remote}`, { method: 'DELETE', signal: AbortSignal.timeout(3000) })),
        Promise.resolve().then(() => audit(lease.owner, `workspace_terminal_${reason}`, lease.target)),
      ]);
      trace.add('settled', 1); trace.finish(results.some(r => r.status === 'rejected'));
    }).catch(() => {
      // Cleanup has no HTTP delivery. Its original transport/audit work has
      // already settled before HubRequestWork's closed-delivery fence rejects.
      // Observe that rejection also for shutdown's deliberately detached remove.
    });
  };
  let scanning = false;
  const timer = setInterval(() => {
    if (closed || scanning) return;
    scanning = true;
    void work.run(async () => {
      for (const l of [...leases.values()]) {
        if (closed) break;
        if (!await l.valid() || Date.now() - l.seen > 40_000 || Date.now() - l.created > 3_600_000) await remove(l, 'expired_or_revoked');
      }
    }).catch(() => {}).finally(() => { scanning = false; });
  }, 1000); timer.unref();
  const safe = (handler: (c: Context) => Response | Promise<Response>) => async (c: Context) => {
    c.header('Cache-Control', 'no-store');
    const trace = guardedTrace(performanceDiagnostics, 'hub-request-authority'); trace.add('step', 88);
    try { const result = await work.run(() => handler(c)); trace.add('settled', 1); trace.finish(); return result; }
    catch (e) {
      trace.add('deferred', 1); trace.finish(true);
      if (e instanceof HubMemberRequestError) return Response.json({ error: 'Terminal unavailable; input was not retried.' }, { status: e.status, headers: { 'Cache-Control': 'no-store' } });
      if (e instanceof HTTPException) throw e;
      const status = e instanceof ConnectorClientError ? (e.status === 401 ? 403 : [403, 404, 409, 429].includes(e.status) ? e.status : 502) : 502;
      return c.json({ error: 'Terminal unavailable; input was not retried.' }, status as 502);
    }
  };
  const connection = async (c: Context) => {
    work.check();
    if (deps.access && !deps.asyncConnectorClient) throw new HTTPException(503);
    // Freeze evidence before the first await. Its lifetime belongs to the
    // terminal, not to the HTTP request which originally created that handle.
    const original = new Request(c.req.url, { headers: new Headers(c.req.raw.headers) });
    const evidence = hubMemberEvidence(original);
    const binding = deps.access ? createHash('sha256').update(JSON.stringify(evidence.accessKey ? { accessKey: evidence.accessKey } : evidence)).digest('hex') : '';
    const id = c.req.param('connectionId')!;
    const access = deps.access ? await deps.access.begin(original, id) : undefined;
    work.check();
    const owner = access ? access.principal.userId : legacy().principal(c).userId;
    const record = access ? access.connection : legacy().hubStore.getConnection(id, owner);
    if (!record || record.status === 'disabled') throw new HTTPException(404);
    const version = access ? access.epoch : legacy().hubStore.connectionAuthority(id, owner);
    const check = async () => {
      work.check();
      if (access) await access.checkTarget();
      else {
        let current;
        try { current = legacy().principal(c); }
        catch (error) {
          // Initial authentication above remains 401. Rechecking an already
          // admitted legacy request retains its original revoked-lease 403.
          // Do not turn storage/shutdown/unclassified failures into revocation.
          if (error instanceof HTTPException && error.status === 401) throw new HTTPException(403);
          throw error;
        }
        if (current.userId !== owner || legacy().hubStore.connectionAuthority(id, owner) !== version) throw new HTTPException(403);
      }
      work.check();
    };
    let flight: Promise<boolean> | undefined;
    const valid = () => flight ??= (async () => {
      const trace = guardedTrace(performanceDiagnostics, 'hub-request-authority'); trace.add('step', 89);
      try { await check(); trace.add('settled', 1); trace.finish(); return true; }
      catch { trace.add('deferred', 1); trace.finish(true); return false; }
    })().finally(() => { flight = undefined; });
    let client: ConnectorClient;
    try { client = await resolveHubConnectionProxyClient(deps, original, id, owner); }
    catch (error) { await check(); throw error; }
    await check();
    if (c.req.raw.signal.aborted) throw new HubMemberRequestError(499);
    return { owner, id, version, binding, valid, check, client };
  };
  type Authority = Awaited<ReturnType<typeof connection>>;
  const checkLease = async (a: Authority, l: Lease, c: Context) => {
    if (l.owner !== a.owner || l.connection !== a.id || l.binding !== a.binding || l.version !== a.version) throw new HTTPException(404);
    if (!await l.valid()) { await remove(l, 'expired_or_revoked'); throw new HTTPException(403); }
    await a.check();
    if (!leases.has(l.id) || l.controller.signal.aborted) throw new HTTPException(404);
    if (c.req.raw.signal.aborted) throw new HubMemberRequestError(499);
  };
  const lease = async (c: Context, a: Authority) => {
    const l = leases.get(c.req.param('id')!);
    if (!l) throw new HTTPException(404);
    await checkLease(a, l, c); return l;
  };
  const body = async (c: Context, a: Authority, keys: string[]) => {
    await a.check();
    const v = await readJsonBody(c.req.raw, 40_000).finally(() => a.check());
    if (c.req.raw.signal.aborted) throw new HubMemberRequestError(499);
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) throw new HTTPException(400);
    return v as Record<string, unknown>;
  };
  app.get(`${base}/targets`, safe(async c => {
    const a = await connection(c);
    let result: { targets: { id: string; label: string; kind: string }[] };
    try { result = await a.client.jsonOriginal('/terminals/targets', { signal: c.req.raw.signal }); }
    catch (error) { await a.check(); throw error; }
    await a.check();
    if (c.req.raw.signal.aborted) throw new HubMemberRequestError(499);
    if (!result || !Array.isArray(result.targets) || result.targets.length > 16 || result.targets.some(t => !t || !terminalId(t.id) || typeof t.label !== 'string' || t.label.length > 80 || !['local', 'ssh'].includes(t.kind))) throw new HTTPException(502);
    return c.json({ targets: result.targets.map(({ id, label, kind }) => ({ id, label, kind })) });
  }));
  app.post(base, safe(async c => {
    const a = await connection(c), v = await body(c, a, ['targetId', 'requestId', 'cols', 'rows']);
    if (!terminalId(v.targetId) || !terminalUuid(v.requestId) || !terminalSize(v.cols, v.rows)) throw new HTTPException(400);
    if (leases.size + activeStarts >= 32 || activeStarts >= 4 || [...leases.values()].filter(l => l.owner === a.owner).length + (pendingOwners.get(a.owner) ?? 0) >= 4) throw new HTTPException(429);
    activeStarts++;
    pendingOwners.set(a.owner, (pendingOwners.get(a.owner) ?? 0) + 1);
    try {
      let result: { id: string };
      try { result = await a.client.jsonOriginal('/terminals', { method: 'POST', body: JSON.stringify(v), signal: c.req.raw.signal }); }
      catch (error) { await a.check(); throw error; }
      if (!result || !terminalUuid(result.id)) throw new HTTPException(502);
      // Do not create two Hub handles for one idempotent Connector start.
      const existing = [...leases.values()].find(l => l.owner === a.owner && l.connection === a.id && l.remote === result.id);
      if (existing) {
        await checkLease(a, existing, c);
        return c.json({ id: existing.id });
      }
      const l: Lease = { id: randomUUID(), remote: result.id, owner: a.owner, connection: a.id, target: v.targetId, version: a.version, binding: a.binding, client: a.client, valid: a.valid, controller: new AbortController(), seen: Date.now(), created: Date.now() };
      leases.set(l.id, l);
      try { await checkLease(a, l, c); await audit(l.owner, 'workspace_terminal_started', l.target); await checkLease(a, l, c); }
      catch (error) { await remove(l, 'start_cancelled'); throw error; }
      return c.json({ id: l.id });
    } finally { activeStarts--; const remaining = (pendingOwners.get(a.owner) ?? 1) - 1; if (remaining) pendingOwners.set(a.owner, remaining); else pendingOwners.delete(a.owner); }
  }));
  for (const operation of ['input', 'resize']) app.post(`${base}/:id/${operation}`, safe(async c => {
    const a = await connection(c), l = await lease(c, a);
    const v = await body(c, a, operation === 'input' ? ['sequence', 'data'] : ['cols', 'rows']);
    if (operation === 'input' ? !Number.isSafeInteger(v.sequence) || Number(v.sequence) < 1 || typeof v.data !== 'string' || !v.data.length || v.data.length > 8192 : !terminalSize(v.cols, v.rows)) throw new HTTPException(400);
    try {
      await checkLease(a, l, c);
      await l.client.jsonOriginal(`/terminals/${l.remote}/${operation}`, { method: 'POST', body: JSON.stringify(v), signal: AbortSignal.any([l.controller.signal, c.req.raw.signal]) });
      await checkLease(a, l, c);
      return c.json({ accepted: true });
    } catch (error) { await remove(l, 'input_uncertain'); await a.check(); throw error; }
  }));
  app.get(`${base}/:id/output`, safe(async c => {
    const a = await connection(c), l = await lease(c, a), cursor = Number(c.req.query('cursor'));
    if (c.req.query('cursor') === undefined || !Number.isSafeInteger(cursor) || cursor < 0) throw new HTTPException(400);
    l.seen = Date.now();
    try {
      const result = await l.client.terminalOutput<{ data: string; cursor: number; more: boolean; truncated: boolean; running: boolean; reason: string | null }>(l.remote, cursor, AbortSignal.any([l.controller.signal, c.req.raw.signal]));
      await checkLease(a, l, c);
      if (!result || typeof result.data !== 'string' || result.data.length > 32768 || !Number.isSafeInteger(result.cursor) || result.cursor < cursor || typeof result.more !== 'boolean' || typeof result.running !== 'boolean' || typeof result.truncated !== 'boolean') throw new HTTPException(502);
      if (!result.running && !result.more) await remove(l, 'exited');
      await a.check();
      return c.json({ data: result.data, cursor: result.cursor, more: result.more, truncated: result.truncated, running: result.running });
    } catch (error) { await remove(l, 'read_disconnected'); await a.check(); throw error; }
  }));
  app.delete(`${base}/:id`, safe(async c => {
    const a = await connection(c); await remove(await lease(c, a), 'stopped'); await a.check();
    return c.json({ stopped: true });
  }));
  let closing: Promise<void> | undefined;
  return { close() {
    if (closing) return closing;
    let complete!: () => void, failed!: (error: unknown) => void;
    closing = new Promise<void>((resolve, reject) => { complete = resolve; failed = reject; });
    closed = true; clearInterval(timer);
    for (const l of leases.values()) void remove(l, 'shutdown');
    void work.close().then(() => cleanup.close()).then(() => deps.closeAccess ? deps.closeAccess() : deps.access?.close()).then(complete, failed);
    return closing;
  } };
}
