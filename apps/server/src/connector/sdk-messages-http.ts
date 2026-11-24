import { randomUUID } from 'node:crypto';
import { createCommandKey, sessionRuntimeId } from '@agentopsdeck/shared';
import type { Context, Hono } from 'hono';
import { reply } from '../commands/http.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { readJsonBody } from '../utils/http-body.js';
import { HTTPException } from 'hono/http-exception';
import type { AsyncSdkMessages } from './async-sdk-messages.js';
import type { AsyncSdkStatus } from './async-sdk-status.js';
import { SDK_MESSAGE_PAYLOAD_BYTES } from './connector-sdk-message-domain.js';
import { isSdkCompactCommand } from './sdk-text-command.js';
import { runNativeOperation } from './native-operation.js';
import type { SdkMessageStopRequest, SdkMessageStopAdmission } from './connector-sdk-stop-domain.js';

export type SdkMessagesHttp = {
  messages: Pick<AsyncSdkMessages, 'send' | 'readReceipt' | 'readSendReceipt'>;
  status?: Pick<AsyncSdkStatus, 'send' | 'read'>;
  /** Original owning driver, not a new native interrupt executor. */
  stop?: (input: SdkMessageStopRequest) => Promise<SdkMessageStopAdmission | { error: 401 | 403 | 409 | 503 }>;
  /** Private original runtime observation. False only vetoes fresh work; true
   * is never an authorization proof. Dispatch retains its own epoch checks. */
  ready: (runtime: 'claude-code' | 'ghcp') => boolean;
  timeoutMs?: number;
  diagnostics?: PerformanceDiagnostics;
};
const validKey = (key: unknown): key is string => typeof key === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(key);
const unavailable = (c: Context, commandKey: string) => c.json({ error: 'Command outcome unavailable; read the original command key, do not resend',
  status: 'outcome_unknown', commandKey }, 503);

/** Register AFTER protocol/node guards, BEFORE synchronous SDK guards/receipt
 * middleware. Ordinary SDK messages, optional original-driver stop, and their
 * read-only recovery are owned here. Other controls retain their distinct lane. */
