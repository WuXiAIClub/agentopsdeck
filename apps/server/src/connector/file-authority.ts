import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ConnectorPrincipal, ConnectorScope } from '../auth/connector-token.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { createTaskDrain } from '../lifecycle/task-drain.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';

type Awaitable<T> = T | PromiseLike<T>;
export function fileAuthorityPending<T>(value: Awaitable<T>): value is PromiseLike<T> {
  return value != null && (typeof value === 'object' || typeof value === 'function') && 'then' in value;
}
/** Current token authority, not a cached read-delivery proof. Original file
 * effects stay in their original executor; no SQL or bearer leaves the worker. */
export type ConnectorFileAuthority = {
  authenticate(request: Request): Awaitable<ConnectorPrincipal | undefined>;
  requireScope(request: Request, scope: ConnectorScope): Awaitable<ConnectorPrincipal | undefined>;
  hasScope(tokenId: string, scope: ConnectorScope): Awaitable<boolean>;
};

export function workerConnectorFileAuthority(owner: Pick<AsyncConnectorOwner, 'command'>): ConnectorFileAuthority {
  // Capture before the first await. A mutable Request must never lend a later
  // caller's credentials to an already admitted file operation.
  const evidence = new WeakMap<Request, string>();
  const authenticate = async (request: Request) => {
    if (!evidence.has(request)) evidence.set(request, request.headers.get('authorization') ?? '');
    return await owner.command('tokenAuthenticate', { authorization: evidence.get(request)! }) ?? undefined;
  };
  return {
    authenticate,
    async requireScope(request, scope) {
      const principal = await authenticate(request);
      return principal?.scopes.includes(scope) ? principal : undefined;
    },
    hasScope: (tokenId, scope) => owner.command('tokenHasScope', { tokenId, scope }),
  };
}

/** Own the original handler, including rename and its finally cleanup. Client
 * abort is advisory, not physical settlement; close never races a write with a
 * synthetic success or timeout and never replays unknown results. */
export function registerFileRequestOwnership(app: Hono, base: string,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics,
  operation: 'connector-machine-files' | 'connector-machine-services' = 'connector-machine-files') {
  const tasks = createTaskDrain();
  let closed = false;
  const check = (request?: Request) => {
    if (closed) throw new HTTPException(503);
    if (request?.signal.aborted) throw new HTTPException(408);
  };
  app.use(`${base}/*`, async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (closed) return c.json({ error: 'File service is closing' }, 503);
    try {
      await tasks.run(async () => {
        const trace = guardedTrace(diagnostics, operation);
        const warning = setTimeout(() => trace.reportPending({ pending: 1 }), 30_000); warning.unref();
        let failed = true;
        try { check(c.req.raw); await next(); check(c.req.raw); failed = c.res.status >= 400; }
        finally { clearTimeout(warning); trace.add('settled', 1); trace.finish(failed); }
      });
    } catch (error) {
      // A late download response has already installed headers. Do not retain
      // stale length/disposition when replacing it with a closed/failed result.
      c.header('Content-Length', undefined); c.header('Content-Disposition', undefined);
      c.res = c.json({ error: 'File operation not confirmed; reload before retrying.' },
        error instanceof HTTPException ? error.status : 503);
    }
  });
  return { check, close() { closed = true; return tasks.close(); } };
}
