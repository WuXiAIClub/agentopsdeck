import type { Hono } from 'hono';
import { HISTORY_ASYNC_HEADER, historyPendingBody, sessionRuntimeId } from '@agentopsdeck/shared';
import type { AsyncHermesReads } from './async-hermes-reads.js';
import { ReadRequestError } from '../lifecycle/read-request-owner.js';
import { clampMessageLimit } from '../messages/history-page.js';
import { createConditionalHistory } from '../messages/conditional-history.js';

export type HermesReadsHttp = { reads: Pick<AsyncHermesReads, 'state' | 'page' | 'message'> };
/** Must follow protocol/node gates and precede legacy synchronous authority. */
export function registerHermesReadsHttp(app: Hono, path: string, deps: HermesReadsHttp) {
  const conditional = createConditionalHistory();
  for (const kind of ['state', 'page', 'message'] as const) app.get(`${path}/${kind === 'state' ? 'state' : kind === 'page' ? 'messages' : 'messages/:messageId'}`, async (c, next) => {
    const key = c.req.param('sessionKey')!;
    if (sessionRuntimeId(key) !== 'hermes') return next();
    c.header('Cache-Control', 'no-store');
    if (c.req.header('x-agentopsdeck-execution-grant') !== undefined) return c.json({ error: 'Hermes reads require owner authority' }, 403);
    const authorization = c.req.header('authorization') ?? '';
    if (!authorization.trim()) return c.json({ error: 'unauthorized' }, 401);
    const before = c.req.query('before'), messageId = c.req.param('messageId');
    if (kind === 'page' && before !== undefined && (!before.length || before.length > 4096)
      || kind === 'message' && (!messageId || messageId.length > 4096)) return c.json({ error: 'Invalid history selection' }, 400);
    try {
      const scope = { key, authorization };
      const result = kind === 'state' ? await deps.reads.state(scope, c.req.raw) : kind === 'message'
        ? await deps.reads.message({ ...scope, messageId: messageId! }, c.req.raw)
        : await deps.reads.page({ ...scope, limit: clampMessageLimit(c.req.query('limit')), ...(before === undefined ? {} : { before }),
          asynchronous: c.req.header(HISTORY_ASYNC_HEADER) === '1' }, c.req.raw);
      if ('error' in result) return c.json({ error: result.error === 404 ? 'session or message not found'
        : result.error === 409 ? 'History changed; refresh history' : 'Hermes read unavailable' }, result.error);
      if ('pending' in result) { c.header('Retry-After', '1'); return c.json(historyPendingBody(), 202); }
      return kind === 'page' ? conditional(c, result.body as Parameters<typeof conditional>[1]) : c.json(result.body);
    } catch (error) { return c.json({ error: 'Hermes read unavailable' }, error instanceof ReadRequestError ? error.status : 503); }
  });
}
