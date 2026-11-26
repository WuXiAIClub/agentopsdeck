import { createHash } from 'node:crypto';
import { sessionRuntimeId } from '@agentopsdeck/shared';
import type { Context, Hono } from 'hono';
import type { createApplicationCommandScopes } from './auth/application-command-scope.js';
import { validApplicationTransactionEvidence, type ApplicationTransactionEvidence } from './auth/application-transaction-gate.js';
import { SessionReadAuthority, type SessionReadActor } from './auth/session-read-authority.js';
import type { AsyncLocalCredentials } from './connector/async-local-credentials.js';
import { connectorOwnerCommandBytes, ConnectorOwnerUnavailable, encodeConnectorOwnerJson } from './connector/connector-owner-domain.js';
import { registerOwnedQueueHttp, type OwnedQueueHttp, type SdkQueueHttp } from './connector/sdk-queue-http.js';
import type { NativeQueueHttp } from './connector/native-queue-http.js';
import type { HermesQueueHttp } from './connector/hermes-queue-http.js';
import { EXPECTED_NODE_HEADER } from './connector/node-identity.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from './diagnostics/performance.js';

type Runtime = 'claude-code' | 'ghcp' | 'antigravity' | 'hermes' | 'codex' | 'openclaw';
type Ports<R extends Runtime> = OwnedQueueHttp<R>['queue'];
type Method = keyof Ports<Runtime>;
const readDigest = createHash('sha256').update('original-queue-read').digest('hex');

/** Reuses the original queue protocol, with request-scoped original application
 * identity and private local transport kept separate. Each command scope owns
 * real SQL/publication completion; an expired HTTP waiter cannot retire it. */
