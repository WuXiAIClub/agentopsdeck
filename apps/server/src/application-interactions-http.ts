import type { Context, Hono } from 'hono';
import type { createApplicationCommandScopes } from './auth/application-command-scope.js';
import { validApplicationTransactionEvidence, type ApplicationTransactionEvidence } from './auth/application-transaction-gate.js';
import { SessionReadAuthority, type SessionReadActor } from './auth/session-read-authority.js';
import type { AsyncLocalCredentials } from './connector/async-local-credentials.js';
import { applicationInteractionIntent } from './connector/application-interaction-transaction.js';
import { connectorOwnerCommandBytes, ConnectorOwnerUnavailable, encodeConnectorOwnerJson } from './connector/connector-owner-domain.js';
import { registerCodexInteractionsHttp, type CodexInteractionsHttp } from './connector/codex-interactions-http.js';
import { registerSdkInteractionsHttp, type SdkInteractionsHttp } from './connector/sdk-interactions-http.js';
import { EXPECTED_NODE_HEADER } from './connector/node-identity.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from './diagnostics/performance.js';

/** Original user credentials are transaction evidence, not the Connector's
 * transport token. Native handles and worker receipts remain the original ones. */
export function registerApplicationInteractionsHttp(app: Hono, deps: {
  commands: Pick<ReturnType<typeof createApplicationCommandScopes>, 'run'>;
  credentials: Pick<AsyncLocalCredentials, 'token'>; observeActor: SessionReadActor;
  available(): boolean; transactions: boolean; codex?: CodexInteractionsHttp; sdk?: SdkInteractionsHttp;
  timeoutMs?: number; diagnostics?: PerformanceDiagnostics;
}) {
  let closed = false;
  const available = () => !closed && deps.transactions === true && deps.available();
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
    return { request: new Request('http://application-interactions.invalid/', { headers, signal: request.signal }), evidence };
  };
  const authorization = () => {
    if (!available()) throw new ConnectorOwnerUnavailable();
    const token = deps.credentials.token('daily'); if (!token) throw new ConnectorOwnerUnavailable(); return `Bearer ${token}`;
  };
  const around = (c: Context, work: () => Promise<Response>) => {
    if (!available()) return Promise.resolve(c.json({ error: 'server_draining' }, 503));
    if (c.req.header('x-agentopsdeck-execution-grant') !== undefined || c.req.header(EXPECTED_NODE_HEADER) !== undefined)
      return Promise.resolve(c.json({ error: 'Invalid local command authority' }, 403));
    return authority.run(original(c.req.raw).request, async check => { const response = await work(); await check(); return response; });
  };
  const codex = (c: Context): CodexInteractionsHttp['interactions'] => {
    const source = original(c.req.raw), port = deps.codex!.interactions;
    return {
      observe: input => port.observe(input),
      mode: input => {
        if (Object.hasOwn(input, 'application')) return Promise.reject(new ConnectorOwnerUnavailable());
        const pinned = JSON.parse(encodeConnectorOwnerJson(input, connectorOwnerCommandBytes('codexInteractionMode'))) as typeof input;
        return deps.commands.run(source.request, applicationInteractionIntent('codex', pinned), async scope => {
          await scope.authorize('prepare'); scope.local();
          const result = await port.mode({ ...pinned, application: source.evidence }, scope);
          await scope.authorize('prepare'); scope.local(); return result;
        });
      },
      answer: input => {
        if (Object.hasOwn(input, 'application')) return Promise.reject(new ConnectorOwnerUnavailable());
        const pinned = JSON.parse(encodeConnectorOwnerJson(input, connectorOwnerCommandBytes('codexInteractionAnswer'))) as typeof input;
        return deps.commands.run(source.request, applicationInteractionIntent('codex', pinned), async scope => {
          await scope.authorize('prepare'); scope.local();
          const result = await port.answer({ ...pinned, application: source.evidence }, scope);
          await scope.authorize('prepare'); scope.local(); return result;
        });
      },
    };
  };
  const sdk = (c: Context): SdkInteractionsHttp['interactions'] => {
    const source = original(c.req.raw), port = deps.sdk!.interactions;
    return {
      observe: input => port.observe(input),
      mode: input => {
        if (Object.hasOwn(input, 'application')) return Promise.reject(new ConnectorOwnerUnavailable());
        const pinned = JSON.parse(encodeConnectorOwnerJson(input, connectorOwnerCommandBytes('sdkInteractionMode'))) as typeof input;
        return deps.commands.run(source.request, applicationInteractionIntent(pinned.runtime, pinned), async scope => {
          await scope.authorize('prepare'); scope.local();
          const result = await port.mode({ ...pinned, application: source.evidence }, scope);
          await scope.authorize('prepare'); scope.local(); return result;
        });
      },
      answer: input => {
        if (Object.hasOwn(input, 'application')) return Promise.reject(new ConnectorOwnerUnavailable());
        const pinned = JSON.parse(encodeConnectorOwnerJson(input, connectorOwnerCommandBytes('sdkInteractionAnswer'))) as typeof input;
        return deps.commands.run(source.request, applicationInteractionIntent(pinned.runtime, pinned), async scope => {
          await scope.authorize('prepare'); scope.local();
          const result = await port.answer({ ...pinned, application: source.evidence }, scope);
          await scope.authorize('prepare'); scope.local(); return result;
        });
      },
    };
  };
  if (deps.codex) registerCodexInteractionsHttp(app, '/api/sessions/:sessionKey', {
    ...deps.codex, diagnostics, timeoutMs, authorization, around, requestInteractions: codex,
  });
  if (deps.sdk) registerSdkInteractionsHttp(app, '/api/sessions/:sessionKey', {
    ...deps.sdk, diagnostics, timeoutMs, authorization, around, requestInteractions: sdk,
  });
  return Object.freeze({ close: () => { closed = true; return authority.close(); } });
}
