import { createHash } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { EXPECTED_NODE_HEADER } from './connector/node-identity.js';
import type { createApplicationCommandScopes } from './auth/application-command-scope.js';
import { validApplicationTransactionEvidence, type ApplicationTransactionEvidence } from './auth/application-transaction-gate.js';
import { SessionReadAuthority, type SessionReadActor } from './auth/session-read-authority.js';
import type { AsyncLocalCredentials } from './connector/async-local-credentials.js';
import { ConnectorOwnerUnavailable, connectorOwnerCommandBytes, encodeConnectorOwnerJson } from './connector/connector-owner-domain.js';
import { registerSessionCreationHttp, type SessionCreationHttp } from './connector/hermes-creation-http.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from './diagnostics/performance.js';

const readDigest = createHash('sha256').update('original-native-creation-read').digest('hex');
type CreateInput = Parameters<SessionCreationHttp['creation']['create']>[0];

/** One original native creation pipeline. Daily credentials identify the local
 * transport; original cookie/key evidence authorizes the worker transaction.
 * HTTP deadlines never retire a command scope or its late native settlement. */
export function registerApplicationNativeCreationHttp(app: Hono, deps: {
  commands: Pick<ReturnType<typeof createApplicationCommandScopes>, 'run'>;
  credentials: Pick<AsyncLocalCredentials, 'token'>;
  observeActor: SessionReadActor;
  available(): boolean;
  transactions: boolean;
  codex?: SessionCreationHttp | undefined;
  hermes?: SessionCreationHttp | undefined;
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
    return { request: new Request('http://application-native-creation.invalid/', { headers, signal: request.signal }), evidence };
  };
  const transport = () => {
    if (!available()) throw new ConnectorOwnerUnavailable();
    const token = deps.credentials.token('daily');
    if (!token) throw new ConnectorOwnerUnavailable();
    return `Bearer ${token}`;
  };
  for (const runtime of ['codex', 'hermes'] as const) {
    const configured = deps[runtime];
    if (!configured) continue;
    const scoped = (c: Context): SessionCreationHttp['creation'] => {
      const source = original(c.req.raw), port = configured.physical;
      if (!available() || !port) throw new ConnectorOwnerUnavailable();
      const run = (input: Pick<CreateInput, 'commandKey'>, payloadJson?: string) => ({
        action: 'create' as const, runtime, resource: `${runtime}:create`, commandKey: input.commandKey,
        payloadDigest: payloadJson === undefined ? readDigest : createHash('sha256').update(payloadJson).digest('hex'),
      });
      return {
        create: input => {
          if (Object.hasOwn(input, 'application')) return Promise.reject(new ConnectorOwnerUnavailable());
          const pinned = JSON.parse(encodeConnectorOwnerJson(input, connectorOwnerCommandBytes(`${runtime}CreationClaim`))) as CreateInput;
          return deps.commands.run(source.request, run(pinned, pinned.payloadJson), async scope => {
            await scope.authorize('prepare'); scope.local();
            const result = await port.createPhysical({ ...pinned, application: source.evidence }, scope);
            await scope.authorize('prepare'); scope.local();
            return result;
          });
        },
        receipt: (authorization, commandKey) => deps.commands.run(source.request, run({ commandKey }), async scope => {
          await scope.authorize('prepare'); scope.local();
          const result = await port.receiptPhysical(authorization, commandKey);
          await scope.authorize('prepare'); scope.local();
          return result;
        }),
      };
    };
    registerSessionCreationHttp(app, '/api', { ...configured, timeoutMs, diagnostics, authorization: transport, requestCreation: scoped,
      around: (c, work) => {
        if (!available() || !configured.physical) return Promise.resolve(c.json({ error: 'server_draining' }, 503));
        if (c.req.header('x-agentopsdeck-execution-grant') !== undefined || c.req.header(EXPECTED_NODE_HEADER) !== undefined)
          return Promise.resolve(c.json({ error: 'Invalid local command authority' }, 403));
        return authority.run(original(c.req.raw).request, async check => {
          const response = await work(); await check(); return response;
        });
      },
    }, runtime);
  }
  return Object.freeze({ close: () => { closed = true; return authority.close(); } });
}
