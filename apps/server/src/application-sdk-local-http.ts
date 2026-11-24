import { createHash } from 'node:crypto';
import type { Context, Hono } from 'hono';
import type { createApplicationCommandScopes } from './auth/application-command-scope.js';
import { validApplicationTransactionEvidence, type ApplicationTransactionEvidence } from './auth/application-transaction-gate.js';
import { SessionReadAuthority, type SessionReadActor } from './auth/session-read-authority.js';
import type { AsyncLocalCredentials } from './connector/async-local-credentials.js';
import { connectorOwnerCommandBytes, ConnectorOwnerUnavailable, encodeConnectorOwnerJson } from './connector/connector-owner-domain.js';
import { EXPECTED_NODE_HEADER } from './connector/node-identity.js';
import { runNativeOperation } from './connector/native-operation.js';
import { registerSdkLocalHttp, type SdkLocalHttp } from './connector/sdk-local-http.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from './diagnostics/performance.js';

type Physical = NonNullable<SdkLocalHttp['physical']>;
type Method = keyof Physical;
const readDigest = createHash('sha256').update('original-sdk-local-read').digest('hex');

/** Original application credentials authorize original SQL transactions; the
 * private daily token is transport only. A physical command retains its scope
 * after an HTTP deadline, including original projection publication. */
export function registerApplicationSdkLocalHttp(app: Hono, deps: {
  commands: Pick<ReturnType<typeof createApplicationCommandScopes>, 'run'>;
  credentials: Pick<AsyncLocalCredentials, 'token'>;
  observeActor: SessionReadActor;
  available(): boolean;
  sdk?: SdkLocalHttp;
  transactions: boolean;
  timeoutMs?: number;
  diagnostics?: PerformanceDiagnostics;
}) {
  let closed = false;
  const available = () => !closed && deps.available() && deps.transactions === true && !!deps.sdk?.physical;
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
    return { request: new Request('http://application-sdk-local.invalid/', { headers, signal: request.signal }), evidence };
  };
  const transport = () => {
    if (!available()) throw new ConnectorOwnerUnavailable();
    const token = deps.credentials.token('daily');
    if (!token) throw new ConnectorOwnerUnavailable();
    return `Bearer ${token}`;
  };
  const scoped = (c: Context): SdkLocalHttp['local'] => {
    const source = original(c.req.raw), port = deps.sdk?.physical;
    if (!port) throw new ConnectorOwnerUnavailable();
    const call = <K extends Method>(method: K, input: Parameters<Physical[K]>[0]): ReturnType<Physical[K]> => {
      const write = method !== 'readReceiptPhysical';
      if (!available() || Object.hasOwn(input, 'application')) return Promise.reject(new ConnectorOwnerUnavailable()) as ReturnType<Physical[K]>;
      const snapshot = JSON.parse(encodeConnectorOwnerJson(input, write
        ? connectorOwnerCommandBytes(method === 'createPhysical' ? 'sdkSessionCreate' : 'sdkModelUpdate') : 16_384)) as typeof input;
      const payloadJson = 'payloadJson' in snapshot ? snapshot.payloadJson : undefined;
      const task = deps.commands.run(source.request, {
        action: write ? method === 'createPhysical' ? 'create' : 'settings' : 'operation' in snapshot ? snapshot.operation : 'settings', runtime: snapshot.runtime,
        resource: 'key' in snapshot ? snapshot.key : `${snapshot.runtime}:create`, commandKey: snapshot.commandKey,
        payloadDigest: typeof payloadJson === 'string' ? createHash('sha256').update(payloadJson).digest('hex') : readDigest,
      }, async scope => {
        await scope.authorize('prepare'); scope.local();
        const work = port[method] as (input: typeof snapshot) => Promise<Awaited<ReturnType<Physical[K]>>>;
        const result = await work.call(port, write ? { ...snapshot, application: source.evidence } : snapshot);
        await scope.authorize('prepare'); scope.local();
        return result;
      });
      return task as ReturnType<Physical[K]>;
    };
    return {
      create: (input, wait) => runNativeOperation(() => call('createPhysical', input), wait),
      updateModel: (input, wait) => runNativeOperation(() => call('updateModelPhysical', input), wait),
      readReceipt: (input, wait) => runNativeOperation(() => call('readReceiptPhysical', input), wait),
    };
  };
  if (deps.sdk) registerSdkLocalHttp(app, '/api', {
    ...deps.sdk, timeoutMs, diagnostics, authorization: transport, requestLocal: scoped,
    around: (c, work) => {
      if (!available()) return Promise.resolve(c.json({ error: 'server_draining' }, 503));
      if (c.req.header('x-agentopsdeck-execution-grant') !== undefined || c.req.header(EXPECTED_NODE_HEADER) !== undefined)
        return Promise.resolve(c.json({ error: 'Invalid local command authority' }, 403));
      return authority.run(original(c.req.raw).request, async check => {
        const response = await work(); await check(); return response;
      });
    },
  });
  return Object.freeze({ close: () => { closed = true; return authority.close(); } });
}
