import { randomUUID } from 'node:crypto';
import { createCommandKey } from '@agentopsdeck/shared';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { reply } from '../commands/http.js';
import { CommandCapacity, CommandConflict, type CommandReceipt } from '../commands/receipts.js';
import { requestOwnerControl, type OwnerControlHttpDeps } from './owner-control.js';
import { StorageAdmissionDeferred } from '../storage/work-admission.js';
import { decodeHubSessionId, encodeHubSessionId } from './session-id.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';

export function registerHubDeletionRoutes(app: Hono, deps: OwnerControlHttpDeps) {
  const fail = (c: Context, error: unknown) => error instanceof HTTPException
    ? c.json({ error: 'Deletion request rejected', status: error.status }, error.status) : deps.error(c, error);
  app.get('/api/hub/v1/sessions/:hubSessionId/deletion-commands/:commandKey', async c => {
    c.header('Cache-Control', 'no-store');
    try {
      const t = await requestOwnerControl(c, deps, 'delete'), key = c.req.param('commandKey');
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) return c.json({ error: 'Invalid command key' }, 400);
      if (!await t.get(key)) return c.json({ error: 'Deletion command not found' }, 404);
      return c.json({ command: await t.recover(key) });
    } catch (error) { return fail(c, error); }
  });
  app.delete('/api/sessions/:hubSessionId', async (c, next) => {
    const id = c.req.param('hubSessionId'), decoded = decodeHubSessionId(id);
    // The outer authentication boundary reserves noncanonical aliases for
    // administrators. Preserve their legacy handler, never reinterpret its ID.
    if (!decoded || encodeHubSessionId(decoded.connectionId, decoded.remoteSessionKey) !== id) return next();
    c.header('Cache-Control', 'no-store');
    try {
      const t = await requestOwnerControl(c, deps, 'delete');
      if (!t.nodeId) return c.json({ error: 'Verify the Connector identity before deleting a session' }, 409);
      const key = c.req.header('idempotency-key') ?? createCommandKey(randomUUID());
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) return c.json({ error: 'Invalid command key' }, 400);
      await t.check(); c.req.raw.signal.throwIfAborted();
      let fresh: boolean;
      try {
        ({ fresh } = await t.claim(key, {}));
        await t.check(); c.req.raw.signal.throwIfAborted();
      }
      catch (error) {
        if (error instanceof CommandConflict) return c.json({ error: 'Deletion command identity conflicts' }, 409);
        if (error instanceof CommandCapacity) return c.json({ error: 'Command capacity reached' }, 503);
        if (error instanceof StorageAdmissionDeferred) return c.json({ error: 'Command storage admission unavailable' }, 503);
        throw error;
      }
      c.header('X-AgentOpsDeck-Command-Key', key);
      if (!fresh) return reply(c, await t.recover(key));
      try {
        const result = await (await t.client()).jsonResponse<{ ok?: boolean; command?: CommandReceipt }>(t.upstream, {
          method: 'DELETE', headers: { 'idempotency-key': await t.deliveryKey(key) }, signal: c.req.raw.signal,
        });
        await t.bound(key);
        if (result.body.command) await t.settle(key, { ...result.body.command, result: { status: result.status, body: { ok: result.body.ok } } });
      } catch {
        // Local post-delivery errors do not prove native rejection.
        await t.bound(key);
      }
      const receipt = await t.recover(key);
      if (receipt.state === 'accepted') {
        // The ACK is already durable. Projection cleanup cannot turn it into a
        // failed send; retries only read receipts and never erase newer prefs.
        try { await t.cleanup(key); } catch {
          // Do not log exception text, identity, paths or request data. Failed
          // observation cannot undo the committed ACK or cause another send.
          try {
            const trace = (deps.diagnostics ?? performanceDiagnostics).start('hub-deletion-projection');
            trace.add('step', 1); trace.add('unknown', 1); trace.finish(true);
          } catch { /* projection repair is a separate lifecycle concern */ }
        }
      }
      return reply(c, receipt);
    } catch (error) { return fail(c, error); }
  });
}
