import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { HubStore } from '../hub/hub-store.js';
import type { HubPrincipal } from '../hub/identity.js';
import { completionTarget, connectionCompletionTarget, CompletionConflict } from '../hub/completion-unread-store.js';
import type { HubCompletionAction, HubCompletionResult } from '../hub/member-completion-domain.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { decodeHubSessionId } from '../hub/session-id.js';
import { readJsonBody } from '../utils/http-body.js';
import { AuthRouteReadWait } from '../auth/route-read-wait.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { HubRequestWork } from '../hub/async-request-work.js';
type Awaitable<T> = T | Promise<T>;
export interface HubCompletionsPort {
  command(request: Request, userId: string, command: HubCompletionAction): Awaitable<HubCompletionResult>;
}

/** Summary keeps the original readonly owner. Mutations may use the awaited
 * fixed-domain port with transaction-local authority; never a second writer. */
export function registerHubCompletions(app: Hono, store: HubStore, principal: (c: Context) => HubPrincipal,
  readWait?: AuthRouteReadWait, mutations?: HubCompletionsPort) {
  const target = (user: string, key: string) => {
    if (key.length > 4096) throw new HTTPException(400);
    const decoded = decodeHubSessionId(key);
    if (!decoded) throw new HTTPException(400);
    const connection = store.getConnection(decoded.connectionId, user), authority = store.connectionAuthority(decoded.connectionId, user);
    if (!connection?.nodeId || connection.status === 'disabled' || authority === undefined) throw new HTTPException(404);
    return { id: connectionCompletionTarget(connection.nodeId, connection.id, authority, decoded.remoteSessionKey),
      displayTarget: completionTarget(connection.nodeId, 'display-only', decoded.remoteSessionKey) };
  };
  const port: HubCompletionsPort = { command: (request, user, command) => {
    if (command.action === 'summary') return (async () => {
      const version = store.connectionDirectoryVersion(user);
      const mapping = new Map<string, ReturnType<typeof target>>();
      for (const key of new Set(command.sessions)) {
        try { mapping.set(key, target(user, key)); }
        catch (error) { if (!(error instanceof HTTPException) || error.status !== 404) throw error; }
      }
      const rows = await store.completionSummaryAsync(user, [...mapping.values()].map(v => v.id));
      // A display generation is NOT an authority proof. Credential changes
      // can increment authority_version without changing directory version.
      try {
        for (const [key, admitted] of mapping) {
          const current = target(user, key);
          if (current.id !== admitted.id) throw new HubMemberRequestError(503);
        }
        if (version !== store.connectionDirectoryVersion(user)) throw new HubMemberRequestError(503);
      } catch (error) {
        // No identities, session keys or credentials in authority-fence logs.
        // Observation failure cannot replace the refusal or release an owner.
        const trace = guardedTrace(performanceDiagnostics, 'hub-completion-summary-read');
        trace.add('step', 3); trace.add('changed', 1); trace.add('settled', 1); trace.add('deferred', 1); trace.finish(true);
        throw error;
      }
      return { items: [...mapping].flatMap(([sessionKey, { id, displayTarget }]) => {
        const row = rows.find(r => r.target === id);
        if (!row) return [];
        const { target: _target, ...value } = row;
        return [{ ...value, sessionKey, displayTarget }];
      }) };
    })();
    if (mutations) return mutations.command(request, user, command);
    const id = target(user, command.sessionKey);
    if (command.action === 'observe') return { observation: store.completions.observe(user, id.id) };
    return { throughSequence: store.completions.markRead(user, id.id, command.requestId, command.token, command.throughSequence) };
  } };
  return registerHubCompletionRoutes(app, { port, principal, synchronousStoreAuthority: principal, ...(readWait ? { readWait } : {}) });
}

