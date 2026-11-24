import type { Hono } from 'hono';
import type { AsyncHubMemberGuidance } from '../hub/async-member-guidance.js';
import type { ConnectorClient } from '../hub/connector-client.js';
import type { AsyncConnectorClientResolver } from '../hub/async-connector-client.js';
import type { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { registerHubSessionGuidanceRoutes } from './hub-session-guidance-port.js';

type GuidanceDeps = {
  guidance: AsyncHubMemberGuidance;
  diagnostics?: PerformanceDiagnostics;
} & ({ mode: 'async'; asyncConnectorClient: AsyncConnectorClientResolver; connectorClient?: never } | {
  mode?: undefined; asyncConnectorClient?: never;
  connectorClient(request: Request, connectionId: string, ownerUserId: string): Promise<ConnectorClient> | ConnectorClient;
});

/** Explicit production mode owns its private guidance lane until the entire
 * original resolver and transport drain. No request-time synchronous fallback. */
export function registerAsyncHubSessionGuidance(app: Hono, deps: GuidanceDeps) {
  if (!deps.guidance?.http || typeof deps.guidance.close !== 'function'
    || (deps.mode === 'async' ? typeof deps.asyncConnectorClient !== 'function' : typeof deps.connectorClient !== 'function'))
    throw Error('guidance-async-ports');
  const routes = registerHubSessionGuidanceRoutes(app, {
    begin: (context, sessionId) => deps.guidance.http.begin(context.req.raw, sessionId),
    connectorClient: (connectionId, userId, request) => deps.mode === 'async'
      ? deps.asyncConnectorClient(request, connectionId, {expectedUserId:userId})
      : deps.connectorClient(request, connectionId, userId),
    ...(deps.diagnostics ? { diagnostics: deps.diagnostics } : {}),
  });
  let closing: Promise<void> | undefined;
  return { close: () => closing ??= routes.close().then(async () => { if (deps.mode === 'async') await deps.guidance.close(); }) };
}
