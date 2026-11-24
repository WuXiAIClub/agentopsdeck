import { randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createCommandKey } from '@agentopsdeck/shared';
import { CommandCapacity, CommandConflict, type CommandReceipt } from '../commands/receipts.js';
import { reply } from '../commands/http.js';
import { requestOwnerControl, type OwnerControlHttpDeps } from './owner-control.js';
import { StorageAdmissionDeferred } from '../storage/work-admission.js';
import { readJsonBody } from '../utils/http-body.js';

export function registerHubCompactRoutes(app: Hono, deps: OwnerControlHttpDeps) {
  const fail = (c: Context, error: unknown) => error instanceof HTTPException
    ? c.json({ error: 'Compact request rejected', status: error.status }, error.status) : deps.error(c, error);
  const path = '/api/hub/v1/sessions/:hubSessionId';
  app.get(`${path}/compact-commands/:commandKey`, async c => {
    c.header('Cache-Control', 'no-store');
    try {
      const target = await requestOwnerControl(c, deps, 'compact'), key = c.req.param('commandKey');
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) return c.json({ error: 'Invalid command key' }, 400);
      if (!await target.get(key)) return c.json({ error: 'Compact command not found' }, 404);
      return c.json({ command: await target.recover(key) });
    } catch (error) { return fail(c, error); }
  });
  app.post(`${path}/compact`, async c => {
    c.header('Cache-Control', 'no-store');
    try {
      const target = await requestOwnerControl(c, deps, 'compact');
      if (!target.nodeId) return c.json({ error: 'Verify the Connector identity before compacting' }, 409);
      const raw = await readJsonBody(c.req.raw, 4096);
      await target.check(); c.req.raw.signal.throwIfAborted();
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return c.json({ error: 'JSON object required' }, 400);
      const { idempotencyKey, ...payload } = raw as Record<string, unknown>, header = c.req.header('idempotency-key');
      if (header && idempotencyKey !== undefined && idempotencyKey !== header) return c.json({ error: 'Conflicting command keys' }, 400);
      if (Object.keys(payload).length) return c.json({ error: 'Compact takes no message or native options' }, 400);
      const key = header ?? idempotencyKey ?? createCommandKey(randomUUID());
      if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)) return c.json({ error: 'Invalid command key' }, 400);
      let fresh: boolean;
      try {
        ({ fresh } = await target.claim(key, {}));
        await target.check(); c.req.raw.signal.throwIfAborted();
      }
      catch (error) {
        if (error instanceof CommandConflict) return c.json({ error: 'Compact command identity conflicts' }, 409);
        if (error instanceof CommandCapacity) return c.json({ error: 'Command capacity reached' }, 503);
        if (error instanceof StorageAdmissionDeferred) return c.json({ error: 'Command storage admission unavailable' }, 503);
        throw error;
      }
      c.header('X-AgentOpsDeck-Command-Key', key);
      if (!fresh) return reply(c, await target.recover(key));
      try {
        const result = await (await target.client()).jsonResponse<Record<string, unknown> & { command?: CommandReceipt }>(`${target.upstream}/compact`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': await target.deliveryKey(key) },
          body: '{}', signal: c.req.raw.signal,
        });
        await target.bound(key);
        if (result.body.command) await target.settle(key, { ...result.body.command, result: { status: result.status, body: result.body } });
      } catch { await target.bound(key); }
      return reply(c, await target.recover(key));
    } catch (error) { return fail(c, error); }
  });
}
