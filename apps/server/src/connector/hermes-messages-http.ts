import { randomUUID } from 'node:crypto';
import { createCommandKey, sessionRuntimeId } from '@agentopsdeck/shared';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { reply } from '../commands/http.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { readJsonBody } from '../utils/http-body.js';
import type { AsyncHermesMessages } from './async-hermes-messages.js';
import type { AsyncHermesStop } from './async-hermes-stop.js';
import type { AsyncHermesLocalControl } from './async-hermes-local-control.js';
import { HERMES_MESSAGE_PAYLOAD_BYTES } from './connector-hermes-message-domain.js';

export type HermesMessagesHttp = {
  messages: Pick<AsyncHermesMessages, 'send' | 'readReceipt' | 'readSendReceipt'>;
  stop?: Pick<AsyncHermesStop, 'stop' | 'receipt'>;
  localControl?: Pick<AsyncHermesLocalControl, 'send' | 'read'>;
  /** Local readiness can veto fresh work, never establish authority. */
  ready: () => boolean;
  timeoutMs?: number;
  diagnostics?: PerformanceDiagnostics;
};
const validKey = (key: unknown): key is string => typeof key === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(key);
const unavailable = (c: Context, commandKey: string) => c.json({
  error: 'Command outcome unavailable; read the original command key, do not resend', status: 'outcome_unknown', commandKey,
}, 503);

/** Install after protocol/node gates, before old receipt middleware. Selected
 * controls never fall back to synchronous authority; unselected controls retain their body. */
