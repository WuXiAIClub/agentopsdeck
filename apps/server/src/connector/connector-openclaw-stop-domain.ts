import { createHash, randomUUID } from 'node:crypto';
import type { ApplicationTransactionClient, ApplicationTransactionEvidence, OriginalTransactionWrite } from '../auth/application-transaction-gate.js';
import { applicationStopTransaction } from './application-stop-transaction.js';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { CommandCapacity, CommandConflict } from '../commands/receipts.js';
import { requireExpectedRun, RunControlConflict } from '../commands/run-control.js';
import { normalizeSendMessageRequest } from '../messages/send-message.js';
import type { OpenClawExecution } from '../openclaw/executions.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { resolveExecutionActor, EXECUTION_GRANT_HEADER } from './execution-authority.js';
import { EXPECTED_NODE_HEADER } from './node-identity.js';
import { validConnectorOpenClawMessageInput, validConnectorOpenClawMessageOutput,
  type OpenClawMessageScope, type OpenClawMessageResult } from './connector-openclaw-message-domain.js';

export type OpenClawStopIntent = { id: string; receiptId: string; key: string; commandKey: string;
  commandId: string; runId: string; connectionId: string; digest: string };
type Failure = { error: 401 | 403 | 409 | 503 };
export type OpenClawStopResult = { result: OpenClawMessageResult; intent: OpenClawStopIntent | null };
export type ConnectorOpenClawStopCommands = {
  openClawStopClaim: { input: OpenClawMessageScope & { payloadJson: string; connectionId: string | null; application?: ApplicationTransactionEvidence }; output: Failure | OpenClawStopResult };
  openClawStopReady: { input: OpenClawMessageScope & { intent: OpenClawStopIntent }; output: boolean };
  openClawStopSettle: { input: { intent: OpenClawStopIntent; outcome: 'acknowledged' | 'not_dispatched' | 'unknown' }; output: OpenClawMessageResult | false };
  openClawStopRelease: { input: { intent: OpenClawStopIntent }; output: boolean };
};
export type ConnectorOpenClawStopKind = keyof ConnectorOpenClawStopCommands;
export const connectorOpenClawStopSteps = Object.freeze({ openClawStopClaim: 201, openClawStopReady: 202,
  openClawStopSettle: 203, openClawStopRelease: 204 });
