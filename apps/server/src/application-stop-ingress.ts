import { createHash } from 'node:crypto';
import type { ApplicationCommandIntent, ApplicationCommandScope, createApplicationCommandScopes } from './auth/application-command-scope.js';
import { validApplicationTransactionEvidence, type ApplicationTransactionEvidence } from './auth/application-transaction-gate.js';
import type { AsyncCodexStop } from './connector/async-codex-stop.js';
import type { AsyncOpenClawStop } from './connector/async-openclaw-stop.js';
import type { AsyncHermesStop } from './connector/async-hermes-stop.js';
import type { SdkMessageStopRequest, ConnectorSdkStopCommands } from './connector/connector-sdk-stop-domain.js';
import { ConnectorOwnerUnavailable, connectorOwnerCommandBytes, encodeConnectorOwnerJson } from './connector/connector-owner-domain.js';
import { runNativeOperation } from './connector/native-operation.js';

type Input<T extends { stopPhysical: (...args: never[]) => unknown }> = Parameters<T['stopPhysical']>[0];
export type ApplicationStopParticipants = {
  codex?: Pick<AsyncCodexStop, 'stopPhysical'> | undefined;
  openclaw?: Pick<AsyncOpenClawStop, 'stopPhysical'> | undefined;
  hermes?: Pick<AsyncHermesStop, 'stopPhysical'> | undefined;
  sdk?: { stopPhysical(input: SdkMessageStopRequest, authority?: ApplicationCommandScope): Promise<ConnectorSdkStopCommands['sdkMessageStopClaim']['output']> } | undefined;
};

/** Physical original stop ingress. Raw original application credentials and
 * private transport credentials are distinct; neither is an actor projection.
 * No waiter deadline can retire the command scope before the native outcome. */
export function createApplicationStopIngress(commands: Pick<ReturnType<typeof createApplicationCommandScopes>, 'run'>,
  participants: ApplicationStopParticipants, options: { transactions: boolean }) {
  const run = commands.run.bind(commands);
  const transactions = options.transactions === true;
  function lane<I extends { key: string; commandKey: string; payloadJson: string }, R>(
    runtime: (input: I) => ApplicationCommandIntent['runtime'],
    kind: 'codexStopClaim' | 'openClawStopClaim' | 'hermesStopClaim' | 'sdkMessageStopClaim',
    original?: (input: I, authority?: ApplicationCommandScope) => Promise<R>,
  ) {
    return (request: Request, input: I, wait: { timeoutMs: number; signal?: AbortSignal }): Promise<R> => {
      let snapshot: I, originalRequest: Request, intent: ApplicationCommandIntent;
      try {
        if (!transactions || !original) throw new ConnectorOwnerUnavailable();
        snapshot = JSON.parse(encodeConnectorOwnerJson(input, connectorOwnerCommandBytes(kind))) as I;
        if (!snapshot || typeof snapshot.key !== 'string' || typeof snapshot.commandKey !== 'string'
          || typeof snapshot.payloadJson !== 'string' || Object.hasOwn(snapshot, 'application')) throw new ConnectorOwnerUnavailable();
        const headers = new Headers(), evidence: { -readonly [K in keyof ApplicationTransactionEvidence]: ApplicationTransactionEvidence[K] } = {};
        for (const [field, name] of [['authorization', 'authorization'], ['accessKey', 'x-agentopsdeck-key'], ['cookie', 'cookie']] as const) {
          const value = request.headers.get(name);
          if (value !== null) { headers.set(name, value); evidence[field] = value; }
        }
        if (!validApplicationTransactionEvidence(evidence)) throw new ConnectorOwnerUnavailable();
        originalRequest = new Request('http://application-stop.invalid/', { headers, signal: request.signal });
        snapshot = { ...snapshot, application: evidence };
        intent = { action: 'stop', runtime: runtime(snapshot), resource: snapshot.key, commandKey: snapshot.commandKey,
          payloadDigest: createHash('sha256').update(snapshot.payloadJson).digest('hex') };
      } catch { return Promise.reject(new ConnectorOwnerUnavailable()); }
      return runNativeOperation(() => run(originalRequest, intent, scope => original!(snapshot, scope)), wait);
    };
  }
  return Object.freeze({
    codex: lane<Input<AsyncCodexStop>, Awaited<ReturnType<AsyncCodexStop['stopPhysical']>>>(
      () => 'codex', 'codexStopClaim', participants.codex?.stopPhysical.bind(participants.codex)),
    openclaw: lane<Input<AsyncOpenClawStop>, Awaited<ReturnType<AsyncOpenClawStop['stopPhysical']>>>(
      () => 'openclaw', 'openClawStopClaim', participants.openclaw?.stopPhysical.bind(participants.openclaw)),
    hermes: lane<Input<AsyncHermesStop>, Awaited<ReturnType<AsyncHermesStop['stopPhysical']>>>(
      () => 'hermes', 'hermesStopClaim', participants.hermes?.stopPhysical.bind(participants.hermes)),
    sdk: lane<SdkMessageStopRequest, ConnectorSdkStopCommands['sdkMessageStopClaim']['output']>(
      input => input.runtime, 'sdkMessageStopClaim', participants.sdk?.stopPhysical.bind(participants.sdk)),
  });
}
