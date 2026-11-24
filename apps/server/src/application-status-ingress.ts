import { createHash } from 'node:crypto';
import type { ApplicationCommandIntent, ApplicationCommandScope, createApplicationCommandScopes } from './auth/application-command-scope.js';
import { validApplicationTransactionEvidence, type ApplicationTransactionEvidence } from './auth/application-transaction-gate.js';
import type { AsyncOpenClawStatus } from './connector/async-openclaw-status.js';
import type { AsyncHermesLocalControl } from './connector/async-hermes-local-control.js';
import type { AsyncSdkStatus } from './connector/async-sdk-status.js';
import { ConnectorOwnerUnavailable, connectorOwnerCommandBytes, encodeConnectorOwnerJson } from './connector/connector-owner-domain.js';
import { runNativeOperation } from './connector/native-operation.js';

export type ApplicationStatusParticipants = {
  openclaw?: Pick<AsyncOpenClawStatus, 'sendPhysical' | 'readPhysical'> | undefined;
  hermes?: Pick<AsyncHermesLocalControl, 'sendPhysical' | 'readPhysical'> | undefined;
  sdk?: Pick<AsyncSdkStatus, 'sendPhysical' | 'readPhysical'> | undefined;
};
type Runtime = ApplicationCommandIntent['runtime'];
type Scope = { key: string; commandKey: string; authorization: string };
type Wait = { timeoutMs: number; signal?: AbortSignal };

/** Local immutable reports use the original control transaction, never a
 * synthetic actor. Recovery reads/project the original IDs without admission.
 * Every projection remains inside its original physical application scope. */
export function createApplicationStatusIngress(commands: Pick<ReturnType<typeof createApplicationCommandScopes>, 'run'>,
  participants: ApplicationStatusParticipants, options: { transactions: boolean }) {
  const run = commands.run.bind(commands), transactions = options.transactions === true;
  function lane<I extends Scope & { payloadJson: string }, R>(runtime: (input: I) => Runtime, kind: string,
    original?: (input: I, authority?: ApplicationCommandScope) => Promise<R>) {
    return (request: Request, input: I, wait: Wait): Promise<R> => {
      let snapshot: I, originalRequest: Request;
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
        originalRequest = new Request('http://application-status.invalid/', { headers, signal: request.signal });
        snapshot = { ...snapshot, application: evidence };
      } catch { return Promise.reject(new ConnectorOwnerUnavailable()); }
      return runNativeOperation(() => run(originalRequest, { action: 'message', runtime: runtime(snapshot),
        resource: snapshot.key, commandKey: snapshot.commandKey,
        payloadDigest: createHash('sha256').update(snapshot.payloadJson).digest('hex') }, scope => original!(snapshot, scope)), wait);
    };
  }
  return Object.freeze({
    openclaw: lane<Parameters<AsyncOpenClawStatus['sendPhysical']>[0], Awaited<ReturnType<AsyncOpenClawStatus['sendPhysical']>>>(
      () => 'openclaw', 'openClawStatus', participants.openclaw?.sendPhysical.bind(participants.openclaw)),
    hermes: lane<Parameters<AsyncHermesLocalControl['sendPhysical']>[0], Awaited<ReturnType<AsyncHermesLocalControl['sendPhysical']>>>(
      () => 'hermes', 'hermesLocalControl', participants.hermes?.sendPhysical.bind(participants.hermes)),
    sdk: lane<Parameters<AsyncSdkStatus['sendPhysical']>[0], Awaited<ReturnType<AsyncSdkStatus['sendPhysical']>>>(
      input => input.runtime, 'sdkMessageStatus', participants.sdk?.sendPhysical.bind(participants.sdk)),
    async recoverPhysical(runtime: Runtime, input: Scope, authority: ApplicationCommandScope): Promise<void> {
      // Codex /status is an ordinary model message. Other absent runtimes have
      // no report to project; the original receipt reader still checks them.
      const result = runtime === 'claude-code' || runtime === 'ghcp'
        ? await participants.sdk?.readPhysical({ ...input, runtime }, authority)
        : runtime === 'openclaw' ? await participants.openclaw?.readPhysical(input, authority)
        : runtime === 'hermes' ? await participants.hermes?.readPhysical(input, authority) : undefined;
      if (result && 'error' in result) throw new ConnectorOwnerUnavailable();
    },
  });
}
