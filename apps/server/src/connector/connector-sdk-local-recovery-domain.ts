import type { CommandReceipt } from '@agentopsdeck/shared';
import type { ConnectorUserStore } from './connector-user-store.js';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import type { SdkAgentId } from './sdk-execution-journal.js';
import { validConnectorSdkLocalInput, validConnectorSdkLocalOutput } from './connector-sdk-local-domain.js';

type Scope = { runtime: SdkAgentId; authorization: string; commandKey: string };
type Input = Scope & ({ operation: 'create' } | { operation: 'settings'; key: string });
type Result = { operation: 'create' | 'settings'; runtime: SdkAgentId; key: string | null; commandKey: string;
  receipt: CommandReceipt | null; settingsStartReleased: boolean };
export type ConnectorSdkLocalRecoveryCommands = {
  sdkLocalReceiptRead: { input: Input; output: Result | { error: 401 | 403 } };
};
export const connectorSdkLocalRecoverySteps = Object.freeze({ sdkLocalReceiptRead: 91 });
export type ConnectorSdkLocalRecoveryKind = keyof ConnectorSdkLocalRecoveryCommands;
export const isConnectorSdkLocalRecoveryKind = (kind: string): kind is ConnectorSdkLocalRecoveryKind => Object.hasOwn(connectorSdkLocalRecoverySteps, kind);
const fields = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));

export function validConnectorSdkLocalRecoveryInput(v: unknown): v is Input {
  if (!v || typeof v !== 'object') return false;
  const p = v as Input;
  if (p.operation !== 'create' && p.operation !== 'settings') return false;
  if (!fields(v, ['operation', 'runtime', 'authorization', 'commandKey', ...(p.operation === 'settings' ? ['key'] : [])])) return false;
  const { operation, ...scope } = p;
  return validConnectorSdkLocalInput(operation === 'create' ? 'sdkSessionCreate' : 'sdkModelUpdate', { ...scope, payloadJson: '{}' });
}

export function validConnectorSdkLocalRecoveryOutput(v: unknown): boolean {
  if (fields(v, ['error'])) return v.error === 401 || v.error === 403;
  if (!fields(v, ['operation', 'runtime', 'key', 'commandKey', 'receipt', 'settingsStartReleased'])
    || v.operation !== 'create' && v.operation !== 'settings' || typeof v.settingsStartReleased !== 'boolean') return false;
  if (!validConnectorSdkLocalRecoveryInput({ operation: v.operation, runtime: v.runtime, authorization: 'Bearer validation', commandKey: v.commandKey,
    ...(v.operation === 'settings' ? { key: v.key } : {}) })) return false;
  if (v.receipt === null) return !v.settingsStartReleased && (v.operation !== 'create' || v.key === null);
  if (!validConnectorSdkLocalOutput(v.operation === 'create' ? 'sdkSessionCreate' : 'sdkModelUpdate',
    { runtime: v.runtime, key: v.key, receipt: v.receipt }, true)) return false;
  const receipt = v.receipt as CommandReceipt;
  return receipt.key === v.commandKey && (!v.settingsStartReleased || v.operation === 'settings' && receipt.state === 'outcome_unknown');
}

/** Original actor-scoped read ONLY. Missing is not proof that submission failed.
 * Do not claim, settle, release a settings fence, recover prewrites or replay.
 * No model catalog/readiness dependency: recovery must work while paused or
 * with a disabled provider. Current token authority remains mandatory. */
export function executeConnectorSdkLocalRecovery(input: Input, owner: ConnectorUserStore, tokens?: ConnectorTokenStore): ConnectorSdkLocalRecoveryCommands['sdkLocalReceiptRead']['output'] {
  if (!validConnectorSdkLocalRecoveryInput(input)) throw Error('connector_storage_unavailable');
  const actor = tokens?.authenticateAuthorization(input.authorization);
  if (!actor) return { error: 401 };
  if (actor.tokenId.startsWith('actor_') || !actor.scopes.includes('sessions:create') || actor.scopes.includes('execution:delegate')) return { error: 403 };
  const scope = JSON.stringify([input.operation, JSON.stringify([actor.tokenId, input.operation === 'create' ? input.runtime : input.key])]);
  const receipt = owner.commands.get(scope, input.commandKey) ?? null;
  const key = input.operation === 'settings' ? input.key
    : receipt?.state === 'accepted' && typeof receipt.result?.body.key === 'string' ? receipt.result.body.key : null;
  const result: Result = { operation: input.operation, runtime: input.runtime, key, commandKey: input.commandKey, receipt,
    settingsStartReleased: input.operation === 'settings' && receipt?.state === 'outcome_unknown' && owner.commands.settingsStartReleased(scope, input.commandKey) };
  if (!validConnectorSdkLocalRecoveryOutput(result)) throw Error('connector_storage_unavailable');
  return result;
}
