import { MAX_MESSAGE_CHARS, type CommandReceipt, type CommandQueueObservation } from '@agentopsdeck/shared';
import { createHash } from 'node:crypto';
import { APPLICATION_TRANSACTION_COMMAND_OVERHEAD, validApplicationTransactionEvidence,
  type ApplicationTransactionClient, type ApplicationTransactionEvidence, type OriginalTransactionWrite } from '../auth/application-transaction-gate.js';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { CommandCapacity, CommandConflict } from '../commands/receipts.js';
import { SessionDeletionConflict, TurnAuthorizationError } from '../commands/turn-queue.js';
import { prepareHermesMessageAdmission } from '../hermes/message-admission.js';
import { normalizeSendMessageRequest } from '../messages/send-message.js';
import type { ConnectorUserStore } from './connector-user-store.js';

type Scope = { key: string; authorization: string; commandKey: string };
type Result = { runtime: 'hermes'; key: string; commandKey: string; receipt: CommandReceipt | null; queue: CommandQueueObservation };
type Failure = { error: 401 | 403 | 409 | 503 };
export type ConnectorHermesMessageCommands = {
  hermesMessageSend: { input: Scope & { payloadJson: string; rejectFresh?: 'runtime_unavailable'; application?: ApplicationTransactionEvidence }; output: Failure | Result & { admitted: boolean } };
  hermesMessageReceiptRead: { input: Scope; output: Failure | Result };
  hermesMessageSendReceiptRead: { input: Scope; output: Failure | Result };
};
export type ConnectorHermesMessageKind = keyof ConnectorHermesMessageCommands;
export const connectorHermesMessageSteps = Object.freeze({ hermesMessageSend: 149, hermesMessageReceiptRead: 150, hermesMessageSendReceiptRead: 151 });
export const isConnectorHermesMessageKind = (kind: string): kind is ConnectorHermesMessageKind => Object.hasOwn(connectorHermesMessageSteps, kind);
// Hermes has no attachment protocol. Bound text + original JSON fingerprint,
// without changing the normal single-flight worker budget or truncating input.
export const HERMES_MESSAGE_PAYLOAD_BYTES = 6 * MAX_MESSAGE_CHARS + 128 * 1024;
export const HERMES_MESSAGE_COMMAND_BYTES = 2 * HERMES_MESSAGE_PAYLOAD_BYTES + APPLICATION_TRANSACTION_COMMAND_OVERHEAD;
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => !!v
  && typeof v === 'object' && !Array.isArray(v) && required.every(k => Object.hasOwn(v, k))
  && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const id = (v: unknown): v is string => typeof v === 'string' && !!v && Buffer.byteLength(v) <= 512 && !/[\u0000-\u001f\u007f]/.test(v);
