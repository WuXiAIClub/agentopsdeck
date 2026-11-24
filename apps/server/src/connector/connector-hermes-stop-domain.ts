import type { CommandReceipt } from '@agentopsdeck/shared';
import type { ApplicationTransactionClient, ApplicationTransactionEvidence, OriginalTransactionWrite } from '../auth/application-transaction-gate.js';
import { applicationStopTransaction } from './application-stop-transaction.js';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { CommandCapacity, CommandConflict } from '../commands/receipts.js';
import type { HermesExecution } from '../hermes/journal.js';
import { normalizeSendMessageRequest } from '../messages/send-message.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { validHermesExecution } from './connector-hermes-execution-domain.js';
import { validConnectorHermesMessageInput, validConnectorHermesMessageOutput, type ConnectorHermesMessageCommands } from './connector-hermes-message-domain.js';

type Scope = ConnectorHermesMessageCommands['hermesMessageSendReceiptRead']['input'];
type Original = { key: string; commandKey: string; receiptId: string; execution: HermesExecution };
export type HermesStopResult = { runtime: 'hermes'; key: string; commandKey: string; receipt: CommandReceipt | null; execution: HermesExecution | null };
type Failure = { error: 401 | 403 | 409 | 503 };
export type ConnectorHermesStopCommands = {
  hermesStopClaim: { input: Scope & { payloadJson: string; execution: HermesExecution | null; application?: ApplicationTransactionEvidence }; output: Failure | HermesStopResult };
  hermesStopReady: { input: Original & { authorization: string }; output: boolean };
  hermesStopSettle: { input: Original & { outcome: 'acknowledged' | 'not_dispatched' | 'unknown' }; output: false | HermesStopResult };
  hermesStopReceiptRead: { input: Scope; output: Failure | HermesStopResult };
};
export type ConnectorHermesStopKind = keyof ConnectorHermesStopCommands;
export const connectorHermesStopSteps = Object.freeze({ hermesStopClaim: 180, hermesStopReady: 181, hermesStopSettle: 182, hermesStopReceiptRead: 183 });
export const isConnectorHermesStopKind = (v: string): v is ConnectorHermesStopKind => Object.hasOwn(connectorHermesStopSteps, v);
const fields = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && keys.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => keys.includes(k));
const id = (v: unknown): v is string => typeof v === 'string' && !!v && v.length <= 512 && !/[\x00-\x1f\x7f]/.test(v);
export const sameHermesStopExecution = (a: HermesExecution | null | undefined, b: HermesExecution) => !!a
  && ['key', 'id', 'live', 'epoch', 'at', 'row'].every(k => a[k as keyof HermesExecution] === b[k as keyof HermesExecution])
  && JSON.stringify(a.members) === JSON.stringify(b.members) && JSON.stringify(a.batch) === JSON.stringify(b.batch);