export function registerHubCompletionRoutes(app: Hono, deps: {
  port: HubCompletionsPort; principal(c: Context): Awaitable<HubPrincipal>;
  synchronousStoreAuthority?(c: Context): HubPrincipal;
  /** Only the complete async port supplies a final atomic identity+directory
   * proof. Do not insert another identity RPC after that delivery boundary. */
  atomicDeliveryAuthority?: true;
  readWait?: AuthRouteReadWait;
}) {
  const work = new HubRequestWork();
  const ownedReads = deps.readWait ? undefined : new AuthRoutePersistence();
  const reads = deps.readWait ?? new AuthRouteReadWait(ownedReads!);
  const recheck = (c: Context, actor: HubPrincipal) => {
    work.check();
    if (!deps.synchronousStoreAuthority) return;
    const current = deps.synchronousStoreAuthority(c);
    if (!current || current.userId !== actor.userId || current.admin !== actor.admin) throw new HTTPException(401);
  };
  const execute = async (c: Context, actor: HubPrincipal, command: HubCompletionAction) => {
    recheck(c, actor);
    const summary = async () => {
      try {
        const result = (await reads.run(c.req.raw, 26, async () => {
          try { return { result: await deps.port.command(c.req.raw, actor.userId, command) }; }
          catch (error) {
            // Only known refusal types bypass unknown-error sanitization.
            if (error instanceof HubMemberRequestError || error instanceof CompletionConflict || error instanceof HTTPException)
              return { refusal: error };
            throw error;
          }
        })).value;
        if ('refusal' in result) throw result.refusal;
        return result.result;
      } catch (error) {
        if (error instanceof HubMemberRequestError || error instanceof CompletionConflict || error instanceof HTTPException) throw error;
        throw new HubMemberRequestError(c.req.raw.signal.aborted ? 499 : 503);
      }
    };
    // Read cancellation is not write settlement: observe/read must never
    // inherit a display timeout or replay their original committed effect.
    const result = command.action === 'summary' ? await summary() : await deps.port.command(c.req.raw, actor.userId, command);
    recheck(c, actor);
    // An async port performs its own original SQL proof plus final proof. A
    // synchronous facade cannot silently return a Promise-shaped permission.
    if (!deps.atomicDeliveryAuthority) {
      const current = await deps.principal(c);
      if (!current || current.userId !== actor.userId || current.admin !== actor.admin) throw new HTTPException(401);
    }
    recheck(c, actor); // No stale synchronous grant across the final await gap.
    if (!result) throw new HTTPException(401);
    if ('error' in result) throw new HTTPException(result.error === 'invalid' ? 400 : 404);
    if ('conflict' in result) return c.json({ error: result.conflict }, 409);
    if (command.action === 'observe' && 'observation' in result) return c.json(result.observation);
    if (command.action === 'summary' && 'items' in result) return c.json(result);
    if (command.action === 'read' && 'throughSequence' in result) return c.json(result);
    throw new HTTPException(503, { message: 'Completion state temporarily unavailable' });
  };
  const run = async (operation: () => Promise<Response>) => {
    try { return await work.run(operation); }
    catch (error) {
      if (error instanceof CompletionConflict) return new Response(JSON.stringify({ error: error.message }), {
        status: 409, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
      if (!(error instanceof HubMemberRequestError)) throw error;
      if (error.status === 499) return new Response(JSON.stringify({ error: 'request_cancelled' }), {
        status: 499, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
      throw new HTTPException(error.status, { message: 'Completion state temporarily unavailable' });
    }
  };
  app.post('/api/hub/v1/completions/summary', c => run(async () => {
    c.header('Cache-Control', 'no-store');
    const actor = await deps.principal(c), body = await readJsonBody(c.req.raw, 64 * 1024) as { sessions?: unknown };
    recheck(c, actor);
    const current = await deps.principal(c);
    if (current.userId !== actor.userId || current.admin !== actor.admin) throw new HTTPException(401);
    if (!body || Object.keys(body).join() !== 'sessions' || !Array.isArray(body.sessions) || body.sessions.length > 256
      || !body.sessions.every(key => typeof key === 'string' && key.length <= 4096)) throw new HTTPException(400);
    return execute(c, actor, { action: 'summary', sessions: body.sessions });
  }));
  app.post('/api/hub/v1/completions/observe', c => run(async () => {
    c.header('Cache-Control', 'no-store');
    const actor = await deps.principal(c), body = await readJsonBody(c.req.raw, 8192) as { sessionKey?: unknown };
    recheck(c, actor);
    const current = await deps.principal(c);
    if (current.userId !== actor.userId || current.admin !== actor.admin) throw new HTTPException(401);
    if (!body || Object.keys(body).join() !== 'sessionKey' || typeof body.sessionKey !== 'string' || body.sessionKey.length > 4096) throw new HTTPException(400);
    return execute(c, actor, { action: 'observe', sessionKey: body.sessionKey });
  }));
  app.post('/api/hub/v1/completions/read', c => run(async () => {
    c.header('Cache-Control', 'no-store');
    const actor = await deps.principal(c), body = await readJsonBody(c.req.raw, 8192) as { sessionKey?: unknown; requestId?: unknown; token?: unknown; throughSequence?: unknown };
    recheck(c, actor);
    const current = await deps.principal(c);
    if (current.userId !== actor.userId || current.admin !== actor.admin) throw new HTTPException(401);
    if (!body || Object.keys(body).sort().join() !== 'requestId,sessionKey,throughSequence,token' || typeof body.requestId !== 'string'
      || typeof body.token !== 'string' || typeof body.throughSequence !== 'number' || typeof body.sessionKey !== 'string'
      || body.sessionKey.length > 4096) throw new HTTPException(400);
    return execute(c, actor, { action: 'read', sessionKey: body.sessionKey, requestId: body.requestId, token: body.token, throughSequence: body.throughSequence });
  }));
  let closing: Promise<void> | undefined;
  return { close: () => closing ??= work.close().then(() => ownedReads?.close()) };
}
