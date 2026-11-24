import { randomUUID } from 'node:crypto';
import { createCommandKey, sessionRuntimeId } from '@agentopsdeck/shared';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { reply } from '../commands/http.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { readJsonBody } from '../utils/http-body.js';
import type { AsyncSdkLocal } from './async-sdk-local.js';
import { SDK_LOCAL_PAYLOAD_BYTES } from './connector-sdk-local-domain.js';
import type { SdkAgentId } from './sdk-execution-journal.js';

export type SdkLocalHttp = {
  local: Pick<AsyncSdkLocal, 'create' | 'updateModel' | 'readReceipt'>;
  physical?: Pick<AsyncSdkLocal, 'createPhysical' | 'updateModelPhysical' | 'readReceiptPhysical'>;
  requestLocal?(c: Context): SdkLocalHttp['local'];
  authorization?(c: Context): string;
  around?(c: Context, work: () => Promise<Response>): Promise<Response>;
  /** Observation can veto fresh admission, never grant worker authority. */
  ready: (runtime: SdkAgentId) => boolean;
  timeoutMs?: number;
  diagnostics?: PerformanceDiagnostics;
};
type Target = { operation: 'create'; runtime: SdkAgentId } | { operation: 'settings'; runtime: SdkAgentId; key: string };
const sdk = (v: string): v is SdkAgentId => v === 'claude-code' || v === 'ghcp';
const validKey = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
const unavailable = (c: Context, commandKey: string) => c.json({ error: 'Command outcome unavailable; read the original command key, do not resend',
  status: 'outcome_unknown', commandKey }, 503);

/** After protocol/node gates, before the old SDK guards/receipt middleware.
 * Owns model writes, creation and their original read-only receipts. Title-only
 * PATCH retains its old lane and original request body; no cloned body stream,
 * synchronous store shim, caller-supplied actor, or duplicate receipt claim. */