export function validConnectorHermesStopInput(k: ConnectorHermesStopKind, v: unknown): boolean {
  if (k === 'hermesStopReceiptRead') return validConnectorHermesMessageInput('hermesMessageSendReceiptRead', v);
  if (k === 'hermesStopClaim') {
    if (!fields(v, ['key', 'commandKey', 'authorization', 'payloadJson', 'execution', ...(v && typeof v === 'object' && Object.hasOwn(v, 'application') ? ['application'] : [])])) return false;
    const { execution, ...input } = v;
    return validConnectorHermesMessageInput('hermesMessageSend', input)
      && (execution === null || validHermesExecution(execution) && execution.key === v.key && execution.phase === 'running');
  }
  return fields(v, ['key', 'commandKey', 'receiptId', 'execution', k === 'hermesStopReady' ? 'authorization' : 'outcome'])
    && id(v.receiptId) && validHermesExecution(v.execution) && v.execution.phase === 'running' && v.execution.key === v.key
    && validConnectorHermesMessageInput('hermesMessageSendReceiptRead', { key: v.key, commandKey: v.commandKey,
      authorization: k === 'hermesStopReady' ? v.authorization : 'internal-settlement' })
    && (k === 'hermesStopReady' || ['acknowledged', 'not_dispatched', 'unknown'].includes(String(v.outcome)));
}
export function validConnectorHermesStopOutput(k: ConnectorHermesStopKind, v: unknown): boolean {
  if (k === 'hermesStopReady') return typeof v === 'boolean';
  if (k === 'hermesStopSettle' && v === false) return true;
  if (fields(v, ['error'])) return k !== 'hermesStopSettle' && typeof v.error === 'number' && [401, 403, 409, 503].includes(v.error);
  if (!fields(v, ['runtime', 'key', 'commandKey', 'receipt', 'execution'])) return false;
  const { execution, ...result } = v;
  return validConnectorHermesMessageOutput('hermesMessageSendReceiptRead', { ...result, queue: { presence: 'unknown' } })
    && (execution === null || k === 'hermesStopClaim' && validHermesExecution(execution) && execution.key === v.key
      && execution.phase === 'running' && (v.receipt as CommandReceipt | null)?.state === 'outcome_unknown');
}
type Binding = Original & { scope: string; actorId: string; dispatched: boolean; applicationReady?: OriginalTransactionWrite };
const active = new WeakMap<ConnectorUserStore, Map<string, Binding>>();
class Denied extends Error {}

/** The durable fence and receipt share the original claim transaction. Native
 * authority is one-shot in this worker lifetime, never recovered from a row. */