const commandKey = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
function payload(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'string' || Buffer.byteLength(v) > HERMES_MESSAGE_PAYLOAD_BYTES) return null;
  try {
    const p: unknown = JSON.parse(v);
    return p && typeof p === 'object' && !Array.isArray(p) && !Object.hasOwn(p, 'idempotencyKey') ? p as Record<string, unknown> : null;
  } catch { return null; }
}
export function validConnectorHermesMessageInput(kind: ConnectorHermesMessageKind, v: unknown): boolean {
  return fields(v, ['key', 'authorization', 'commandKey', ...(kind === 'hermesMessageSend' ? ['payloadJson'] : [])], kind === 'hermesMessageSend' ? ['rejectFresh', 'application'] : [])
    && id(v.key) && v.key.startsWith('hermes:') && v.key !== 'hermes:' && commandKey(v.commandKey)
    && typeof v.authorization === 'string' && !!v.authorization.trim() && Buffer.byteLength(v.authorization) <= 4096 && !/[\r\n\u0000]/.test(v.authorization)
    && (kind !== 'hermesMessageSend' || payload(v.payloadJson) !== null && (!Object.hasOwn(v, 'rejectFresh') || v.rejectFresh === 'runtime_unavailable')
      && (!Object.hasOwn(v, 'application') || validApplicationTransactionEvidence(v.application)));
}
function validReceipt(v: unknown): v is CommandReceipt {
  if (!fields(v, ['id', 'key', 'state', 'createdAt', 'updatedAt'], ['result']) || !id(v.id) || !commandKey(v.key)
    || !Number.isSafeInteger(v.createdAt) || Number(v.createdAt) < 0 || !Number.isSafeInteger(v.updatedAt) || Number(v.updatedAt) < 0) return false;
  if (v.state === 'outcome_unknown') return !Object.hasOwn(v, 'result');
  if (!fields(v.result, ['status', 'body'])) return false;
  const { status, body } = v.result;
  if (v.state === 'rejected') return Number.isInteger(status) && Number(status) >= 400 && Number(status) < 500 && fields(body, ['error']) && body.error === 'Command rejected';
  if (v.state !== 'accepted' || status !== 200 || !fields(body, ['media'], ['ok', 'status', 'queueDisposition', 'idempotencyKey', 'runId', 'deliveryMode', 'deliver'])
    || !Array.isArray(body.media) || body.media.length !== 0) return false;
  // Existing control receipts inhabit the same original scope: recover only,
  // never submit them on the ordinary-message lane.
  return fields(body, ['ok', 'status', 'queueDisposition', 'idempotencyKey', 'media']) && body.ok === true && body.status === 'queued'
    && ['waiting', 'preparing'].includes(String(body.queueDisposition)) && id(body.idempotencyKey)
    || fields(body, ['ok', 'status', 'runId', 'idempotencyKey', 'media']) && body.ok === true && body.status === 'interrupt_requested' && id(body.runId) && commandKey(body.idempotencyKey)
    || fields(body, ['status', 'idempotencyKey', 'deliveryMode', 'deliver', 'media']) && body.status === 'ok' && id(body.idempotencyKey) && body.deliveryMode === 'web-only' && body.deliver === false;
}
export function validConnectorHermesMessageOutput(kind: ConnectorHermesMessageKind, v: unknown): boolean {
  if (fields(v, ['error'])) return typeof v.error === 'number' && [401, 403, 409, 503].includes(v.error);
  if (!fields(v, ['runtime', 'key', 'commandKey', 'receipt', 'queue', ...(kind === 'hermesMessageSend' ? ['admitted'] : [])])
    || v.runtime !== 'hermes' || !id(v.key) || !v.key.startsWith('hermes:') || v.key === 'hermes:' || !commandKey(v.commandKey)
    || v.receipt !== null && (!validReceipt(v.receipt) || v.receipt.key !== v.commandKey)
    || kind === 'hermesMessageSend' && (v.receipt === null || typeof v.admitted !== 'boolean'
      || v.admitted && ((v.receipt as CommandReceipt).state !== 'accepted' || (v.receipt as CommandReceipt).result?.body.status !== 'queued'))) return false;
  const q = v.queue;
  return fields(q, ['presence']) && ['absent', 'unknown'].includes(String(q.presence))
    || fields(q, ['presence', 'state', 'createdAt', 'version']) && q.presence === 'present'
      && ['queued', 'blocked', 'dispatching', 'outcome_unknown'].includes(String(q.state)) && Number.isSafeInteger(q.createdAt) && Number(q.createdAt) >= 0
      && typeof q.version === 'string' && /^[1-9]\d{0,15}:[1-9]\d{0,15}$/.test(q.version) && (v.receipt as CommandReceipt | null)?.state === 'accepted';
}

/** Original authorization is re-read after waits AND inside original queue /
 * receipt transaction. No caller identity, provider call, replay or unlock. */
