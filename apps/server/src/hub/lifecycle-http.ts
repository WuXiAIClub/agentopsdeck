import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { CommandConflict } from '../commands/receipts.js';
import { readJsonBody } from '../utils/http-body.js';
import { HubMemberRequestError } from './async-member-request.js';
import type { AsyncHubLifecyclePort } from './async-lifecycle-commands.js';
import { requireLegacyHubStoreRoute, type LegacyHubStoreRouteDependencies, type AsyncOnlyHubStoreRouteDependencies } from '../routes/hub-legacy-dependencies.js';

type LifecycleDependencies = { asyncLifecycle?: AsyncHubLifecyclePort }
  & (LegacyHubStoreRouteDependencies | AsyncOnlyHubStoreRouteDependencies & { asyncLifecycle: AsyncHubLifecyclePort });
export function registerHubLifecycleRoutes(app: Hono, deps: LifecycleDependencies) {
  if (deps.mode === 'async' && (typeof deps.asyncLifecycle?.open !== 'function'
    || typeof deps.asyncLifecycle.close !== 'function')) throw Error('hub_lifecycle_ports_required');
  const legacy = () => requireLegacyHubStoreRoute(deps);
  const base = '/api/hub/v1/connections/:connectionId/lifecycle';
  const fail = (c: Context, error: unknown) => c.json({ error: 'Independent Connector maintenance unavailable' },
    error instanceof HTTPException ? error.status : error instanceof HubMemberRequestError ? error.status === 499 ? 503 : error.status
      : error instanceof CommandConflict ? 409 : 503);
  const authority = (c: Context) => {
    const actor = legacy().principal(c), connectionId = c.req.param('connectionId')!;
    return { userId: actor.userId, connectionId, authorize: () => {
      c.req.raw.signal.throwIfAborted();
      if (legacy().principal(c).userId !== actor.userId) throw new HTTPException(401);
    } };
  };
  app.get(`${base}/status`, async c => {
    c.header('Cache-Control', 'no-store');
    try {
      if (deps.asyncLifecycle) {
        const port = await deps.asyncLifecycle.open(c.req.raw, { connectionId: c.req.param('connectionId')!, operation: 'restart' });
        return c.json(await port.status());
      }
      const actor = authority(c);
      return c.json(await legacy().store.lifecycleCommands.status(actor.userId, actor.connectionId, actor.authorize, c.req.raw.signal));
    } catch (error) { return fail(c, error); }
  });
  for (const operation of ['restart', 'upgrade'] as const) {
    app.post(`${base}/commands/${operation}`, async c => {
      c.header('Cache-Control', 'no-store');
      try {
        const target = { connectionId: c.req.param('connectionId')!, operation };
        const port = deps.asyncLifecycle ? await deps.asyncLifecycle.open(c.req.raw, target) : undefined;
        const actor = port ? undefined : authority(c);
        if (!/^application\/json(?:\s*;|$)/i.test(c.req.header('Content-Type') ?? '')) return c.json({ error: 'JSON required' }, 415);
        const value = await readJsonBody(c.req.raw, 1024);
        if (port) await port.check(); else actor!.authorize();
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join(',') !== 'idempotencyKey'
          || typeof (value as Record<string, unknown>).idempotencyKey !== 'string') return c.json({ error: 'Original command key required' }, 400);
        const { idempotencyKey } = value as { idempotencyKey: string };
        if (!/^[A-Za-z0-9._:-]{1,200}$/.test(idempotencyKey)) throw new CommandConflict();
        return c.json(port ? await port.send(idempotencyKey)
          : await legacy().store.lifecycleCommands.send({ userId: actor!.userId, ...target },
            idempotencyKey, actor!.authorize, c.req.raw.signal), 202);
      } catch (error) { return fail(c, error); }
    });
    app.get(`${base}/commands/${operation}/:commandKey`, async c => {
      c.header('Cache-Control', 'no-store');
      try {
        if (deps.asyncLifecycle) {
          const port = await deps.asyncLifecycle.open(c.req.raw, { connectionId: c.req.param('connectionId')!, operation });
          const key = c.req.param('commandKey');
          if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) throw new CommandConflict();
          const receipt = await port.recover(key);
          return receipt ? c.json(receipt) : c.json({ error: 'Maintenance command not found' }, 404);
        }
        const actor = authority(c);
        const receipt = await legacy().store.lifecycleCommands.recover({ userId: actor.userId, connectionId: actor.connectionId, operation },
          c.req.param('commandKey'), actor.authorize, c.req.raw.signal);
        return receipt ? c.json(receipt) : c.json({ error: 'Maintenance command not found' }, 404);
      } catch (error) { return fail(c, error); }
    });
  }
}