export function registerSdkMessagesHttp(app: Hono, path: string, deps: SdkMessagesHttp) {
  const timeoutMs = deps.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new RangeError('Finite SDK HTTP deadline required');
  let bodyReaders = 0;
  app.post(`${path}/messages`, async (c, next) => {
    const key = c.req.param('sessionKey')!, runtime = sessionRuntimeId(key);
    if (runtime !== 'claude-code' && runtime !== 'ghcp') return next();
    c.header('Cache-Control', 'no-store');
    const authorization = c.req.raw.headers.get('authorization') ?? '';
    if (!authorization.trim()) return c.json({ error: 'unauthorized' }, 401);
    if (c.req.header('x-agentopsdeck-execution-grant') !== undefined) return c.json({ error: 'Delegated execution is not supported' }, 403);
    const trace = guardedTrace(deps.diagnostics ?? performanceDiagnostics, 'sdk-message-http');
    let failed = true, commandKey = createCommandKey(randomUUID());
    // Bound HTTP assemblies separately from the physical worker IPC budget.
    // A slow request cannot allocate one maximum-size buffer per connection.
    if (bodyReaders >= 2) { trace.finish(true); return c.json({ error: 'Message input capacity reached' }, 503); }
    bodyReaders++;
    const wait = { timeoutMs, signal: c.req.raw.signal };
    try {
      trace.add('step', 1);
      // Reject unauthorized uploads before buffering. This command is read-only
      // and does not claim a receipt or permit an unknown operation to replay.
      const probe = await deps.messages.readSendReceipt({ runtime, key, authorization, commandKey }, wait);
      if ('error' in probe) return c.json({ error: 'Message authority unavailable' }, probe.error);
      const raw = await readJsonBody(c.req.raw, SDK_MESSAGE_PAYLOAD_BYTES, timeoutMs);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return c.json({ error: 'JSON object required' }, 400);
      const { idempotencyKey, ...payload } = raw as Record<string, unknown>;
      const text = typeof payload.message === 'string' ? payload.message.trim() : '';
      if ((text === '/status' && !deps.status) || (text === '/stop' && !deps.stop) || isSdkCompactCommand(text)) {
        // Hono's public request cache keeps the original control body available
        // without cloning/teeing an unbounded second Request stream.
        c.req.bodyCache.json = Promise.resolve(raw);
        failed = false;
        return next();
      }
      const header = c.req.header('idempotency-key');
      if (header && idempotencyKey !== undefined && idempotencyKey !== header) return c.json({ error: 'Conflicting command keys' }, 400);
      const selected = header ?? idempotencyKey ?? commandKey;
      if (!validKey(selected)) return c.json({ error: 'Invalid command key' }, 400);
      commandKey = selected;
      c.header('X-AgentOpsDeck-Command-Key', commandKey);
      trace.add('step', 2);
      const scope = { runtime, key, authorization, commandKey };
      const result = text === '/status' && deps.status
        ? await deps.status.send({ ...scope, payloadJson: JSON.stringify(payload) }, wait)
        : text === '/stop' && deps.stop
        ? await runNativeOperation(() => deps.stop!({ ...scope, payloadJson: JSON.stringify(payload) }), wait)
        : await deps.messages.send({ ...scope, payloadJson: JSON.stringify(payload),
          ...(deps.ready(runtime) !== true ? { rejectFresh: 'runtime_unavailable' as const } : {}) }, wait);
      if ('error' in result) return c.json({ error: 'Message admission unavailable' }, result.error);
      // Do not trust an ACK that crossed an event boundary after revocation.
      // This only rereads the original fact; it cannot create another intent.
      trace.add('step', 3);
      const current = text === '/status' && deps.status ? await deps.status.read(scope, wait) : await deps.messages.readSendReceipt(scope, wait);
      if ('error' in current) return c.json({ error: 'Message authority unavailable' }, current.error);
      if (!current.receipt) return unavailable(c, commandKey);
      if (current.receipt.id !== result.receipt?.id) return c.json({ error: 'Message authority changed' }, 403);
      failed = false;
      return reply(c, current.receipt);
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      // Includes deadline/abort/lost IPC. No invented durable receipt, fallback
      // store, automatic resend, or release of the original physical command.
      c.header('X-AgentOpsDeck-Command-Key', commandKey);
      return unavailable(c, commandKey);
    } finally { bodyReaders--; trace.finish(failed); }
  });
  // Read-only recovery of an original local report after a lost HTTP ACK or
  // projection failure. No payload, display refresh, new receipt or native work.
  app.get(`${path}/commands/:commandKey/status`, async (c, next) => {
    const key = c.req.param('sessionKey')!, runtime = sessionRuntimeId(key);
    if (!deps.status || runtime !== 'claude-code' && runtime !== 'ghcp') return next();
    c.header('Cache-Control', 'no-store');
    const commandKey = c.req.param('commandKey')!;
    if (!validKey(commandKey)) return c.json({ error: 'Invalid command key' }, 400);
    const authorization = c.req.raw.headers.get('authorization') ?? '';
    if (!authorization.trim()) return c.json({ error: 'unauthorized' }, 401);
    if (c.req.header('x-agentopsdeck-execution-grant') !== undefined) return c.json({ error: 'Delegated execution is not supported' }, 403);
    try {
      const result = await deps.status.read({ runtime, key, authorization, commandKey }, { timeoutMs, signal: c.req.raw.signal });
      if ('error' in result) return c.json({ error: 'Message authority unavailable' }, result.error);
      if (!result.receipt || !result.report) return c.json({ error: 'Status report not found' }, 404);
      return reply(c, result.receipt);
    } catch { return unavailable(c, commandKey); }
  });
  for (const queue of [false, true]) app.get(`${path}/commands/:commandKey${queue ? '/queue' : ''}`, async (c, next) => {
    const key = c.req.param('sessionKey')!, runtime = sessionRuntimeId(key);
    if (runtime !== 'claude-code' && runtime !== 'ghcp') return next();
    c.header('Cache-Control', 'no-store');
    const commandKey = c.req.param('commandKey')!;
    if (!validKey(commandKey)) return c.json({ error: 'Invalid command key' }, 400);
    const authorization = c.req.raw.headers.get('authorization') ?? '';
    if (!authorization.trim()) return c.json({ error: 'unauthorized' }, 401);
    if (c.req.header('x-agentopsdeck-execution-grant') !== undefined) return c.json({ error: 'Delegated execution is not supported' }, 403);
    const trace = guardedTrace(deps.diagnostics ?? performanceDiagnostics, 'sdk-message-http');
    let failed = true;
    try {
      trace.add('step', queue ? 5 : 4);
      const result = await deps.messages.readReceipt({ runtime, key, authorization, commandKey }, { timeoutMs, signal: c.req.raw.signal });
      if ('error' in result) return c.json({ error: 'Message authority unavailable' }, result.error);
      if (!result.receipt) return c.json({ error: 'Command not found' }, 404);
      failed = false;
      return queue ? c.json({ commandKey, queue: result.queue }) : c.json({ command: result.receipt });
    } catch { return unavailable(c, commandKey); }
    finally { trace.finish(failed); }
  });
}
