import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { readJsonBody } from '../utils/http-body.js';
import { runNativeOperation } from './native-operation.js';
import { validAutomationConfigurationInput } from './connector-automation-domain.js';
import type { AsyncAutomationConfiguration } from './async-automation-configuration.js';
import { automationIdentity } from '@agentopsdeck/shared';

/** Existing automation configuration wire protocol. No trigger, replay, native
 * completion or dispatch endpoint is exposed. Raw credentials reach the owner. */
export type AsyncAutomationHttp = {
  configuration: Pick<AsyncAutomationConfiguration, 'authority' | 'view' | 'original' | 'configure'>;
  timeoutMs?: number;
};
export function registerAsyncConnectorAutomation(app: Hono, base: string, deps: AsyncAutomationHttp) {
  const timeoutMs = deps.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new RangeError('Finite automation HTTP deadline required');
  let readers = 0;
  const safe = (handle: (c: Context, authorization: string) => Promise<Response>) => async (c: Context) => {
    c.header('Cache-Control', 'no-store');
    if (c.req.header('x-agentopsdeck-execution-grant') !== undefined) return c.json({ error: 'automation_conflict' }, 403);
    const authorization = c.req.header('authorization') ?? '';
    if (!authorization.trim()) return c.json({ error: 'unauthorized' }, 401);
    try { return await handle(c, authorization); }
    catch (error) {
      if (error instanceof HTTPException) return error.getResponse();
      return c.json({ error: 'automation_unavailable' }, 503);
    }
  };
  const wait = (c: Context) => ({ timeoutMs, signal: c.req.raw.signal });
  const error = (c: Context, status: 401 | 403 | 404 | 409 | 503) => c.json({ error: status === 503 ? 'automation_unavailable' : 'automation_conflict' }, status);
  app.get(base, safe(async (c, authorization) => {
    const r = await runNativeOperation(() => deps.configuration.view({ authorization }), wait(c));
    return r.ok ? c.json(r.value) : error(c, r.error);
  }));
  app.get(`${base}/configuration/:requestId`, safe(async (c, authorization) => {
    const requestId = c.req.param('requestId')!;
    if (!automationIdentity(requestId)) return c.json({ error: 'automation_conflict' }, 400);
    const r = await runNativeOperation(() => deps.configuration.original({ authorization, requestId }), wait(c));
    return !r.ok ? error(c, r.error) : r.value ? c.json(r.value) : c.json({ error: 'not_found' }, 404);
  }));
  app.post(`${base}/configuration/:requestId`, safe(async (c, authorization) => {
    const requestId = c.req.param('requestId')!;
    if (!automationIdentity(requestId)) return c.json({ error: 'automation_conflict' }, 400);
    const authority = await runNativeOperation(() => deps.configuration.authority({ authorization }), wait(c));
    if (!authority.ok) return error(c, authority.error);
    if (readers >= 2) return c.json({ error: 'automation_unavailable' }, 503);
    readers++;
    try {
      const configuration = await readJsonBody(c.req.raw, 48 * 1024, timeoutMs);
      if (!validAutomationConfigurationInput(configuration)) return c.json({ error: 'automation_conflict' }, 400);
      const r = await runNativeOperation(() => deps.configuration.configure({ authorization, requestId, configuration }), wait(c));
      return r.ok ? c.json(r.value) : error(c, r.error);
    } finally { readers--; }
  }));
}
