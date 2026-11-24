import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { tokenSnapshotRequestId } from '@agentopsdeck/shared';
import type { ConnectorClient } from '../hub/connector-client.js';
import { decodeHubSessionId } from '../hub/session-id.js';
import { GuidanceConflict, type GuidanceSubmission, type SessionGuidanceStore } from '../hub/session-guidance-store.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { HubRequestWork } from '../hub/async-request-work.js';
import { readJsonBody } from '../utils/http-body.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';

type Awaitable<T> = T | Promise<T>;
export type GuidanceConnectorAck = { key: string; id: string; state: 'accepted' | 'rejected' };
export interface HubSessionGuidanceScope {
  readonly request: Request;
  readonly nodeId: string;
  readonly ownerUserId: string;
  readonly connectionId: string;
  readonly remoteSessionKey: string;
  check(): Awaitable<void>;
  inspect(): Awaitable<ReturnType<SessionGuidanceStore['inspect']>>;
  save(revision: number, text: string, enabled: boolean): Awaitable<void>;
  prepare(requestId: string, revision: number, input: string): Awaitable<GuidanceSubmission>;
  lookup(requestId: string): Awaitable<{ receipt: GuidanceSubmission | null; cancelled: boolean }>;
  cancel(requestId: string): Awaitable<void>;
  claim(requestId: string): Awaitable<{ receipt: GuidanceSubmission; claimed: boolean }>;
  reconcile(requestId: string, ack: GuidanceConnectorAck): Awaitable<void>;
}
export interface HubSessionGuidancePort {
  begin(request: Request, sessionId: string): Awaitable<HubSessionGuidanceScope>;
}

/** One HTTP contract for the original synchronous store and the complete async
 * Hub owner. Remote I/O stays outside SQL transactions. Waiting is not a claim,
 * a cancellation is not a receipt, and UNKNOWN never grants another send. */
