import { randomUUID } from 'node:crypto';
import type { ApplicationTransactionClient, ApplicationTransactionEvidence, OriginalTransactionWrite } from '../auth/application-transaction-gate.js';
import { applicationStopTransaction } from './application-stop-transaction.js';
import { HTTPException } from 'hono/http-exception';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { CommandCapacity, CommandConflict } from '../commands/receipts.js';
import { requireExpectedRun, RunControlConflict } from '../commands/run-control.js';
import { normalizeSendMessageRequest } from '../messages/send-message.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { resolveExecutionActor, EXECUTION_GRANT_HEADER } from './execution-authority.js';
import { EXPECTED_NODE_HEADER } from './node-identity.js';
import { validConnectorCodexMessageInput, validConnectorCodexMessageOutput,
  type CodexMessageScope, type CodexMessageResult } from './connector-codex-message-domain.js';

export type CodexStopIntent = { id: string; receiptId: string; key: string; commandKey: string;
  commandId: string | null; runId: string; connectionId: string };
export type CodexStopObservation = { pendingCommandTools: string[]; cleanupRecovered: boolean };
type Failure = { error: 401 | 403 | 409 | 503 };
type Ref = CodexMessageScope & { intent: CodexStopIntent };
export type ConnectorCodexStopCommands = {
  codexStopClaim: { input: CodexMessageScope & { payloadJson: string; connectionId: string | null; application?: ApplicationTransactionEvidence }; output: Failure | { result: CodexMessageResult; intent: CodexStopIntent | null } };
  codexStopReady: { input: Ref; output: boolean };
  codexStopCheck: { input: Ref & { afterInterrupt: boolean }; output: false | CodexStopObservation };
  codexStopSettle: { input: { intent: CodexStopIntent; outcome: 'acknowledged' | 'not_dispatched' | 'unknown' }; output: false | CodexMessageResult };
  codexStopRelease: { input: { intent: CodexStopIntent }; output: boolean };
  codexStopReceiptRead: { input: CodexMessageScope; output: Failure | CodexMessageResult };
};
export type ConnectorCodexStopKind = keyof ConnectorCodexStopCommands;
export const connectorCodexStopSteps = Object.freeze({ codexStopClaim: 233, codexStopReady: 234,
  codexStopCheck: 235, codexStopSettle: 236, codexStopRelease: 237, codexStopReceiptRead: 238 });