export function registerHermesMessagesHttp(app: Hono, path: string, deps: HermesMessagesHttp) {
  const timeoutMs = deps.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new RangeError('Finite Hermes HTTP deadline required');
  let bodyReaders = 0;
  app.post(`${path}/messages`, async (c, next) => {
    const key = c.req.param('sessionKey')!;
    if (sessionRuntimeId(key) !== 'hermes') return next();
    c.header('Cache-Control', 'no-store');
    const authorization = c.req.raw.headers.get('authorization') ?? '';
    if (!authorization.trim()) return c.json({ error: 'unauthorized' }, 401);
    if (c.req.header('x-agentopsdeck-execution-grant') !== undefined) return c.json({ error: 'Delegated execution is not supported' }, 403);
    const trace = guardedTrace(deps.diagnostics ?? performanceDiagnostics, 'hermes-message-http');
    let failed = true, commandKey = createCommandKey(randomUUID());
    if (bodyReaders >= 2) { trace.finish(true); return c.json({ error: 'Message input capacity reached' }, 503); }
    bodyReaders++;
    const wait = { timeoutMs, signal: c.req.raw.signal };
    try {
      trace.add('step', 1);
      const probe = await deps.messages.readSendReceipt({ key, authorization, commandKey }, wait);
      if ('error' in probe) return c.json({ error: 'Message authority unavailable' }, probe.error);
      const raw = await readJsonBody(c.req.raw, HERMES_MESSAGE_PAYLOAD_BYTES, timeoutMs);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return c.json({ error: 'JSON object required' }, 400);
      const { idempotencyKey, ...payload } = raw as Record<string, unknown>;
      const text = typeof payload.message === 'string' ? payload.message.trim() : '';
      if (['/stop', '/status', '/compact'].includes(text) && !(text === '/stop' && deps.stop)
        && !(['/status', '/compact'].includes(text) && deps.localControl)) {
        c.req.bodyCache.json = Promise.resolve(raw);
        failed = false;
        return next();
      }
      const header = c.req.header('idempotency-key');
      if (header !== undefined && idempotencyKey !== undefined && idempotencyKey !== header) return c.json({ error: 'Conflicting command keys' }, 400);
      const selected = header ?? idempotencyKey ?? commandKey;
      if (!validKey(selected)) return c.json({ error: 'Invalid command key' }, 400);
      commandKey = selected;
      c.header('X-AgentOpsDeck-Command-Key', commandKey);
      trace.add('step', 2);
      const scope = { key, authorization, commandKey };
      if (['/status', '/compact'].includes(text) && deps.localControl) {
        const result = await deps.localControl.send({ ...scope, payloadJson: JSON.stringify(payload) }, wait);
        if ('error' in result) return c.json({ error: 'Control authority unavailable' }, result.error);
        const current = await deps.localControl.read(scope, wait);
        if ('error' in current) return c.json({ error: 'Control authority unavailable' }, current.error);
        if (!current.receipt) return unavailable(c, commandKey);
        if (current.receipt.id !== result.receipt?.id) return c.json({ error: 'Control authority changed' }, 403);
        failed = false;
        return reply(c, current.receipt);
      }
      if (text === '/stop' && deps.stop) {
        const result = await deps.stop.stop({ ...scope, payloadJson: JSON.stringify(payload) });
        if ('error' in result) return c.json({ error: 'Stop authority unavailable' }, result.error);
        // Current original stop authority, not the stale pre-body probe.
        const current = await deps.stop.receipt(scope, wait);
        if ('error' in current) return c.json({ error: 'Stop authority unavailable' }, current.error);
        if (!current.receipt) return unavailable(c, commandKey);
        if (current.receipt.id !== result.receipt?.id) return c.json({ error: 'Stop authority changed' }, 403);
        failed = false;
        return reply(c, current.receipt);
      }
      const result = await deps.messages.send({ ...scope, payloadJson: JSON.stringify(payload),
        ...(deps.ready() !== true ? { rejectFresh: 'runtime_unavailable' as const } : {}) }, wait);
      if ('error' in result) return c.json({ error: 'Message admission unavailable' }, result.error);
      trace.add('step', 3);
      // The original durable fact is not permission to deliver after revocation.
      const current = await deps.messages.readSendReceipt(scope, wait);
      if ('error' in current) return c.json({ error: 'Message authority unavailable' }, current.error);
      if (!current.receipt) return unavailable(c, commandKey);
      if (current.receipt.id !== result.receipt?.id) return c.json({ error: 'Message authority changed' }, 403);
      failed = false;
      return reply(c, current.receipt);
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      c.header('X-AgentOpsDeck-Command-Key', commandKey);
      return unavailable(c, commandKey);
    } finally { bodyReaders--; trace.finish(failed); }
  });
  // Read-only recovery of the immutable original report after deadline or a
  // partial projection failure. Never reclaims a command or probes native.
  app.get(`${path}/commands/:commandKey/status`, async (c, next) => {
    const key = c.req.param('sessionKey')!;
    if (!deps.localControl || sessionRuntimeId(key) !== 'hermes') return next();
    c.header('Cache-Control', 'no-store');
    const commandKey = c.req.param('commandKey')!;
    if (!validKey(commandKey)) return c.json({ error: 'Invalid command key' }, 400);
    const authorization = c.req.raw.headers.get('authorization') ?? '';
    if (!authorization.trim()) return c.json({ error: 'unauthorized' }, 401);
    if (c.req.header('x-agentopsdeck-execution-grant') !== undefined) return c.json({ error: 'Delegated execution is not supported' }, 403);
    try {
      const result = await deps.localControl.read({ key, authorization, commandKey }, { timeoutMs, signal: c.req.raw.signal });
      if ('error' in result) return c.json({ error: 'Control authority unavailable' }, result.error);
      if (!result.receipt || !result.report) return c.json({ error: 'Status report not found' }, 404);
      return reply(c, result.receipt);
    } catch { return unavailable(c, commandKey); }
  });
  for (const queue of [false, true]) app.get(`${path}/commands/:commandKey${queue ? '/queue' : ''}`, async (c, next) => {
    const key = c.req.param('sessionKey')!;
    if (sessionRuntimeId(key) !== 'hermes') return next();
    c.header('Cache-Control', 'no-store');
    const commandKey = c.req.param('commandKey')!;
    if (!validKey(commandKey)) return c.json({ error: 'Invalid command key' }, 400);
    const authorization = c.req.raw.headers.get('authorization') ?? '';
    if (!authorization.trim()) return c.json({ error: 'unauthorized' }, 401);
    if (c.req.header('x-agentopsdeck-execution-grant') !== undefined) return c.json({ error: 'Delegated execution is not supported' }, 403);
    const trace = guardedTrace(deps.diagnostics ?? performanceDiagnostics, 'hermes-message-http');
    let failed = true;
    try {
      trace.add('step', queue ? 5 : 4);
      const result = await deps.messages.readReceipt({ key, authorization, commandKey }, { timeoutMs, signal: c.req.raw.signal });
      if ('error' in result) return c.json({ error: 'Message authority unavailable' }, result.error);
      if (!result.receipt) return c.json({ error: 'Command not found' }, 404);
      failed = false;
      return queue ? c.json({ commandKey, queue: result.queue }) : c.json({ command: result.receipt });
    } catch { return unavailable(c, commandKey); }
    finally { trace.finish(failed); }
  });
}
