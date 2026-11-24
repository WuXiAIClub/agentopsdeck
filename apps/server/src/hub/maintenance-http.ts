import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { reply } from '../commands/http.js';
import { CommandConflict } from '../commands/receipts.js';
import { readJsonBody } from '../utils/http-body.js';
import type { LocalMaintenance } from './maintenance-commands.js';
import type { AsyncHubMaintenancePort } from './async-maintenance-commands.js';
import { HubMemberRequestError } from './async-member-request.js';
import { requireLegacyHubStoreRoute, type LegacyHubStoreRouteDependencies, type AsyncOnlyHubStoreRouteDependencies } from '../routes/hub-legacy-dependencies.js';

type MaintenanceDependencies = {
  local?: LocalMaintenance | undefined;
  asyncMaintenance?: AsyncHubMaintenancePort;
} & (LegacyHubStoreRouteDependencies | AsyncOnlyHubStoreRouteDependencies & { asyncMaintenance: AsyncHubMaintenancePort });
export function registerHubMaintenanceRoutes(app: Hono, deps: MaintenanceDependencies) {
  if (deps.mode === 'async' && (typeof deps.asyncMaintenance?.open !== 'function'
    || typeof deps.asyncMaintenance.close !== 'function')) throw Error('hub_maintenance_ports_required');
  const legacy = () => requireLegacyHubStoreRoute(deps);
  const fail = (c: Context, error: unknown) => {
    const status = error instanceof HTTPException || error instanceof HubMemberRequestError ? error.status : error instanceof CommandConflict ? 409 : 503;
    const response = c.json({ error: 'Maintenance command unavailable' });
    // Request cancellation uses the existing 499 boundary, which is not in
    // Hono's ContentfulStatusCode union. Retain its headers and wire status.
    return new Response(response.body, { status, headers: response.headers });
  };
  for (const operation of ['apply', 'rollback', 'pause', 'resume'] as const) {
    const boundary = ['pause', 'resume'].includes(operation) ? 'maintenance' : 'update';
    const base = `/api/hub/v1/connections/:connectionId/${boundary}/commands`;
    const target = (c: Context) => {
      const actor = legacy().principal(c);
      return { userId: actor.userId, ownerUserId: actor.userId, connectionId: c.req.param('connectionId')!, operation };
    };
    app.post(`${base}/${operation}`, async c => {
      c.header('Cache-Control', 'no-store');
      try {
        if (deps.asyncMaintenance) {
          const port = await deps.asyncMaintenance.open(c.req.raw, { connectionId: c.req.param('connectionId')!, operation });
          const raw = await readJsonBody(c.req.raw, 8192);
          await port.check(); c.req.raw.signal.throwIfAborted();
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return c.json({ error: 'JSON object required' }, 400);
          const { idempotencyKey, ...payload } = raw as Record<string, unknown>;
          if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(idempotencyKey)) return c.json({ error: 'Original command key required' }, 400);
          return reply(c, await port.send(idempotencyKey, payload));
        }
        const original = target(c);
        const raw = await readJsonBody(c.req.raw, 8192);
        legacy().principal(c); c.req.raw.signal.throwIfAborted();
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return c.json({ error: 'JSON object required' }, 400);
        const { idempotencyKey, ...payload } = raw as Record<string, unknown>;
        if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(idempotencyKey)) return c.json({ error: 'Original command key required' }, 400);
        const read = () => { legacy().principal(c); };
        const send = () => {
          read();
          const connection = legacy().store.getConnection(original.connectionId, original.ownerUserId);
          if (!connection || connection.status === 'disabled') throw new HTTPException(404);
          if (!connection.nodeId) throw new HTTPException(409);
        };
        return reply(c, await legacy().store.maintenanceCommands.send(original, idempotencyKey, payload, { read, send }, deps.local, c.req.raw.signal));
      } catch (error) { return fail(c, error); }
    });
    app.get(`${base}/${operation}/:commandKey`, async c => {
      c.header('Cache-Control', 'no-store');
      try {
        const key = c.req.param('commandKey');
        if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) return c.json({ error: 'Invalid command key' }, 400);
        if (deps.asyncMaintenance) {
          const port = await deps.asyncMaintenance.open(c.req.raw, { connectionId: c.req.param('connectionId')!, operation });
          const command = await port.recover(key);
          return command ? c.json({ command }) : c.json({ error: 'Maintenance command not found' }, 404);
        }
        const command = await legacy().store.maintenanceCommands.recover(target(c), key, () => { legacy().principal(c); }, deps.local, c.req.raw.signal);
        return command ? c.json({ command }) : c.json({ error: 'Maintenance command not found' }, 404);
      } catch (error) { return fail(c, error); }
    });
  }
}
