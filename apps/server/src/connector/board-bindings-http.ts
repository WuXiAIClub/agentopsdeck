import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { validBoardUuid } from '@agentopsdeck/shared';
import type { ConnectorMachineAuthority } from './machine-authority.js';
import { settleMachineWork } from './machine-authority.js';
import { registerFileRequestOwnership } from './file-authority.js';
import { readJsonBody } from '../utils/http-body.js';
import { ConnectorBoardBindings, BoardBindingError, validBoardBindingInput, type BoardBindingPolicy, type BoardBindingRuntime } from './board-bindings.js';

export type BoardBindingSessionRead = (key: string) => { runtime: BoardBindingRuntime; sessionId: string; ready: boolean } | undefined
  | PromiseLike<{ runtime: BoardBindingRuntime; sessionId: string; ready: boolean } | undefined>;

export function registerConnectorBoardBindings(app: Hono, deps: {
  tokens: ConnectorMachineAuthority;
  directories: Partial<Record<BoardBindingRuntime, string>>;
  policies: readonly BoardBindingPolicy[];
  resolveSession: BoardBindingSessionRead;
  deferredStart?: boolean;
  available?: () => boolean;
}) {
  const base = '/api/connector/v1/sessions/:key/board-binding';
  const requests = registerFileRequestOwnership(app, base, undefined, 'connector-machine-services');
  const controller = new AbortController();
  let healthy = true, started = false;
  const bindings = new ConnectorBoardBindings(deps.directories, deps.policies, owner => deps.tokens.hasScope(owner, 'boards:bind'));
  let resolveReady!: () => void, rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((yes, no) => { resolveReady = yes; rejectReady = no; });
  void ready.catch(() => {});
  let recovery: Promise<void> | undefined, watch: Promise<void> | undefined;
  const start = (): Promise<void> => {
    if (started || controller.signal.aborted) return ready;
    started = true;
    // Own raw recovery independently of ready: freeze may reject delivery,
    // but close must still retain the exact in-flight filesystem operation.
    recovery = Promise.resolve().then(async () => {
      await bindings.reconcile();
      if (controller.signal.aborted) throw new HTTPException(503);
      resolveReady();
    });
    void recovery.catch(() => { healthy = false; rejectReady(new HTTPException(503)); });
    // Default-off must not allocate a watcher. Removed policies still reconcile
    // configured directories so managed grants cannot outlive revocation.
    watch = recovery.then(async () => {
      if (!Object.values(deps.directories).some(Boolean)) return;
      while (!controller.signal.aborted) {
        const revision = deps.tokens.changes.revision;
        try { await bindings.reconcile(); healthy = true; }
        catch { healthy = false; }
        await deps.tokens.changes.wait(revision, controller.signal);
      }
    }).catch(() => { healthy = false; });
    return ready;
  };
  if (!deps.deferredStart) void start();
  const actor = async (c: Context) => {
    c.header('Cache-Control', 'no-store');
    requests.check(c.req.raw);
    if (!started || deps.available?.() === false) throw new HTTPException(503);
    if (!await deps.tokens.authenticate(c.req.raw)) throw new HTTPException(401);
    requests.check(c.req.raw);
    const principal = await deps.tokens.requireScope(c.req.raw, 'boards:bind');
    requests.check(c.req.raw);
    if (deps.available?.() === false) throw new HTTPException(503);
    if (!principal) throw new HTTPException(403);
    if (!healthy || controller.signal.aborted) throw new HTTPException(503);
    requests.check(c.req.raw);
    return principal;
  };
  const session = async (c: Context) => {
    const current = await deps.resolveSession(c.req.param('key')!);
    requests.check(c.req.raw);
    if (deps.available?.() === false) throw new HTTPException(503);
    if (!current || !validBoardUuid(current.sessionId)) throw new HTTPException(404);
    return current;
  };
  const safe = (handler: (c: Context) => Promise<Response>) => async (c: Context) => {
    try { await actor(c); await ready; await actor(c); return await handler(c); }
    catch (e) { return c.json({ error: 'Private task binding unavailable; inspect the original request' }, e instanceof HTTPException ? e.status : e instanceof BoardBindingError ? e.status : 503); }
  };
  app.get(base, safe(async c => {
    const a = await actor(c), s = await session(c), result = await bindings.get(a.tokenId, s.runtime, s.sessionId);
    const after = await actor(c), current = await session(c);
    if (after.tokenId !== a.tokenId || current.sessionId !== s.sessionId || current.runtime !== s.runtime) throw new HTTPException(409);
    return c.json({ binding: result ?? null, runtime: s.runtime, sessionId: s.sessionId, ready: current.ready });
  }));
  app.put(base, safe(async c => {
    const before = await actor(c), original = await session(c);
    const body = await readJsonBody(c.req.raw, 4096), a = await actor(c), s = await session(c);
    if (a.tokenId !== before.tokenId || s.sessionId !== original.sessionId || s.runtime !== original.runtime) throw new HTTPException(409);
    if (!s.ready) throw new HTTPException(503);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2 || !('id' in body) || !('credential' in body)) throw new HTTPException(400);
    const input = { id: body.id, credential: body.credential, runtime: s.runtime, sessionId: s.sessionId };
    if (!validBoardBindingInput(input)) throw new HTTPException(400);
    const result = await bindings.install(a.tokenId, input, () => requests.check(c.req.raw));
    try {
      const after = await actor(c), current = await session(c);
      if (after.tokenId !== a.tokenId || current.sessionId !== s.sessionId || current.runtime !== s.runtime) throw new HTTPException(409);
    } catch (error) {
      // Cleanup targets the admitted native session, never a newly resolved one.
      await bindings.remove(a.tokenId, s.runtime, s.sessionId, input.id).catch(() => {});
      throw error;
    }
    return c.json({ binding: result });
  }));
  app.delete(`${base}/:id`, safe(async c => {
    const a = await actor(c), s = await session(c), id = c.req.param('id')!;
    if (!validBoardUuid(id)) throw new HTTPException(400);
    const result = await bindings.remove(a.tokenId, s.runtime, s.sessionId, id);
    await actor(c);
    return c.json(result);
  }));
  let closing: Promise<void> | undefined;
  const freeze = () => {
    controller.abort(); rejectReady(new HTTPException(503));
    return requests.close();
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    closing = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const drained = freeze();
    void (async () => {
      // A rejected recovery is already reported through ready, not a reason to
      // skip physical peer drains or final managed-grant cleanup.
      await settleMachineWork([drained, ...(recovery ? [recovery.catch(() => {})] : []), ...(watch ? [watch] : [])]);
      if (started) await bindings.reconcile();
    })().then(resolve, () => reject(new BoardBindingError(503)));
    return closing;
  };
  return { ready, start, freeze, close };
}
