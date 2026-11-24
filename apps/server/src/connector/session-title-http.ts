import { randomUUID } from 'node:crypto';
import { sessionRuntimeId } from '@agentopsdeck/shared';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AsyncSessionTitle } from './async-session-title.js';
import { titleRuntime } from './connector-title-domain.js';
import { runNativeOperation } from './native-operation.js';
import { readJsonBody } from '../utils/http-body.js';
import { reply } from '../commands/http.js';

export type SessionTitleHttp = { titles: Pick<AsyncSessionTitle, 'change' | 'receipt'>; timeoutMs?: number;
  requestTitles?(c: Context): SessionTitleHttp['titles']; authorization?(c: Context): string;
  around?(c: Context, work: () => Promise<Response>): Promise<Response> };
const validKey = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
const unavailable = (c: Context, commandKey: string) => c.json({ error: 'Settings outcome unavailable; read the original command key, do not resend', status: 'outcome_unknown', commandKey }, 503);
/** After protocol and SDK model routes, before legacy settings receipts. Reuse
 * an upstream bounded JSON read; title-only PATCH never falls through to SQL. */
export function registerSessionTitleHttp(app: Hono, path: string, deps: SessionTitleHttp) {
  const timeoutMs = deps.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new RangeError('Finite settings deadline required');
  let readers = 0;
  const owned = (handler: MiddlewareHandler): MiddlewareHandler => async (c, next) => {
    if (!titleRuntime(sessionRuntimeId(c.req.param('sessionKey') ?? ''))) return next();
    if (!deps.around) return handler(c, next);
    return deps.around(c, async () => { const response = await handler(c, next); return response instanceof Response ? response : c.res; });
  };
  app.patch(path, owned(async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const key = c.req.param('sessionKey')!, authorization = deps.authorization ? deps.authorization(c) : c.req.header('authorization') ?? '';
    if (!authorization.trim() || c.req.header('x-agentopsdeck-execution-grant') !== undefined) return c.json({ error: 'missing sessions:create scope' }, 403);
    if (readers >= 2) return c.json({ error: 'Settings input capacity reached' }, 503);
    readers++; let commandKey = randomUUID() as string; const wait = { timeoutMs, signal: c.req.raw.signal };
    try {
      const titles = deps.requestTitles?.(c) ?? deps.titles;
      const probe = await runNativeOperation(() => titles.receipt({ authorization, key, commandKey }), wait);
      if ('error' in probe) return c.json({ error: 'Settings authority unavailable' }, probe.error);
      // Hono's json() caches TEXT, whereas the bounded SDK reader forwards an
      // explicit parsed JSON cache. Both are original reads, never reread raw.
      const raw: unknown = await runNativeOperation(async () => {
        if (c.req.bodyCache.json) return c.req.bodyCache.json;
        if (c.req.bodyCache.text) {
          const text = await c.req.bodyCache.text;
          if (Buffer.byteLength(text) > 128 * 1024) throw new HTTPException(413);
          try { return JSON.parse(text) as unknown; } catch { throw new HTTPException(400); }
        }
        return readJsonBody(c.req.raw, 128 * 1024, timeoutMs);
      }, wait);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return c.json({ error: 'JSON object required' }, 400);
      // Supported SDK models were consumed by their dedicated earlier route.
      // No unsupported control may escape into a legacy synchronous writer.
      if (Object.hasOwn(raw, 'goal') || Object.hasOwn(raw, 'model')) return c.json({ error: 'Unsupported session settings' }, 400);
      const { idempotencyKey, ...payload } = raw as Record<string, unknown>, header = c.req.header('idempotency-key');
      if (header !== undefined && idempotencyKey !== undefined && idempotencyKey !== header) return c.json({ error: 'Conflicting command keys' }, 400);
      const selected = header ?? idempotencyKey ?? commandKey;
      if (!validKey(selected)) return c.json({ error: 'Invalid command key' }, 400);
      commandKey = selected; c.header('X-AgentOpsDeck-Command-Key', commandKey);
      const changed = await runNativeOperation(() => titles.change({ authorization, key, commandKey, payloadJson: JSON.stringify(payload) }), wait);
      if ('error' in changed) return c.json({ error: 'Settings unavailable' }, changed.error);
      const current = await runNativeOperation(() => titles.receipt({ authorization, key, commandKey }), wait);
      if ('error' in current) return c.json({ error: 'Settings authority unavailable' }, current.error);
      if (!current.receipt || !changed.receipt || current.receipt.id !== changed.receipt.id) return unavailable(c, commandKey);
      return reply(c, current.receipt);
    } catch (error) { return error instanceof HTTPException && error.status < 500 ? c.json({ error: 'Invalid settings input' }, error.status) : unavailable(c, commandKey); }
    finally { readers--; }
  }));
  app.get(`${path}/settings-commands/:commandKey`, owned(async c => {
    c.header('Cache-Control', 'no-store');
    const key = c.req.param('sessionKey')!, commandKey = c.req.param('commandKey')!, authorization = deps.authorization ? deps.authorization(c) : c.req.header('authorization') ?? '';
    if (!authorization.trim() || c.req.header('x-agentopsdeck-execution-grant') !== undefined) return c.json({ error: 'missing sessions:create scope' }, 403);
    if (!validKey(commandKey)) return c.json({ error: 'Invalid command key' }, 400);
    try {
      const titles = deps.requestTitles?.(c) ?? deps.titles;
      const current = await runNativeOperation(() => titles.receipt({ authorization, key, commandKey }), { timeoutMs, signal: c.req.raw.signal });
      if ('error' in current) return c.json({ error: 'Settings authority unavailable' }, current.error);
      return current.receipt ? c.json({ command: current.receipt }) : c.json({ error: 'Command not found' }, 404);
    } catch { return unavailable(c, commandKey); }
  }));
}