export async function executeConnectorHermesMessage<K extends ConnectorHermesMessageKind>(kind: K,
  request: ConnectorHermesMessageCommands[K]['input'], owner: ConnectorUserStore, tokens: ConnectorTokenStore | undefined,
  applicationTransactions?: ApplicationTransactionClient): Promise<ConnectorHermesMessageCommands[K]['output']> {
  if (!validConnectorHermesMessageInput(kind, request)) throw Error('connector_storage_unavailable');
  const input = structuredClone(request), actor = tokens?.authenticateAuthorization(input.authorization);
  const application = kind === 'hermesMessageSend' ? (input as ConnectorHermesMessageCommands['hermesMessageSend']['input']).application : undefined;
  if (application && !applicationTransactions) throw Error('application_transaction_unavailable');
  const transactionWrite = (phase: 'claim' | 'queue'): OriginalTransactionWrite | undefined => application ? write => applicationTransactions!.run({
    runtime: 'hermes', resource: input.key, commandKey: input.commandKey, phase, evidence: application,
    payloadDigest: createHash('sha256').update((input as ConnectorHermesMessageCommands['hermesMessageSend']['input']).payloadJson).digest('hex'),
  }, write) : undefined;
  if (!actor) return { error: 401 };
  const allowed = () => {
    const fresh = tokens?.authenticateAuthorization(input.authorization);
    return !!fresh && fresh.tokenId === actor.tokenId && !fresh.tokenId.startsWith('actor_') && !fresh.scopes.includes('execution:delegate')
      && fresh.scopes.includes(kind === 'hermesMessageReceiptRead' ? 'messages:read' : 'messages:send');
  };
  const check = () => { if (!allowed()) throw new TurnAuthorizationError(); };
  if (!allowed()) return { error: 403 };
  const scope = JSON.stringify([actor.tokenId, input.key]), journal = owner.hermesJournal;
  const wrap = (receipt: CommandReceipt | null, admitted = false) => {
    const turn = receipt?.state === 'accepted' && receipt.result?.body.status === 'queued' ? receipt.result.body.idempotencyKey : undefined;
    return { runtime: 'hermes' as const, key: input.key, commandKey: input.commandKey, receipt,
      queue: typeof turn === 'string' ? owner.turns.commandState('hermes', input.key, turn, actor.tokenId) : { presence: 'unknown' as const },
      ...(kind === 'hermesMessageSend' ? { admitted } : {}) };
  };
  if (kind !== 'hermesMessageSend') {
    const result = wrap(owner.commands.get(scope, input.commandKey) ?? null);
    if (!validConnectorHermesMessageOutput(kind, result)) throw Error('connector_storage_unavailable');
    return result as ConnectorHermesMessageCommands[K]['output'];
  }
  let fresh = false, mutationStarted = false;
  const reject = (status: 400 | 403 | 404 | 409) => wrap(owner.commands.settle(scope, input.commandKey, { status, body: { error: 'Command rejected' } }));
  let result: unknown;
  try {
    const p = payload((input as ConnectorHermesMessageCommands['hermesMessageSend']['input']).payloadJson)!;
    const claimed = await owner.commands.claimAsync(scope, input.commandKey, p, false, undefined, undefined, undefined, false, check, check, transactionWrite('claim'));
    fresh = claimed.fresh; check();
    if (!fresh) result = wrap(claimed.receipt);
    else {
      const normalized = normalizeSendMessageRequest(p);
      if ('error' in normalized) result = reject(400);
      else if ((input as ConnectorHermesMessageCommands['hermesMessageSend']['input']).rejectFresh || !owner.sdkCommandAdmissionOpen) result = reject(409);
      else if (!journal.session(input.key)) result = reject(404);
      else if (journal.deletion(input.key) || journal.current(input.key)?.phase === 'unknown' || normalized.deliveryMode === 'mirror'
        || normalized.media.length || ['/stop', '/status', '/compact'].includes(normalized.message)) result = reject(409);
      else {
        const pending = prepareHermesMessageAdmission({ journal, turns: owner.turns, authorize: allowed,
          assertAvailable: () => { if (!owner.sdkCommandAdmissionOpen) throw new SessionDeletionConflict(); } }, input.key, normalized.message,
        { actorId: actor.tokenId, accept: admission => owner.commands.queueCommit(scope, input.commandKey, { status: 200, body: { ok: true, ...admission } }) });
        mutationStarted = true;
        await owner.turns.enqueueAsync('hermes', pending.turn, pending.commit, pending.check, transactionWrite('queue'));
        result = wrap(owner.commands.get(scope, input.commandKey)!, true);
      }
    }
  } catch (error) {
    const saved = owner.commands.get(scope, input.commandKey);
    if (mutationStarted && saved?.state === 'accepted') result = wrap(saved, true);
    else if (error instanceof TurnAuthorizationError) result = fresh && saved?.state === 'outcome_unknown' ? reject(403) : { error: 403 };
    else if (error instanceof SessionDeletionConflict) result = fresh && saved?.state === 'outcome_unknown' ? reject(409) : { error: 409 };
    else if (error instanceof CommandConflict) result = { error: 409 };
    else if (error instanceof CommandCapacity) result = { error: 503 };
    else throw error;
  }
  if (!validConnectorHermesMessageOutput(kind, result)) throw Error('connector_storage_unavailable');
  return result as ConnectorHermesMessageCommands[K]['output'];
}
