import { randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createCommandKey } from '@agentopsdeck/shared';
import { CommandCapacity, CommandConflict, type CommandReceipt } from '../commands/receipts.js';
import { reply } from '../commands/http.js';
import { ConnectorClientError } from './connector-client.js';
import { ConnectorNotDispatchedError } from './connector-connect.js';
import { requestOwnerControl, type OwnerControlHttpDeps } from './owner-control.js';
import { StorageAdmissionDeferred } from '../storage/work-admission.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { weixinOriginalAction } from './weixin-bridge.js';

/** The ordinary owner message boundary, including the private Weixin /stop
 * bridge. The database port owns receipts; this module owns only transport.
 * Duplicate/unknown observation can GET a receipt, never resend a message.
 * Keep the original [owner, session] scope and HTTP envelope for old clients. */
export function registerHubMessageRoutes(app: Hono, path: string, deps: OwnerControlHttpDeps) {
  const fail = (c: Context, error: unknown) => error instanceof HTTPException
    ? c.json({ error: 'Message request rejected', status: error.status }, error.status) : deps.error(c, error);
  app.get(`${path}/commands/:commandKey`, async c => {
    c.header('Cache-Control', 'no-store');
    try {
      const target = await requestOwnerControl(c, deps, 'message'), key = c.req.param('commandKey');
      if (!await target.get(key)) return c.json({ error: 'Command not found' }, 404);
      return c.json({ command: await target.recover(key) });
    } catch (error) { return fail(c, error); }
  });
  app.post(`${path}/messages`, async c => {
    c.header('Cache-Control', 'no-store');
    const trace = guardedTrace(deps.diagnostics ?? performanceDiagnostics, 'hub-message-http');
    let failed = true, step = 1;
    const warning = setTimeout(() => trace.reportPending({ pending: 1, step }), 30_000);
    warning.unref();
    const present = (receipt: CommandReceipt) => {
      trace.add('unknown', Number(receipt.state === 'outcome_unknown')); failed = false;
      return reply(c, receipt);
    };
    try {
      // Pin current identity/connection BEFORE waiting for the request body.
      const target = await requestOwnerControl(c, deps, 'message');
      const raw: unknown = await c.req.json().catch(() => undefined);
      await target.check(); c.req.raw.signal.throwIfAborted();
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return c.json({ error: 'JSON object required' }, 400);
      const { idempotencyKey, ...payload } = raw as Record<string, unknown>, header = c.req.header('idempotency-key');
      if (header && idempotencyKey !== undefined && idempotencyKey !== header) return c.json({ error: 'Conflicting command keys' }, 400);
      const key = header ?? idempotencyKey ?? createCommandKey(randomUUID());
      if (typeof key !== 'string') return c.json({ error: 'Invalid command key' }, 400);
      let claimed: { fresh: boolean; receipt: CommandReceipt };
      step = 2;
      try {
        claimed = await target.claim(key, payload);
        await target.check(); c.req.raw.signal.throwIfAborted();
      } catch (error) {
        if (error instanceof CommandConflict) return c.json({ error: error.message }, 409);
        if (error instanceof CommandCapacity) return c.json({ error: 'Command receipt capacity reached' }, 503);
        if (error instanceof StorageAdmissionDeferred) return c.json({ error: 'Command storage admission unavailable' }, 503);
        throw error;
      }
      c.header('X-AgentOpsDeck-Command-Key', key);
      trace.add('changed', Number(claimed.fresh));
      if (!claimed.fresh) { step = 5; return present(await target.recover(key)); }
      const delivery = await target.deliveryKey(key);
      step = 3;
      try {
        const original = weixinOriginalAction(c.req.raw), client = await target.client();
        const result = original?.command.operation === 'stop'
          ? await client.weixinActionOriginal({ ...original.command, key: delivery }, original.observe, c.req.raw.signal)
          : await client.jsonResponse<Record<string, unknown>>(`${target.upstream}/messages`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': delivery },
          body: JSON.stringify({ ...payload, idempotencyKey: delivery }), signal: c.req.raw.signal,
        });
        await target.bound(key);
        step = 4;
        const body = result.body;
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          const { command, ...metadata } = body as Record<string, unknown>;
          // A 202/legacy 4xx envelope does not override explicit unknown.
          // Ordinary successful replies without a Connector receipt retain
          // their original 2.3.7 settlement semantics.
          if (!(command && typeof command === 'object' && (command as CommandReceipt).state === 'outcome_unknown')) {
            await target.settle(key, { ...claimed.receipt, key: delivery,
              state: result.status >= 200 && result.status < 300 ? 'accepted'
                : result.status >= 400 && result.status < 500 ? 'rejected' : 'outcome_unknown',
              result: { status: result.status, body: metadata } });
          }
        }
      } catch (error) {
        // Claim/effect/settlement ACK loss is not evidence of non-execution.
        // Recheck original authority but do not retry any write or effect.
        await target.bound(key);
        // Preserve the original HTTP receipt boundary: an explicit Connector
        // 4xx is a durable rejection, unlike a missing/5xx transport ACK.
        if (error instanceof ConnectorNotDispatchedError) {
          // Exhausted connect(2) refusals prove that none of the buffered
          // attempts reached the Connector. Resets/timeouts/ACK loss do not.
          await target.settle(key, { ...claimed.receipt, key: delivery, state: 'rejected',
            result: { status: 409, body: { error: 'Connector is not ready; command was not sent' } } });
        } else if (error instanceof ConnectorClientError && error.status >= 400 && error.status < 500) {
          await target.settle(key, { ...claimed.receipt, key: delivery, state: 'rejected',
            result: { status: error.status, body: { error: 'Command rejected' } } });
        }
      }
      const receipt = await target.get(key);
      if (!receipt) throw new Error('message_receipt_unavailable');
      return present(receipt);
    } catch (error) { return fail(c, error); }
    finally { clearTimeout(warning); trace.add('step', step); trace.finish(failed); }
  });
}