export const isConnectorCodexStopKind = (k: string): k is ConnectorCodexStopKind => Object.hasOwn(connectorCodexStopSteps, k);
const fields = (v: unknown, names: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const id = (v: unknown, max = 512): v is string => typeof v === 'string' && !!v && Buffer.byteLength(v) <= max && !/[\x00-\x1f\x7f]/.test(v);
const validIntent = (v: unknown): v is CodexStopIntent => fields(v,
  ['id', 'receiptId', 'key', 'commandKey', 'commandId', 'runId', 'connectionId'])
  && id(v.id) && id(v.receiptId) && (v.commandId === null || id(v.commandId)) && id(v.runId) && id(v.connectionId)
  && validConnectorCodexMessageInput('codexMessageReceiptRead', { key: v.key, commandKey: v.commandKey, authorization: 'internal' });
export function validConnectorCodexStopInput(k: ConnectorCodexStopKind, v: unknown): boolean {
  if (k === 'codexStopReceiptRead') return validConnectorCodexMessageInput('codexMessageReceiptRead', v);
  if (k === 'codexStopRelease') return fields(v, ['intent']) && validIntent(v.intent);
  if (k === 'codexStopSettle') return fields(v, ['intent', 'outcome']) && validIntent(v.intent)
    && ['acknowledged', 'not_dispatched', 'unknown'].includes(String(v.outcome));
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const { intent, payloadJson, connectionId, afterInterrupt, ...scope } = v as Record<string, unknown>;
  if (k === 'codexStopClaim') return !Object.hasOwn(v, 'intent') && !Object.hasOwn(v, 'afterInterrupt')
    && Object.hasOwn(v, 'connectionId') && (connectionId === null || id(connectionId))
    && validConnectorCodexMessageInput('codexMessageClaim', { ...scope, payloadJson });
  return !Object.hasOwn(v, 'payloadJson') && !Object.hasOwn(v, 'connectionId') && validIntent(intent)
    && intent.key === scope.key && intent.commandKey === scope.commandKey
    && (k === 'codexStopCheck' ? typeof afterInterrupt === 'boolean' : !Object.hasOwn(v, 'afterInterrupt'))
    && validConnectorCodexMessageInput('codexMessageReceiptRead', scope);
}
const validResult = (v: unknown): v is CodexMessageResult => !!v && typeof v === 'object' && !('error' in v)
  && validConnectorCodexMessageOutput('codexMessageReceiptRead', v)
  && (v as CodexMessageResult).intent === null && (v as CodexMessageResult).admitted === false;
export function validConnectorCodexStopOutput(k: ConnectorCodexStopKind, v: unknown): boolean {
  if (k === 'codexStopReceiptRead') return validResult(v) || fields(v, ['error']) && typeof v.error === 'number' && [401, 403, 409, 503].includes(v.error);
  if (k === 'codexStopReady' || k === 'codexStopRelease') return typeof v === 'boolean';
  if (k === 'codexStopCheck') return v === false || fields(v, ['pendingCommandTools', 'cleanupRecovered'])
    && Array.isArray(v.pendingCommandTools) && v.pendingCommandTools.length <= 4096 && v.pendingCommandTools.every(x => id(x, 4096))
    && typeof v.cleanupRecovered === 'boolean';
  if (k === 'codexStopSettle') return v === false || validResult(v);
  if (fields(v, ['error'])) return typeof v.error === 'number' && [401, 403, 409, 503].includes(v.error);
  return fields(v, ['result', 'intent']) && validResult(v.result)
    && (v.intent === null || validIntent(v.intent) && v.result.key === v.intent.key
      && v.result.commandKey === v.intent.commandKey && v.result.receipt?.id === v.intent.receiptId
      && v.result.receipt.state === 'outcome_unknown');
}
type Actor = ReturnType<typeof resolveExecutionActor>;
type Binding = { scope: string; actor: Actor; intent: CodexStopIntent; ready: boolean; applicationReady?: OriginalTransactionWrite };
const active = new WeakMap<ConnectorUserStore, Map<string, Binding>>();
export function disposeCodexStopIntents(owner: ConnectorUserStore) { active.delete(owner); }
function actorFor(p: CodexMessageScope, owner: ConnectorUserStore, tokens: ConnectorTokenStore): Actor {
  if (p.expectedNode !== undefined && p.expectedNode !== owner.nodeId) throw new RunControlConflict();
  const headers = new Headers({ authorization: p.authorization });
  if (p.grantId !== undefined) headers.set(EXECUTION_GRANT_HEADER, p.grantId);
  if (p.expectedNode !== undefined) headers.set(EXPECTED_NODE_HEADER, p.expectedNode);
  const actor = resolveExecutionActor(new Request('http://connector.invalid', { headers }), { tokens, grants: owner.executionGrants, nodeId: owner.nodeId },
    { runtime: 'codex', sessionKey: p.key }, 'runs:interrupt');
  if (!actor.principal.scopes.includes('messages:send')) throw new RunControlConflict();
  return actor;
}
const sameActor = (a: Actor, b: Actor) => a.actorId === b.actorId && a.principal.tokenId === b.principal.tokenId
  && a.executionGrant?.id === b.executionGrant?.id && a.executionGrant?.issuerTokenId === b.executionGrant?.issuerTokenId;
export async function executeConnectorCodexStop<K extends ConnectorCodexStopKind>(kind: K, input: ConnectorCodexStopCommands[K]['input'],
  owner: ConnectorUserStore, tokens?: ConnectorTokenStore, applicationTransactions?: ApplicationTransactionClient): Promise<ConnectorCodexStopCommands[K]['output']> {
  if (!validConnectorCodexStopInput(kind, input)) throw Error('connector_storage_unavailable');
  const bindings = active.get(owner) ?? new Map<string, Binding>(); active.set(owner, bindings);
  const result = (scope: string, p: { key: string; commandKey: string }): CodexMessageResult => ({ key: p.key, commandKey: p.commandKey,
    receipt: owner.commands.get(scope, p.commandKey) ?? null, queue: { presence: 'unknown' }, intent: null, admitted: false });
  const factAllowed = (intent: CodexStopIntent, after: boolean) => {
    const fact = owner.codexExecutions.get(intent.key);
    // The public execution fact hides its internal fence bit; fenced facts
    // are represented as phase=unknown and cannot satisfy the phase gate.
    return intent.commandId === null ? !fact : !!fact && !fact.preparation
      && fact.commandId === intent.commandId && fact.runId === intent.runId
      && fact.connectionId === intent.connectionId && (fact.phase === 'running' || after && ['completed', 'failed', 'interrupted'].includes(fact.phase))
      && fact.nativeHistory?.state !== 'blocked';
  };
  let value: unknown;
  if (kind === 'codexStopReceiptRead') {
    const p = input as CodexMessageScope;
    if (!tokens?.authenticateAuthorization(p.authorization)) value = { error: 401 };
    else { try { value = result(JSON.stringify([actorFor(p, owner, tokens).actorId, p.key]), p); } catch { value = { error: 403 }; } }
  } else if (kind === 'codexStopClaim') {
    const p = input as ConnectorCodexStopCommands['codexStopClaim']['input'];
    if (!tokens?.authenticateAuthorization(p.authorization)) return { error: 401 } as ConnectorCodexStopCommands[K]['output'];
    let actor: Actor; try { actor = actorFor(p, owner, tokens); } catch { return { error: 403 } as ConnectorCodexStopCommands[K]['output']; }
    const scope = JSON.stringify([actor.actorId, p.key]); let created: Binding | undefined;
    const transaction = applicationStopTransaction('codex', p, applicationTransactions);
    const check = () => { if (!sameActor(actorFor(p, owner, tokens), actor)) throw new RunControlConflict(); };
    try {
      const claimed = await owner.commands.claimAsync(scope, p.commandKey, JSON.parse(p.payloadJson), false, undefined,
        () => !!owner.runtimeOwnerFile && bindings.size < 128, receiptId => {
          const normalized = normalizeSendMessageRequest(JSON.parse(p.payloadJson));
          const reject = (status: 400 | 409) => ({ metadata: { runtime: 'codex-stop' }, complete: { status, body: { error: 'Command rejected' } } });
          if ('error' in normalized || normalized.media.length) return reject(400);
          if (normalized.message !== '/stop' || normalized.deliveryMode === 'mirror' || !p.connectionId || owner.commands.sessionDeletion(p.key)) return reject(409);
          let runId: string; try { runId = requireExpectedRun(normalized.expectedRunId); } catch { return reject(409); }
          const fact = owner.codexExecutions.get(p.key);
          const intent: CodexStopIntent = { id: randomUUID(), receiptId, key: p.key, commandKey: p.commandKey,
            commandId: fact?.commandId ?? null, runId, connectionId: p.connectionId };
          if (!validIntent(intent) || !factAllowed(intent, false)) return reject(409);
          created = { scope, actor, intent, ready: false, ...(transaction ? { applicationReady: transaction.ready } : {}) };
          return { metadata: { runtime: 'codex-stop' } };
        }, false, check, check, transaction?.claim);
      check();
      if (claimed.fresh && created && claimed.receipt.id === created.intent.receiptId && claimed.receipt.state === 'outcome_unknown') bindings.set(created.intent.receiptId, created);
      value = { result: result(scope, p), intent: claimed.fresh && created && bindings.has(created.intent.receiptId) ? created.intent : null };
    } catch (error) {
      if (error instanceof CommandConflict) value = { error: 409 };
      else if (error instanceof CommandCapacity) value = { error: 503 };
      else if (error instanceof RunControlConflict || error instanceof HTTPException) value = { error: 403 };
      else throw error;
    }
  } else {
    const p = input as Ref & { afterInterrupt?: boolean; outcome?: 'acknowledged' | 'not_dispatched' | 'unknown' };
    const b = bindings.get(p.intent.receiptId);
    const matches = b && (Object.keys(b.intent) as (keyof CodexStopIntent)[]).every(k => b.intent[k] === p.intent[k]);
    if (kind === 'codexStopRelease') value = !!matches && bindings.delete(p.intent.receiptId);
    else if (!matches || owner.commands.get(b.scope, b.intent.commandKey)?.id !== p.intent.receiptId) value = false;
    else if (kind === 'codexStopSettle') {
      const receipt = owner.commands.get(b.scope, b.intent.commandKey)!;
      if (p.outcome === 'acknowledged' && !b.ready) value = false;
      else {
        if (receipt.state === 'outcome_unknown' && p.outcome !== 'unknown') owner.commands.settle(b.scope, b.intent.commandKey, p.outcome === 'acknowledged'
          ? { status: 200, body: { ok: true, runId: b.intent.runId, status: 'interrupt_requested', idempotencyKey: b.intent.commandKey, media: [] } }
          : { status: 409, body: { error: 'Command rejected' } });
        value = result(b.scope, b.intent);
      }
    } else {
      const ready = () => {
      let permitted = false;
      try { permitted = !!tokens && sameActor(actorFor(p, owner, tokens), b.actor); } catch { /* Current authority veto. */ }
      const receipt = owner.commands.get(b.scope, b.intent.commandKey)!;
      const after = kind === 'codexStopCheck' && p.afterInterrupt === true;
      const allowed = permitted && !!owner.runtimeOwnerFile && !owner.commands.sessionDeletion(b.intent.key)
        && (receipt.state === 'outcome_unknown' || after && receipt.state === 'accepted') && factAllowed(b.intent, after);
      if (kind === 'codexStopReady') { value = !b.ready && allowed; if (value) b.ready = true; }
      else value = b.ready && allowed ? { pendingCommandTools: owner.codexExecutions.get(b.intent.key)?.pendingCommandTools ?? [],
        cleanupRecovered: owner.codexExecutions.cleanupRecovered(b.intent.key, b.intent.runId) } : false;
      };
      if (b.applicationReady) await b.applicationReady(ready); else ready();
    }
  }
  if (!validConnectorCodexStopOutput(kind, value)) throw Error('connector_storage_unavailable');
  return value as ConnectorCodexStopCommands[K]['output'];
}
