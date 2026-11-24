import type { Context, Hono, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { readInteractionSubmission, sessionRuntimeId } from '@agentopsdeck/shared';
import type { AsyncCodexInteractions } from './async-codex-interactions.js';
import { interactionCapabilitiesFor } from './sdk-interaction.js';
import { readJsonBody } from '../utils/http-body.js';
import { runNativeOperation } from './native-operation.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

/** Same frontend protocol as the original interaction routes. Authentication is
 * raw evidence for the sole DB owner; HTTP cannot name an actor or native run. */
export type CodexInteractionsHttp = {
  interactions: Pick<AsyncCodexInteractions, 'observe' | 'mode' | 'answer'>;
  ready(): boolean;
  timeoutMs?: number;
  diagnostics?: PerformanceDiagnostics;
  requestInteractions?(c: Context): CodexInteractionsHttp['interactions'];
  authorization?(c: Context): string;
  around?(c: Context, work: () => Promise<Response>): Promise<Response>;
};
export function registerCodexInteractionsHttp(app: Hono, base: string, deps: CodexInteractionsHttp) {
  const timeoutMs = deps.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new RangeError('Finite interaction HTTP deadline required');
  let readers = 0;
  const owned = (handler: MiddlewareHandler): MiddlewareHandler => async (c, next) => {
    if (sessionRuntimeId(c.req.param('sessionKey') ?? '') !== 'codex') return next();
    if (!deps.around) return handler(c, next);
    return deps.around(c, async () => { const response = await handler(c, next); return response instanceof Response ? response : c.res; });
  };
  for (const [method, suffix, step] of [['get', 'interactions', 1], ['patch', 'interaction-mode', 2], ['post', 'interactions/:requestId/answer', 3]] as const) {
    app[method](`${base}/${suffix}`, owned(async (c, next) => {
      const key = c.req.param('sessionKey')!;
      if (sessionRuntimeId(key) !== 'codex') return next();
      c.header('Cache-Control', 'no-store');
      if (c.req.header('x-agentopsdeck-execution-grant') !== undefined) return c.json({ error: 'Interaction requires owner authority' }, 403);
      const authorization = deps.authorization ? deps.authorization(c) : c.req.header('authorization') ?? '';
      if (!authorization.trim()) return c.json({ error: 'unauthorized' }, 401);
      const trace = guardedTrace(deps.diagnostics ?? performanceDiagnostics, 'codex-dispatch');
      trace.add('step', 50 + step);
      let failed = true, reading = false;
      const wait = { timeoutMs, signal: c.req.raw.signal }, request = { key, authorization };
      try {
        const interactions = deps.requestInteractions?.(c) ?? deps.interactions;
        const observed = await runNativeOperation(() => interactions.observe(request), wait);
        if (!observed.ok) return c.json({ error: 'Interaction authority unavailable' }, observed.error);
        if (method === 'get') {
          failed = false;
          return c.json({ version: 1, ...observed.value, capabilities: deps.ready() === true
            ? interactionCapabilitiesFor('codex') : { version: 1, kinds: [], modes: ['automatic'] } });
        }
        if (readers >= 2) return c.json({ error: 'Interaction input capacity reached' }, 503);
        readers++; reading = true;
        const body = await readJsonBody(c.req.raw, method === 'patch' ? 128 : 40_000, timeoutMs);
        if (method === 'patch') {
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1
            || !('mode' in body) || body.mode !== 'automatic' && body.mode !== 'interactive') return c.json({ error: 'Invalid interaction mode' }, 400);
          if (deps.ready() !== true) return c.json({ error: 'Agent is not ready' }, 503);
          const mode = body.mode;
          const result = await runNativeOperation(() => interactions.mode({ ...request, mode, nativeReady: true }), wait);
          if (!result.ok) return c.json({ error: 'Interaction mode unavailable' }, result.error);
          failed = false; return c.json({ mode: result.value });
        }
        const submission = readInteractionSubmission(body), requestId = c.req.param('requestId')!;
        if (!submission || !requestId.trim() || requestId.length > 256) return c.json({ error: 'Invalid interaction answer' }, 400);
        const result = await runNativeOperation(() => interactions.answer({ ...request, requestId, submission }), wait);
        if (!result.ok) return c.json({ error: 'Interaction unavailable; no answer was resent' }, result.error);
        failed = false; return c.json(result.value);
      } catch (error) {
        if (error instanceof HTTPException) return error.getResponse();
        return c.json({ error: 'Interaction unavailable; read the original request, no answer was resent' }, 503);
      } finally { if (reading) readers--; trace.finish(failed); }
    }));
  }
}
