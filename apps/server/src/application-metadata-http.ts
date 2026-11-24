import type { Context, Hono } from 'hono';
import { SessionReadAuthority, type SessionReadActor } from './auth/session-read-authority.js';
import type { AsyncLocalCredentials } from './connector/async-local-credentials.js';
import { ConnectorOwnerUnavailable } from './connector/connector-owner-domain.js';
import { EXPECTED_NODE_HEADER } from './connector/node-identity.js';
import { registerCodexCatalogHttp, type CodexCatalogHttp } from './connector/codex-catalog-http.js';
import { registerSdkMetadataHttp, type SdkMetadataHttp } from './connector/sdk-metadata-http.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from './diagnostics/performance.js';

/** Original frontend reads, not a machine-token proxy. Current application
 * identity fences admission and delivery; original ports retain physical work. */
export function registerApplicationMetadataHttp(app: Hono, deps: {
  credentials: Pick<AsyncLocalCredentials, 'token'>; observeActor: SessionReadActor;
  available(): boolean; codex?: CodexCatalogHttp; sdk?: SdkMetadataHttp;
  timeoutMs?: number; diagnostics?: PerformanceDiagnostics;
}) {
  let closed = false;
  const available = () => !closed && deps.available();
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const authority = new SessionReadAuthority(request => {
    if (!available()) throw new ConnectorOwnerUnavailable();
    return deps.observeActor(request);
  }, deps.diagnostics ?? performanceDiagnostics, timeoutMs);
  const authorization = () => {
    if (!available()) throw new ConnectorOwnerUnavailable();
    const token = deps.credentials.token('daily');
    if (!token) throw new ConnectorOwnerUnavailable();
    return `Bearer ${token}`;
  };
  const around = (context: Context, work: () => Promise<Response>) => {
    if (!available()) return Promise.resolve(context.json({ error: 'server_draining' }, 503));
    if (context.req.header('x-agentopsdeck-execution-grant') !== undefined || context.req.header(EXPECTED_NODE_HEADER) !== undefined)
      return Promise.resolve(context.json({ error: 'Invalid local metadata authority' }, 403));
    // Snapshot only original caller evidence. The private daily token is never
    // put in this Request and cannot satisfy original application authority.
    const headers = new Headers();
    for (const name of ['authorization', 'x-agentopsdeck-key', 'cookie']) {
      const value = context.req.header(name); if (value !== undefined) headers.set(name, value);
    }
    return authority.run(new Request('http://application-metadata.invalid/', { headers, signal: context.req.raw.signal }), () => work());
  };
  if (deps.codex) registerCodexCatalogHttp(app, '/api', { ...deps.codex, timeoutMs, authorization, around });
  if (deps.sdk) registerSdkMetadataHttp(app, '/api', { ...deps.sdk, authorization, around });
  return Object.freeze({ close: () => { closed = true; return authority.close(); } });
}
