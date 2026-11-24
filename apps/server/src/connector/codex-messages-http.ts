import { randomUUID } from 'node:crypto';
import { createCommandKey, sessionRuntimeId } from '@agentopsdeck/shared';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { reply } from '../commands/http.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { readJsonBody } from '../utils/http-body.js';
import type { AsyncCodexMessages } from './async-codex-messages.js';
import type { AsyncCodexStop } from './async-codex-stop.js';
import { CODEX_MESSAGE_PAYLOAD_BYTES } from './connector-codex-message-domain.js';
import { EXECUTION_GRANT_HEADER } from './execution-authority.js';
import { EXPECTED_NODE_HEADER } from './node-identity.js';

export type CodexMessagesHttp = {
  messages: Pick<AsyncCodexMessages, 'send' | 'readReceipt' | 'readSendReceipt'>;
  stop?: Pick<AsyncCodexStop, 'stop' | 'readReceipt'>;
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
/** Ordinary ingress and optional worker-authorized stop control. Without the
 * stop port, controls keep their original receipt lane.
 * Installed after protocol/node gates and before synchronous receipt middleware. */
export function registerCodexMessagesHttp(app: Hono, path: string, deps: CodexMessagesHttp) {
  const timeoutMs = deps.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new RangeError('Finite Codex HTTP deadline required');
  let readers = 0;
  app.post(`${path}/messages`, async (c, next) => {
    const key = c.req.param('sessionKey')!;
    if (sessionRuntimeId(key) !== 'codex') return next();
    c.header('Cache-Control', 'no-store');
    const identity = evidence(c);
    if (!identity.authorization.trim()) return c.json({ error: 'unauthorized' }, 401);
    if (readers >= 2) return c.json({ error: 'Message input capacity reached' }, 503);
    readers++;
    const trace = guardedTrace(deps.diagnostics ?? performanceDiagnostics, 'codex-message-http');
    let failed = true, commandKey = createCommandKey(randomUUID());
    const wait = { timeoutMs, signal: c.req.raw.signal };
    try {
      trace.add('step', 1);
      const raw = await readJsonBody(c.req.raw, CODEX_MESSAGE_PAYLOAD_BYTES, timeoutMs);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return c.json({ error: 'JSON object required' }, 400);
      const { idempotencyKey, ...payload } = raw as Record<string, unknown>;
      const text = typeof payload.message === 'string' ? payload.message.trim() : '';
      // Only /stop is a control in Codex POST messages. /status and /compact
      // are ordinary message text; the dedicated compact endpoint is separate.
      if (text === '/stop' && !deps.stop) {
        c.req.bodyCache.json = Promise.resolve(raw); failed = false; return next();
      }
      const header = c.req.header('idempotency-key');
      if (header !== undefined && idempotencyKey !== undefined && idempotencyKey !== header) return c.json({ error: 'Conflicting command keys' }, 400);
      const selected = header ?? idempotencyKey ?? commandKey;
      if (!validKey(selected)) return c.json({ error: 'Invalid command key' }, 400);
      commandKey = selected; c.header('X-AgentOpsDeck-Command-Key', commandKey);
      trace.add('step', 2);
      const scope = { key, commandKey, ...identity };
      const result = text === '/stop' && deps.stop
        ? await deps.stop.stop({ ...scope, payloadJson: JSON.stringify(payload) }, wait)
        : await deps.messages.send({ ...scope, payloadJson: JSON.stringify(payload),
          ...(deps.ready() !== true ? { rejectFresh: 'runtime_unavailable' as const } : {}) }, wait);
      if ('error' in result) return c.json({ error: 'Message admission unavailable' }, result.error);
      trace.add('step', 3);
      const current = text === '/stop' && deps.stop ? await deps.stop.readReceipt(scope, wait) : await deps.messages.readSendReceipt(scope, wait);
      if ('error' in current) return c.json({ error: 'Message authority unavailable' }, current.error);
      if (!current.receipt) return unavailable(c, commandKey);
      if (current.receipt.id !== result.receipt?.id) return c.json({ error: 'Message authority changed' }, 403);
      failed = false; return reply(c, current.receipt);
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      c.header('X-AgentOpsDeck-Command-Key', commandKey); return unavailable(c, commandKey);
    } finally { readers--; trace.finish(failed); }
  });
  for (const queue of [false, true]) app.get(`${path}/commands/:commandKey${queue ? '/queue' : ''}`, async (c, next) => {
    const key = c.req.param('sessionKey')!;
    if (sessionRuntimeId(key) !== 'codex') return next();
    c.header('Cache-Control', 'no-store');
    const commandKey = c.req.param('commandKey')!, identity = evidence(c);
    if (!validKey(commandKey)) return c.json({ error: 'Invalid command key' }, 400);
    if (!identity.authorization.trim()) return c.json({ error: 'unauthorized' }, 401);
    const trace = guardedTrace(deps.diagnostics ?? performanceDiagnostics, 'codex-message-http');
    let failed = true;
    try {
      trace.add('step', queue ? 5 : 4);
      const result = await deps.messages.readReceipt({ key, commandKey, ...identity }, { timeoutMs, signal: c.req.raw.signal });
      if ('error' in result) return c.json({ error: 'Message authority unavailable' }, result.error);
      if (!result.receipt) return c.json({ error: 'Command not found' }, 404);
      failed = false; return queue ? c.json({ commandKey, queue: result.queue }) : c.json({ command: result.receipt });
    } catch { return unavailable(c, commandKey); }
    finally { trace.finish(failed); }
  });
}
