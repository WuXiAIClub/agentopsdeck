import { createHash } from 'node:crypto';
import { sessionRuntimeId } from '@agentopsdeck/shared';
import type { Context, Hono } from 'hono';
import type { createApplicationCommandScopes } from './auth/application-command-scope.js';
import { validApplicationTransactionEvidence, type ApplicationTransactionEvidence } from './auth/application-transaction-gate.js';
import { SessionReadAuthority, type SessionReadActor } from './auth/session-read-authority.js';
import type { AsyncLocalCredentials } from './connector/async-local-credentials.js';
import { connectorOwnerCommandBytes, ConnectorOwnerUnavailable, encodeConnectorOwnerJson } from './connector/connector-owner-domain.js';
import { EXPECTED_NODE_HEADER } from './connector/node-identity.js';
import { registerSessionTitleHttp, type SessionTitleHttp } from './connector/session-title-http.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from './diagnostics/performance.js';

const readDigest = createHash('sha256').update('original-title-settings-read').digest('hex');
export function registerApplicationSessionTitleHttp(app: Hono, deps: {
  commands: Pick<ReturnType<typeof createApplicationCommandScopes>, 'run'>; credentials: Pick<AsyncLocalCredentials, 'token'>;
  observeActor: SessionReadActor; available(): boolean; transactions: boolean; titles?: SessionTitleHttp;
  timeoutMs?: number; diagnostics?: PerformanceDiagnostics;
}) {
  let closed = false;
  const available = () => !closed && deps.available() && deps.transactions === true && !!deps.titles;
  const diagnostics = deps.diagnostics ?? performanceDiagnostics, timeoutMs = deps.timeoutMs ?? 10_000;
  const authority = new SessionReadAuthority(request => { if (!available()) throw new ConnectorOwnerUnavailable(); return deps.observeActor(request); }, diagnostics, timeoutMs);
  const original = (request: Request) => {
    const headers = new Headers(), evidence: { -readonly [K in keyof ApplicationTransactionEvidence]: ApplicationTransactionEvidence[K] } = {};
    for (const [field, name] of [['authorization', 'authorization'], ['accessKey', 'x-agentopsdeck-key'], ['cookie', 'cookie']] as const) {
      const value = request.headers.get(name); if (value !== null) { headers.set(name, value); evidence[field] = value; }
    }
    if (!validApplicationTransactionEvidence(evidence)) throw new ConnectorOwnerUnavailable();
    return { request: new Request('http://application-session-title.invalid/', { headers, signal: request.signal }), evidence };
  };
  const transport = () => { if (!available()) throw new ConnectorOwnerUnavailable(); const token = deps.credentials.token('daily');
    if (!token) throw new ConnectorOwnerUnavailable(); return `Bearer ${token}`; };
  const scoped = (c: Context): SessionTitleHttp['titles'] => {
    const source = original(c.req.raw), port = deps.titles?.titles;
    if (!available() || !port) throw new ConnectorOwnerUnavailable();
    const intent = (key: string, commandKey: string, payloadJson?: string) => ({ action: 'settings' as const, runtime: sessionRuntimeId(key), resource: key,
      commandKey, payloadDigest: payloadJson === undefined ? readDigest : createHash('sha256').update(payloadJson).digest('hex') });
    return {
      change: input => {
        if (Object.hasOwn(input, 'application')) return Promise.reject(new ConnectorOwnerUnavailable());
        const pinned = JSON.parse(encodeConnectorOwnerJson(input, connectorOwnerCommandBytes('titleClaim'))) as typeof input;
        return deps.commands.run(source.request, intent(pinned.key, pinned.commandKey, pinned.payloadJson), async scope => {
          await scope.authorize('prepare'); scope.local();
          const result = await port.change({ ...pinned, application: source.evidence }, scope);
          await scope.authorize('prepare'); scope.local(); return result;
        });
      },
      receipt: input => {
        const pinned = { ...input };
        return deps.commands.run(source.request, intent(pinned.key, pinned.commandKey), async scope => {
          await scope.authorize('prepare'); scope.local(); const result = await port.receipt(pinned);
          await scope.authorize('prepare'); scope.local(); return result;
        });
      },
    };
  };
  if (deps.titles) registerSessionTitleHttp(app, '/api/sessions/:sessionKey', { ...deps.titles, timeoutMs, requestTitles: scoped, authorization: transport,
    around: (c, work) => {
      if (!available()) return Promise.resolve(c.json({ error: 'server_draining' }, 503));
      if (c.req.header('x-agentopsdeck-execution-grant') !== undefined || c.req.header(EXPECTED_NODE_HEADER) !== undefined)
        return Promise.resolve(c.json({ error: 'Invalid local command authority' }, 403));
      return authority.run(original(c.req.raw).request, async check => { const response = await work(); await check(); return response; });
    } });
  return Object.freeze({ close: () => { closed = true; return authority.close(); } });
}
