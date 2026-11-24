import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import { validBoardUuid } from '@agentopsdeck/shared';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { readJsonBody, readOptionalJsonBody } from '../utils/http-body.js';
import { ChangeSignal } from '../utils/change-signal.js';
import { ConnectorFileBoards, ConnectorWorkspaceFiles, FileBoardError, type WorkspaceFileEffects } from './workspace-board-files.js';
import type { AsyncWorkspaceFiles } from './async-workspace-files.js';
import type { WorkspaceFileActor } from './connector-workspace-file-domain.js';
import type { WorkspaceFileSnapshot } from './workspace-file-codec.js';
import type { FileBoardRuntime } from './workspace-board-file-policy.js';
import { createTaskDrain } from '../lifecycle/task-drain.js';

/** Registered only with an explicitly configured manager. No generic file
 * reads, Agent commands or task-tool privileges are accepted by this API. */
export function registerConnectorFileBoards(app: Hono, deps: {
  tokens: ConnectorTokenStore; boards: ConnectorFileBoards;
  runtimes?: (owner: string) => readonly FileBoardRuntime[];
  session: (key: string) => { exists: boolean; ready: boolean } | Promise<{ exists: boolean; ready: boolean }>;
}) {
  return registerConnectorWorkspaceFiles(app, deps);
}
export function registerConnectorWorkspaceFiles<T>(app: Hono, deps: {
  tokens: ConnectorTokenStore; boards: ConnectorWorkspaceFiles<T>;
  runtimes?: (owner: string) => readonly FileBoardRuntime[];
  session: (key: string) => { exists: boolean; ready: boolean } | Promise<{ exists: boolean; ready: boolean }>;
}) {
  return registerWorkspaceFileRoutes<T,string>(app, {
    ...deps,
    authority: {
      changes: deps.tokens.changes,
      authenticate: request => {
        if (!deps.tokens.authenticate(request)) return null;
        const principal = deps.tokens.requireScope(request, 'boards:files');
        if (!principal) throw new HTTPException(403);
        return { id: principal.tokenId, actor: principal.tokenId };
      },
      hasScope: id => deps.tokens.hasScope(id, 'boards:files'),
    },
  });
}

/** Same routes and physical executor as the legacy root; only durable authority
 * and metadata cross the fixed worker protocol. Never substitute tokenId for
 * the original transport evidence. */
export function registerAsyncConnectorWorkspaceFiles<T>(app: Hono, deps: {
  boards: AsyncWorkspaceFiles<T>;
  authority: WorkspaceFileHttpAuthority<WorkspaceFileActor>;
  deferredStart?: boolean;
  runtimes?: (owner: string) => readonly FileBoardRuntime[] | Promise<readonly FileBoardRuntime[]>;
  session: (key: string) => { exists: boolean; ready: boolean } | Promise<{ exists: boolean; ready: boolean }>;
}) { return registerWorkspaceFileRoutes<T,WorkspaceFileActor>(app,deps); }

