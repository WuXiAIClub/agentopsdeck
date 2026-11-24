import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { RESEARCH_READING_SOURCES, researchQuery, type ResearchReadingRange, type ResearchReadingSelection } from '@agentopsdeck/shared';
import type { HubPrincipal } from '../hub/identity.js';
import type { AuthRouteAuditStore } from '../auth/route-persistence.js';
import type { HubAdministrativeServices } from '../hub/administrative-route-services.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { pinOriginalRequestScope } from '../hub/original-request-scope.js';
import { ResearchWork } from '../hub/research-execution.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ResearchError, WorkspaceResearch, type ResearchConfig } from '../hub/workspace-research.js';
import { readJsonBody } from '../utils/http-body.js';
import { WorkspaceSynthesis } from '../hub/workspace-synthesis.js';
import { WorkspaceReader } from '../hub/workspace-reader.js';
import { WorkspaceArticleSnapshots } from '../hub/workspace-article-snapshots.js';
import { validStandaloneModel, type ModelCatalogOptions } from '../hub/standalone-model-catalog.js';
import { legacyWorkspaceToolDependencies, validateWorkspaceToolDependencies, type WorkspaceToolRouteDependencies } from './hub-workspace-tool-dependencies.js';

export function registerHubResearchRoutes(app: Hono, deps: WorkspaceToolRouteDependencies<ReturnType<HubAdministrativeServices['createWorkspaceResearchAccess']>> & {
  config?: ResearchConfig | undefined; service?: WorkspaceResearch; synthesis?: WorkspaceSynthesis; reader?: WorkspaceReader; articles?: WorkspaceArticleSnapshots; modelCatalog?: ModelCatalogOptions;
  diagnostics?: PerformanceDiagnostics }) {
  validateWorkspaceToolDependencies(deps);
  const legacy = () => legacyWorkspaceToolDependencies(deps);
  const service = deps.service ?? new WorkspaceResearch(deps.config), base = '/api/hub/v1/workspace/research';
  const synthesis = deps.synthesis ?? new WorkspaceSynthesis(deps.config?.synthesis, fetch, Date.now, 45_000, deps.modelCatalog);
  const aiEnabled = (user: string) => service.synthesisEnabled(user) && synthesis.enabled(user);
  const reader = deps.reader ?? new WorkspaceReader(deps.config?.reader);
  const readerEnabled = (user: string) => service.readerEnabled(user) && reader.enabled(user);
  const articles = deps.articles ?? new WorkspaceArticleSnapshots();
  const readingEnabled = (user: string) => readerEnabled(user) && aiEnabled(user);
  const work = new ResearchWork();
  const scopes = new WeakMap<Context, { principal: HubPrincipal; check: () => void | Promise<void>; current?: () => void }>();
  let closed = false;
  const scope = (c: Context) => {
    const value = scopes.get(c);
    if (closed || !value || c.req.raw.signal.aborted) throw new HTTPException(503);
    return value;
  };
  const audit = async (record: Parameters<AuthRouteAuditStore['append']>[0]) => {
    try { await (deps.access?.audit ?? legacy().audit).append(record); }
    catch { throw new HTTPException(503, { res: Response.json({ error: 'research_unavailable' }, { status: 503 }) }); }
  };
  app.use(`${base}/*`, (c, next) => work.track(async () => {
    c.header('Cache-Control', 'no-store');
    const trace = guardedTrace(deps.diagnostics ?? performanceDiagnostics, 'hub-workspace-research'); trace.add('admitted', 1);
    try {
      if (closed) throw new HTTPException(503);
      if (deps.access) {
        const context = await deps.access.requests.begin(c.req.raw);
        if (closed || c.req.raw.signal.aborted) throw new HTTPException(503);
        // The async route bypasses the legacy parent scope check. Authenticate
        // first, reject stale browser correlation before any provider/body work,
        // and pin only the server snapshot (never the public header).
        const expectedScope = c.req.header('x-agentopsdeck-recovery-scope');
        if (expectedScope !== undefined && expectedScope !== context.recoveryScope) throw new HubMemberRequestError(409);
        pinOriginalRequestScope(c.req.raw, context.recoveryScope);
        scopes.set(c, { principal: context.principal, check: async () => {
          try { await context.check(); }
          catch (error) {
            const status = error instanceof HubMemberRequestError && error.status !== 499 ? error.status : 503;
            throw new HTTPException(status, { res: Response.json({ error: 'research_unavailable' }, { status }) });
          }
        } });
      } else {
        const principal = legacy().principal(c);
        scopes.set(c, { principal, check: () => {
          const current = legacy().principal(c);
          if (current.userId !== principal.userId || current.admin !== principal.admin) throw new HTTPException(401);
        } });
      }
      await next();
      await scope(c).check();
      if (c.res.status < 400) {
        scope(c).current?.(); // No await between final snapshot check and delivery.
      }
    } catch (error) {
      // next() may already have finalized c.res. Hono ignores a returned
      // response in that case; explicitly replace it to deny stale delivery.
      if (error instanceof HubMemberRequestError) { c.res = c.json({ error: 'research_unavailable' }, error.status === 499 ? 503 : error.status); return c.res; }
      if (error instanceof ResearchError) { c.res = c.json({ error: error.code }, error.status); return c.res; }
      if (error instanceof HTTPException) {
        // Revocation/cancellation may happen after next() finalized a private
        // result. Replace it explicitly, without forwarding exception bodies.
        let status: HTTPException['status'] = 503;
        try { const candidate = error.status;
          if (Number.isInteger(candidate) && candidate >= 400 && candidate <= 599) status = candidate;
        } catch { /* An unclassifiable failure is unavailable, never success. */ }
        c.res = c.json({ error: 'research_unavailable' }, status); return c.res;
      }
      throw error;
    } finally { scopes.delete(c); trace.add('settled', 1); trace.finish(c.res.status >= 400); }
  }));
  const authorize = (c: Context, enabled: (user: string) => boolean) => Object.assign(async () => {
    try { const context = scope(c); await context.check(); return !closed && !c.req.raw.signal.aborted && enabled(context.principal.userId); }
    catch { return false; }
  }, { current: () => {
    try { const context = scope(c); context.current?.(); return enabled(context.principal.userId); }
    catch { return false; }
  } });
  app.get(`${base}/config`, async c => { c.header('Cache-Control', 'no-store'); const user = scope(c).principal.userId;
    const target = aiEnabled(user) ? await synthesis.catalog(user) : undefined;
    await scope(c).check();
    return c.json({ enabled: service.enabled(user), synthesisEnabled: aiEnabled(user),
      ...(aiEnabled(user) ? { synthesisTarget: target } : {}),
      ...(readingEnabled(user) ? { articleSynthesisEnabled: true, multiArticleSynthesisEnabled: true } : {}),
      ...(readerEnabled(user) ? { readerEnabled: true, readerTarget: reader.target(user), readerOrigins: reader.origins(user) } : {}) }); });
  app.post(`${base}/search`, async c => {
    c.header('Cache-Control', 'no-store'); c.header('X-Content-Type-Options', 'nosniff');
    const actor = scope(c).principal;
    const authorized = authorize(c, user => service.enabled(user));
    try {
      if (!service.enabled(actor.userId)) throw new ResearchError(403, 'research_unavailable');
      if (c.req.url.includes('?')) throw new ResearchError(400, 'invalid_query');
      const body = await readJsonBody(c.req.raw, 4096);
      if (!await authorized()) throw new ResearchError(401, 'authorization_changed');
      const query = body && typeof body === 'object' && Object.keys(body).length === 1 ? researchQuery((body as { query?: unknown }).query) : undefined;
      if (!query) throw new ResearchError(400, 'invalid_query');
      articles.drop(actor.userId);
      const result = await service.search(actor.userId, query, c.req.raw.signal, authorized);
      if (!await authorized()) throw new ResearchError(401, 'authorization_changed');
      if (aiEnabled(actor.userId) || readerEnabled(actor.userId)) scope(c).current = () => { service.snapshot(actor.userId, result.searchId); };
      await audit({ event: 'api_authz', outcome: 'success', userId: actor.userId, reason: 'workspace_research_search_completed' });
      return c.json(result);
    } catch (error) {
      if (!(error instanceof ResearchError)) throw error;
      await audit({ event: 'api_authz', outcome: error.status === 429 ? 'throttled' : 'failure', userId: actor.userId,
        reason: `workspace_research_${error.code}` });
      if (error.status === 429) c.header('Retry-After', '60');
      return c.json({ error: error.code }, error.status);
    }
  });
  app.post(`${base}/synthesize`, async c => {
    c.header('Cache-Control', 'no-store'); c.header('X-Content-Type-Options', 'nosniff');
    const actor = scope(c).principal;
    const authorized = authorize(c, aiEnabled);
    try {
      if (!aiEnabled(actor.userId)) throw new ResearchError(403, 'synthesis_unavailable');
      if (c.req.url.includes('?')) throw new ResearchError(400, 'invalid_sources');
      const body = await readJsonBody(c.req.raw, 4096);
      if (!await authorized()) throw new ResearchError(401, 'authorization_changed');
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ResearchError(400, 'invalid_sources');
      const data = body as Record<string, unknown>;
      if (Object.keys(data).length !== (data.model === undefined ? 3 : 4)
        || Object.keys(data).some(key => !['consent', 'searchId', 'sourceIds', 'model'].includes(key))
        || (data.model !== undefined && !validStandaloneModel(data.model))
        || data.consent !== true || typeof data.searchId !== 'string' || data.searchId.length !== 36
        || !Array.isArray(data.sourceIds) || data.sourceIds.length > 8 || data.sourceIds.some(id => typeof id !== 'string' || !/^S[1-8]$/.test(id)))
        throw new ResearchError(400, 'invalid_sources');
      const snapshot = service.snapshot(actor.userId, data.searchId);
      scope(c).current = () => { service.snapshot(actor.userId, data.searchId as string); };
      const result = await synthesis.synthesize(actor.userId, snapshot, data.sourceIds, c.req.raw.signal, authorized, undefined, data.model as string | undefined);
      if (!await authorized()) throw new ResearchError(401, 'authorization_changed');
      await audit({ event: 'api_authz', outcome: 'success', userId: actor.userId, reason: 'workspace_research_synthesis_completed' });
      return c.json(result);
    } catch (error) {
      if (!(error instanceof ResearchError)) throw error;
      await audit({ event: 'api_authz', outcome: error.status === 429 ? 'throttled' : 'failure', userId: actor.userId, reason: `workspace_research_${error.code}` });
      if (error.status === 429) c.header('Retry-After', '60');
      return c.json({ error: error.code }, error.status);
    }
  });
  app.post(`${base}/read`, async c => {
    c.header('Cache-Control', 'no-store'); c.header('X-Content-Type-Options', 'nosniff');
    const actor = scope(c).principal;
    const authorized = authorize(c, readerEnabled);
    try {
      if (!readerEnabled(actor.userId)) throw new ResearchError(403, 'reader_unavailable');
      if (c.req.url.includes('?')) throw new ResearchError(400, 'invalid_sources');
      const body = await readJsonBody(c.req.raw, 4096);
      if (!await authorized()) throw new ResearchError(401, 'authorization_changed');
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ResearchError(400, 'invalid_sources');
      const data = body as Record<string, unknown>;
      if (Object.keys(data).length !== (data.retain === true ? 4 : 3) || Object.keys(data).some(key => !['consent', 'searchId', 'sourceId', 'retain'].includes(key))
        || (data.retain !== undefined && data.retain !== true) || data.consent !== true || typeof data.searchId !== 'string' || data.searchId.length !== 36
        || typeof data.sourceId !== 'string' || data.sourceId.length !== 2 || !/^S[1-8]$/.test(data.sourceId)) throw new ResearchError(400, 'invalid_sources');
      const snapshot = service.snapshot(actor.userId, data.searchId);
      scope(c).current = () => { service.snapshot(actor.userId, data.searchId as string); };
      const stillAuthorized = async () => { if (!await authorized()) return false; try { service.snapshot(actor.userId, data.searchId as string); return true; } catch { return false; } };
      const result = await reader.read(actor.userId, snapshot, data.sourceId, c.req.raw.signal, Object.assign(stillAuthorized, { current: authorized.current }));
      if (!await stillAuthorized()) throw new ResearchError(401, 'authorization_changed');
      const saved = readingEnabled(actor.userId) ? articles.save(actor.userId, snapshot, result, data.retain === true) : result;
      if (saved.articleId) scope(c).current = () => { articles.assertCurrent(actor.userId, service.snapshot(actor.userId, data.searchId as string), saved.articleId!); };
      await audit({ event: 'api_authz', outcome: 'success', userId: actor.userId, reason: 'workspace_research_read_completed' });
      return c.json(saved);
    } catch (error) {
      if (!(error instanceof ResearchError)) throw error;
      await audit({ event: 'api_authz', outcome: error.status === 429 ? 'throttled' : 'failure', userId: actor.userId, reason: `workspace_research_${error.code}` });
      if (error.status === 429) c.header('Retry-After', '60');
      return c.json({ error: error.code }, error.status);
    }
  });
  app.post(`${base}/read/synthesize`, async c => {
    c.header('Cache-Control', 'no-store'); c.header('X-Content-Type-Options', 'nosniff');
    const actor = scope(c).principal;
    const authorized = authorize(c, readingEnabled);
    try {
      if (!readingEnabled(actor.userId)) throw new ResearchError(403, 'synthesis_unavailable');
      if (c.req.url.includes('?')) throw new ResearchError(400, 'invalid_article_selection');
      const body = await readJsonBody(c.req.raw, 4096);
      if (!await authorized()) throw new ResearchError(401, 'authorization_changed');
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ResearchError(400, 'invalid_article_selection');
      const data = body as Record<string, unknown>;
      if (data.consent !== true || typeof data.searchId !== 'string' || data.searchId.length !== 36
        || typeof data.articleId !== 'string' || !/^[a-f0-9-]{36}$/.test(data.articleId)
        || (data.mode !== 'full' && data.mode !== 'selection')
        || Object.keys(data).length !== (data.mode === 'full' ? 4 : 5) + (data.model === undefined ? 0 : 1)
        || Object.keys(data).some(key => !['searchId', 'articleId', 'mode', 'range', 'consent', 'model'].includes(key))
        || (data.model !== undefined && !validStandaloneModel(data.model))
        || (data.mode === 'full' && data.range !== undefined)) throw new ResearchError(400, 'invalid_article_selection');
      if (data.mode === 'selection' && (!data.range || typeof data.range !== 'object' || Array.isArray(data.range)
        || Object.keys(data.range).length !== 2 || !('start' in data.range) || !('end' in data.range))) throw new ResearchError(400, 'invalid_article_selection');
      const snapshot = service.snapshot(actor.userId, data.searchId);
      const input = articles.resolve(actor.userId, snapshot, data.articleId, data.mode, data.range as ResearchReadingRange | undefined);
      scope(c).current = () => { articles.assertCurrent(actor.userId, service.snapshot(actor.userId, data.searchId as string), data.articleId as string); };
      const stillAuthorized = async () => {
        if (!await authorized()) return false;
        try { articles.assertCurrent(actor.userId, service.snapshot(actor.userId, data.searchId as string), data.articleId as string); return true; } catch { return false; }
      };
      const result = await synthesis.synthesize(actor.userId, snapshot, [input.evidence.sourceId], c.req.raw.signal, Object.assign(stillAuthorized, { current: authorized.current }), input, data.model as string | undefined);
      if (!await stillAuthorized()) throw new ResearchError(401, 'authorization_changed');
      await audit({ event: 'api_authz', outcome: 'success', userId: actor.userId, reason: 'workspace_research_article_synthesis_completed' });
      return c.json({ ...result, evidence: input.evidence });
    } catch (error) {
      if (!(error instanceof ResearchError)) throw error;
      await audit({ event: 'api_authz', outcome: error.status === 429 ? 'throttled' : 'failure', userId: actor.userId, reason: `workspace_research_${error.code}` });
      if (error.status === 429) c.header('Retry-After', '60');
      return c.json({ error: error.code }, error.status);
    }
  });
  app.post(`${base}/read/synthesize-many`, async c => {
    c.header('Cache-Control', 'no-store'); c.header('X-Content-Type-Options', 'nosniff');
    const actor = scope(c).principal;
    const authorized = authorize(c, readingEnabled);
    try {
      if (!readingEnabled(actor.userId)) throw new ResearchError(403, 'synthesis_unavailable');
      if (c.req.url.includes('?')) throw new ResearchError(400, 'invalid_article_selection');
      const body = await readJsonBody(c.req.raw, 4096);
      if (!await authorized()) throw new ResearchError(401, 'authorization_changed');
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ResearchError(400, 'invalid_article_selection');
      const data = body as Record<string, unknown>;
      if (Object.keys(data).length !== (data.model === undefined ? 3 : 4)
        || Object.keys(data).some(key => !['consent', 'searchId', 'selections', 'model'].includes(key))
        || (data.model !== undefined && !validStandaloneModel(data.model))
        || data.consent !== true || typeof data.searchId !== 'string' || data.searchId.length !== 36
        || !Array.isArray(data.selections) || data.selections.length < 2 || data.selections.length > RESEARCH_READING_SOURCES)
        throw new ResearchError(400, 'invalid_article_selection');
      for (const value of data.selections) {
        if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.articleId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.articleId)
          || !['full', 'selection'].includes(value.mode) || Object.keys(value).length !== (value.mode === 'full' ? 2 : 3)
          || Object.keys(value).some(key => !['articleId', 'mode', 'range'].includes(key))
          || (value.mode === 'full' && value.range !== undefined)
          || (value.mode === 'selection' && (!value.range || typeof value.range !== 'object' || Array.isArray(value.range)
            || Object.keys(value.range).length !== 2 || !('start' in value.range) || !('end' in value.range))))
          throw new ResearchError(400, 'invalid_article_selection');
      }
      const selections = data.selections as ResearchReadingSelection[];
      const snapshot = service.snapshot(actor.userId, data.searchId);
      const inputs = selections.map(value => articles.resolve(actor.userId, snapshot, value.articleId, value.mode, value.range));
      scope(c).current = () => { for (const value of selections) articles.assertCurrent(actor.userId, service.snapshot(actor.userId, data.searchId as string), value.articleId); };
      const stillAuthorized = async () => {
        if (!await authorized()) return false;
        try { for (const value of selections) articles.assertCurrent(actor.userId, service.snapshot(actor.userId, data.searchId as string), value.articleId); return true; }
        catch { return false; }
      };
      const answer = await synthesis.synthesize(actor.userId, snapshot, inputs.map(input => input.evidence.sourceId), c.req.raw.signal, Object.assign(stillAuthorized, { current: authorized.current }), inputs, data.model as string | undefined);
      if (!await stillAuthorized()) throw new ResearchError(401, 'authorization_changed');
      await audit({ event: 'api_authz', outcome: 'success', userId: actor.userId, reason: 'workspace_research_multi_article_completed' });
      return c.json({ ...answer, evidence: inputs.map(input => input.evidence) });
    } catch (error) {
      if (!(error instanceof ResearchError)) throw error;
      await audit({ event: 'api_authz', outcome: error.status === 429 ? 'throttled' : 'failure', userId: actor.userId, reason: `workspace_research_${error.code}` });
      if (error.status === 429) c.header('Retry-After', '60');
      return c.json({ error: error.code }, error.status);
    }
  });
  const executors = createIndependentDrain([() => service.close(), () => synthesis.close(), () => reader.close(),
    () => articles.close()], 'hub-route-drain', deps.diagnostics ?? performanceDiagnostics);
  const drain = createIndependentDrain([async () => {
    await executors(); await work.drain(); await deps.access?.close();
  }], 'hub-route-drain', deps.diagnostics ?? performanceDiagnostics);
  return { close: () => { closed = true; return drain(); } };
}
