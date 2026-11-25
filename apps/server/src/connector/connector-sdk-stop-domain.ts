import type { CommandReceipt } from '@agentopsdeck/shared';
import type { ApplicationTransactionClient, ApplicationTransactionEvidence, OriginalTransactionWrite } from '../auth/application-transaction-gate.js';
import { applicationStopTransaction } from './application-stop-transaction.js';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { CommandCapacity, CommandConflict } from '../commands/receipts.js';
import { normalizeSendMessageRequest } from '../messages/send-message.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { validConnectorSdkMessageInput, validConnectorSdkMessageOutput, type ConnectorSdkMessageCommands } from './connector-sdk-message-domain.js';
import { validConnectorSdkTranscriptInput, sameSdkTranscriptRef } from './connector-sdk-transcript-domain.js';
import { validSdkJournalSnapshot } from './connector-sdk-journal-domain.js';
import type { SdkCompactRef, SdkExecution } from './sdk-execution-journal.js';

type Scope = ConnectorSdkMessageCommands['sdkMessageSendReceiptRead']['input'];
export type SdkMessageStopRequest = Scope & { payloadJson: string; application?: ApplicationTransactionEvidence };
type Original = Omit<Scope, 'authorization'> & { ref: SdkCompactRef; receiptId: string };
type Failure = { error: 401 | 403 | 409 | 503 };
export type SdkMessageStopAdmission = Omit<Scope, 'authorization'> & { receipt: CommandReceipt; execution: SdkExecution | null };
export type ConnectorSdkStopCommands = {
  sdkMessageStopClaim: { input: SdkMessageStopRequest & { ref: SdkCompactRef | null }; output: Failure | SdkMessageStopAdmission };
  sdkMessageStopReady: { input: Original & { authorization: string }; output: boolean };
  sdkMessageStopSettle: { input: Original; output: boolean };
};
export type ConnectorSdkStopKind = keyof ConnectorSdkStopCommands;
export const connectorSdkStopSteps = Object.freeze({ sdkMessageStopClaim: 112, sdkMessageStopReady: 113, sdkMessageStopSettle: 114 });
export const isConnectorSdkStopKind = (k: string): k is ConnectorSdkStopKind => Object.hasOwn(connectorSdkStopSteps, k);
const fields = (v: unknown, required: string[]): v is Record<string, unknown> => !!v && typeof v === 'object'
  && !Array.isArray(v) && required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k));
const id = (v: unknown): v is string => typeof v === 'string' && !!v && v.length <= 512 && !/[\u0000-\u001f\u007f]/.test(v);
const validRef = (runtime: unknown, key: unknown, ref: unknown) => validConnectorSdkTranscriptInput('sdkTranscriptEnd', { runtime, ref })
  && (ref as SdkCompactRef).key === key;
const stoppable = (e: SdkExecution) => e.kind === 'compact' ? ['dispatching', 'running'].includes(e.phase) : e.phase === 'running';
export function validConnectorSdkStopInput(k: ConnectorSdkStopKind, v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  if (k === 'sdkMessageStopClaim') {
    if (!fields(v, ['runtime', 'key', 'commandKey', 'authorization', 'payloadJson', 'ref', ...(Object.hasOwn(v, 'application') ? ['application'] : [])])) return false;
    const { ref, ...body } = p;
    return validConnectorSdkMessageInput('sdkMessageSend', body) && (ref === null || validRef(p.runtime, p.key, ref));
  }
  if (!fields(v, ['runtime', 'key', 'commandKey', 'receiptId', 'ref', ...(k === 'sdkMessageStopReady' ? ['authorization'] : [])])) return false;
  return id(p.receiptId) && validRef(p.runtime, p.key, p.ref) && validConnectorSdkMessageInput('sdkMessageSendReceiptRead', {
    runtime: p.runtime, key: p.key, commandKey: p.commandKey, authorization: k === 'sdkMessageStopReady' ? p.authorization : 'internal-settlement',
  });
}
export function validConnectorSdkStopOutput(k: ConnectorSdkStopKind, v: unknown): boolean {
  if (k !== 'sdkMessageStopClaim') return typeof v === 'boolean';
  if (fields(v, ['error'])) return [401, 403, 409, 503].includes(Number(v.error)) && typeof v.error === 'number';
  if (!fields(v, ['runtime', 'key', 'commandKey', 'receipt', 'execution']) || !v.receipt) return false;
  const { execution, ...receipt } = v;
  if (!validConnectorSdkMessageOutput('sdkMessageSendReceiptRead', { ...receipt, queue: { presence: 'unknown' } })) return false;
  return execution === null || validSdkJournalSnapshot({ session: null, execution, deletion: null, canStart: false, unresolved: true })
    && (execution as SdkExecution).key === v.key && stoppable(execution as SdkExecution)
    && (execution as SdkExecution).stopRequested === true
    && (v.receipt as CommandReceipt).state === 'outcome_unknown';
}
type Binding = Original & { scope: string; actorId: string; kind: 'message' | 'compact'; dispatched: boolean; applicationReady?: OriginalTransactionWrite };
const bindings = new WeakMap<ConnectorUserStore, Map<string, Binding>>();
class Denied extends Error {}

