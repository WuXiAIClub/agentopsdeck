import { createHash } from 'node:crypto';
import type { ApplicationCommandIntent, ApplicationCommandScope, createApplicationCommandScopes } from './auth/application-command-scope.js';
import type { AsyncCodexMessages } from './connector/async-codex-messages.js';
import type { AsyncOpenClawMessages } from './connector/async-openclaw-messages.js';
import type { AsyncSdkMessages } from './connector/async-sdk-messages.js';
import type { AsyncHermesMessages } from './connector/async-hermes-messages.js';
import { ConnectorOwnerUnavailable, connectorOwnerCommandBytes, encodeConnectorOwnerJson } from './connector/connector-owner-domain.js';
import { runNativeOperation } from './connector/native-operation.js';
import { validApplicationTransactionEvidence, type ApplicationTransactionEvidence } from './auth/application-transaction-gate.js';

type Commands = Pick<ReturnType<typeof createApplicationCommandScopes>, 'run'>;
type Wait = { timeoutMs: number; signal?: AbortSignal };
type Send<Messages extends { sendPhysical: (...args: never[]) => unknown }> = Parameters<Messages['sendPhysical']>[0];
type Participant<Messages> = Pick<Messages, 'sendPhysical' & keyof Messages>;

/** Original application observation PLUS actual Connector authority, never a
 * translation between the two. Fixed, internal message ingress; not an HTTP
 * registrar, actor factory or retry loop. Only a constructor-paired lane may
 * attach raw evidence for its actual Auth-worker SQL gate; the observation
 * scope itself is never a transferable transaction permission.
 *
 * Lifetime: HTTP wait -> original application scope -> complete physical
 * message chain. Only the outer waiter expires. The scope and both original
 * owners retain late SQL ACKs, notifications and retirement through shutdown. */
export function createApplicationMessageIngress(commands: Commands, participants: {
  codex?: Participant<AsyncCodexMessages>;
  openclaw?: Participant<AsyncOpenClawMessages>;
  sdk?: Participant<AsyncSdkMessages>;
  hermes?: Participant<AsyncHermesMessages>;
}, options: { sdkTransactions?: boolean; messageTransactions?: boolean } = {}) {
  const run = commands.run.bind(commands);
  const sdkTransactions = options.sdkTransactions === true;
  const messageTransactions = options.messageTransactions === true;
  function lane<Input extends { key: string; commandKey: string; payloadJson: string }, Result>(
    runtime: (input: Input) => ApplicationCommandIntent['runtime'],
    kind: 'codexMessageClaim' | 'openClawMessageClaim' | 'sdkMessageSend' | 'hermesMessageSend',
    original?: (input: Input, authority?: ApplicationCommandScope) => Promise<Result>,
  ) {
    return (request: Request, input: Input, wait: Wait): Promise<Result> => {
      let snapshot: Input, intent: ApplicationCommandIntent, originalRequest: Request;
      try {
        if (!original) throw new ConnectorOwnerUnavailable();
        // Pin before original identity I/O. No getters/toJSON, mutable input,
        // credential substitution or shared caller-owned options in the task.
        snapshot = JSON.parse(encodeConnectorOwnerJson(input, connectorOwnerCommandBytes(kind))) as Input;
        if (!snapshot || typeof snapshot.key !== 'string' || typeof snapshot.commandKey !== 'string'
          || typeof snapshot.payloadJson !== 'string' || Object.hasOwn(snapshot, 'application')) throw new ConnectorOwnerUnavailable();
        const headers = new Headers(), evidence: { -readonly [K in keyof ApplicationTransactionEvidence]: ApplicationTransactionEvidence[K] } = {};
        for (const [field, name] of [['authorization', 'authorization'], ['accessKey', 'x-agentopsdeck-key'], ['cookie', 'cookie']] as const) {
          const value = request.headers.get(name);
          if (value !== null) { headers.set(name, value); evidence[field] = value; }
        }
        // Both observation and transaction use the SAME pinned original
        // credentials. Neither caller input nor later Headers mutation may
        // substitute a more privileged principal between the two boundaries.
        originalRequest = new Request('http://application-ingress.invalid/', { headers, signal: request.signal });
        if (messageTransactions || kind === 'sdkMessageSend' && sdkTransactions) {
          if (!validApplicationTransactionEvidence(evidence)) throw new ConnectorOwnerUnavailable();
          snapshot = { ...snapshot, application: evidence };
        }
        intent = { action: 'message', runtime: runtime(snapshot), resource: snapshot.key,
          commandKey: snapshot.commandKey, payloadDigest: createHash('sha256').update(snapshot.payloadJson).digest('hex') };
      } catch { return Promise.reject(new ConnectorOwnerUnavailable()); }
      return runNativeOperation(() => run(originalRequest, intent, scope => original!(snapshot, scope)), wait);
    };
  }
  return Object.freeze({
    codex: lane<Send<AsyncCodexMessages>, Awaited<ReturnType<AsyncCodexMessages['sendPhysical']>>>(
      () => 'codex', 'codexMessageClaim', participants.codex?.sendPhysical.bind(participants.codex)),
    openclaw: lane<Send<AsyncOpenClawMessages>, Awaited<ReturnType<AsyncOpenClawMessages['sendPhysical']>>>(
      () => 'openclaw', 'openClawMessageClaim', participants.openclaw?.sendPhysical.bind(participants.openclaw)),
    sdk: lane<Send<AsyncSdkMessages>, Awaited<ReturnType<AsyncSdkMessages['sendPhysical']>>>(
      input => input.runtime, 'sdkMessageSend', participants.sdk?.sendPhysical.bind(participants.sdk)),
    hermes: lane<Send<AsyncHermesMessages>, Awaited<ReturnType<AsyncHermesMessages['sendPhysical']>>>(
      () => 'hermes', 'hermesMessageSend', participants.hermes?.sendPhysical.bind(participants.hermes)),
  });
}
