import { randomUUID } from 'node:crypto';
import { createCommandKey, sessionRuntimeId } from '@agentopsdeck/shared';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { reply } from '../commands/http.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { readJsonBody } from '../utils/http-body.js';
import type { AsyncOpenClawMessages } from './async-openclaw-messages.js';
import type { AsyncOpenClawStop } from './async-openclaw-stop.js';
import type { AsyncOpenClawStatus } from './async-openclaw-status.js';
import type { AsyncOpenClawCompact } from './async-openclaw-compact.js';
import { OPENCLAW_MESSAGE_PAYLOAD_BYTES } from './connector-openclaw-message-domain.js';
import { EXECUTION_GRANT_HEADER } from './execution-authority.js';
import { EXPECTED_NODE_HEADER } from './node-identity.js';

export type OpenClawMessagesHttp = {
  messages: Pick<AsyncOpenClawMessages, 'send' | 'readReceipt' | 'readSendReceipt'>;
  stop?: Pick<AsyncOpenClawStop, 'stop'>;
  status?: Pick<AsyncOpenClawStatus, 'send' | 'read' | 'readForSend'>;
  compact?: Pick<AsyncOpenClawCompact, 'compact' | 'read' | 'readForSend'>;
  ready(): boolean;
  timeoutMs?: number;
  diagnostics?: PerformanceDiagnostics;
};
const validKey = (key: unknown): key is string => typeof key === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(key);
const unavailable = (c: Context, commandKey: string) => c.json({
  error: 'Command outcome unavailable; read the original command key, do not resend', status: 'outcome_unknown', commandKey,
}, 503);
function evidence(c: Context) {
  const grantId = c.req.header(EXECUTION_GRANT_HEADER), expectedNode = c.req.header(EXPECTED_NODE_HEADER);
  return { authorization: c.req.raw.headers.get('authorization') ?? '',
    ...(grantId !== undefined ? { grantId } : {}), ...(expectedNode !== undefined ? { expectedNode } : {}) };
}

/** After protocol/node gates, before legacy receipts. Unmigrated controls retain
 * their original authority lane; migrated controls validate current authority in SQL.
 * Body readers are bounded even when this port is tested without outer gates. */