/** Sole owning transaction. Original HTTP evidence is checked here; a returned
 * actor identifier never becomes a replacement credential on the main thread.
 * Receipt binding is durable, but native dispatch permission is one-shot and
 * local to this original worker lifetime. Restart never replays an interrupt. */
export async function executeConnectorSdkStop<K extends ConnectorSdkStopKind>(k: K,
  request: ConnectorSdkStopCommands[K]['input'], owner: ConnectorUserStore, tokens?: ConnectorTokenStore,
  applicationTransactions?: ApplicationTransactionClient): Promise<ConnectorSdkStopCommands[K]['output']> {
  if (!validConnectorSdkStopInput(k, request)) throw Error('connector_storage_unavailable');
  const p = structuredClone(request), journal = p.runtime === 'claude-code' ? owner.claudeJournal : p.runtime === 'ghcp' ? owner.copilotJournal : owner.antigravityJournal;
  const map = bindings.get(owner) ?? new Map<string, Binding>();
  bindings.set(owner, map);
  const authorized = (authorization: string, actorId?: string) => {
    const actor = tokens?.authenticateAuthorization(authorization);
    return actor && (!actorId || actor.tokenId === actorId) && !actor.tokenId.startsWith('actor_')
      && !actor.scopes.includes('execution:delegate') && actor.scopes.includes('messages:send') ? actor : undefined;
  };
  const original = (v: Original) => {
    const b = map.get(v.receiptId);
    if (!b || b.runtime !== v.runtime || b.key !== v.key || b.commandKey !== v.commandKey || !sameSdkTranscriptRef(b.ref, v.ref)) return;
    const receipt = owner.commands.get(b.scope, b.commandKey), saved = owner.commands.binding(b.scope, b.commandKey);
    if (receipt?.id !== v.receiptId || saved?.domain !== 'sdk-message-stop' || saved.receiptId !== v.receiptId
      || saved.actorId !== b.actorId || saved.kind !== b.kind || !saved.ref || !sameSdkTranscriptRef(saved.ref as SdkCompactRef, b.ref)) return;
    return { b, receipt };
  };
  let result: unknown;
  if (k !== 'sdkMessageStopClaim') {
    const v = p as Original & { authorization?: string }, found = original(v);
    if (!found || found.receipt.state !== 'outcome_unknown') result = false;
    else if (k === 'sdkMessageStopReady') {
      const ready = () => {
      const snapshot = journal.readSnapshot(v.key), e = snapshot.execution;
      if (!validSdkJournalSnapshot(snapshot)) throw Error('connector_storage_unavailable');
      result = !found.b.dispatched && !!authorized(v.authorization!, found.b.actorId) && !snapshot.deletion
        && !owner.commands.sessionDeletion(v.key) && !!snapshot.session && snapshot.session.nativeSessionId === v.ref.nativeSessionId
        && !!e && (e.kind ?? 'message') === found.b.kind && sameSdkTranscriptRef(e, v.ref) && stoppable(e) && e.stopRequested === true;
      if (result) found.b.dispatched = true;
      };
      if (found.b.applicationReady) await found.b.applicationReady(ready); else ready();
    } else if (!found.b.dispatched) result = false;
    else {
      // An ACK settles the original command even if the run has since ended or
      // authority was revoked. It never rewrites today's execution/permission.
      const receipt = owner.commands.settle(found.b.scope, v.commandKey, { status: 200, body: {
        ok: true, status: 'interrupt_requested', runId: v.ref.id, idempotencyKey: v.commandKey, media: [],
      } });
      result = receipt.state === 'accepted'; if (result) map.delete(v.receiptId);
    }
  } else {
    const v = p as ConnectorSdkStopCommands['sdkMessageStopClaim']['input'];
    const actor = tokens?.authenticateAuthorization(v.authorization);
    if (!actor) result = { error: 401 };
    else if (!authorized(v.authorization)) result = { error: 403 };
    else {
      const scope = JSON.stringify([actor.tokenId, v.key]), payload = JSON.parse(v.payloadJson) as Record<string, unknown>;
      const normalized = normalizeSendMessageRequest(payload);
      const check = () => { if (!authorized(v.authorization, actor.tokenId)) throw new Denied(); };
      const transaction = applicationStopTransaction(v.runtime, v, applicationTransactions);
      let execution: SdkExecution | null = null, rejected: 400 | 404 | 409 = 409, boundId: string | undefined;
      try {
        const claimed = await owner.commands.claimAsync(scope, v.commandKey, payload, false, undefined, undefined, receiptId => {
          check();
          if ('error' in normalized || normalized.message.trim() !== '/stop' || normalized.media.length || !id(normalized.expectedRunId)) rejected = 400;
          else if (normalized.deliveryMode === 'mirror') rejected = 409;
          else {
            const snapshot = journal.readSnapshot(v.key), e = snapshot.execution;
            if (!validSdkJournalSnapshot(snapshot)) throw Error('connector_storage_unavailable');
            if (!snapshot.session) rejected = 404;
            else if (v.ref && normalized.expectedRunId === v.ref.id && e && stoppable(e)
              && !e.stopRequested && sameSdkTranscriptRef(e, v.ref) && snapshot.session.nativeSessionId === v.ref.nativeSessionId
              && !snapshot.deletion && !owner.commands.sessionDeletion(v.key) && map.size < 128
              && (e.kind === 'compact' ? journal.requestCompactStop(v.ref) : journal.requestStop(v.ref))) {
              execution = { ...e, stopRequested: true }; boundId = receiptId;
              const kind = e.kind ?? 'message';
              const metadata = { domain: 'sdk-message-stop', receiptId, actorId: actor.tokenId, kind, ref: v.ref };
              map.set(receiptId, { runtime: v.runtime, key: v.key, commandKey: v.commandKey, receiptId, ref: v.ref,
                scope, actorId: actor.tokenId, kind, dispatched: false, ...(transaction ? { applicationReady: transaction.ready } : {}) });
              return { metadata };
            }
          }
          return { metadata: { domain: 'sdk-message-stop-rejected', status: rejected },
            complete: { status: rejected, body: { error: 'Command rejected' } } };
        }, false, check, check, transaction?.claim);
        result = { runtime: v.runtime, key: v.key, commandKey: v.commandKey,
          receipt: claimed.receipt,
          execution: claimed.fresh ? execution : null };
      } catch (error) {
        if (boundId && owner.commands.get(scope, v.commandKey)?.id !== boundId) map.delete(boundId);
        if (error instanceof Denied) result = { error: 403 };
        else if (error instanceof CommandCapacity) result = { error: 503 };
        else if (error instanceof CommandConflict) result = { error: 409 };
        else throw error;
      }
    }
  }
  if (!validConnectorSdkStopOutput(k, result)) throw Error('connector_storage_unavailable');
  return result as ConnectorSdkStopCommands[K]['output'];
}
