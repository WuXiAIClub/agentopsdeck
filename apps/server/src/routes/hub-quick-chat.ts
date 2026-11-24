import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { tokenSnapshotRequestId } from '@agentopsdeck/shared';
import type { HubPrincipal } from '../hub/identity.js';
import { QuickChatConflict } from '../hub/quick-chat-store.js';
import { QuickChatService } from '../hub/quick-chat-service.js';
import type { AsyncHubMemberQuickChatRecovery } from '../hub/async-member-quick-chat-recovery.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { readJsonBody } from '../utils/http-body.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

type QuickChatRouteDependencies = { service: QuickChatService;
  diagnostics?: PerformanceDiagnostics; recovery?: Pick<AsyncHubMemberQuickChatRecovery, 'begin'> } & (
  { mode: 'async'; principal?: never } | { mode?: 'legacy'; principal: (c: Context) => HubPrincipal });

export function registerHubQuickChat(app: Hono, deps: QuickChatRouteDependencies) {
  if (deps.mode === 'async' && typeof deps.service?.persistence?.begin !== 'function')
    throw Error('Async Hub quick chat persistence ports are required before route registration');
  const legacyPrincipal = (c: Context) => {
    if (deps.mode === 'async') throw Error('hub_legacy_quick_chat_not_selected');
    return deps.principal(c);
  };
  const contexts = new WeakMap<Context, { check: () => void | Promise<void> }>();
  const base = '/api/hub/v1/quick-chat', service = deps.service;
  const id = (raw: unknown) => { try { return tokenSnapshotRequestId(raw); } catch { throw new HTTPException(400); } };
  // Fixed event/step only: never record prompts, outputs, credentials, target
  // URLs or raw provider exceptions. Logs cannot authorize or retry a send.
  type Trace = ReturnType<PerformanceDiagnostics['start']>;
  const safe = (step: number, action: (c: Context, trace?: Trace) => Response | Promise<Response>) => async (c: Context) => {
    c.header('Cache-Control', 'no-store');
    let trace: ReturnType<PerformanceDiagnostics['start']> | undefined, failed = true;
    try { trace = (deps.diagnostics ?? performanceDiagnostics).start('hub-quick-chat'); trace.add('step',step); } catch { /* Observation only. */ }
    try {
      let response: Response;
      try { response = await action(c,trace); }
      finally { try { await contexts.get(c)?.check(); } finally { contexts.delete(c); } }
      failed = response.status >= 400; return response;
    } catch (error) {
      try { trace?.add('unknown',1); } catch { /* Preserve the original response. */ }
      if (error instanceof HubMemberRequestError) return new Response(JSON.stringify({ error: 'Quick chat unavailable' }),
        { status: error.status, headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' } });
      if (error instanceof HTTPException) return c.json({ error: 'Quick chat unavailable' }, error.status);
      if (error instanceof QuickChatConflict) return c.json({ error: 'Quick chat input, revision, target or capacity conflict' }, 409);
      return c.json({ error: 'Quick chat outcome unavailable; inspect the original request' }, 503);
    } finally { try { trace?.finish(failed); } catch { /* Never resend or settle to log. */ } }
  };
  const scope = async (c: Context) => {
    if (service.persistence) {
      const context = await service.persistence.begin(c.req.raw);
      contexts.set(c, context);
      return { owner: context.ownerUserId, check: context.check, authorized: () => true, context };
    }
    const owner = legacyPrincipal(c).userId;
    const check = () => { if (legacyPrincipal(c).userId !== owner) throw new HTTPException(403); };
    return { owner, check, authorized: () => { check(); return true; }, context: undefined };
  };
  const fields = (v: unknown, allowed: string[]) => {
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !allowed.includes(k))) throw new HTTPException(400);
  };
  const recovery = async (c: Context, s: Awaited<ReturnType<typeof scope>>) => {
    if (s.context) return s.context;
    if (!deps.recovery) return undefined;
    const owned = await deps.recovery.begin(c.req.raw); await s.check();
    if (owned.ownerUserId !== s.owner) throw new HTTPException(403);
    return owned; // No fallback to synchronous SQL after any owner failure.
  };
  app.get(base, safe(1, async c => {
    const s = await scope(c), target = await service.catalog(s.owner, true); await s.check();
    const owned = await recovery(c, s);
    const value = owned ? await owned.list() : { profiles: service.store.profiles(s.owner),
      receipts: service.store.receipts(s.owner).map(r => service.inspect(s.owner, r.requestId).receipt) };
    await s.check(); return c.json({ target: target ?? null, ...value });
  }));
  app.put(`${base}/profiles/:id`, safe(2, async c => {
    const s = await scope(c), profileId = id(c.req.param('id')), v = await readJsonBody(c.req.raw, 4096) as { revision: number; name: string; target: string; model: string; outputLimit: number };
    await s.check(); fields(v, ['revision', 'name', 'target', 'model', 'outputLimit']);
    await service.catalog(s.owner); await s.check();
    const raw = { id: profileId, name: v.name, target: v.target, model: v.model, outputLimit: v.outputLimit };
    const profile = s.context ? await service.saveProfileAwaited(s.context, v.revision, raw)
      : service.saveProfile(s.owner, v.revision, raw, s.authorized);
    await s.check(); return c.json({ profile });
  }));
  app.post(`${base}/requests`, safe(3, async (c, trace) => {
    const s = await scope(c), v = await readJsonBody(c.req.raw, 320000) as { requestId: string; profileId: string; revision: number; input: string; history?: unknown };
    await s.check(); fields(v, ['requestId', 'profileId', 'revision', 'input', 'history']);
    id(v.requestId); id(v.profileId);
    const result = await service.send(s.owner, v.requestId, v.profileId, v.revision, v.input, s.authorized, v.history, s.context);
    try { trace?.add(result.receipt.state === 'unknown' ? 'unknown' : 'settled',1); } catch { /* Observation only. */ }
    await s.check(); return c.json(result);
  }));
  app.get(`${base}/requests/:id`, safe(4, async c => {
    const s = await scope(c), requestId = id(c.req.param('id')), owned = await recovery(c, s);
    const value = owned ? await owned.inspect(requestId) : service.inspect(s.owner, requestId);
    await s.check(); return c.json(value);
  }));
  app.delete(`${base}/requests/:id/result`, safe(5, async c => {
    const s = await scope(c), requestId = id(c.req.param('id')), owned = await recovery(c, s);
    let value;
    if (owned) value = await owned.clear(requestId);
    else { service.store.clearResult(s.owner, requestId, s.authorized); value = service.inspect(s.owner, requestId); }
    await s.check(); return c.json(value);
  }));
  app.post(`${base}/requests/:id/cancel`, safe(6, async c => {
    const s = await scope(c), requestId = id(c.req.param('id')), owned = await recovery(c, s);
    let value;
    if (owned) value = await owned.cancel(requestId);
    else { service.store.cancelAdmitted(s.owner, requestId, s.authorized); value = service.inspect(s.owner, requestId); }
    await s.check(); return c.json(value);
  }));
  return service;
}
