import { randomUUID } from 'node:crypto';
import { createCommandKey } from '@agentopsdeck/shared';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { reply } from '../commands/http.js';
import { CommandCapacity, CommandConflict, type CommandReceipt } from '../commands/receipts.js';
import { requestOwnerControl, type OwnerControlHttpDeps } from './owner-control.js';
import { StorageAdmissionDeferred } from '../storage/work-admission.js';
import { readJsonBody } from '../utils/http-body.js';

export function registerHubCreationRoutes(app: Hono, deps: OwnerControlHttpDeps) {
  const path = '/api/hub/v1/connections/:connectionId/agents/:agentId/sessions';
  const fail = (c: Context, error: unknown) => error instanceof HTTPException
    ? c.json({ error: 'Creation request rejected', status: error.status }, error.status) : deps.error(c, error);
  app.get(`${path}/creation-commands/:commandKey`, async c => {
    c.header('Cache-Control', 'no-store');
    try {
      const t = await requestOwnerControl(c, deps, 'create'), key = c.req.param('commandKey');
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) return c.json({ error: 'Invalid command key' }, 400);
      if (!await t.get(key)) return c.json({ error: 'Creation command not found' }, 404);
      return c.json({ command: await t.recover(key) });
    } catch (error) { return fail(c, error); }
  });
  app.post(path, async c => {
    c.header('Cache-Control', 'no-store');
    try {
      const t = await requestOwnerControl(c, deps, 'create');
      if (!t.nodeId) return c.json({ error: 'Verify the Connector identity before creating a session' }, 409);
      const raw = await readJsonBody(c.req.raw, 128 * 1024);
      await t.check(); c.req.raw.signal.throwIfAborted();
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return c.json({ error: 'JSON object required' }, 400);
      const { idempotencyKey, ...payload } = raw as Record<string, unknown>, header = c.req.header('idempotency-key');
      if (header && idempotencyKey !== undefined && idempotencyKey !== header) return c.json({ error: 'Conflicting command keys' }, 400);
      const key = header ?? idempotencyKey ?? createCommandKey(randomUUID());
      if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)) return c.json({ error: 'Invalid command key' }, 400);
      let fresh: boolean;
      try {
        ({ fresh } = await t.claim(key, payload));
        await t.check(); c.req.raw.signal.throwIfAborted();
      }
      catch (error) {
        if (error instanceof CommandConflict) return c.json({ error: 'Creation command identity conflicts' }, 409);
        if (error instanceof CommandCapacity) return c.json({ error: 'Command capacity reached' }, 503);
        if (error instanceof StorageAdmissionDeferred) return c.json({ error: 'Command storage admission unavailable' }, 503);
        throw error;
      }
      c.header('X-AgentOpsDeck-Command-Key', key);
      if (!fresh) return reply(c, await t.recover(key));
      try {
        const result = await (await t.client()).jsonResponse<{ key?: string; command?: CommandReceipt }>(t.upstream, {
          method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': await t.deliveryKey(key) },
          body: JSON.stringify(payload), signal: c.req.raw.signal,
        });
        await t.bound(key);
        if (result.body.command) await t.settle(key, { ...result.body.command, result: { status: result.status, body: { key: result.body.key } } });
      } catch {
        // Delivery may have created a native session; only its bound receipt
        // can resolve uncertainty. Never recreate on transport/parse errors.
        await t.bound(key);
      }
      return reply(c, await t.recover(key));
    } catch (error) { return fail(c, error); }
  });
}