export type WorkspaceFileHttpAuthority<Actor> = {
  changes: ChangeSignal;
  authenticate(request: Request): { id: string; actor: Actor } | null | Promise<{ id: string; actor: Actor } | null>;
  hasScope(id: string): boolean | Promise<boolean>;
};
type FileRoutesPort<T,Actor> = Pick<WorkspaceFileEffects<T,Actor>,
  'codec' | 'changes' | 'snapshot' | 'install' | 'write' | 'revoke' | 'reconcile' | 'close'> & {
  get(owner: Actor,id: string): ReturnType<WorkspaceFileEffects<T,Actor>['get']> | Awaited<ReturnType<WorkspaceFileEffects<T,Actor>['get']>>;
  receipt(owner: Actor,id: string,mutation: string): ReturnType<WorkspaceFileEffects<T,Actor>['receipt']> | Awaited<ReturnType<WorkspaceFileEffects<T,Actor>['receipt']>>;
  subscribe(owner: Actor,id: string,dirty: () => void): Promise<{
    current(): WorkspaceFileSnapshot<T> | Promise<WorkspaceFileSnapshot<T>>; release(): Promise<void>;
  }>;
};
function registerWorkspaceFileRoutes<T,Actor>(app: Hono, deps: {
  boards: FileRoutesPort<T,Actor>; authority: WorkspaceFileHttpAuthority<Actor>;
  deferredStart?: boolean;
  runtimes?: (owner: string) => readonly FileBoardRuntime[] | Promise<readonly FileBoardRuntime[]>;
  session: (key: string) => { exists: boolean; ready: boolean } | Promise<{ exists: boolean; ready: boolean }>;
}) {
  const codec = deps.boards.codec;
  const base = codec.name === 'tasks.json' ? '/api/connector/v1/workspace/board-files' : '/api/connector/v1/workspace/card-files';
  const eventPrefix = codec.name === 'tasks.json' ? 'board-file' : 'card-file';
  const shutdown = new AbortController(), streams = new Map<AbortController, string>();
  const requests = createTaskDrain(), streamWork = new Set<Promise<void>>();
  let healthy = true, started = false, watcher: Promise<void> | undefined;
  let resolveReady!: () => void, rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((yes, no) => { resolveReady = yes; rejectReady = no; });
  void ready.catch(() => {});
  const start = (): Promise<void> => {
    if (started || shutdown.signal.aborted) return ready;
    started = true;
    // Publish ownership before entering the original executor. Deferred roots
    // remain inert until their owner and original native binding are ready.
    watcher = (async () => {
      await deps.boards.reconcile();
      if (shutdown.signal.aborted) throw new HTTPException(503);
      resolveReady();
      while (!shutdown.signal.aborted) {
        const revision = deps.authority.changes.revision;
        await deps.boards.reconcile();
        for (const [controller, owner] of streams) if (!await deps.authority.hasScope(owner)) controller.abort();
        await deps.authority.changes.wait(revision, shutdown.signal);
      }
    })().catch(() => {
      healthy = false; rejectReady(new HTTPException(503));
      for (const controller of streams.keys()) controller.abort();
    });
    return ready;
  };
  if (!deps.deferredStart) void start();
  const actor = async (c: Context) => {
    if (!started || !healthy || shutdown.signal.aborted) throw new HTTPException(503);
    const principal = await deps.authority.authenticate(c.req.raw);
    if (!principal) throw new HTTPException(401);
    if (!healthy || shutdown.signal.aborted) throw new HTTPException(503);
    if (c.req.url.includes('?')) throw new HTTPException(400);
    return principal;
  };
  const recheck = async (c: Context,id: string) => {
    if ((await actor(c)).id !== id) throw new HTTPException(401);
  };
  const safe = (handler: (c: Context, owner: Actor, id: string) => Promise<Response> | Response) => async (c: Context) => {
    c.header('Cache-Control', 'no-store');
    try { return await requests.run(async () => {
      const owner = await actor(c); await ready; await recheck(c,owner.id); return await handler(c, owner.actor, owner.id);
    }); }
    catch (e) { return c.json({ error: 'File panel unavailable; inspect the original binding before retrying' },
      e instanceof HTTPException ? e.status : e instanceof FileBoardError ? e.status : 503); }
  };
  app.get(base, safe(async (c, _owner, id) => {
    const runtimes = deps.runtimes ? await deps.runtimes(id) : undefined;
    await recheck(c,id);
    return c.json({ protocol: 1, writeProtocol: 1, maxBindings: 64,
    mode: codec.name === 'tasks.json' ? 'whole-board-file' : 'workspace-card-file',
    ...(codec.name === 'card.json' ? { notebookArchiveProtocol: 1 } : {}),
    ...(deps.runtimes ? { runtimeProtocol: 1, runtimes } : {}),
  }); }));
  app.get(`${base}/:id`, safe(async (c, owner, id) => {
    const binding = await deps.boards.get(owner,c.req.param('id')!);
    await recheck(c,id); return c.json({binding});
  }));
  app.get(`${base}/:id/snapshot`, safe(async (c, owner, id) => {
    const snapshot = await deps.boards.snapshot(owner, c.req.param('id')!);
    await recheck(c,id);
    return c.json({ snapshot });
  }));
  app.get(`${base}/:id/writes/:mutationId`, safe(async (c, owner, id) => {
    const receipt = await deps.boards.receipt(owner,c.req.param('id')!,c.req.param('mutationId')!);
    await recheck(c,id); return c.json({receipt});
  }));
  app.post(`${base}/:id/writes`, safe(async (c, owner, id) => {
    const input = await readJsonBody(c.req.raw, codec.maxBytes + 4096);
    await recheck(c,id);
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).sort().join(',') !== 'content,expectedHash,mutationId'
      || !('mutationId' in input) || !validBoardUuid(input.mutationId)
      || !('expectedHash' in input) || typeof input.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedHash)
      || !('content' in input) || !codec.valid(input.content)) throw new HTTPException(400);
    const binding = await deps.boards.get(owner, c.req.param('id')!);
    const session = await deps.session(binding.sessionKey);
    await recheck(c,id);
    if (!session.exists) throw new HTTPException(404);
    if (!session.ready) throw new HTTPException(503);
    const receipt = await deps.boards.write(owner, binding.id, { mutationId: input.mutationId, expectedHash: input.expectedHash, content: input.content });
    await recheck(c,id);
    return c.json({ receipt });
  }));
  app.put(`${base}/:id`, safe(async (c, owner, id) => {
    const input = await readJsonBody(c.req.raw, codec.maxBytes + 4096);
    await recheck(c,id);
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).sort().join(',') !== 'content,sessionKey'
      || !('sessionKey' in input) || typeof input.sessionKey !== 'string'
      || !('content' in input) || !codec.valid(input.content) || !validBoardUuid(c.req.param('id'))) throw new HTTPException(400);
    const session = await deps.session(input.sessionKey);
    await recheck(c,id);
    if (!session.exists) throw new HTTPException(404);
    // Receipts are still readable while the runtime is draining/offline. Only
    // a genuinely new installation needs readiness; retries cannot rewrite.
    let existing = false;
    try { await deps.boards.get(owner, c.req.param('id')!); existing = true; }
    catch (e) { if (!(e instanceof FileBoardError) || e.status !== 404) throw e; }
    if (!existing && !session.ready) throw new HTTPException(503);
    const binding = await deps.boards.install(owner, { id: c.req.param('id')!, sessionKey: input.sessionKey, content: input.content });
    await recheck(c,id);
    return c.json({ binding });
  }));
  app.delete(`${base}/:id`, safe(async (c, owner, id) => {
    let sessionKey: string | undefined;
    const input = await readOptionalJsonBody(c.req.raw, 1024);
    if (input !== undefined) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join(',') !== 'sessionKey'
        || !('sessionKey' in input) || typeof input.sessionKey !== 'string') throw new HTTPException(400);
      sessionKey = input.sessionKey;
    }
    await recheck(c,id);
    const binding = await deps.boards.revoke(owner, c.req.param('id')!, sessionKey);
    await recheck(c,id);
    return c.json({ binding });
  }));
  app.post(`${base}/subscribe`, safe(async (c, owner, ownerId) => {
    const input = await readJsonBody(c.req.raw, 4096);
    await recheck(c,ownerId);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join(',') !== 'ids'
      || !('ids' in input) || !Array.isArray(input.ids) || !input.ids.length || input.ids.length > 64
      || !input.ids.every(validBoardUuid) || new Set(input.ids).size !== input.ids.length) throw new HTTPException(400);
    if (streams.size >= 16 || [...streams.values()].filter(id => id === ownerId).length >= 2) throw new HTTPException(429);
    const controller = new AbortController(); streams.set(controller, ownerId);
    type Subscription = Awaited<ReturnType<FileRoutesPort<T,Actor>['subscribe']>>;
    const subscriptions = new Map<string, Subscription>(), dirty = new Set<string>(), unavailable = new Set<string>(), changes = new ChangeSignal();
    const dispose = async () => {
      controller.abort(); streams.delete(controller);
      await Promise.all([...subscriptions.values()].map(s => s.release())); subscriptions.clear();
    };
    try {
      for (const id of input.ids as string[]) {
        if (controller.signal.aborted || c.req.raw.signal.aborted) throw new HTTPException(503);
        try {
          const subscription = await deps.boards.subscribe(owner, id, () => { dirty.add(id); changes.notify(); });
          subscriptions.set(id, subscription); dirty.add(id);
        } catch (e) {
          // A missing/revoked binding must not prevent the other panels from
          // reconnecting. No distinction or foreign metadata is disclosed.
          if (!(e instanceof FileBoardError) || ![403, 404, 409].includes(e.status)) throw e;
          unavailable.add(id);
        }
      }
      await recheck(c,ownerId);
      if (controller.signal.aborted) throw new HTTPException(403);
    } catch (e) { await dispose(); throw e; }
    c.header('X-Accel-Buffering', 'no');
    let finishStream!: () => void;
    const physicalStream = new Promise<void>(yes => { finishStream = yes; });
    streamWork.add(physicalStream);
    return streamSSE(c, async stream => {
      const cancel = () => controller.abort(), abort = () => stream.abort();
      controller.signal.addEventListener('abort', abort, { once: true });
      c.req.raw.signal.addEventListener('abort', cancel, { once: true }); stream.onAbort(cancel);
      const write = async (event: string, data: unknown) => {
        await recheck(c,ownerId);
        if (controller.signal.aborted) throw new HTTPException(403);
        const deadline = setTimeout(cancel, 10_000);
        try { await stream.writeSSE({ event, data: JSON.stringify(data) }); } finally { clearTimeout(deadline); }
      };
      let heartbeat = 0;
      try {
        if (controller.signal.aborted || c.req.raw.signal.aborted) return;
        for (const id of unavailable) await write(`${eventPrefix}.closed`, { id });
        while (!controller.signal.aborted && subscriptions.size) {
          const revision = changes.revision, policy = deps.boards.changes.revision;
          // Revalidate EVERY subscribed binding after a revocation wake, even
          // when its file is idle. A bad binding cannot poison the other boards.
          for (const [id, subscription] of subscriptions) {
            let snapshot;
            try { snapshot = await subscription.current(); }
            catch {
              subscriptions.delete(id); dirty.delete(id); await subscription.release();
              await write(`${eventPrefix}.closed`, { id }); continue;
            }
            if (!dirty.delete(id)) continue;
            await write(`${eventPrefix}.snapshot`, { id, snapshot: snapshot.state === 'ready' ? snapshot : { state: snapshot.state } });
          }
          if (Date.now() >= heartbeat) { await write('heartbeat', {}); heartbeat = Date.now() + 15_000; }
          if (!subscriptions.size || dirty.size) continue;
          const wait = new AbortController(), signal = AbortSignal.any([controller.signal, wait.signal]);
          try {
            await Promise.race([changes.wait(revision, signal, Math.max(1, heartbeat - Date.now())), deps.boards.changes.wait(policy, signal)]);
          } finally { wait.abort(); }
        }
      } catch { /* Never serialize internal errors or retain a broken stream. */ }
      finally {
        controller.signal.removeEventListener('abort', abort); c.req.raw.signal.removeEventListener('abort', cancel);
        try { await dispose(); }
        finally { streamWork.delete(physicalStream); finishStream(); }
      }
    });
  }));
  let closing: Promise<void> | undefined;
  const freeze = () => {
    shutdown.abort(); rejectReady(new HTTPException(503));
    for (const controller of streams.keys()) controller.abort();
    return requests.close();
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    closing = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const drained = freeze();
    void (async () => {
      await Promise.all([watcher, drained]);
      await Promise.all([...streamWork]);
      await deps.boards.close();
    })().then(resolve, reject);
    return closing;
  };
  return { ready, start, freeze, close };
}