export const isConnectorOpenClawStopKind = (kind: string): kind is ConnectorOpenClawStopKind => Object.hasOwn(connectorOpenClawStopSteps, kind);
const fields = (v: unknown, names: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const id = (v: unknown, max = 512): v is string => typeof v === 'string' && !!v && Buffer.byteLength(v) <= max && !/[\u0000-\u001f\u007f]/.test(v);
export const validOpenClawStopIntent = (v: unknown): v is OpenClawStopIntent => fields(v,
  ['id', 'receiptId', 'key', 'commandKey', 'commandId', 'runId', 'connectionId', 'digest'])
  && Object.values(v).every(x => id(x)) && /^[a-f0-9]{64}$/.test(String(v.digest));
export function validConnectorOpenClawStopInput(kind: ConnectorOpenClawStopKind, v: unknown): boolean {
  if (kind === 'openClawStopRelease') return fields(v, ['intent']) && validOpenClawStopIntent(v.intent);
  if (kind === 'openClawStopSettle') return fields(v, ['intent', 'outcome']) && validOpenClawStopIntent(v.intent)
    && ['acknowledged', 'not_dispatched', 'unknown'].includes(String(v.outcome));
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const { connectionId, payloadJson, intent, application, ...scope } = v as Record<string, unknown>;
  if (kind === 'openClawStopClaim') return !Object.hasOwn(v, 'intent') && Object.hasOwn(v, 'payloadJson') && Object.hasOwn(v, 'connectionId')
    && validConnectorOpenClawMessageInput('openClawMessageReceiptRead', scope)
    && (connectionId === null || id(connectionId)) && validConnectorOpenClawMessageInput('openClawMessageClaim', { ...scope, payloadJson, defaultAgentId: 'main',
      ...(Object.hasOwn(v, 'application') ? { application } : {}) });
  return !Object.hasOwn(v, 'application') && !Object.hasOwn(v, 'connectionId') && !Object.hasOwn(v, 'payloadJson') && validOpenClawStopIntent(intent)
    && intent.key === scope.key && intent.commandKey === scope.commandKey
    && validConnectorOpenClawMessageInput('openClawMessageReceiptRead', scope);
}
export function validConnectorOpenClawStopOutput(kind: ConnectorOpenClawStopKind, v: unknown): boolean {
  if (kind === 'openClawStopReady' || kind === 'openClawStopRelease') return typeof v === 'boolean';
  if (kind === 'openClawStopSettle') return v === false || validResult(v);
  if (fields(v, ['error'])) return typeof v.error === 'number' && [401, 403, 409, 503].includes(v.error);
  return fields(v, ['result', 'intent']) && validResult(v.result)
    && (v.intent === null || validOpenClawStopIntent(v.intent)
      && v.result.key === v.intent.key && v.result.commandKey === v.intent.commandKey
      && v.result.receipt?.state === 'outcome_unknown' && v.result.receipt.id === v.intent.receiptId);
}
const validResult = (v: unknown): v is OpenClawMessageResult => !!v && typeof v === 'object' && !('error' in v)
  && validConnectorOpenClawMessageOutput('openClawMessageReceiptRead', v);
type Binding = { intent: OpenClawStopIntent; scope: string; actor: string; token: string; dispatched: boolean; applicationReady?: OriginalTransactionWrite };
const active = new WeakMap<ConnectorUserStore, Map<string, Binding>>();
export const disposeOpenClawStopIntents = (owner: ConnectorUserStore) => { active.delete(owner); };
const digest = (fact: OpenClawExecution) => createHash('sha256').update(JSON.stringify(fact)).digest('hex');
function currentActor(input: OpenClawMessageScope, owner: ConnectorUserStore, tokens: ConnectorTokenStore) {
  if (input.expectedNode !== undefined && input.expectedNode !== owner.nodeId) throw new RunControlConflict();
  const headers = new Headers({ authorization: input.authorization });
  if (input.grantId !== undefined) headers.set(EXECUTION_GRANT_HEADER, input.grantId);
  if (input.expectedNode !== undefined) headers.set(EXPECTED_NODE_HEADER, input.expectedNode);
  const actor = resolveExecutionActor(new Request('http://connector.invalid', { headers }), { tokens, grants: owner.executionGrants, nodeId: owner.nodeId },
    { runtime: 'openclaw', sessionKey: input.key }, 'runs:interrupt');
  if (!actor.principal.scopes.includes('messages:send')) throw new RunControlConflict();
  return actor;
}
export async function executeConnectorOpenClawStop<K extends ConnectorOpenClawStopKind>(kind: K,
  request: ConnectorOpenClawStopCommands[K]['input'], owner: ConnectorUserStore, tokens?: ConnectorTokenStore,
  applicationTransactions?: ApplicationTransactionClient): Promise<ConnectorOpenClawStopCommands[K]['output']> {
  if (!validConnectorOpenClawStopInput(kind, request)) throw Error('connector_storage_unavailable');
  const bindings = active.get(owner) ?? new Map<string, Binding>(); active.set(owner, bindings);
  const input = structuredClone(request);
  const result = (scope: string, key: string, commandKey: string): OpenClawMessageResult => ({ key, commandKey,
    receipt: owner.commands.get(scope, commandKey) ?? null, queue: { presence: 'unknown' }, intent: null, admitted: false });
  let value: unknown;
  if (kind === 'openClawStopClaim') {
    const p = input as ConnectorOpenClawStopCommands['openClawStopClaim']['input'];
    if (!tokens?.authenticateAuthorization(p.authorization)) return { error: 401 } as ConnectorOpenClawStopCommands[K]['output'];
    let actor: ReturnType<typeof currentActor>;
    try { actor = currentActor(p, owner, tokens); } catch { return { error: 403 } as ConnectorOpenClawStopCommands[K]['output']; }
    const scope = JSON.stringify([actor.actorId, p.key]), body = JSON.parse(p.payloadJson);
    const transaction = applicationStopTransaction('openclaw', p, applicationTransactions);
    const check = () => {
      try { const a = currentActor(p, owner, tokens); if (a.actorId === actor.actorId && a.principal.tokenId === actor.principal.tokenId) return; } catch { /* Current authority denied. */ }
      throw new RunControlConflict();
    };
    let created: Binding | undefined;
    try {
      const claimed = await owner.commands.claimAsync(scope, p.commandKey, body, false, undefined,
        () => owner.sdkCommandAdmissionOpen && bindings.size < 128, receiptId => {
          const normalized = normalizeSendMessageRequest(body);
          const reject = (status: 400 | 409) => ({ metadata: { runtime: 'openclaw-stop' }, complete: { status, body: { error: 'Command rejected' } } });
          if ('error' in normalized || normalized.media.length) return reject(400);
          if (normalized.message.trim() !== '/stop' || normalized.deliveryMode === 'mirror' || actor.executionGrant) return reject(409);
          let commandId: string; try { commandId = requireExpectedRun(normalized.expectedRunId); } catch { return reject(409); }
          const fact = owner.openClawExecutions.recoveryCandidate(p.key, p.connectionId ?? undefined);
          if (!p.connectionId || !fact?.runId || fact.commandId !== commandId) return reject(409);
          created = { scope, actor: actor.actorId, token: actor.principal.tokenId, dispatched: false, ...(transaction ? { applicationReady: transaction.ready } : {}),
            intent: { id: randomUUID(), receiptId, key: p.key, commandKey: p.commandKey, commandId,
              runId: fact.runId, connectionId: p.connectionId!, digest: digest(fact) } };
          return { metadata: { runtime: 'openclaw-stop' } };
        }, false, check, check, transaction?.claim);
      check();
      if (claimed.fresh && created && claimed.receipt.id === created.intent.receiptId && claimed.receipt.state === 'outcome_unknown') bindings.set(created.intent.receiptId, created);
      value = { result: result(scope, p.key, p.commandKey), intent: claimed.fresh && created && bindings.has(created.intent.receiptId) ? created.intent : null };
    } catch (error) {
      if (error instanceof CommandConflict) value = { error: 409 };
      else if (error instanceof CommandCapacity) value = { error: 503 };
      else if (error instanceof RunControlConflict) value = { error: 403 };
      else throw error;
    }
  } else {
    const p = input as { intent: OpenClawStopIntent; outcome?: 'acknowledged' | 'not_dispatched' | 'unknown' } & OpenClawMessageScope;
    const b = bindings.get(p.intent.receiptId);
    const matches = b && (Object.keys(b.intent) as (keyof OpenClawStopIntent)[]).every(k => b.intent[k] === p.intent[k]);
    if (kind === 'openClawStopRelease') value = !!matches && bindings.delete(p.intent.receiptId);
    else if (!matches || owner.commands.get(b.scope, b.intent.commandKey)?.id !== p.intent.receiptId
      || owner.commands.get(b.scope, b.intent.commandKey)?.state !== 'outcome_unknown') value = false;
    else if (kind === 'openClawStopReady') {
      const ready = () => {
      const fact = owner.openClawExecutions.recoveryCandidate(p.key, b.intent.connectionId);
      let permitted = false;
      try { if (tokens) { const a = currentActor(p, owner, tokens); permitted = a.actorId === b.actor && a.principal.tokenId === b.token && !a.executionGrant; } } catch { /* veto */ }
      value = !b.dispatched && permitted && owner.sdkCommandAdmissionOpen && !!fact && digest(fact) === b.intent.digest;
      if (value) b.dispatched = true;
      };
      if (b.applicationReady) await b.applicationReady(ready); else ready();
    } else if (p.outcome === 'acknowledged' && !b.dispatched) value = false;
    else {
      if (p.outcome !== 'unknown') owner.commands.settle(b.scope, b.intent.commandKey, p.outcome === 'acknowledged'
        ? { status: 200, body: { ok: true, runId: b.intent.commandId, status: 'interrupt_requested', idempotencyKey: b.intent.commandKey, media: [] } }
        : { status: 409, body: { error: 'Command rejected' } });
      bindings.delete(p.intent.receiptId); value = result(b.scope, b.intent.key, b.intent.commandKey);
    }
  }
  if (!validConnectorOpenClawStopOutput(kind, value)) throw Error('connector_storage_unavailable');
  return value as ConnectorOpenClawStopCommands[K]['output'];
}
