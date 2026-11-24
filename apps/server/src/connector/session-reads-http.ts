import type { Hono } from 'hono';
import { ReadRequestError } from '../lifecycle/read-request-owner.js';
import { SessionReadError, type AsyncSessionReads } from './async-session-reads.js';

export type SessionReadsHttp = { reads: Pick<AsyncSessionReads, 'directory' | 'state'> };
/** After protocol/node gates; selecting this port never falls back to sync auth. */
export function registerSessionReadsHttp(app: Hono, path: string, deps: SessionReadsHttp) {
  for (const kind of ['directory', 'state'] as const) app.get(`${path}/${kind}`, async c => {
    c.header('Cache-Control', 'no-store');
    const authorization = c.req.header('authorization') ?? '';
    if (!authorization.trim()) return c.json({ error: 'missing sessions:read scope' }, 403);
    try {
      let body;
      if (kind === 'directory') {
        body = await deps.reads.directory(authorization, new URL(c.req.url).searchParams, c.req.raw);
      } else body = await deps.reads.state(authorization, {
        includeHidden: ['1', 'true'].includes(c.req.query('includeHidden') ?? ''),
        includeArchived: ['1', 'true'].includes(c.req.query('includeArchived') ?? ''),
      }, c.req.raw);
      return c.json(body);
    } catch (error) {
      const status = error instanceof ReadRequestError || error instanceof SessionReadError ? error.status : 503;
      return c.json({ error: status === 403 ? 'missing sessions:read scope' : status === 409 ? 'session authorization changed'
        : status === 400 ? 'Invalid session directory query' : status === 408 ? 'Request interrupted'
        : kind === 'directory' ? 'Session directory unavailable' : 'Session snapshot unavailable' }, status);
    }
  });
}
