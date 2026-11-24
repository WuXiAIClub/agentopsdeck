import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { claimHermesDispatch, hermesDispatchNativeReady, hermesDispatchSeparator, planHermesDispatch,
  validHermesDispatchPlan, type HermesDispatchContext, type HermesDispatchPlan } from '../hermes/dispatch-admission.js';
import type { HermesExecution } from '../hermes/journal.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { validHermesExecution } from './connector-hermes-execution-domain.js';
import { createTurnAuthorizer } from './execution-grants.js';

export type ConnectorHermesDispatchCommands = {
  hermesDispatchPlan: { input: { key: string }; output: HermesDispatchPlan | 'blocked' | null };
  hermesDispatchClaim: { input: { key: string; digest: string; id: string; live: string; epoch: string; separator?: string }; output: HermesExecution | null };
  hermesDispatchNativeReady: { input: { execution: HermesExecution }; output: boolean };
  hermesDispatchPreparationFailed: { input: { key: string; head: string }; output: boolean };
};
export type ConnectorHermesDispatchKind = keyof ConnectorHermesDispatchCommands;
export const connectorHermesDispatchSteps = Object.freeze({ hermesDispatchPlan: 152, hermesDispatchClaim: 153, hermesDispatchNativeReady: 154, hermesDispatchPreparationFailed: 175 });
export const isConnectorHermesDispatchKind = (kind: string): kind is ConnectorHermesDispatchKind => Object.hasOwn(connectorHermesDispatchSteps, kind);
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => !!v
  && typeof v === 'object' && !Array.isArray(v) && required.every(k => Object.hasOwn(v, k))
  && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const id = (v: unknown, max = 512): v is string => typeof v === 'string' && !!v && Buffer.byteLength(v) <= max && !/[\x00-\x1f\x7f]/.test(v);
const key = (v: unknown): v is string => id(v) && v.startsWith('hermes:') && v.length > 7;
export function validConnectorHermesDispatchInput(kind: ConnectorHermesDispatchKind, v: unknown): boolean {
  if (kind === 'hermesDispatchPlan') return fields(v, ['key']) && key(v.key);
  if (kind === 'hermesDispatchPreparationFailed') return fields(v, ['key', 'head']) && key(v.key) && id(v.head);
  if (kind === 'hermesDispatchNativeReady') return fields(v, ['execution']) && validHermesExecution(v.execution)
    && v.execution.phase === 'starting' && v.execution.row === undefined;
  return fields(v, ['key', 'digest', 'id', 'live', 'epoch'], ['separator']) && key(v.key)
    && typeof v.digest === 'string' && /^[a-f0-9]{64}$/.test(v.digest) && id(v.id) && id(v.live, 1024) && id(v.epoch, 1024)
    && (!Object.hasOwn(v, 'separator') || hermesDispatchSeparator(v.separator));
}
export function validConnectorHermesDispatchOutput(kind: ConnectorHermesDispatchKind, v: unknown): boolean {
  if (kind === 'hermesDispatchPlan') return v === null || v === 'blocked' || validHermesDispatchPlan(v);
  if (kind === 'hermesDispatchNativeReady' || kind === 'hermesDispatchPreparationFailed') return typeof v === 'boolean';
  return v === null || validHermesExecution(v) && v.phase === 'starting' && v.row === undefined;
}
/** Internal worker-only original queue authority. No public caller actors,
 * permission booleans, prompt text, arbitrary SQL or native effects. */
export function executeConnectorHermesDispatch<K extends ConnectorHermesDispatchKind>(kind: K,
  input: ConnectorHermesDispatchCommands[K]['input'], owner: ConnectorUserStore, tokens?: ConnectorTokenStore): ConnectorHermesDispatchCommands[K]['output'] {
  if (!validConnectorHermesDispatchInput(kind, input) || !tokens) throw Error('connector_storage_unavailable');
  const authorize = createTurnAuthorizer(owner.executionGrants, (actor, scope) => tokens.hasScope(actor, scope));
  const context: HermesDispatchContext = { journal: owner.hermesJournal, turns: owner.turns,
    available: () => owner.sdkCommandAdmissionOpen,
    authorize: (sessionKey, payload) => authorize(payload.actorId, { runtime: 'hermes', sessionKey }, 'messages:send', payload.executionGrant) };
  let result: unknown;
  if (kind === 'hermesDispatchPlan') result = planHermesDispatch(context, (input as { key: string }).key, undefined, true);
  else if (kind === 'hermesDispatchClaim') result = claimHermesDispatch(context, input as ConnectorHermesDispatchCommands['hermesDispatchClaim']['input']);
  else if (kind === 'hermesDispatchPreparationFailed') {
    const request = input as ConnectorHermesDispatchCommands['hermesDispatchPreparationFailed']['input'];
    const head = owner.turns.head('hermes', request.key);
    // Internal denial only. No actor supplied by the caller, no native effect,
    // and never mutate a replacement head, claimed/unknown execution or deletion.
    result = false;
    if (owner.sdkCommandAdmissionOpen === true && !owner.hermesJournal.deletion(request.key)
      && owner.hermesJournal.canStart(request.key) && head?.id === request.head && head.state === 'queued') {
      owner.turns.block('hermes', head.id); result = true;
    }
  } else result = hermesDispatchNativeReady(context, (input as { execution: HermesExecution }).execution);
  if (!validConnectorHermesDispatchOutput(kind, result) || !connectorHermesDispatchReplyMatches(kind, input, result)) throw Error('connector_storage_unavailable');
  return result as ConnectorHermesDispatchCommands[K]['output'];
}
export function connectorHermesDispatchReplyMatches(kind: ConnectorHermesDispatchKind,
  input: ConnectorHermesDispatchCommands[ConnectorHermesDispatchKind]['input'], value: unknown): boolean {
  if (kind === 'hermesDispatchNativeReady' || kind === 'hermesDispatchPreparationFailed' || value === null || value === 'blocked') return true;
  if (kind === 'hermesDispatchPlan') return (value as HermesDispatchPlan).key === (input as { key: string }).key;
  const request = input as ConnectorHermesDispatchCommands['hermesDispatchClaim']['input'], e = value as HermesExecution;
  return ['key', 'id', 'live', 'epoch'].every(k => e[k as keyof HermesExecution] === request[k as keyof typeof request])
    && e.batch?.separator === request.separator;
}