export function registerHubSessionGuidanceRoutes(app: Hono, deps: {
  begin(c: Context, sessionId: string): Awaitable<HubSessionGuidanceScope>;
  connectorClient(connectionId: string, userId: string, request: Request): Awaitable<ConnectorClient>;
  diagnostics?: PerformanceDiagnostics;
}) {
  const base = '/api/hub/v1/sessions/:sessionId/guidance';
  const diagnostics = deps.diagnostics ?? performanceDiagnostics;
  const requests = new HubRequestWork();
  let closed = false;
  const observe = (step: number, outcome: 'unknown' | 'deferred') => {
    const trace = guardedTrace(diagnostics, 'hub-session-guidance');
    trace.add('step', step); trace.add(outcome, 1); trace.finish(true);
  };
  const requestId = (value: unknown) => {
    try { return tokenSnapshotRequestId(value); } catch { throw new HTTPException(400); }
  };
  const scope = async (c: Context) => {
    const id = c.req.param('sessionId')!, decoded = decodeHubSessionId(id);
    if (closed) throw new HubMemberRequestError(503);
    if (!decoded || id.length > 4096
      || !['codex:', 'claude-code:', 'ghcp:'].some(prefix => decoded.remoteSessionKey.startsWith(prefix))) throw new HTTPException(404);
    const original = await deps.begin(c, id);
    const check = async () => {
      if (closed) throw new HubMemberRequestError(503);
      await original.check();
      if (closed) throw new HubMemberRequestError(503);
    };
    await check();
    return { original, check };
  };
  type Scope = Awaited<ReturnType<typeof scope>>;
  const call = async <T>(s: Scope, work: () => Awaitable<T>): Promise<T> => {
    await s.check();
    const result = await work();
    await s.check();
    return result;
  };
  const client = async (c: Context, s: Scope) => {
    const result = await Promise.resolve().then(() => deps.connectorClient(s.original.connectionId, s.original.ownerUserId, s.original.request)).finally(s.check);
    await s.check(); c.req.raw.signal.throwIfAborted();
    if (result.expectedNodeId !== s.original.nodeId) throw new HubMemberRequestError(409);
    return result;
  };
  const safe = (step: number, work: (c: Context) => Promise<Response>) => async (c: Context) => {
    const trace = guardedTrace(diagnostics, 'hub-session-guidance'); let failed = true;
    c.header('Cache-Control', 'no-store');
    try { const response = await requests.run(() => work(c)); failed = response.status >= 400; return response; }
    catch (error) {
      if (error instanceof GuidanceConflict || error instanceof HubMemberRequestError && error.status === 409)
        return c.json({ error: 'Guidance revision, request or capacity conflict' }, 409);
      if (error instanceof HubMemberRequestError && error.status === 499)
        return new Response(JSON.stringify({ error: 'request_cancelled' }), {
          status: 499, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      if (error instanceof HTTPException) return c.json({ error: 'Guidance unavailable' }, error.status);
      if (error instanceof HubMemberRequestError && error.status !== 503 && error.status !== 499)
        return c.json({ error: 'Guidance unavailable' }, error.status);
      return c.json({ error: 'Guidance outcome unavailable; inspect the original request' }, 503);
    } finally {
      trace.add('step', step); if (failed) trace.add('deferred', 1); trace.finish(failed);
    }
  };
  const view = (receipt: GuidanceSubmission) => {
    const { commandKey: _, inputHash: __, ...result } = receipt; return result;
  };
  const lookup = (s: Scope, id: string) => call(s, () => s.original.lookup(id));
  const receipt = async (s: Scope, id: string) => {
    const found = await lookup(s, id);
    if (!found.receipt) throw new HTTPException(404);
    return found.receipt;
  };
  const settle = async (s: Scope, original: GuidanceSubmission, body: unknown) => {
    await s.check();
    const command = (body as { command?: { key?: unknown; id?: unknown; state?: unknown } } | null)?.command;
    if (!original.commandKey || command?.key !== original.commandKey || typeof command.id !== 'string'
      || !command.id || command.id.length > 512 || /[\u0000-\u001f\u007f]/.test(command.id)
      || (command.state !== 'accepted' && command.state !== 'rejected')) {
      observe(9, 'deferred'); return;
    }
    const ack: GuidanceConnectorAck = { key: original.commandKey, id: command.id, state: command.state as 'accepted' | 'rejected' };
    await call(s, () => s.original.reconcile(original.requestId, ack));
  };
  const recover = async (c: Context, s: Scope, original: GuidanceSubmission) => {
    if (original.state === 'unknown' && original.commandKey) {
      try {
        const transport = await client(c, s);
        const body = await transport.json<unknown>(
          `/sessions/${encodeURIComponent(s.original.remoteSessionKey)}/commands/${encodeURIComponent(original.commandKey)}`,
          { signal: c.req.raw.signal });
        await settle(s, original, body);
      } catch { observe(7, 'unknown'); }
    }
    return receipt(s, original.requestId);
  };
  app.get(base, safe(1, async c => {
    const s = await scope(c), guidance = await call(s, () => s.original.inspect());
    return c.json({ guidance: guidance ?? null, contextVerification: 'unsupported' });
  }));
  app.put(base, safe(2, async c => {
    const s = await scope(c), body = await readJsonBody(c.req.raw, 40000).finally(s.check) as { revision: number; text: string; enabled: boolean };
    if (!body || Array.isArray(body) || Object.keys(body).some(key => !['revision', 'text', 'enabled'].includes(key))) throw new HTTPException(400);
    await call(s, () => s.original.save(body.revision, body.text, body.enabled));
    const guidance = await call(s, () => s.original.inspect());
    return c.json({ guidance, contextVerification: 'unsupported' });
  }));
  app.post(`${base}/submissions`, safe(3, async c => {
    const s = await scope(c), body = await readJsonBody(c.req.raw, 40000).finally(s.check) as { requestId: string; revision: number; input?: string };
    if (!body || Array.isArray(body) || Object.keys(body).some(key => !['revision', 'requestId', 'input'].includes(key))
      || body.input !== undefined && (typeof body.input !== 'string' || body.input.length > 8000)) throw new HTTPException(400);
    requestId(body.requestId);
    const prepared = await call(s, () => s.original.prepare(body.requestId, body.revision, body.input ?? ''));
    return c.json({ receipt: view(prepared) }, 201);
  }));
  app.get(`${base}/submissions/:id`, safe(4, async c => {
    const s = await scope(c), id = requestId(c.req.param('id')), found = await lookup(s, id);
    if (found.cancelled) return c.json({ receipt: null, cancelled: true, requestId: id });
    if (!found.receipt) throw new HTTPException(404);
    return c.json({ receipt: view(await recover(c, s, found.receipt)) });
  }));
  app.delete(`${base}/submissions/:id`, safe(5, async c => {
    const s = await scope(c), id = requestId(c.req.param('id'));
    await call(s, () => s.original.cancel(id));
    return c.json({ receipt: null, cancelled: true, requestId: id });
  }));
  app.post(`${base}/submissions/:id/submit`, safe(6, async c => {
    const s = await scope(c), id = requestId(c.req.param('id')), body = await readJsonBody(c.req.raw, 32).finally(s.check);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new HTTPException(400);
    const original = await receipt(s, id);
    if (!original.commandKey) throw new GuidanceConflict('legacy-preview');
    c.req.raw.signal.throwIfAborted();
    const claim = await call(s, () => s.original.claim(id));
    if (claim.claimed) {
      if (claim.receipt.commandKey !== original.commandKey || claim.receipt.requestId !== id
        || claim.receipt.state !== 'unknown') throw new HubMemberRequestError(503);
      try {
        const transport = await client(c, s);
        const result = await transport.jsonResponse<unknown>(
          `/sessions/${encodeURIComponent(s.original.remoteSessionKey)}/messages`, {
            method: 'POST', signal: c.req.raw.signal,
            headers: { 'content-type': 'application/json', 'idempotency-key': original.commandKey },
            body: JSON.stringify({ message: claim.receipt.text, deliveryMode: 'web-only', idempotencyKey: original.commandKey }),
          });
        await settle(s, claim.receipt, result.body);
      } catch { observe(8, 'unknown'); }
    }
    return c.json({ receipt: view(await recover(c, s, await receipt(s, id))) });
  }));
  return { close() { closed = true; return requests.close(); } };
}
