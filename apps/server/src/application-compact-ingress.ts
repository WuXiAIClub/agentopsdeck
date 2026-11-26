import { createHash } from 'node:crypto';
import type { ApplicationCommandScope, createApplicationCommandScopes } from './auth/application-command-scope.js';
import { validApplicationTransactionEvidence, type ApplicationTransactionEvidence } from './auth/application-transaction-gate.js';
import type { AsyncOpenClawCompact } from './connector/async-openclaw-compact.js';
import type { ConnectorSdkCompactCommands } from './connector/connector-sdk-compact-domain.js';
import type { SdkDispatchResult } from './connector/sdk-dispatch.js';
import { ConnectorOwnerUnavailable, connectorOwnerCommandBytes, encodeConnectorOwnerJson } from './connector/connector-owner-domain.js';
import { runNativeOperation } from './connector/native-operation.js';

export type ApplicationSdkCompactInput = { runtime: 'claude-code' | 'ghcp' | 'antigravity'; key: string; commandKey: string;
  authorization: string; payloadJson: string; application?: ApplicationTransactionEvidence };
export type ApplicationCompactParticipants = {
  openclaw?: Pick<AsyncOpenClawCompact, 'compactPhysical' | 'readPhysical'> | undefined;
  sdk?: { compactPhysical(input: ApplicationSdkCompactInput, authority: ApplicationCommandScope): Promise<SdkDispatchResult>;
    readPhysical(input: ConnectorSdkCompactCommands['sdkCompactReceiptRead']['input'], authority: ApplicationCommandScope):
      Promise<ConnectorSdkCompactCommands['sdkCompactReceiptRead']['output']> } | undefined;
};
type OpenClawInput = Parameters<AsyncOpenClawCompact['compactPhysical']>[0];
type Wait = { timeoutMs: number; signal?: AbortSignal };

/** The original request authorizes both the receipt transaction and native
 * Ready. Transport tokens never replace application identity. Logical waiters
 * may expire; the application scope retains the entire physical driver job. */
export function createApplicationCompactIngress(commands: Pick<ReturnType<typeof createApplicationCommandScopes>, 'run'>,
  participants: ApplicationCompactParticipants, options: { transactions: boolean }) {
  function execute<I extends OpenClawInput | ApplicationSdkCompactInput, T>(request: Request, input: I, wait: Wait,
    work: (input: I, scope: ApplicationCommandScope) => Promise<T>, kind: string) {
    let original: Request, snapshot: I;
    try {
      if (options.transactions !== true || Object.hasOwn(input, 'application')) throw new ConnectorOwnerUnavailable();
      snapshot = JSON.parse(encodeConnectorOwnerJson(input, connectorOwnerCommandBytes(kind))) as I;
      if (typeof snapshot.payloadJson !== 'string' || typeof snapshot.key !== 'string' || typeof snapshot.commandKey !== 'string') throw new ConnectorOwnerUnavailable();
      const headers = new Headers(), evidence: { -readonly [K in keyof ApplicationTransactionEvidence]: ApplicationTransactionEvidence[K] } = {};
      for (const [field, name] of [['authorization', 'authorization'], ['accessKey', 'x-agentopsdeck-key'], ['cookie', 'cookie']] as const) {
        const value = request.headers.get(name);
        if (value !== null) { headers.set(name, value); evidence[field] = value; }
      }
      if (!validApplicationTransactionEvidence(evidence)) throw new ConnectorOwnerUnavailable();
      original = new Request('http://application-compact.invalid/', { headers, signal: request.signal });
      snapshot = { ...snapshot, application: evidence };
    } catch { return Promise.reject(new ConnectorOwnerUnavailable()); }
    return runNativeOperation(() => commands.run(original, { action: 'operation' in snapshot && snapshot.operation === 'message' ? 'message' : 'compact',
      runtime: 'runtime' in snapshot ? snapshot.runtime : 'openclaw', resource: snapshot.key, commandKey: snapshot.commandKey,
      payloadDigest: createHash('sha256').update(snapshot.payloadJson).digest('hex') }, authority => work(snapshot, authority)), wait);
  }
  return Object.freeze({
    openclaw(request: Request, input: OpenClawInput, wait: Wait) {
      if (!participants.openclaw) return Promise.reject(new ConnectorOwnerUnavailable());
      return execute(request, input, wait, (v, scope) => participants.openclaw!.compactPhysical(v, scope), 'openClawCompactClaim');
    },
    sdk(request: Request, input: ApplicationSdkCompactInput, wait: Wait) {
      if (!participants.sdk || input.payloadJson !== '{}') return Promise.reject(new ConnectorOwnerUnavailable());
      return execute(request, input, wait, async (v, scope) => {
        // Reading a prior receipt prevents duplicate native attempts even when
        // the session is now busy/not ready or the old driver has disappeared.
        const read = () => participants.sdk!.readPhysical({ runtime: v.runtime, key: v.key,
          commandKey: v.commandKey, authorization: v.authorization, purpose: 'mutation' }, scope);
        const previous = await read();
        if ('error' in previous || previous.receipt) return previous;
        const dispatch = await participants.sdk!.compactPhysical(v, scope);
        const result = await read();
        return { ...result, dispatch };
      }, 'sdkCompactClaim');
    },
    async readPhysical(runtime: 'openclaw' | 'claude-code' | 'ghcp' | 'antigravity',
      input: { key: string; commandKey: string; authorization: string }, authority: ApplicationCommandScope, operation: 'message' | 'compact' = 'compact') {
      const result = runtime === 'openclaw'
        ? await participants.openclaw?.readPhysical({ ...input, operation }, authority)
        : await participants.sdk?.readPhysical({ ...input, runtime, purpose: 'read' }, authority);
      if (!result) throw new ConnectorOwnerUnavailable();
      await authority.authorize('prepare'); authority.local(); return result;
    },
  });
}