export async function executeConnectorHermesStop<K extends ConnectorHermesStopKind>(kind: K,
  request: ConnectorHermesStopCommands[K]['input'], owner: ConnectorUserStore, tokens?: ConnectorTokenStore,
  applicationTransactions?: ApplicationTransactionClient): Promise<ConnectorHermesStopCommands[K]['output']> {
  if (!validConnectorHermesStopInput(kind, request)) throw Error('connector_storage_unavailable');
  const input = structuredClone(request), journal = owner.hermesJournal;
  const bindings = active.get(owner) ?? new Map<string, Binding>(); active.set(owner, bindings);
  const permitted = (authorization: string, actorId?: string) => {
    const actor = tokens?.authenticateAuthorization(authorization);
    return !!actor && (!actorId || actorId === actor.tokenId) && !actor.tokenId.startsWith('actor_')
      // Connector's original non-delegated runs:interrupt action maps to
      // messages:send; runs:interrupt is NOT a ConnectorToken scope.
      && !actor.scopes.includes('execution:delegate') && actor.scopes.includes('messages:send');
  };
  const wrap = (key: string, commandKey: string, receipt: CommandReceipt | null, execution: HermesExecution | null = null): HermesStopResult =>
    ({ runtime: 'hermes', key, commandKey, receipt, execution });
  let value: unknown;
  if (kind === 'hermesStopClaim' || kind === 'hermesStopReceiptRead') {
    const v = input as ConnectorHermesStopCommands['hermesStopClaim']['input'];
    const actor = tokens?.authenticateAuthorization(v.authorization);
    if (!actor) value = { error: 401 };
    else if (!permitted(v.authorization, actor.tokenId)) value = { error: 403 };
    else {
      const scope = JSON.stringify([actor.tokenId, v.key]);
      if (kind === 'hermesStopReceiptRead') value = wrap(v.key, v.commandKey, owner.commands.get(scope, v.commandKey) ?? null);
      else {
        const payload = JSON.parse(v.payloadJson) as Record<string, unknown>, normalized = normalizeSendMessageRequest(payload);
        const check = () => { if (!permitted(v.authorization, actor.tokenId)) throw new Denied(); };
        const transaction = applicationStopTransaction('hermes', v, applicationTransactions);
        let original: Binding | undefined;
        try {
          const claimed = await owner.commands.claimAsync(scope, v.commandKey, payload, false, undefined, undefined, receiptId => {
            check();
            const reject = (status: 400 | 404 | 409) => ({ metadata: { domain: 'hermes-stop-rejected' }, complete: { status, body: { error: 'Command rejected' } } });
            if ('error' in normalized || normalized.message !== '/stop' || normalized.media.length || !id(normalized.expectedRunId)) return reject(400);
            if (!journal.session(v.key)) return reject(404);
            if (normalized.deliveryMode === 'mirror' || bindings.size >= 128 || !v.execution
              || normalized.expectedRunId !== v.execution.id || !journal.claimInterrupt(v.execution, receiptId)) return reject(409);
            original = { key: v.key, commandKey: v.commandKey, receiptId, execution: v.execution, scope, actorId: actor.tokenId, dispatched: false,
              ...(transaction ? { applicationReady: transaction.ready } : {}) };
            return { metadata: { domain: 'hermes-stop', receiptId, actorId: actor.tokenId, execution: v.execution } };
          }, false, check, check, transaction?.claim);
          if (claimed.fresh && original && claimed.receipt.state === 'outcome_unknown') bindings.set(claimed.receipt.id, original);
          value = wrap(v.key, v.commandKey, claimed.receipt, claimed.fresh && original ? original.execution : null);
        } catch (error) {
          // The admission release can fail AFTER committing the claim. This
          // invocation has not returned a native handoff, so only its exact
          // committed original can be rejected as known-not-dispatched. A DB
          // failure here preserves both receipt and fence for explicit recovery.
          if (original) {
            try {
              const receipt = owner.commands.get(scope, v.commandKey);
              if (receipt?.id === original.receiptId && receipt.state === 'outcome_unknown') {
                journal.settleInterrupt(original.execution, original.receiptId, () => {
                  const saved = owner.commands.settle(scope, v.commandKey, { status: 409, body: { error: 'Command rejected' } });
                  if (saved.state === 'outcome_unknown') throw Error('connector_storage_unavailable');
                });
              }
            } catch { /* No proof of committed rejection: retain original fence. */ }
          }
          if (error instanceof Denied) value = { error: 403 };
          else if (error instanceof CommandCapacity) value = { error: 503 };
          else if (error instanceof CommandConflict) value = { error: 409 };
          else throw error;
        }
      }
    }
  } else {
    const v = input as Original & { authorization?: string; outcome?: 'acknowledged' | 'not_dispatched' | 'unknown' };
    const b = bindings.get(v.receiptId), receipt = b ? owner.commands.get(b.scope, b.commandKey) : undefined;
    if (!b || b.key !== v.key || b.commandKey !== v.commandKey || !sameHermesStopExecution(b.execution, v.execution)
      || receipt?.id !== v.receiptId || receipt.state !== 'outcome_unknown' || !journal.interruptMatches(v.execution, v.receiptId)) value = false;
    else if (kind === 'hermesStopReady') {
      const ready = () => {
      const current = journal.current(v.key);
      value = !b.dispatched && permitted(v.authorization!, b.actorId) && !journal.deletion(v.key)
        && !!journal.session(v.key) && sameHermesStopExecution(current, v.execution) && current?.phase === 'running';
      if (value === true) b.dispatched = true;
      };
      if (b.applicationReady) await b.applicationReady(ready); else ready();
    } else if (v.outcome === 'acknowledged' && !b.dispatched) value = false;
    else {
      if (v.outcome !== 'unknown') {
        if (!journal.settleInterrupt(v.execution, v.receiptId, () => {
          const saved = owner.commands.settle(b.scope, b.commandKey, v.outcome === 'acknowledged'
            ? { status: 200, body: { ok: true, status: 'interrupt_requested', runId: v.execution.id, idempotencyKey: b.commandKey, media: [] } }
            : { status: 409, body: { error: 'Command rejected' } });
          if (saved.state === 'outcome_unknown') throw Error('connector_storage_unavailable');
        })) throw Error('connector_storage_unavailable');
      }
      bindings.delete(v.receiptId);
      value = wrap(b.key, b.commandKey, owner.commands.get(b.scope, b.commandKey) ?? null);
    }
  }
  if (!validConnectorHermesStopOutput(kind, value)) throw Error('connector_storage_unavailable');
  return value as ConnectorHermesStopCommands[K]['output'];
}
