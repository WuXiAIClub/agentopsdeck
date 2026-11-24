import type { Hono, Context } from 'hono';
import type { ConnectorPrincipal, ConnectorScope } from '../auth/connector-token.js';
import type { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { IssueCardReader, IssueReadError } from '../hub/issue-card-reader.js';
import { IssueProviderAdapter, type IssueSource } from './issue-sources.js';
import { ReadRequestOwner, ReadRequestError, type ReadRequestContext } from '../lifecycle/read-request-owner.js';
type Awaitable<T> = T | PromiseLike<T>;
export type ConnectorIssueAuthority = {
  authenticate(request: Request): Awaitable<ConnectorPrincipal | undefined>;
  requireScope(request: Request, scope: ConnectorScope): Awaitable<ConnectorPrincipal | undefined>;
  hasScope(tokenId: string, scope: ConnectorScope): Awaitable<boolean>;
};
type Delivery = () => Response;
export function registerConnectorIssueRoutes(app: Hono, tokens: ConnectorIssueAuthority, sources: readonly IssueSource[] = [], fetcher: typeof fetch = fetch,
  options: { diagnostics?: PerformanceDiagnostics; requestWaitMs?: number; providerWaitMs?: number } = {}) {
  const reader = new IssueCardReader(new IssueProviderAdapter(sources, fetcher), async (owner, query) => {
    const source = sources.find(s => s.id === query.connection && s.project === query.project);
    const snapshot = source ? { epoch: `${owner}:${source.epoch}`, origin: source.origin, provider: source.provider } : undefined;
    return snapshot && await tokens.hasScope(owner, 'issues:read') === true ? snapshot : undefined;
  }, Date.now, options.providerWaitMs ?? 10_000);
  const reads = new ReadRequestOwner('system-read-wait', { diagnostics: options.diagnostics, waitMs: options.requestWaitMs });
  const cooldown = new Map<string, number>(), base = '/api/connector/v1/issues';
  function read(handler: (c: Context, tokenId: string, context: ReadRequestContext) => Awaitable<Delivery>) {
    return async (c: Context) => {
      c.header('Cache-Control', 'no-store');
      try {
        const result = await reads.run(c.req.raw, async context => {
          if (!(await context.stage(21, () => tokens.authenticate(c.req.raw))).value) return c.json({ error: 'unauthorized' }, 401);
          const actor = (await context.stage(22, () => tokens.requireScope(c.req.raw, 'issues:read'))).value;
          if (!actor) return c.json({ error: 'Issue access required' }, 403);
          const tokenId = actor.tokenId;
          const deliver = (await context.stage(24, () => handler(c, tokenId, context))).value;
          const current = (await context.stage(23, () => tokens.hasScope(tokenId, 'issues:read'))).value;
          if (current !== true) return c.json({ error: 'Issue access revoked' }, 403);
          context.check(); return deliver();
        });
        return result.value;
      } catch (error) {
        return c.json({ error: 'Issue read unavailable; refresh explicitly' }, error instanceof ReadRequestError ? error.status : 503);
      }
    };
  }
  app.get(`${base}/sources`, read(c => () => c.json({ readOnly: true,
    sources: sources.map(({ id, label, provider, origin, project, workItemPath }) => ({ id, label, provider, origin, project,
      kinds: provider === 'gitlab' && workItemPath ? ['issue', 'work_item'] : ['issue'] })) })));
  app.get(`${base}/:sourceId/items`, read(async (c, tokenId, context) => {
    const source = sources.find(s => s.id === c.req.param('sourceId')); if (!source) return () => c.json({ error: 'Source unavailable' }, 404);
    const sourceId = source.id, project = source.project;
    const values = c.req.queries(), kind = c.req.query('kind') ?? 'issue';
    if (!['issue', 'work_item'].includes(kind) || kind === 'work_item' && (source.provider !== 'gitlab' || !source.workItemPath)
      || Object.keys(values).some(k => !['state', 'cursor', 'kind'].includes(k)) || Object.values(values).some(v => v.length !== 1)
      || !['', 'open', 'closed', 'all'].includes(c.req.query('state') ?? '')
      || c.req.query('cursor') !== undefined && !/^[a-f0-9-]{36}$/.test(c.req.query('cursor')!)) return () => c.json({ error: 'Invalid issue query' }, 400);
    const remaining = Math.ceil(((cooldown.get(sourceId) ?? 0) - Date.now()) / 1000);
    if (remaining > 0) return () => { c.header('Retry-After', String(remaining)); return c.json({ error: 'Source rate limited', retryAfter: remaining }, 429); };
    if (reader.pendingFor(tokenId) || reader.pending >= 8) return () => c.json({ error: 'Issue read already active' }, 429);
    try {
      // The outer authority deadline is also a cancellation request to the
      // nested reader, not an acknowledgement that its provider has stopped.
      const request = new Request(c.req.raw, { signal: context.signal });
      const result = await reader.list(tokenId, { connection: sourceId, project, kind: kind as 'issue' | 'work_item', filter: c.req.query('state') ?? '', order: 'updated_desc', limit: 50 }, c.req.query('cursor'), request);
      context.check();
      return () => {
        context.check();
        if (result.retryAfter !== null) cooldown.set(sourceId, Date.now() + result.retryAfter * 1000);
        return c.json(result);
      };
    } catch (error) {
      context.check();
      if (error instanceof IssueReadError && error.message === 'busy') return () => c.json({ error: 'Issue read already active' }, 429);
      return () => c.json({ error: 'Issue read unavailable or cursor expired; refresh explicitly' }, 409);
    }
  }));
  // Preserve the old middleware's protected unknown-path/method boundary.
  app.all(`${base}/*`, read(async c => { const response = await c.notFound(); return () => response; }));
  let closing: Promise<void> | undefined;
  return { close(): Promise<void> { return closing ??= Promise.all([reads.close(), reader.close()]).then(() => undefined); } };
}
