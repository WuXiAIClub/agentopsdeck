import { sessionRuntimeId } from '@agentopsdeck/shared';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { readJsonBody } from '../utils/http-body.js';
import { runNativeOperation } from './native-operation.js';
import type { SdkAgentId } from './sdk-execution-journal.js';

export type SdkRecoveryHttp = {
  ready: (runtime: SdkAgentId) => boolean;
  recover: (runtime: SdkAgentId, key: string, expectedRunId: string, authorization: string, signal: AbortSignal) => Promise<{ error: 401 | 403 | 404 | 409 } | { requested: true }>;
  timeoutMs?: number;
  diagnostics?: PerformanceDiagnostics;
};

export function registerSdkRecoveryHttp(app: Hono, path: string, deps: SdkRecoveryHttp): void {
  const timeoutMs = deps.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new RangeError('Finite SDK recovery deadline required');
  const scope = (c: Context) => {
    const key = c.req.param('sessionKey')!, runtime = sessionRuntimeId(key);
    return runtime === 'claude-code' || runtime === 'ghcp' || runtime === 'antigravity' ? { runtime, key } : undefined;
  };
  const authority = (c: Context) => {
    const authorization = c.req.raw.headers.get('authorization') ?? '';
    if (!authorization.trim()) throw new HTTPException(401);
    if (c.req.header('x-agentopsdeck-execution-grant') !== undefined) throw new HTTPException(403);
    return authorization;
  };
  const wait = <T>(c: Context, work: () => Promise<T>) => runNativeOperation(work, { timeoutMs, signal: c.req.raw.signal });

  app.post(`${path}/recovery`, async (c, next) => {
    const current = scope(c); if (!current) return next();
    c.header('Cache-Control', 'no-store');
    const trace = guardedTrace(deps.diagnostics ?? performanceDiagnostics, 'sdk-recovery-http');
    let unavailable = true;
    try {
      trace.add('step', 1);
      const authorization = authority(c);
      const body = await readJsonBody(c.req.raw, 1024, timeoutMs);
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1
        || !('expectedRunId' in body) || typeof body.expectedRunId !== 'string' || !body.expectedRunId.length
        || body.expectedRunId.length > 512 || /[\x00-\x1f\x7f]/.test(body.expectedRunId)) {
        return c.json({ error: 'Invalid execution identity' }, 400);
      }
      if (deps.ready(current.runtime) !== true) return c.json({ error: 'Agent is not ready; recovery unavailable' }, 409);
      trace.add('step', 2);
      const result = await wait(c, () => deps.recover(current.runtime, current.key, body.expectedRunId as string, authorization, c.req.raw.signal));
      unavailable = false;
      if ('error' in result) {
        return c.json({ error: result.error === 409 ? 'Execution changed or recovery unavailable; refresh session state'
          : result.error === 404 ? 'Session not found'
          : result.error === 403 ? 'Session recovery access denied' : 'unauthorized' }, result.error);
      }
      return c.json({ requested: true });
    } catch (error) {
      if (error instanceof HTTPException && error.status < 500) {
        return c.json({ error: error.status === 403 ? 'Session recovery access denied' : 'unauthorized' }, error.status);
      }
      return c.json({ error: 'Recovery request could not be confirmed; execution remains protected' }, 503);
    } finally { trace.finish(unavailable); }
  });
}
