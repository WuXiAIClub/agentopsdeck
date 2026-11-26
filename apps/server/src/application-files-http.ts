import type { Context, Hono } from 'hono';
import type { createApplicationCommandScopes } from './auth/application-command-scope.js';
import { validApplicationTransactionEvidence, type ApplicationTransactionEvidence } from './auth/application-transaction-gate.js';
import { SessionReadAuthority, type SessionReadActor } from './auth/session-read-authority.js';
import { applicationFilesIntent } from './connector/application-files-transaction.js';
import type { AsyncLocalCredentials } from './connector/async-local-credentials.js';
import { ConnectorOwnerUnavailable } from './connector/connector-owner-domain.js';
import { EXPECTED_NODE_HEADER } from './connector/node-identity.js';
import { registerCodexFilesHttp, type CodexFilesHttp } from './connector/codex-files-http.js';
import { registerSdkFilesHttp, type SdkFilesHttp, type OwnedFilesHttp } from './connector/sdk-files-http.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from './diagnostics/performance.js';

/** Original application identity is separate from private Connector transport.
 * Read delivery cannot mint write authority; each rebuild mutation rechecks
 * original evidence in the worker around the original bounded state machine. */
export function registerApplicationFilesHttp(app: Hono, deps: {
  commands: Pick<ReturnType<typeof createApplicationCommandScopes>, 'run'>; credentials: Pick<AsyncLocalCredentials, 'token'>;
  observeActor: SessionReadActor; available(): boolean; transactions: boolean; codex?: CodexFilesHttp; sdk?: SdkFilesHttp;
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
    return { request: new Request('http://application-files.invalid/', { headers, signal: request.signal }), evidence };
  };
  const authorization = () => {
    if (!available()) throw new ConnectorOwnerUnavailable();
    const token = deps.credentials.token('daily'); if (!token) throw new ConnectorOwnerUnavailable(); return `Bearer ${token}`;
  };
  const around = (c: Context, work: () => Promise<Response>) => {
    if (!available()) return Promise.resolve(c.json({ error: 'server_draining' }, 503));
    if (c.req.header('x-agentopsdeck-execution-grant') !== undefined || c.req.header(EXPECTED_NODE_HEADER) !== undefined)
      return Promise.resolve(c.json({ error: 'Invalid local file authority' }, 403));
    return authority.run(original(c.req.raw).request, async check => { const response = await work(); await check(); return response; });
  };
  const requestFiles = <R extends 'codex' | 'claude-code' | 'ghcp' | 'antigravity'>(c: Context, port: OwnedFilesHttp<R>['files']): OwnedFilesHttp<R>['files'] => {
    const source = original(c.req.raw);
    const mutate = <I extends { runtime: R; key: string; jobId?: string; step?: number }, T>(
      operation: 'start' | 'step' | 'cancel', input: I, work: (pinned: I & { application: ApplicationTransactionEvidence }) => Promise<T>) => {
      if (Object.hasOwn(input, 'application')) return Promise.reject(new ConnectorOwnerUnavailable());
      const pinned = structuredClone(input);
      return deps.commands.run(source.request, applicationFilesIntent(pinned.runtime, operation, pinned), async scope => {
        await scope.authorize('prepare'); scope.local();
        const result = await work({ ...pinned, application: source.evidence });
        await scope.authorize('prepare'); scope.local(); return result;
      });
    };
    return {
      page: (input, request) => port.page({ ...input }, request),
      start: (input, request) => mutate('start', input, pinned => port.start(pinned, request)),
      step: (input, request) => mutate('step', input, pinned => port.step(pinned, request)),
      cancel: (input, request) => mutate('cancel', input, pinned => port.cancel(pinned, request)),
    };
  };
  if (deps.codex) registerCodexFilesHttp(app, '/api/sessions/:sessionKey', { ...deps.codex, timeoutMs, authorization, around,
    requestFiles: c => requestFiles(c, deps.codex!.files) });
  if (deps.sdk) registerSdkFilesHttp(app, '/api/sessions/:sessionKey', { ...deps.sdk, timeoutMs, authorization, around,
    requestFiles: c => requestFiles(c, deps.sdk!.files) });
  return Object.freeze({ close: () => { closed = true; return authority.close(); } });
}
