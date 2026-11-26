import { createHash } from 'node:crypto';
import { sessionRuntimeId } from '@agentopsdeck/shared';
import type { Context, Hono } from 'hono';
import type { createApplicationCommandScopes } from './auth/application-command-scope.js';
import { validApplicationTransactionEvidence, type ApplicationTransactionEvidence } from './auth/application-transaction-gate.js';
import { SessionReadAuthority, type SessionReadActor } from './auth/session-read-authority.js';
import type { AsyncLocalCredentials } from './connector/async-local-credentials.js';
import type { CodexDeletionHttp } from './connector/codex-deletion-http.js';
import type { HermesDeletionHttp } from './connector/hermes-deletion-http.js';
import { registerOwnedDeletionHttp, type SdkDeletionHttp, type DeletionPorts } from './connector/sdk-deletion-http.js';
import { ConnectorOwnerUnavailable } from './connector/connector-owner-domain.js';
import { EXPECTED_NODE_HEADER } from './connector/node-identity.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from './diagnostics/performance.js';

type Runtime = 'codex' | 'hermes' | 'claude-code' | 'ghcp' | 'antigravity';
const digest = createHash('sha256').update('{}').digest('hex');

/** Original application credentials remain separate from the daily Connector
 * transport. Only the retained physical deletion port receives the scope;
 * receipt observation never manufactures an execution permit. */
export function registerApplicationDeletionHttp(app: Hono, deps: {
  commands: Pick<ReturnType<typeof createApplicationCommandScopes>, 'run'>;
  credentials: Pick<AsyncLocalCredentials, 'token'>; observeActor: SessionReadActor;
  available(): boolean; transactions: boolean; codex?: CodexDeletionHttp; hermes?: HermesDeletionHttp; sdk?: SdkDeletionHttp;
  timeoutMs?: number; diagnostics?: PerformanceDiagnostics;
}) {
  let closed = false;
  const available = () => !closed && deps.available() && deps.transactions === true;
  const timeoutMs = deps.timeoutMs ?? 10_000, diagnostics = deps.diagnostics ?? performanceDiagnostics;
  const readers = new SessionReadAuthority(request => {
    if (!available()) throw new ConnectorOwnerUnavailable(); return deps.observeActor(request);
  }, diagnostics, timeoutMs);
  const original = (request: Request) => {
    const headers = new Headers(), evidence: { -readonly [K in keyof ApplicationTransactionEvidence]: ApplicationTransactionEvidence[K] } = {};
    for (const [field, name] of [['authorization', 'authorization'], ['accessKey', 'x-agentopsdeck-key'], ['cookie', 'cookie']] as const) {
      const value = request.headers.get(name); if (value !== null) { headers.set(name, value); evidence[field] = value; }
    }
    if (!validApplicationTransactionEvidence(evidence)) throw new ConnectorOwnerUnavailable();
    return { request: new Request('http://application-deletion.invalid/', { headers, signal: request.signal }), evidence };
  };
  const transport = () => {
    if (!available()) throw new ConnectorOwnerUnavailable();
    const token = deps.credentials.token('daily'); if (!token) throw new ConnectorOwnerUnavailable(); return `Bearer ${token}`;
  };
  const receipt: DeletionPorts<Runtime>['receipt'] = (runtime, key, commandKey, authorization) => {
    if (runtime === 'codex' && deps.codex) return deps.codex.deletion.receipt(key, commandKey, authorization);
    if (runtime === 'hermes' && deps.hermes) return deps.hermes.lifecycle.receipt(key, commandKey, authorization);
    if ((runtime === 'claude-code' || runtime === 'ghcp' || runtime === 'antigravity') && deps.sdk)
      return deps.sdk.owner.command('sdkDeletionReceiptRead', { runtime, key, commandKey, authorization });
    return Promise.reject(new ConnectorOwnerUnavailable());
  };
  const scoped = (c: Context): DeletionPorts<Runtime> => {
    const source = original(c.req.raw);
    const run = <T>(runtime: Runtime, key: string, commandKey: string, work: Parameters<typeof deps.commands.run<T>>[2]) =>
      deps.commands.run(source.request, { action: 'delete', runtime, resource: key, commandKey, payloadDigest: digest }, work);
    return {
      receipt: (runtime, key, commandKey, authorization) => run(runtime, key, commandKey, async scope => {
        await scope.authorize('prepare'); scope.local();
        const result = await receipt(runtime, key, commandKey, authorization);
        await scope.authorize('prepare'); scope.local(); return result;
      }),
      remove: (runtime, key, commandKey, authorization) => run(runtime, key, commandKey, async scope => {
        await scope.authorize('prepare'); scope.local();
        let result;
        if (runtime === 'codex' && deps.codex)
          result = await deps.codex.deletion.remove(key, commandKey, authorization, source.evidence, scope);
        else if (runtime === 'hermes' && deps.hermes)
          result = await deps.hermes.lifecycle.remove(key, commandKey, authorization, source.evidence, scope);
        else if ((runtime === 'claude-code' || runtime === 'ghcp' || runtime === 'antigravity') && deps.sdk?.removePhysical)
          result = await deps.sdk.removePhysical({ runtime, key, commandKey, authorization, application: source.evidence }, scope);
        else throw new ConnectorOwnerUnavailable();
        await scope.authorize('prepare'); scope.local(); return result;
      }),
    };
  };
  registerOwnedDeletionHttp<Runtime>(app, '/api/sessions/:sessionKey', {
    runtime: key => { const runtime = sessionRuntimeId(key);
      return runtime === 'codex' || runtime === 'hermes' || runtime === 'claude-code' || runtime === 'ghcp' || runtime === 'antigravity' ? runtime : undefined; },
    receipt, remove: () => Promise.reject(new ConnectorOwnerUnavailable()),
    ready: runtime => available() && (runtime === 'codex' ? deps.codex?.ready() === true
      : runtime === 'hermes' ? deps.hermes?.ready() === true : deps.sdk?.ready(runtime) === true),
    authorization: transport, requestPorts: scoped, operation: 'sdk-deletion-http', timeoutMs, diagnostics,
    around: (c, work) => {
      if (!available()) return Promise.resolve(c.json({ error: 'server_draining' }, 503));
      if (c.req.header('x-agentopsdeck-execution-grant') !== undefined || c.req.header(EXPECTED_NODE_HEADER) !== undefined)
        return Promise.resolve(c.json({ error: 'Invalid local command authority' }, 403));
      return readers.run(original(c.req.raw).request, async check => { const response = await work(); await check(); return response; });
    },
  });
  return Object.freeze({ close: () => { closed = true; return readers.close(); } });
}
