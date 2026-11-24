import type { Context, Hono } from 'hono';
import type { createApplicationCommandScopes } from './auth/application-command-scope.js';
import { validApplicationTransactionEvidence, type ApplicationTransactionEvidence } from './auth/application-transaction-gate.js';
import { SessionReadAuthority, type SessionReadActor } from './auth/session-read-authority.js';
import { applicationUsageIntent } from './connector/application-usage-transaction.js';
import type { AsyncLocalCredentials } from './connector/async-local-credentials.js';
import { ConnectorOwnerUnavailable } from './connector/connector-owner-domain.js';
import { EXPECTED_NODE_HEADER } from './connector/node-identity.js';
import { registerCodexPublicUsageHttp, type CodexPublicUsageHttp } from './connector/codex-public-usage-http.js';
import { registerSdkUsageHttp, type SdkUsageHttp, type OwnedUsageHttp } from './connector/sdk-usage-http.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from './diagnostics/performance.js';

/** Old frontend wire, original application identity, original immutable ledger.
 * Private transport is never accepted as proof of the caller's authority. */
export function registerApplicationUsageHttp(app: Hono, deps: {
  commands: Pick<ReturnType<typeof createApplicationCommandScopes>, 'run'>; credentials: Pick<AsyncLocalCredentials, 'token'>;
  observeActor: SessionReadActor; available(): boolean; transactions: boolean; codex?: CodexPublicUsageHttp; sdk?: SdkUsageHttp;
  timeoutMs?: number; diagnostics?: PerformanceDiagnostics;
}) {
  let closed = false;
  const available = () => !closed && deps.available() && deps.transactions === true;
  const diagnostics = deps.diagnostics ?? performanceDiagnostics, timeoutMs = deps.timeoutMs ?? 10_000;
  const authority = new SessionReadAuthority(request => {
    if (!available()) throw new ConnectorOwnerUnavailable(); return deps.observeActor(request);
  }, diagnostics, timeoutMs);
  const original = (request: Request) => {
    const headers = new Headers(), evidence: { -readonly [K in keyof ApplicationTransactionEvidence]: ApplicationTransactionEvidence[K] } = {};
    for (const [field, name] of [['authorization', 'authorization'], ['accessKey', 'x-agentopsdeck-key'], ['cookie', 'cookie']] as const) {
      const value = request.headers.get(name); if (value !== null) { headers.set(name, value); evidence[field] = value; }
    }
    if (!validApplicationTransactionEvidence(evidence)) throw new ConnectorOwnerUnavailable();
    return { request: new Request('http://application-usage.invalid/', { headers, signal: request.signal }), evidence };
  };
  const authorization = () => {
    if (!available()) throw new ConnectorOwnerUnavailable();
    const token = deps.credentials.token('daily'); if (!token) throw new ConnectorOwnerUnavailable(); return `Bearer ${token}`;
  };
  const around = (c: Context, work: () => Promise<Response>) => {
    if (!available()) return Promise.resolve(c.json({ error: 'server_draining' }, 503));
    if (c.req.header('x-agentopsdeck-execution-grant') !== undefined || c.req.header(EXPECTED_NODE_HEADER) !== undefined)
      return Promise.resolve(c.json({ error: 'Invalid local usage authority' }, 403));
    return authority.run(original(c.req.raw).request, async check => { const response = await work(); await check(); return response; });
  };
  const requestUsage = <R extends 'codex' | 'claude-code' | 'ghcp'>(c: Context, port: OwnedUsageHttp<R>['usage']): OwnedUsageHttp<R>['usage'] => ({
    range: (input, request) => port.range({ ...input }, request),
    export: (input, request) => port.export({ ...input }, request),
    readSnapshot: (input, request) => port.readSnapshot({ ...input }, request),
    createSnapshot: (input, request) => {
      if (Object.hasOwn(input, 'application')) return Promise.reject(new ConnectorOwnerUnavailable());
      const pinned = structuredClone(input), source = original(c.req.raw);
      return deps.commands.run(source.request, applicationUsageIntent(pinned.runtime, pinned), async scope => {
        await scope.authorize('prepare'); scope.local();
        const input = { ...pinned, application: source.evidence };
        const result = await port.createSnapshot(input, request);
        await scope.authorize('prepare'); scope.local(); return result;
      });
    },
  });
  if (deps.codex) registerCodexPublicUsageHttp(app, '/api/sessions/:sessionKey', { ...deps.codex, timeoutMs, authorization, around,
    requestUsage: c => requestUsage(c, deps.codex!.usage) });
  if (deps.sdk) registerSdkUsageHttp(app, '/api/sessions/:sessionKey', { ...deps.sdk, timeoutMs, authorization, around,
    requestUsage: c => requestUsage(c, deps.sdk!.usage) });
  return Object.freeze({ close: () => { closed = true; return authority.close(); } });
}
