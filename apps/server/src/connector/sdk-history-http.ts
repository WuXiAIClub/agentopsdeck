import type { Hono } from 'hono';
import { sessionRuntimeId } from '@agentopsdeck/shared';
import { clampMessageLimit } from '../messages/history-page.js';
import { createConditionalHistory } from '../messages/conditional-history.js';
import { ReadRequestError, type AsyncSdkHistory } from './async-sdk-history.js';

export type SdkHistoryHttp = { history: Pick<AsyncSdkHistory, 'page' | 'message'> };
/** Register after protocol/node guards, before legacy synchronous authority.
 * ETags and deltas are computed only after the final worker delivery check. */
export function registerSdkHistoryHttp(app: Hono, base: string, deps: SdkHistoryHttp) {
  const conditional = createConditionalHistory();
  for (const detail of [false, true]) app.get(`${base}/messages${detail ? '/:messageId' : ''}`, async (c, next) => {
    const key = c.req.param('sessionKey')!, runtime = sessionRuntimeId(key);
    if (runtime !== 'claude-code' && runtime !== 'ghcp') return next();
    c.header('Cache-Control', 'no-store');
    if (c.req.header('x-agentopsdeck-execution-grant') !== undefined) return c.json({ error: 'History requires owner authority' }, 403);
    const authorization = c.req.header('authorization') ?? '';
    if (!authorization.trim()) return c.json({ error: 'unauthorized' }, 401);
    const before = c.req.query('before'), messageId = c.req.param('messageId');
    if (detail ? !messageId || messageId.length > 4096 : before !== undefined && (!before.length || before.length > 4096)) {
      return c.json({ error: detail ? 'Invalid message id' : 'Invalid history anchor' }, 400);
    }
    try {
      const scope = { runtime, key, authorization };
      const result = detail ? await deps.history.message({ ...scope, messageId: messageId! }, c.req.raw)
        : await deps.history.page({ ...scope, limit: Math.min(200, clampMessageLimit(c.req.query('limit'))), ...(before === undefined ? {} : { before }) }, c.req.raw);
      if ('error' in result) return c.json({ error: result.error === 409 ? 'History anchor or reader unavailable; refresh history'
        : result.error === 404 ? 'session or message not found' : 'History authority unavailable' }, result.error);
      return 'messages' in result.body ? conditional(c, result.body) : c.json(result.body);
    } catch (error) { return c.json({ error: 'SDK history unavailable' }, error instanceof ReadRequestError ? error.status : 503); }
  });
}
