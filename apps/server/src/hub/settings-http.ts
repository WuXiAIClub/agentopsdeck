import { randomUUID } from 'node:crypto';
import { createCommandKey, readGoalControl, readGoalControlSnapshot } from '@agentopsdeck/shared';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { reply } from '../commands/http.js';
import { CommandCapacity, CommandConflict, type CommandReceipt } from '../commands/receipts.js';
import { requestOwnerControl, type OwnerControlHttpDeps } from './owner-control.js';
import { StorageAdmissionDeferred } from '../storage/work-admission.js';
import { decodeHubSessionId, encodeHubSessionId } from './session-id.js';
import { readJsonBody } from '../utils/http-body.js';

export function registerHubSettingsRoutes(app: Hono, deps: OwnerControlHttpDeps) {
  const fail = (c: Context, error: unknown) => error instanceof HTTPException
    ? c.json({ error: 'Settings request rejected', status: error.status }, error.status) : deps.error(c, error);
  app.get('/api/hub/v1/sessions/:hubSessionId/goal', async c => {
    c.header('Cache-Control', 'no-store');
    try {
      const t = await requestOwnerControl(c, deps, 'settings');
      if (!t.nodeId) return c.json({ error: 'Verify the Connector identity before reading goal controls' }, 409);
      const raw = await (await t.client()).json<unknown>(`${t.upstream}/goal`, { signal: c.req.raw.signal });
      await t.check();
      const snapshot = readGoalControlSnapshot(raw);
      return snapshot ? c.json(snapshot) : c.json({ error: 'Goal observation unavailable' }, 502);
    } catch (error) { return fail(c, error); }
  });
  app.get('/api/hub/v1/sessions/:hubSessionId/settings-commands/:commandKey', async c => {
    c.header('Cache-Control', 'no-store');
    try {
      const t = await requestOwnerControl(c, deps, 'settings'), key = c.req.param('commandKey');
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) return c.json({ error: 'Invalid command key' }, 400);
      if (!await t.get(key)) return c.json({ error: 'Settings command not found' }, 404);
      return c.json({ command: await t.recover(key) });
    } catch (error) { return fail(c, error); }
  });
  app.patch('/api/sessions/:hubSessionId', async (c, next) => {
    const id = c.req.param('hubSessionId'), decoded = decodeHubSessionId(id);
    if (!decoded || encodeHubSessionId(decoded.connectionId, decoded.remoteSessionKey) !== id) return next();
    c.header('Cache-Control', 'no-store');
    try {
      const t = await requestOwnerControl(c, deps, 'settings');
      if (!t.nodeId) return c.json({ error: 'Verify the Connector identity before modifying a session' }, 409);
      const raw = await readJsonBody(c.req.raw, 128 * 1024);
      await t.check(); c.req.raw.signal.throwIfAborted();
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return c.json({ error: 'JSON object required' }, 400);
      const { idempotencyKey, ...payload } = raw as Record<string, unknown>, header = c.req.header('idempotency-key');
      // Reject unsupported/mixed Goal intent before reserving a durable unknown
      // receipt or forwarding to a potentially older Connector. The Connector
      // still validates independently at its own trust boundary.
      if (Object.hasOwn(payload, 'goal') && (Object.keys(payload).length !== 1 || !readGoalControl(payload.goal))) {
        return c.json({ error: 'Invalid goal control' }, 400);
      }
      if (header && idempotencyKey !== undefined && idempotencyKey !== header) return c.json({ error: 'Conflicting command keys' }, 400);
      const key = header ?? idempotencyKey ?? createCommandKey(randomUUID());
      if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)) return c.json({ error: 'Invalid command key' }, 400);
      let fresh: boolean;
      try {
        ({ fresh } = await t.claim(key, payload));
        await t.check(); c.req.raw.signal.throwIfAborted();
      }
      catch (error) {
        if (error instanceof CommandConflict) return c.json({ error: 'Settings command identity conflicts' }, 409);
        if (error instanceof CommandCapacity) return c.json({ error: 'Command capacity reached' }, 503);
        if (error instanceof StorageAdmissionDeferred) return c.json({ error: 'Command storage admission unavailable' }, 503);
        throw error;
      }
      c.header('X-AgentOpsDeck-Command-Key', key);
      if (!fresh) return reply(c, await t.recover(key));
      try {
        const result = await (await t.client()).jsonResponse<Record<string, unknown> & { command?: CommandReceipt }>(t.upstream, {
          method: 'PATCH', headers: { 'content-type': 'application/json', 'idempotency-key': await t.deliveryKey(key) },
          body: JSON.stringify(payload), signal: c.req.raw.signal,
        });
        await t.bound(key);
        if (result.body.command) await t.settle(key, { ...result.body.command, result: { status: result.status, body: result.body } });
      } catch { await t.bound(key); } // Transport/parse errors do not prove absence of writes.
      return reply(c, await t.recover(key));
    } catch (error) { return fail(c, error); }
  });
}
