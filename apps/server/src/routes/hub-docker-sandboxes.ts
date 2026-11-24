import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import {
  defaultDockerSandboxManager,
  type DockerSandboxConfig,
  type DockerSandboxManager,
} from '../hub/docker-sandbox.js';
import type { HubPrincipal } from '../hub/identity.js';
import type { AsyncHubMemberRequests } from '../hub/async-member-request.js';
import { readJsonBody, readOptionalJsonBody } from '../utils/http-body.js';

export type HubDockerSandboxRouteDeps = {
  base?: string | undefined;
  manager?: DockerSandboxManager | undefined;
  /** Independent, server-owned gate. Never inferred from login/membership or
   * request JSON. Production assembly leaves this off until host acceptance. */
  hostOperationsEnabled?: boolean;
} & ({ members: Pick<AsyncHubMemberRequests, 'begin'>; principal?: (c: Context) => HubPrincipal }
  | { members?: undefined; principal: (c: Context) => HubPrincipal });

export function isHubDockerSandboxRequest(method: string, path: string): boolean {
  if (['GET', 'HEAD', 'POST'].includes(method) && path === '/api/hub/v1/docker-sandboxes') {
    return true;
  }
  if (method === 'POST' && /^\/api\/hub\/v1\/docker-sandboxes\/[^/]+\/renew$/.test(path)) {
    return true;
  }
  if (method === "DELETE" && /^\/api\/hub\/v1\/docker-sandboxes\/[^/]+$/.test(path)) {
    return true;
  }
  if (
    ["GET", "POST"].includes(method) &&
    /^\/api\/hub\/v1\/docker-sandboxes\/containers\/[^/]+\/(start|stop|restart|remove|logs)$/.test(path)
  ) {
    return true;
  }
  return false;
}