export function registerApplicationQueueHttp(app: Hono, deps: {
  commands: Pick<ReturnType<typeof createApplicationCommandScopes>, 'run'>;
  credentials: Pick<AsyncLocalCredentials, 'token'>;
  observeActor: SessionReadActor;
  available(): boolean;
  sdk?: SdkQueueHttp | undefined;
  hermes?: HermesQueueHttp | undefined;
  native?: NativeQueueHttp | undefined;
  transactions: boolean;
  timeoutMs?: number;
  diagnostics?: PerformanceDiagnostics;
}) {
  let closed = false;
  const available = () => !closed && deps.available() && deps.transactions === true;
  const diagnostics = deps.diagnostics ?? performanceDiagnostics, timeoutMs = deps.timeoutMs ?? 10_000;
  const authority = new SessionReadAuthority(request => {
    if (!available()) throw new ConnectorOwnerUnavailable();
    return deps.observeActor(request);
  }, diagnostics, timeoutMs);
  const original = (request: Request) => {
    const headers = new Headers(), evidence: { -readonly [K in keyof ApplicationTransactionEvidence]: ApplicationTransactionEvidence[K] } = {};
    for (const [field, name] of [['authorization', 'authorization'], ['accessKey', 'x-agentopsdeck-key'], ['cookie', 'cookie']] as const) {
      const value = request.headers.get(name);
      if (value !== null) { headers.set(name, value); evidence[field] = value; }
    }
    if (!validApplicationTransactionEvidence(evidence)) throw new ConnectorOwnerUnavailable();
    return { request: new Request('http://application-queue.invalid/', { headers, signal: request.signal }), evidence };
  };
  const transport = () => {
    if (!available()) throw new ConnectorOwnerUnavailable();
    const token = deps.credentials.token('daily');
    if (!token) throw new ConnectorOwnerUnavailable();
    return `Bearer ${token}`;
  };
  function scoped<R extends Runtime>(c: Context, port: Ports<R>): Ports<R> {
    const source = original(c.req.raw);
    const call = <K extends Method>(method: K, input: Parameters<Ports<R>[K]>[0]): ReturnType<Ports<R>[K]> => {
      const mutation = method === 'edit' || method === 'cancel';
      const runtime = input.runtime;
      const prefix = runtime === 'hermes' ? 'hermes' : runtime === 'codex' || runtime === 'openclaw' ? 'native' : 'sdk';
      const kind = `${prefix}${method === 'edit' ? 'QueuedEdit' : 'QueuedCancel'}`;
      if (!available() || Object.hasOwn(input, 'application')) return Promise.reject(new ConnectorOwnerUnavailable()) as ReturnType<Ports<R>[K]>;
      const snapshot = JSON.parse(encodeConnectorOwnerJson(input, mutation ? connectorOwnerCommandBytes(kind) : 16_384)) as typeof input;
      const mutationInput = snapshot as Parameters<Ports<R>['edit']>[0];
      const payload = mutation ? JSON.stringify({ method: method === 'edit' ? 'PATCH' : 'DELETE', version: mutationInput.version,
        text: method === 'edit' ? mutationInput.text.trim() : '' }) : undefined;
      const task = deps.commands.run(source.request, { action: 'queue', runtime, resource: snapshot.key,
        commandKey: 'mutationKey' in snapshot && typeof snapshot.mutationKey === 'string' ? snapshot.mutationKey : 'queue.read',
        payloadDigest: payload ? createHash('sha256').update(payload).digest('hex') : readDigest }, async scope => {
        await scope.authorize('prepare'); scope.local();
        // The method/input pair is fixed here, not supplied by HTTP. Reads
        // retain their strict original schema and never acquire write evidence.
        const work = port[method] as (input: typeof snapshot) => Promise<Awaited<ReturnType<Ports<R>[K]>>>;
        const result = await work.call(port, mutation ? { ...snapshot, application: source.evidence } : snapshot);
        await scope.authorize('prepare'); scope.local();
        return result;
      });
      return task as ReturnType<Ports<R>[K]>;
    };
    return { page: input => call('page', input), commandPage: input => call('commandPage', input),
      edit: input => call('edit', input), cancel: input => call('cancel', input), readReceipt: input => call('readReceipt', input) };
  }
  const around = (c: Context, work: () => Promise<Response>) => {
    if (!available()) return Promise.resolve(c.json({ error: 'server_draining' }, 503));
    // These are local administrator routes, not delegated Connector routes.
    if (c.req.header('x-agentopsdeck-execution-grant') !== undefined || c.req.header(EXPECTED_NODE_HEADER) !== undefined)
      return Promise.resolve(c.json({ error: 'Invalid local queue authority' }, 403));
    return authority.run(original(c.req.raw).request, async check => { const response = await work(); await check(); return response; });
  };
  const path = '/api/sessions/:sessionKey';
  if (deps.sdk) {
    const sdk = deps.sdk;
    registerOwnedQueueHttp<'claude-code' | 'ghcp' | 'antigravity'>(app, path, {
      queue: sdk.queue, requestQueue: c => scoped(c, sdk.queue), ready: runtime => sdk.ready(runtime),
      authorization: transport, around, timeoutMs, diagnostics, operation: 'sdk-queue-http',
      runtime: key => { const runtime = sessionRuntimeId(key); return runtime === 'claude-code' || runtime === 'ghcp' || runtime === 'antigravity' ? runtime : undefined; },
    });
  }
  if (deps.hermes) {
    const hermes = deps.hermes;
    registerOwnedQueueHttp<'hermes'>(app, path, {
      queue: hermes.queue, requestQueue: c => scoped(c, hermes.queue), ready: () => hermes.ready(),
      authorization: transport, around, timeoutMs, diagnostics, operation: 'hermes-queue-http', mutationMethod: true,
      runtime: key => sessionRuntimeId(key) === 'hermes' ? 'hermes' : undefined,
    });
  }
  if (deps.native) {
    const native = deps.native;
    registerOwnedQueueHttp<'codex' | 'openclaw'>(app, path, {
      queue: native.queue, requestQueue: c => scoped(c, native.queue), ready: runtime => native.ready(runtime),
      authorization: transport, around, timeoutMs, diagnostics, operation: 'native-queue-http', mutationMethod: true,
      runtime: key => { const runtime = sessionRuntimeId(key); return runtime === 'codex' || runtime === 'openclaw' ? runtime : undefined; },
    });
  }
  return Object.freeze({ close: () => { closed = true; return authority.close(); } });
}