export function registerSdkLocalHttp(app: Hono, base: string, deps: SdkLocalHttp): void {
  const timeoutMs = deps.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new RangeError('Finite SDK HTTP deadline required');
  let bodyReaders = 0;
  const createTarget = (c: Context): Target | undefined => {
    const runtime = c.req.param('agentId')!;
    return sdk(runtime) ? { operation: 'create', runtime } : undefined;
  };
  const settingsTarget = (c: Context): Target | undefined => {
    const key = c.req.param('sessionKey')!, runtime = sessionRuntimeId(key);
    return sdk(runtime) ? { operation: 'settings', runtime, key } : undefined;
  };
  const owned = (targetFor: (c: Context) => Target | undefined, handler: MiddlewareHandler): MiddlewareHandler => async (c, next) => {
    if (!targetFor(c)) return next();
    if (!deps.around) return handler(c, next);
    return deps.around(c, async () => {
      const response = await handler(c, next);
      return response instanceof Response ? response : c.res;
    });
  };
  for (const [method, path, targetFor] of [
    ['post', `${base}/agents/:agentId/sessions`, createTarget],
    ['patch', `${base}/sessions/:sessionKey`, settingsTarget],
  ] as const) app[method](path, owned(targetFor, async (c, next) => {
    const target = targetFor(c);
    if (!target) return next();
    c.header('Cache-Control', 'no-store');
    const authorization = deps.authorization ? deps.authorization(c) : c.req.raw.headers.get('authorization') ?? '';
    if (!authorization.trim()) return c.json({ error: 'unauthorized' }, 401);
    if (c.req.header('x-agentopsdeck-execution-grant') !== undefined) return c.json({ error: 'SDK local commands require owner authority' }, 403);
    const trace = guardedTrace(deps.diagnostics ?? performanceDiagnostics, 'sdk-local-http');
    let failed = true, commandKey = createCommandKey(randomUUID());
    if (bodyReaders >= 2) { trace.finish(true); return c.json({ error: 'Local command input capacity reached' }, 503); }
    bodyReaders++;
    const wait = { timeoutMs, signal: c.req.raw.signal };
    try {
      const local = deps.requestLocal?.(c) ?? deps.local;
      trace.add('step', target.operation === 'create' ? 1 : 2);
      const probe = await local.readReceipt({ ...target, authorization, commandKey }, wait);
      if ('error' in probe) return c.json({ error: 'Local command authority unavailable' }, probe.error);
      const raw = await readJsonBody(c.req.raw, SDK_LOCAL_PAYLOAD_BYTES, timeoutMs);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return c.json({ error: 'JSON object required' }, 400);
      if (target.operation === 'settings' && (!Object.hasOwn(raw, 'model') || Object.hasOwn(raw, 'goal'))) {
        c.req.bodyCache.json = Promise.resolve(raw);
        failed = false;
        return next();
      }
      const { idempotencyKey, ...payload } = raw as Record<string, unknown>;
      const header = c.req.header('idempotency-key');
      if (header !== undefined && idempotencyKey !== undefined && idempotencyKey !== header) return c.json({ error: 'Conflicting command keys' }, 400);
      const selected = header ?? idempotencyKey ?? commandKey;
      if (!validKey(selected)) return c.json({ error: 'Invalid command key' }, 400);
      commandKey = selected;
      c.header('X-AgentOpsDeck-Command-Key', commandKey);
      const scope = { ...target, authorization, commandKey };
      // Do not pass recovery-only "operation" into the fixed write envelope.
      const input = { runtime: target.runtime, authorization, commandKey, payloadJson: JSON.stringify(payload),
        ...(deps.ready(target.runtime) !== true ? { rejectFresh: 'runtime_unavailable' as const } : {}) };
      trace.add('step', 3);
      const result = target.operation === 'create' ? await local.create(input, wait)
        : await local.updateModel({ ...input, key: target.key }, wait);
      if ('error' in result) return c.json({ error: 'Local command admission unavailable' }, result.error);
      // Original worker reread, not redispatch: late ACK cannot bypass revoke.
      trace.add('step', 4);
      const current = await local.readReceipt(scope, wait);
      if ('error' in current) return c.json({ error: 'Local command authority unavailable' }, current.error);
      if (!current.receipt) return unavailable(c, commandKey);
      if (current.receipt.id !== result.receipt.id) return c.json({ error: 'Local command authority changed' }, 403);
      failed = false;
      return reply(c, current.receipt);
    } catch (error) {
      return error instanceof HTTPException && error.status < 500
        ? c.json({ error: 'Invalid local command input' }, error.status) : unavailable(c, commandKey);
    } finally { bodyReaders--; trace.finish(failed); }
  }));
  for (const [path, targetFor] of [
    [`${base}/agents/:agentId/sessions/creation-commands/:commandKey`, createTarget],
    [`${base}/sessions/:sessionKey/settings-commands/:commandKey`, settingsTarget],
  ] as const) app.get(path, owned(targetFor, async (c, next) => {
    const target = targetFor(c);
    if (!target) return next();
    c.header('Cache-Control', 'no-store');
    const commandKey = c.req.param('commandKey')!;
    if (!validKey(commandKey)) return c.json({ error: 'Invalid command key' }, 400);
    const authorization = deps.authorization ? deps.authorization(c) : c.req.raw.headers.get('authorization') ?? '';
    if (!authorization.trim()) return c.json({ error: 'unauthorized' }, 401);
    if (c.req.header('x-agentopsdeck-execution-grant') !== undefined) return c.json({ error: 'SDK local commands require owner authority' }, 403);
    const trace = guardedTrace(deps.diagnostics ?? performanceDiagnostics, 'sdk-local-http');
    let failed = true;
    try {
      trace.add('step', target.operation === 'create' ? 5 : 6);
      const local = deps.requestLocal?.(c) ?? deps.local;
      const current = await local.readReceipt({ ...target, authorization, commandKey }, { timeoutMs, signal: c.req.raw.signal });
      if ('error' in current) return c.json({ error: 'Local command authority unavailable' }, current.error);
      if (!current.receipt) return c.json({ error: 'Command not found' }, 404);
      failed = false;
      return c.json({ command: current.settingsStartReleased ? { ...current.receipt, settingsStartReleased: true } : current.receipt });
    } catch { return unavailable(c, commandKey); }
    finally { trace.finish(failed); }
  }));
}