export function registerHubDockerSandboxes(app: Hono, deps: HubDockerSandboxRouteDeps): void {
  const base = deps.base ?? '/api/hub/v1';
  const manager = deps.manager ?? defaultDockerSandboxManager;

  async function resolveAccess(c: Context) {
    const deny = (status: 401 | 403 | 503): never => {
      throw new HTTPException(status, { message: 'Docker access unavailable' });
    };
    let actor: HubPrincipal, check: () => Promise<void>;
    if (deps.members) {
      try {
        const handle = await deps.members.begin(c.req.raw);
        actor = handle.principal;
        check = async () => {
          try { await handle.check(); }
          catch (error) { deny(error instanceof HubMemberRequestError && error.status === 401 ? 401 : 503); }
        };
      } catch (error) {
        return deny(error instanceof HubMemberRequestError && error.status === 401 ? 401 : 503);
      }
    } else {
      try { actor = Object.freeze({ ...deps.principal(c) }); } catch { return deny(401); }
      check = async () => {
        let current: HubPrincipal;
        try { current = deps.principal(c); } catch { return deny(401); }
        if (current.userId !== actor.userId || current.admin !== actor.admin) deny(401);
      };
    }
    const hostAllowed = actor.admin && deps.hostOperationsEnabled === true;
    const current = async () => {
      if (c.req.raw.signal.aborted) deny(503);
      await check();
      if (c.req.raw.signal.aborted) deny(503);
    };
    const host = async () => {
      await current();
      // A later opt-in cannot upgrade this request, and closing the server gate
      // also invalidates a retained in-flight host operation.
      if (!hostAllowed || deps.hostOperationsEnabled !== true) deny(403);
    };
    return { actor, current, host, hostAllowed };
  }

  app.get(`${base}/docker-sandboxes`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const access = await resolveAccess(c);
    const { actor } = access;
    if (!access.hostAllowed) {
      await access.current();
      const sandboxes = manager.list(actor.userId, false);
      return c.json({ engine: { available: false, activeSandboxes: 0, totalCpuAllocated: 0, totalMemoryAllocatedMb: 0 }, sandboxes,
        containers: [], hostOperations: false, updatedAt: Date.now() });
    }
    await access.host();
    const engine = await manager.probeDockerEngine();
    await access.host();
    const containers = await manager.listHostContainers();
    await access.host();
    const sandboxes = manager.list(actor.userId, true);
    return c.json({ engine, sandboxes, containers, hostOperations: true, updatedAt: Date.now() });
  });

  app.post(`${base}/docker-sandboxes`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const access = await resolveAccess(c);
    const { actor } = access;
    const raw = await readJsonBody(c.req.raw, 8 * 1024);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return c.json({ error: 'JSON object required' }, 400);
    const body = raw as DockerSandboxConfig & {
      executeContainer?: boolean;
      connectionId?: string;
    };
    if (body.executeContainer !== undefined && typeof body.executeContainer !== 'boolean') return c.json({ error: 'Invalid execution option' }, 400);
    if (body.executeContainer === true) {
      await access.host();
      // Even an opted-in host operator cannot execute an arbitrary client image
      // with host environment references. Managed profile/secret authorization
      // and durable sandbox ownership have not been accepted yet.
      return c.json({ error: 'Managed sandbox execution unavailable' }, 403);
    }
    await access.current();
    const originUrl = (() => {
      try {
        return new URL(c.req.url).origin;
      } catch {
        return 'https://hub.example.com';
      }
    })();
    const sandbox = await manager.create(
      {
        ...body,
        ownerUserId: actor.userId,
        hubUrl: body.hubUrl || originUrl,
      },
      false,
      typeof body.connectionId === 'string' ? body.connectionId : undefined,
    );
    await access.current();
    return c.json({ sandbox, updatedAt: Date.now() }, 201);
  });

  app.post(`${base}/docker-sandboxes/:sandboxId/renew`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const access = await resolveAccess(c);
    const { actor } = access;
    const sandboxId = c.req.param('sandboxId');
    const existing = manager.get(sandboxId);
    if (!existing || (!access.hostAllowed && existing.ownerUserId !== actor.userId)) {
      return c.json({ error: 'sandbox not found' }, 404);
    }
    const raw = await readOptionalJsonBody(c.req.raw, 1024);
    if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) return c.json({ error: 'JSON object required' }, 400);
    const body = (raw ?? {}) as { extendMinutes?: number };
    if (existing.engineAvailable || existing.containerId || existing.status === 'running') await access.host(); else await access.current();
    const renewed = manager.renew(sandboxId, body.extendMinutes ?? 60);
    return c.json({ ok: true, sandbox: renewed, updatedAt: Date.now() });
  });

  app.delete(`${base}/docker-sandboxes/:sandboxId`, async (c) => {
    c.header('Cache-Control', 'no-store');
    const access = await resolveAccess(c);
    const { actor } = access;
    const sandboxId = c.req.param('sandboxId');
    const existing = manager.get(sandboxId);
    if (!existing || (!access.hostAllowed && existing.ownerUserId !== actor.userId)) {
      return c.json({ error: 'sandbox not found' }, 404);
    }
    const removeRecord = c.req.query('remove') === '1' || c.req.query('remove') === 'true';
    if (existing.engineAvailable || existing.containerId || existing.status === 'running') await access.host(); else await access.current();
    const stopped = await manager.stop(sandboxId, removeRecord);
    await access.current();
    return c.json({ ok: true, sandbox: stopped, updatedAt: Date.now() });
  });

  app.get(`${base}/docker-sandboxes/containers/:containerId/logs`, async (c) => {
    c.header("Cache-Control", "no-store");
    const access = await resolveAccess(c);
    await access.host();
    const containerId = c.req.param("containerId");
    const tail = Number(c.req.query("tail") || 60);
    const logs = await manager.getContainerLogs(containerId, tail);
    await access.host();
    return c.json({ ok: true, containerId, logs, updatedAt: Date.now() });
  });

  app.post(`${base}/docker-sandboxes/containers/:containerId/:action`, async (c) => {
    c.header("Cache-Control", "no-store");
    const access = await resolveAccess(c);
    await access.host();
    const containerId = c.req.param("containerId");
    const action = c.req.param("action");
    if (action !== "start" && action !== "stop" && action !== "restart" && action !== "remove") {
      return c.json({ error: "unsupported container action" }, 400);
    }
    const result = await manager.controlHostContainer(containerId, action);
    await access.host();
    const containers = await manager.listHostContainers();
    await access.host();
    return c.json({ ...result, containers, updatedAt: Date.now() }, result.ok ? 200 : 400);
  });
}
