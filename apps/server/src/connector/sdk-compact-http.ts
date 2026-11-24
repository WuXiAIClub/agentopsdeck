import { randomUUID } from 'node:crypto';
import { createCommandKey, sessionRuntimeId } from '@agentopsdeck/shared';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { reply } from '../commands/http.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { readJsonBody } from '../utils/http-body.js';
import { runNativeOperation } from './native-operation.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import type { SdkAgentId } from './sdk-execution-journal.js';
import type { SdkDispatchResult } from './sdk-dispatch.js';

export type SdkCompactHttp = {
  owner: Pick<AsyncConnectorOwner, 'command'>;
  compact: (runtime: SdkAgentId, key: string, commandKey: string, authorization: string, signal: AbortSignal) => Promise<SdkDispatchResult>;
  ready: (runtime: SdkAgentId) => boolean;
  timeoutMs?: number;
  diagnostics?: PerformanceDiagnostics;
};
const validKey = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
const unknown = (c: Context, commandKey: string) => c.json({
  error: 'Compaction outcome unavailable; read the original command key, do not resend', status: 'outcome_unknown', commandKey,
}, 503);

/** Original compact lane, after protocol/node gates and before legacy guards.
 * Accepted receipts certify admission, never physical completion. A bounded
 * HTTP waiter does not cancel, forget or replay the original runtime job. */
export function registerSdkCompactHttp(app: Hono, path: string, deps: SdkCompactHttp): void {
  const timeoutMs = deps.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new RangeError('Finite SDK compact deadline required');
  let bodyReaders = 0;
  const scope = (c: Context) => {
    const key = c.req.param('sessionKey')!, runtime = sessionRuntimeId(key);
    return runtime === 'claude-code' || runtime === 'ghcp' ? { runtime, key } : undefined;
  };
  const authority = (c: Context) => {
    const authorization = c.req.raw.headers.get('authorization') ?? '';
    if (!authorization.trim()) throw new HTTPException(401);
    if (c.req.header('x-agentopsdeck-execution-grant') !== undefined) throw new HTTPException(403);
    return authorization;
  };
  const wait = <T>(c: Context, work: () => Promise<T>) => runNativeOperation(work, { timeoutMs, signal: c.req.raw.signal });
  const failed = (c: Context, error: unknown, commandKey?: string) => error instanceof HTTPException && error.status < 500
    ? c.json({ error: 'Invalid compaction request or authority' }, error.status)
    : commandKey ? unknown(c, commandKey) : c.json({ error: 'Compaction receipt unavailable' }, 503);

  app.get(`${path}/compact-commands/:commandKey`, async (c, next) => {
    const current = scope(c); if (!current) return next();
    c.header('Cache-Control', 'no-store');
    const trace = guardedTrace(deps.diagnostics ?? performanceDiagnostics, 'sdk-compact-http');
    let unavailable = true;
    try {
      trace.add('step', 1);
      const authorization = authority(c), commandKey = c.req.param('commandKey')!;
      if (!validKey(commandKey)) return c.json({ error: 'Invalid compact command key' }, 400);
      const view = await wait(c, () => deps.owner.command('sdkCompactReceiptRead', { ...current, authorization, commandKey, purpose: 'read' }));
      if ('error' in view) return c.json({ error: 'Compaction receipt authority unavailable' }, view.error);
      if (!view.receipt) return c.json({ error: 'Command not found' }, 404);
      unavailable = false; return c.json({ command: view.receipt });
    } catch (error) { return failed(c, error); }
    finally { trace.finish(unavailable); }
  });
  app.post(`${path}/compact`, async (c, next) => {
    const current = scope(c); if (!current) return next();
    c.header('Cache-Control', 'no-store');
    const trace = guardedTrace(deps.diagnostics ?? performanceDiagnostics, 'sdk-compact-http');
    let unavailable = true, commandKey = createCommandKey(randomUUID());
    if (bodyReaders >= 2) { trace.finish(true); return c.json({ error: 'Compact input capacity reached' }, 503); }
    bodyReaders++;
    try {
      trace.add('step', 2);
      const authorization = authority(c);
      const probe = await wait(c, () => deps.owner.command('sdkCompactReceiptRead', { ...current, authorization, commandKey, purpose: 'mutation' }));
      if ('error' in probe) return c.json({ error: 'Compaction authority unavailable' }, probe.error);
      const raw = await readJsonBody(c.req.raw, 4096, timeoutMs);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return c.json({ error: 'JSON object required' }, 400);
      const { idempotencyKey, ...payload } = raw as Record<string, unknown>;
      if (Object.keys(payload).length) return c.json({ error: 'Compact takes no message or native options' }, 400);
      const header = c.req.header('idempotency-key');
      if (header !== undefined && idempotencyKey !== undefined && idempotencyKey !== header) return c.json({ error: 'Conflicting command keys' }, 400);
      const selected = header ?? idempotencyKey ?? commandKey;
      if (!validKey(selected)) return c.json({ error: 'Invalid compact command key' }, 400);
      commandKey = selected; c.header('X-AgentOpsDeck-Command-Key', commandKey);
      const input = { ...current, authorization, commandKey, purpose: 'mutation' as const };
      const original = await wait(c, () => deps.owner.command('sdkCompactReceiptRead', input));
      if ('error' in original) return c.json({ error: 'Compaction authority unavailable' }, original.error);
      if (original.receipt) { unavailable = false; return reply(c, original.receipt); }
      if (deps.ready(current.runtime) !== true) return c.json({ error: 'Agent is not ready; command was not admitted', code: 'agent_not_ready' }, 409);
      trace.add('step', 3);
      const result = await wait(c, () => deps.compact(current.runtime, current.key, commandKey, authorization, c.req.raw.signal));
      trace.add('step', 4);
      // The driver returns an execution classification, not a receipt ID. Only
      // the original immutable scope/key in the worker can supply the fact.
      const view = await wait(c, () => deps.owner.command('sdkCompactReceiptRead', input));
      if ('error' in view) return c.json({ error: 'Compaction authority unavailable' }, view.error);
      if (view.receipt) { unavailable = false; return reply(c, view.receipt); }
      if (result === 'blocked') return c.json({ error: 'Compaction authority unavailable' }, 403);
      if (result === 'not_started') return c.json({ error: 'Compaction was not admitted; session must be ready and queue empty' }, 409);
      return unknown(c, commandKey);
    } catch (error) { return failed(c, error, commandKey); }
    finally { bodyReaders--; trace.finish(unavailable); }
  });
}
