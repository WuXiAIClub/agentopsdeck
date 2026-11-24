import type { Hono } from 'hono';
import { HISTORY_ASYNC_HEADER, historyPendingBody, sessionRuntimeId } from '@agentopsdeck/shared';
import type { AsyncRuntimeReads } from './async-runtime-reads.js';
import type { PublicReadRuntime } from './connector-runtime-read-domain.js';
import { ReadRequestError } from '../lifecycle/read-request-owner.js';
import { clampMessageLimit } from '../messages/history-page.js';
import { createConditionalHistory } from '../messages/conditional-history.js';
import { readJsonBody } from '../utils/http-body.js';

export type RuntimeReadsHttp = { reads: Pick<AsyncRuntimeReads, 'state' | 'page' | 'message'> & Partial<Pick<AsyncRuntimeReads, 'recheck'>> };
/** Original node/protocol gates run first; never fall through to synchronous
 * authority after selecting this application, including errors or timeouts. */
export function registerRuntimeReadsHttp(app: Hono, path: string, deps: RuntimeReadsHttp, runtime: PublicReadRuntime) {
  const conditional = createConditionalHistory();
  if (runtime === 'codex') app.post(`${path}/recovery`, async (c, next) => {
    const key = c.req.param('sessionKey')!;
    if (sessionRuntimeId(key) !== runtime) return next();
    c.header('Cache-Control', 'no-store');
    const body = await readJsonBody(c.req.raw, 1024);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1
      || !('expectedRunId' in body) || typeof body.expectedRunId !== 'string' || !body.expectedRunId.length
      || body.expectedRunId.length > 512 || /[\x00-\x1f\x7f]/.test(body.expectedRunId)) return c.json({ error: 'Invalid execution identity' }, 400);
    if (!deps.reads.recheck) return c.json({ error: 'Session recovery is unavailable on this Connector' }, 409);
    try {
      const result = await deps.reads.recheck({ key, authorization: c.req.header('authorization') ?? '', expectedRunId: body.expectedRunId }, c.req.raw);
      if ('error' in result) return c.json({ error: result.error === 409 ? 'Execution changed or recovery unavailable; refresh session state'
        : result.error === 403 ? 'Session recovery access denied' : 'Session not found' }, result.error);
      return c.json(result);
    } catch (error) {
      return c.json({ error: 'Recovery request could not be confirmed; execution remains protected' }, error instanceof ReadRequestError ? error.status : 503);
    }
  });
  for (const kind of ['state', 'page', 'message'] as const) app.get(`${path}/${kind === 'state' ? 'state' : kind === 'page' ? 'messages' : 'messages/:messageId'}`, async (c, next) => {
    const key = c.req.param('sessionKey')!;
    if (sessionRuntimeId(key) !== runtime) return next();
    c.header('Cache-Control', 'no-store');
    const authorization = c.req.header('authorization') ?? '';
    const before = c.req.query('before'), messageId = c.req.param('messageId');
    const unavailable = kind === 'state' ? 'Session state unavailable' : kind === 'page' ? 'Session history unavailable' : 'Tool detail snapshot unavailable';
    try {
      const scope = { key, authorization };
      const result = kind === 'state' ? await deps.reads.state(scope, c.req.raw) : kind === 'message'
        ? await deps.reads.message({ ...scope, messageId: messageId! }, c.req.raw)
        : await deps.reads.page({ ...scope, limit: clampMessageLimit(c.req.query('limit')), ...(before === undefined ? {} : { before }),
          asynchronous: c.req.header(HISTORY_ASYNC_HEADER) === '1' }, c.req.raw);
      if ('error' in result) return c.json({ error: result.error === 403 ? 'missing messages:read scope'
        : result.error === 400 ? 'Invalid history anchor'
        : result.error === 404 ? kind === 'message' ? 'message not found' : 'session not found'
        : result.error === 409 ? kind === 'page' ? 'History anchor unavailable; refresh history'
          : result.reason === 'source' ? 'Tool detail source changed; refresh history' : 'Tool detail projection changed; retry'
        : result.reason === 'history' ? 'Session history unavailable' : unavailable }, result.error);
      if ('pending' in result) { c.header('Retry-After', '1'); return c.json(historyPendingBody(), 202); }
      return kind === 'page' ? conditional(c, result.body as Parameters<typeof conditional>[1]) : c.json(result.body);
    } catch (error) { return c.json({ error: error instanceof ReadRequestError && error.status === 408 ? 'Request interrupted' : unavailable },
      error instanceof ReadRequestError ? error.status : 503); }
  });
}
