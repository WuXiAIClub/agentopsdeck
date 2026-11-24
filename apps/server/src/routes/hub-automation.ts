import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { automationIdentity, readAutomationRule, validAutomationConfigurationView,
  validAutomationConfigurationReceipt, type AutomationConfiguration, type AutomationConfigurationView } from '@agentopsdeck/shared';
import { ConnectorClientError } from '../hub/connector-client.js';
import { decodeHubSessionId } from '../hub/session-id.js';
import { readJsonBody } from '../utils/http-body.js';
import { legacyHubConnectionProxyDeps, resolveHubConnectionProxyClient, validateHubConnectionProxyRouteDeps,
  type HubConnectionProxyRouteDeps } from '../hub/connection-proxy-route-deps.js';
import { HubMemberRequestError } from '../hub/async-member-request.js';
import { HubRequestWork } from '../hub/async-request-work.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';

/** Owner-only config proxy. No shared grants, dispatch endpoint, completion
 * injection, automatic retries or credential exposure. Unknown POST outcomes
 * are queried using the exact original request, never replaced with a new one. */
export function registerHubAutomation(app: Hono, deps: HubConnectionProxyRouteDeps) {
  validateHubConnectionProxyRouteDeps(deps);
  const legacy = () => legacyHubConnectionProxyDeps(deps);
  const base = '/api/hub/v1/sessions/:sessionId/automation';
  const work = new HubRequestWork();
  const scope = async (c: Context) => {
    const decoded = decodeHubSessionId(c.req.param('sessionId')!);
    if (!decoded || !decoded.remoteSessionKey.startsWith('codex:')) throw new HTTPException(404);
    if (deps.access && !deps.asyncConnectorClient) throw new HTTPException(503);
    const access = deps.access ? await deps.access.begin(c.req.raw, decoded.connectionId) : undefined;
    work.check();
    const owner = (access ? access.principal : legacy().principal(c)).userId;
    const connection = access ? access.connection : legacy().hubStore.getConnection(decoded.connectionId, owner);
    const epoch = access ? undefined : legacy().hubStore.connectionAuthority(decoded.connectionId, owner);
    if (!connection?.nodeId || connection.status === 'disabled') throw new HTTPException(404);
    const check = async () => {
      work.check();
      if (access) await access.check();
      else {
        const current = legacy().hubStore.getConnection(decoded.connectionId, owner);
        if (legacy().principal(c).userId !== owner || !current || current.status === 'disabled'
          || current.nodeId !== connection.nodeId || legacy().hubStore.connectionAuthority(decoded.connectionId, owner) !== epoch) throw new HTTPException(403);
      }
      work.check();
      if (c.req.raw.signal.aborted) throw new HubMemberRequestError(499);
    };
    const client = await (async () => {
      try { return await resolveHubConnectionProxyClient(deps, c.req.raw, decoded.connectionId, owner); }
      catch (error) { await check(); throw error; }
    })();
    // Resolver waits can outlive the original owner or connection generation.
    // Reject before any upstream read or mutation, not just after its response.
    await check();
    const read = async (path: string, init?: RequestInit) => {
      try { return await client.jsonOriginal<unknown>(path, init); }
      catch (error) { await check(); throw error; }
    };
    const target = (value: { connectionId: string; runtime: string; sessionId: string }) => value.connectionId === connection.nodeId
      && value.runtime === 'codex' && value.sessionId === decoded.remoteSessionKey;
    const view = async () => {
      const v = await read('/automation', { signal: c.req.raw.signal }); await check();
      if (!validAutomationConfigurationView(v) || v.connectionId !== connection.nodeId) throw new HTTPException(502);
      return { ...v, sessionId: decoded.remoteSessionKey, rules: v.rules.filter(s => target(s.rule.target)) };
    };
    return { check, read, target, view };
  };
  const safe = (handler: (c: Context) => Promise<Response>) => async (c: Context) => {
    c.header('Cache-Control', 'no-store');
    const trace = guardedTrace(performanceDiagnostics, 'hub-request-authority'); trace.add('step', 87);
    try { const response = await work.run(() => handler(c)); trace.add('settled', 1); trace.finish(); return response; } catch (error) {
      trace.add('deferred', 1); trace.finish(true);
      if (error instanceof HubMemberRequestError) {
        if (error.status === 499) return Response.json({ error: 'automation_unavailable' }, {
          status: 499, headers: { 'Cache-Control': 'no-store' },
        });
        return c.json({ error: 'automation_unavailable' }, error.status);
      }
      if (error instanceof HTTPException) return c.json({ error: 'automation_unavailable' }, error.status);
      if (error instanceof ConnectorClientError && [401, 403, 404, 409, 413].includes(error.status))
        return c.json({ error: 'automation_configuration_rejected' }, error.status as 401 | 403 | 404 | 409 | 413);
      return c.json({ error: 'automation_outcome_unknown_inspect_original' }, 503);
    }
  };
  const request = (c: Context) => {
    const id = c.req.param('requestId'); if (!automationIdentity(id)) throw new HTTPException(400); return id;
  };
  app.get(base, safe(async c => c.json(await (await scope(c)).view())));
  app.get(`${base}/configuration/:requestId`, safe(async c => {
    const s = await scope(c), id = request(c);
    const r = await s.read(`/automation/configuration/${encodeURIComponent(id)}`, { signal: c.req.raw.signal }); await s.check();
    if (!validAutomationConfigurationReceipt(r) || r.requestId !== id || !s.target(r.result.rule.target)) throw new HTTPException(502);
    return c.json(r);
  }));
  app.post(`${base}/configuration/:requestId`, safe(async c => {
    const s = await scope(c), id = request(c);
    const input = await readJsonBody(c.req.raw, 48 * 1024).finally(() => s.check()) as AutomationConfiguration;
    if (!input || !['save', 'revoke'].includes(input.kind)) throw new HTTPException(400);
    const view: AutomationConfigurationView = await s.view(); await s.check();
    if (input.kind === 'save') {
      const rule = readAutomationRule(input.rule);
      if (!rule || !s.target(rule.target) || rule.target.ownerId !== view.ownerId) throw new HTTPException(403);
    } else if (!view.rules.some(r => r.rule.id === input.ruleId)) throw new HTTPException(404);
    await s.check(); // Preserve original request id; never replay an unknown POST.
    const r = await s.read(`/automation/configuration/${encodeURIComponent(id)}`, {
      method: 'POST', body: JSON.stringify(input), signal: c.req.raw.signal,
      headers: { 'content-type': 'application/json' },
    }); await s.check();
    if (!validAutomationConfigurationReceipt(r) || r.requestId !== id || !s.target(r.result.rule.target)
      || r.result.rule.target.ownerId !== view.ownerId) throw new HTTPException(502);
    return c.json(r);
  }));
  let closing: Promise<void> | undefined;
  return { close: () => closing ??= work.close().then(() => deps.access?.close()) };
}