export function registerOpenClawMessagesHttp(app: Hono, path: string, deps: OpenClawMessagesHttp) {
  const timeoutMs = deps.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new RangeError('Finite OpenClaw HTTP deadline required');
  let bodyReaders = 0;
  app.post(`${path}/messages`, async (c, next) => {
    const key = c.req.param('sessionKey')!;
    if (sessionRuntimeId(key) !== 'openclaw') return next();
    c.header('Cache-Control', 'no-store');
    const identity = evidence(c);
    if (!identity.authorization.trim()) return c.json({ error: 'unauthorized' }, 401);
    const trace = guardedTrace(deps.diagnostics ?? performanceDiagnostics, 'openclaw-message-http');
    let failed = true, commandKey = createCommandKey(randomUUID());
    if (bodyReaders >= 2) { trace.finish(true); return c.json({ error: 'Message input capacity reached' }, 503); }
    bodyReaders++;
    const wait = { timeoutMs, signal: c.req.raw.signal };
    try {
      trace.add('step', 1);
      const raw = await readJsonBody(c.req.raw, OPENCLAW_MESSAGE_PAYLOAD_BYTES, timeoutMs);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return c.json({ error: 'JSON object required' }, 400);
      const { idempotencyKey, ...payload } = raw as Record<string, unknown>;
      const text = typeof payload.message === 'string' ? payload.message.trim() : '';
      const media = Array.isArray(payload.media) && payload.media.length > 0;
      const legacy = text === '/stop' ? !deps.stop
        : text === '/status' ? !deps.status && (!media || payload.deliveryMode === 'mirror')
        : text === '/compact' && !deps.compact && (!media || payload.deliveryMode === 'mirror');
      if (legacy) {
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
      const scope = { key, commandKey, ...identity };
      const localStatus = text === '/status' && !media && deps.status;
      const localCompact = text === '/compact' && (!media || payload.deliveryMode === 'mirror') && deps.compact;
      const result = localCompact ? await localCompact.compact({ ...scope, operation: 'message', payloadJson: JSON.stringify(payload) }, wait)
        : localStatus ? await localStatus.send({ ...scope, payloadJson: JSON.stringify(payload) }, wait)
        : text === '/stop' && deps.stop
        ? await deps.stop.stop({ ...scope, payloadJson: JSON.stringify(payload) }, wait)
        : await deps.messages.send({ ...scope, payloadJson: JSON.stringify(payload),
          ...(deps.ready() !== true ? { rejectFresh: 'runtime_unavailable' as const } : {}) }, wait);
      if ('error' in result) return c.json({ error: 'Message admission unavailable' }, result.error);
      trace.add('step', 3);
      const current = localCompact ? await localCompact.readForSend({ ...scope, operation: 'message' }, wait)
        : localStatus ? await localStatus.readForSend(scope, wait) : await deps.messages.readSendReceipt(scope, wait);
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
  for (const queue of [false, true]) app.get(`${path}/commands/:commandKey${queue ? '/queue' : ''}`, async (c, next) => {
    const key = c.req.param('sessionKey')!;
    if (sessionRuntimeId(key) !== 'openclaw') return next();
    c.header('Cache-Control', 'no-store');
    const commandKey = c.req.param('commandKey')!;
    if (!validKey(commandKey)) return c.json({ error: 'Invalid command key' }, 400);
    const identity = evidence(c);
    if (!identity.authorization.trim()) return c.json({ error: 'unauthorized' }, 401);
    const trace = guardedTrace(deps.diagnostics ?? performanceDiagnostics, 'openclaw-message-http');
    let failed = true;
    try {
      trace.add('step', queue ? 5 : 4);
      const result = await (deps.status ? deps.status.read({ key, commandKey, ...identity }, { timeoutMs, signal: c.req.raw.signal })
        : deps.messages.readReceipt({ key, commandKey, ...identity }, { timeoutMs, signal: c.req.raw.signal }));
      if ('error' in result) return c.json({ error: 'Message authority unavailable' }, result.error);
      if (!result.receipt) return c.json({ error: 'Command not found' }, 404);
      if (deps.compact) {
        const current = await deps.compact.read({ key, commandKey, ...identity, operation: 'message' }, { timeoutMs, signal: c.req.raw.signal });
        if ('error' in current) return c.json({ error: 'Message authority unavailable' }, current.error);
        if (current.receipt?.id !== result.receipt.id) return unavailable(c, commandKey);
        // The compact projection is original-only. Ordinary/status readers
        // still supply the original queue wire, not a guessed queue absence.
      }
      failed = false;
      return queue ? c.json({ commandKey, queue: result.queue }) : c.json({ command: result.receipt });
    } catch { return unavailable(c, commandKey); }
    finally { trace.finish(failed); }
  });
  if (deps.compact) {
    const compact = deps.compact;
    app.get(`${path}/compact-commands/:commandKey`, async (c, next) => {
      const key = c.req.param('sessionKey')!;
      if (sessionRuntimeId(key) !== 'openclaw') return next();
      c.header('Cache-Control', 'no-store');
      const commandKey = c.req.param('commandKey')!, identity = evidence(c);
      if (!validKey(commandKey)) return c.json({ error: 'Invalid command key' }, 400);
      if (!identity.authorization.trim()) return c.json({ error: 'unauthorized' }, 401);
      try {
        const result = await compact.read({ key, commandKey, ...identity, operation: 'compact' }, { timeoutMs, signal: c.req.raw.signal });
        if ('error' in result) return c.json({ error: 'Compaction authority unavailable' }, result.error);
        return result.receipt ? c.json({ command: result.receipt }) : c.json({ error: 'Command not found' }, 404);
      } catch { return unavailable(c, commandKey); }
    });
    app.post(`${path}/compact`, async (c, next) => {
      const key = c.req.param('sessionKey')!;
      if (sessionRuntimeId(key) !== 'openclaw') return next();
      c.header('Cache-Control', 'no-store');
      const identity = evidence(c);
      if (!identity.authorization.trim()) return c.json({ error: 'unauthorized' }, 401);
      let commandKey = createCommandKey(randomUUID());
      if (bodyReaders >= 2) return c.json({ error: 'Compact input capacity reached' }, 503);
      bodyReaders++;
      try {
        const raw = await readJsonBody(c.req.raw, 4096, timeoutMs);
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return c.json({ error: 'JSON object required' }, 400);
        const { idempotencyKey, ...payload } = raw as Record<string, unknown>;
        if (Object.keys(payload).length) return c.json({ error: 'Compact takes no message or native options' }, 400);
        const header = c.req.header('idempotency-key');
        if (header !== undefined && idempotencyKey !== undefined && idempotencyKey !== header) return c.json({ error: 'Conflicting command keys' }, 400);
        const selected = header ?? idempotencyKey ?? commandKey;
        if (!validKey(selected)) return c.json({ error: 'Invalid command key' }, 400);
        commandKey = selected; c.header('X-AgentOpsDeck-Command-Key', commandKey);
        const scope = { key, commandKey, ...identity, operation: 'compact' as const }, wait = { timeoutMs, signal: c.req.raw.signal };
        const result = await compact.compact({ ...scope, payloadJson: JSON.stringify(payload) }, wait);
        if ('error' in result) return c.json({ error: 'Compaction admission unavailable' }, result.error);
        const current = await compact.readForSend(scope, wait);
        if ('error' in current) return c.json({ error: 'Compaction authority unavailable' }, current.error);
        if (!current.receipt) return unavailable(c, commandKey);
        if (current.receipt.id !== result.receipt?.id) return c.json({ error: 'Compaction authority changed' }, 403);
        return reply(c, current.receipt);
      } catch (error) {
        if (error instanceof HTTPException) throw error;
        c.header('X-AgentOpsDeck-Command-Key', commandKey); return unavailable(c, commandKey);
      } finally { bodyReaders--; }
    });
  }
}
