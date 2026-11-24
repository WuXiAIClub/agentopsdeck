import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { readJsonBody } from '../utils/http-body.js';
import { NODE_ID_HEADER } from './node-identity.js';
import { ConnectorGrantRequestAborted, synchronousConnectorGrantRequests, type ConnectorGrantRequestPort } from './async-grant-request.js';
import { connectorGrantSteps, type ConnectorGrantDependencies, type ConnectorHttpGrantKind } from './connector-grant-domain.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';

/** Preserve the trusted operator API and wire DTOs for both owner modes. The
 * application still selects its synchronous whole owner until every shared
 * participant migrates; this function never starts a second writer. */
export function registerExecutionGrantRoutes(app: Hono, deps: ConnectorGrantDependencies) {
  registerExecutionGrantHttp(app, deps.nodeId, synchronousConnectorGrantRequests(deps));
}
export function registerExecutionGrantHttp(app: Hono, nodeId: string, requests: ConnectorGrantRequestPort,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics, warningMs = 30_000) {
  const path = '/api/connector/v1/execution-grants';
  for (const [suffix, kind] of [['/issuer', 'authorizedGrantIssuer'], ['/issuer/creation', 'authorizedGrantCreation'],
    ['', 'authorizedGrantIssue'], ['/revoke', 'authorizedGrantRevoke'], ['/usage', 'authorizedGrantUsage']] as const) {
    const read = kind === 'authorizedGrantIssuer' || kind === 'authorizedGrantCreation';
    app.on(read ? 'GET' : 'POST', `${path}${suffix}`, async c => {
      c.header('Cache-Control', 'no-store'); c.header(NODE_ID_HEADER, nodeId);
      const trace = guardedTrace(diagnostics, 'connector-grants-http'); trace.add('step', connectorGrantSteps[kind]);
      const timer = setTimeout(() => trace.reportPending({ pending: 1 }),
        Number.isSafeInteger(warningMs) && warningMs > 0 && warningMs <= 2_147_483_647 ? warningMs : 30_000);
      timer.unref();
      let status = 503;
      try {
        // Preserve issuer/node precedence before reading a body. This result
        // never supplies authority to the mutation after the body await.
        const preflight = await requests.execute(read ? kind : 'authorizedGrantIssuer', c.req.raw);
        if (preflight.status !== 200) {
          status = preflight.status;
          if (preflight.error === 'Trusted delegation issuer required' || preflight.error === 'Verified Connector identity required')
            throw new HTTPException(preflight.status, { message: preflight.error });
          return c.json({ error: preflight.error }, preflight.status);
        }
        const result = read ? preflight : await requests.execute(kind as ConnectorHttpGrantKind, c.req.raw, await readJsonBody(c.req.raw, 8 * 1024));
        status = result.status;
        if (result.status !== 200 && (result.error === 'Trusted delegation issuer required' || result.error === 'Verified Connector identity required'))
          throw new HTTPException(result.status, { message: result.error });
        return result.status === 200 ? c.json(result.value) : c.json({ error: result.error }, result.status);
      } catch (error) {
        if (error instanceof HTTPException) { status = error.status; throw error; }
        status = error instanceof ConnectorGrantRequestAborted ? 499 : 503;
        if (status === 499) return new Response(JSON.stringify({ error: 'Execution grant storage unavailable' }),
          { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', [NODE_ID_HEADER]: nodeId } });
        return c.json({ error: 'Execution grant storage unavailable' }, 503);
      } finally {
        clearTimeout(timer); trace.add('settled', 1);
        if (status >= 500) trace.add('unknown', 1); else if (status >= 400) trace.add('deferred', 1);
        trace.finish(status >= 400);
      }
    });
  }
}
