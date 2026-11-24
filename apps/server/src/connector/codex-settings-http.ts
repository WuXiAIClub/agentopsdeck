import { randomUUID } from 'node:crypto';
import { createCommandKey, sessionRuntimeId } from '@agentopsdeck/shared';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { AsyncCodexSettings } from './async-codex-settings.js';
import { runNativeOperation } from './native-operation.js';
import { readJsonBody } from '../utils/http-body.js';
import { reply } from '../commands/http.js';

export type CodexSettingsHttp = { settings: Pick<AsyncCodexSettings, 'change' | 'receipt' | 'goal'>; timeoutMs?: number;
  requestSettings?(context: Context): CodexSettingsHttp['settings'];
  authorization?(context: Context): string;
  around?(context: Context, work: () => Promise<Response>): Promise<Response>;
};
const validKey = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
const unavailable = (c: Context, commandKey: string) => c.json({ error: 'Settings outcome unavailable; read the original command key, do not resend', status: 'outcome_unknown', commandKey }, 503);
/** Consumes Codex BEFORE legacy synchronous receipt middleware, after the
 * existing protocol/node gates. All other runtimes keep their original route. */
export function registerCodexSettingsHttp(app: Hono, path: string, deps: CodexSettingsHttp) {
  const timeoutMs = deps.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new RangeError('Finite settings deadline required');
  const owned = (handler: MiddlewareHandler): MiddlewareHandler => async (c, next) => {
    if (sessionRuntimeId(c.req.param('sessionKey') ?? '') !== 'codex') return next();
    if (!deps.around) return handler(c, next);
    return deps.around(c, async () => {
      const response = await handler(c, next);
      return response instanceof Response ? response : c.res;
    });
  };
  let readers = 0;
  app.patch(path, owned(async (c, next) => {
    const key = c.req.param('sessionKey') ?? '';
    if (sessionRuntimeId(key) !== 'codex') return next();
    c.header('Cache-Control', 'no-store');
    const authorization = deps.authorization ? deps.authorization(c) : c.req.header('authorization') ?? '';
    if (!authorization.trim() || c.req.header('x-agentopsdeck-execution-grant') !== undefined) return c.json({ error: 'missing sessions:create scope' }, 403);
    if (readers >= 2) return c.json({ error: 'Settings input capacity reached' }, 503);
    readers++;
    let commandKey = createCommandKey(randomUUID());
    const wait = { timeoutMs, signal: c.req.raw.signal };
    try {
      const settings = deps.requestSettings?.(c) ?? deps.settings;
      const probe = await runNativeOperation(() => settings.receipt({ authorization, key, commandKey }), wait);
      if ('error' in probe) return c.json({ error: 'Settings authority unavailable' }, probe.error);
      const raw = await readJsonBody(c.req.raw, 128 * 1024, timeoutMs);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return c.json({ error: 'JSON object required' }, 400);
      const { idempotencyKey, ...payload } = raw as Record<string, unknown>;
      const header = c.req.header('idempotency-key');
      if (header !== undefined && idempotencyKey !== undefined && idempotencyKey !== header) return c.json({ error: 'Conflicting command keys' }, 400);
      const selected = header ?? idempotencyKey ?? commandKey;
      if (!validKey(selected)) return c.json({ error: 'Invalid command key' }, 400);
      commandKey = selected; c.header('X-AgentOpsDeck-Command-Key', commandKey);
      const changed = await runNativeOperation(() => settings.change({ authorization, key, commandKey, payloadJson: JSON.stringify(payload) }), wait);
      if ('error' in changed) return c.json({ error: 'Settings unavailable' }, changed.error);
      const current = await runNativeOperation(() => settings.receipt({ authorization, key, commandKey }), wait);
      if ('error' in current) return c.json({ error: 'Settings authority unavailable' }, current.error);
      if (!current.receipt || !changed.receipt || current.receipt.id !== changed.receipt.id) return unavailable(c, commandKey);
      return reply(c, current.receipt);
    } catch (error) {
      return error instanceof HTTPException && error.status < 500 ? c.json({ error: 'Invalid settings input' }, error.status) : unavailable(c, commandKey);
    } finally { readers--; }
  }));
  app.get(`${path}/settings-commands/:commandKey`, owned(async (c, next) => {
    const key = c.req.param('sessionKey') ?? '';
    if (sessionRuntimeId(key) !== 'codex') return next();
    c.header('Cache-Control', 'no-store');
    const authorization = deps.authorization ? deps.authorization(c) : c.req.header('authorization') ?? '', commandKey = c.req.param('commandKey') ?? '';
    if (!authorization.trim() || c.req.header('x-agentopsdeck-execution-grant') !== undefined) return c.json({ error: 'missing sessions:create scope' }, 403);
    if (!validKey(commandKey)) return c.json({ error: 'Invalid command key' }, 400);
    try {
      const settings = deps.requestSettings?.(c) ?? deps.settings;
      const result = await runNativeOperation(() => settings.receipt({ authorization, key, commandKey }), { timeoutMs, signal: c.req.raw.signal });
      if ('error' in result) return c.json({ error: 'Settings authority unavailable' }, result.error);
      return result.receipt ? c.json({ command: result.receipt }) : c.json({ error: 'Command not found' }, 404);
    } catch { return unavailable(c, commandKey); }
  }));
  app.get(`${path}/goal`, owned(async (c, next) => {
    const key = c.req.param('sessionKey') ?? '';
    if (sessionRuntimeId(key) !== 'codex') return next();
    c.header('Cache-Control', 'no-store');
    const authorization = deps.authorization ? deps.authorization(c) : c.req.header('authorization') ?? '';
    if (!authorization.trim() || c.req.header('x-agentopsdeck-execution-grant') !== undefined) return c.json({ error: 'missing sessions:create scope' }, 403);
    try {
      const settings = deps.requestSettings?.(c) ?? deps.settings;
      const result = await runNativeOperation(() => settings.goal({ authorization, key }), { timeoutMs, signal: c.req.raw.signal });
      return 'error' in result ? c.json({ error: 'Goal unavailable; no settings were changed' }, result.error) : c.json(result.value);
    } catch { return c.json({ error: 'Goal unavailable; no settings were changed' }, 409); }
  }));
}
