import { MAX_MESSAGE_CHARS, sessionRuntimeId, type CommandReceipt, type CommandQueueObservation } from '@agentopsdeck/shared';
import { CommandCapacity, CommandConflict } from '../commands/receipts.js';
import { SessionDeletionConflict, TurnAuthorizationError } from '../commands/turn-queue.js';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { normalizeSendMessageRequest } from '../messages/send-message.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import type { SdkAgentId } from './sdk-execution-journal.js';
import type { SdkOwnerCatalogs } from './connector-sdk-local-domain.js';
import { prepareSdkAttachments, SDK_ATTACHMENTS_MAX_BYTES } from './sdk-attachment-input.js';
import { prepareSdkMessageAdmission } from './sdk-message-admission.js';
import { isSdkCompactCommand } from './sdk-text-command.js';
import { createHash } from 'node:crypto';
import { APPLICATION_TRANSACTION_COMMAND_OVERHEAD, validApplicationTransactionEvidence, type ApplicationTransactionClient,
  type ApplicationTransactionEvidence, type OriginalTransactionWrite } from '../auth/application-transaction-gate.js';

// Preserve the original 20 MiB decoded payload, plus bounded JSON/text metadata.
// JSON nesting escapes may expand the envelope further (never SQL/RPC methods).
export const SDK_MESSAGE_PAYLOAD_BYTES = Math.ceil(SDK_ATTACHMENTS_MAX_BYTES / 3) * 4 + 6 * MAX_MESSAGE_CHARS + 128 * 1024;
export const SDK_MESSAGE_COMMAND_BYTES = 2 * SDK_MESSAGE_PAYLOAD_BYTES + APPLICATION_TRANSACTION_COMMAND_OVERHEAD;
type Scope = { runtime: SdkAgentId; key: string; authorization: string; commandKey: string };
type Result = { runtime: SdkAgentId; key: string; commandKey: string; receipt: CommandReceipt | null; queue: CommandQueueObservation };
type Failure = { error: 401 | 403 | 409 | 503 };
export type ConnectorSdkMessageCommands = {
  sdkMessageSend: { input: Scope & { payloadJson: string; rejectFresh?: 'runtime_unavailable';
    application?: ApplicationTransactionEvidence }; output: Failure | Result & { admitted: boolean } };
  sdkMessageReceiptRead: { input: Scope; output: Failure | Result };
  // Read-only delivery fence for the original POST authority. A send-only
  // credential may observe its own POST ACK without acquiring messages:read.
  sdkMessageSendReceiptRead: { input: Scope; output: Failure | Result };
};
export type ConnectorSdkMessageKind = keyof ConnectorSdkMessageCommands;
export const connectorSdkMessageSteps = Object.freeze({ sdkMessageSend: 96, sdkMessageReceiptRead: 97, sdkMessageSendReceiptRead: 98 });
export const isConnectorSdkMessageKind = (kind: string): kind is ConnectorSdkMessageKind => Object.hasOwn(connectorSdkMessageSteps, kind);
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => !!v
  && typeof v === 'object' && !Array.isArray(v) && required.every(k => Object.hasOwn(v, k))
  && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const runtime = (v: unknown): v is SdkAgentId => v === 'claude-code' || v === 'ghcp' || v === 'antigravity';
const id = (v: unknown): v is string => typeof v === 'string' && !!v && Buffer.byteLength(v) <= 512 && !/[\u0000-\u001f\u007f]/.test(v);
const commandKey = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
function payload(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'string' || Buffer.byteLength(v) > SDK_MESSAGE_PAYLOAD_BYTES) return null;
  try {
    const p: unknown = JSON.parse(v);
    return p && typeof p === 'object' && !Array.isArray(p) && !Object.hasOwn(p, 'idempotencyKey') ? p as Record<string, unknown> : null;
  } catch { return null; }
}
export function validConnectorSdkMessageInput(kind: ConnectorSdkMessageKind, v: unknown): boolean {
  return fields(v, ['runtime', 'key', 'authorization', 'commandKey', ...(kind === 'sdkMessageSend' ? ['payloadJson'] : [])], kind === 'sdkMessageSend' ? ['rejectFresh', 'application'] : [])
    && runtime(v.runtime) && id(v.key) && v.key !== `${v.runtime}:` && sessionRuntimeId(v.key) === v.runtime && commandKey(v.commandKey)
    && typeof v.authorization === 'string' && !!v.authorization.trim() && Buffer.byteLength(v.authorization) <= 4096 && !/[\r\n\u0000]/.test(v.authorization)
    && (kind !== 'sdkMessageSend' || payload(v.payloadJson) !== null
      && (!Object.hasOwn(v, 'rejectFresh') || v.rejectFresh === 'runtime_unavailable')
      && (!Object.hasOwn(v, 'application') || validApplicationTransactionEvidence(v.application)));
}
function validReceipt(v: unknown): v is CommandReceipt {
  if (!fields(v, ['id', 'key', 'state', 'createdAt', 'updatedAt'], ['result']) || !id(v.id) || !commandKey(v.key)
    || !Number.isSafeInteger(v.createdAt) || Number(v.createdAt) < 0 || !Number.isSafeInteger(v.updatedAt) || Number(v.updatedAt) < 0) return false;
  if (v.state === 'outcome_unknown') return !Object.hasOwn(v, 'result');
  if (!fields(v.result, ['status', 'body'])) return false;
  const { status, body } = v.result;
  if (v.state === 'rejected') return Number.isInteger(status) && Number(status) >= 400 && Number(status) < 500
    && fields(body, ['error']) && body.error === 'Command rejected';
  // Existing stop/status receipts share the original message scope. Recover
  // them unchanged even though their effects remain on the control lane.
  if (v.state === 'accepted' && status === 200) {
    if (fields(body, ['ok', 'status', 'runId', 'idempotencyKey', 'media']) && body.ok === true
      && body.status === 'interrupt_requested' && id(body.runId) && commandKey(body.idempotencyKey)
      && Array.isArray(body.media) && body.media.length === 0) return true;
    if (fields(body, ['status', 'idempotencyKey', 'deliveryMode', 'deliver', 'media']) && body.status === 'ok'
      && id(body.idempotencyKey) && body.deliveryMode === 'web-only' && body.deliver === false
      && Array.isArray(body.media) && body.media.length === 0) return true;
  }
  return v.state === 'accepted' && status === 200 && fields(body, ['ok', 'status', 'queueDisposition', 'idempotencyKey', 'media'])
    && body.ok === true && body.status === 'queued' && ['waiting', 'preparing'].includes(String(body.queueDisposition))
    && id(body.idempotencyKey) && Array.isArray(body.media) && body.media.length <= 8
    && body.media.every(m => fields(m, ['url', 'type', 'name', 'mimeType', 'size']) && typeof m.url === 'string'
      && /^\/api\/sdk-attachments\/[A-Za-z0-9-]{1,128}$/.test(m.url)
      && ['image', 'file'].includes(String(m.type)) && typeof m.name === 'string' && typeof m.mimeType === 'string'
      && Number.isSafeInteger(m.size) && Number(m.size) > 0);
}
export function validConnectorSdkMessageOutput(kind: ConnectorSdkMessageKind, v: unknown): boolean {
  if (fields(v, ['error'])) return typeof v.error === 'number' && [401, 403, 409, 503].includes(v.error);
  if (!fields(v, ['runtime', 'key', 'commandKey', 'receipt', 'queue', ...(kind === 'sdkMessageSend' ? ['admitted'] : [])])
    || !runtime(v.runtime) || !id(v.key) || sessionRuntimeId(v.key) !== v.runtime || !commandKey(v.commandKey)
    || v.receipt !== null && (!validReceipt(v.receipt) || v.receipt.key !== v.commandKey)
    || kind === 'sdkMessageSend' && (v.receipt === null || typeof v.admitted !== 'boolean'
      || v.admitted && (v.receipt as CommandReceipt).state !== 'accepted')) return false;
  const q = v.queue;
  return fields(q, ['presence']) && ['absent', 'unknown'].includes(String(q.presence))
    || fields(q, ['presence', 'state', 'createdAt', 'version']) && q.presence === 'present'
      && ['queued', 'blocked', 'dispatching', 'outcome_unknown'].includes(String(q.state))
      && Number.isSafeInteger(q.createdAt) && Number(q.createdAt) >= 0
      && typeof q.version === 'string' && /^[1-9]\d{0,15}:[1-9]\d{0,15}$/.test(q.version)
      && (v.receipt as CommandReceipt | null)?.state === 'accepted';
}

/** Own original actor receipt, queue and attachment savepoints. Identity is
 * derived here and checked after waits and inside writes. No native effects. */
export async function executeConnectorSdkMessage<K extends ConnectorSdkMessageKind>(kind: K,
  request: ConnectorSdkMessageCommands[K]['input'], owner: ConnectorUserStore, tokens: ConnectorTokenStore | undefined,
  catalogs: SdkOwnerCatalogs, applicationTransactions?: ApplicationTransactionClient): Promise<ConnectorSdkMessageCommands[K]['output']> {
  if (!validConnectorSdkMessageInput(kind, request)) throw Error('connector_storage_unavailable');
  const input = structuredClone(request);
  // This optional internal lane never replaces the original machine token.
  // A supplied application identity MUST reach its actual Auth worker; no
  // preflight boolean, synthetic local bearer or missing-link fallback.
  const application = kind === 'sdkMessageSend' ? (input as ConnectorSdkMessageCommands['sdkMessageSend']['input']).application : undefined;
  if (application && !applicationTransactions) throw Error('application_transaction_unavailable');
  const transactionWrite = (phase: 'claim' | 'queue'): OriginalTransactionWrite | undefined => application ? write => applicationTransactions!.run({
    runtime: input.runtime, resource: input.key, commandKey: input.commandKey, phase, evidence: application,
    payloadDigest: createHash('sha256').update((input as ConnectorSdkMessageCommands['sdkMessageSend']['input']).payloadJson).digest('hex'),
  }, write) : undefined;
  const actor = tokens?.authenticateAuthorization(input.authorization);
  if (!actor) return { error: 401 };
  const allowed = () => {
    const fresh = tokens?.authenticateAuthorization(input.authorization);
    return !!fresh && fresh.tokenId === actor.tokenId && !fresh.tokenId.startsWith('actor_')
      && !fresh.scopes.includes('execution:delegate') && fresh.scopes.includes(kind === 'sdkMessageReceiptRead' ? 'messages:read' : 'messages:send');
  };
  const check = () => { if (!allowed()) throw new TurnAuthorizationError(); };
  if (!allowed()) return { error: 403 };
  const scope = JSON.stringify([actor.tokenId, input.key]);
  const journal = input.runtime === 'claude-code' ? owner.claudeJournal : input.runtime === 'ghcp' ? owner.copilotJournal : owner.antigravityJournal;
  const wrap = (receipt: CommandReceipt | null, admitted = false) => {
    const turn = receipt?.state === 'accepted' ? receipt.result?.body.idempotencyKey : undefined;
    const queue: CommandQueueObservation = typeof turn === 'string'
      ? owner.turns.commandState(input.runtime, input.key, turn, actor.tokenId) : { presence: 'unknown' };
    return { runtime: input.runtime, key: input.key, commandKey: input.commandKey, receipt, queue,
      ...(kind === 'sdkMessageSend' ? { admitted } : {}) };
  };
  if (kind !== 'sdkMessageSend') {
    const result = wrap(owner.commands.get(scope, input.commandKey) ?? null);
    if (!validConnectorSdkMessageOutput(kind, result)) throw Error('connector_storage_unavailable');
    return result as ConnectorSdkMessageCommands[K]['output'];
  }
  let fresh = false, mutationStarted = false;
  const reject = (status: 400 | 403 | 404 | 409) => wrap(owner.commands.settle(scope, input.commandKey, { status, body: { error: 'Command rejected' } }));
  let result: unknown;
  try {
    const p = payload((input as ConnectorSdkMessageCommands['sdkMessageSend']['input']).payloadJson)!;
    const claimed = await owner.commands.claimAsync(scope, input.commandKey, p, false, undefined, undefined, undefined, false, check, check, transactionWrite('claim'));
    fresh = claimed.fresh;
    check();
    if (!fresh) result = wrap(claimed.receipt);
    else {
      const normalized = normalizeSendMessageRequest(p), catalog = catalogs[input.runtime];
      if ('error' in normalized) result = reject(400);
      // Trusted local readiness can only veto a fresh admission, never grant
      // permission or mask an original receipt. It is not fingerprint input.
      else if ((input as ConnectorSdkMessageCommands['sdkMessageSend']['input']).rejectFresh || !owner.sdkCommandAdmissionOpen || !catalog) result = reject(409);
      else if (!journal.session(input.key)) result = reject(404);
      else if (normalized.deliveryMode === 'mirror' || ['/stop', '/status'].includes(normalized.message) || isSdkCompactCommand(normalized.message)) result = reject(409);
      else {
        let attachments;
        try { attachments = prepareSdkAttachments(normalized.media); }
        catch { result = reject(400); }
        if (attachments) {
          const pending = prepareSdkMessageAdmission({ runtime: input.runtime, journal, store: owner,
            assertAvailable: () => { if (!owner.sdkCommandAdmissionOpen) throw new SessionDeletionConflict(); },
            authorize: () => allowed(), models: { model: catalog.model, ...(catalog.modelChoices ? { modelChoices: [...catalog.modelChoices] } : {}), ...(catalog.dynamicModels ? { dynamicModels: true } : {}) },
          }, input.key, normalized.message, { actorId: actor.tokenId,
            accept: admission => owner.commands.queueCommit(scope, input.commandKey, { status: 200, body: { ok: true, ...admission } }),
          }, attachments);
          mutationStarted = true;
          await owner.turns.enqueueAsync(input.runtime, pending.turn, pending.commit, pending.check, transactionWrite('queue'));
          result = wrap(owner.commands.get(scope, input.commandKey)!, true);
        }
      }
    }
  } catch (error) {
    const saved = owner.commands.get(scope, input.commandKey);
    // COMMIT may precede a failed physical release/notification ACK. Read the
    // original receipt rather than reject committed work or create a new turn.
    if (mutationStarted && saved?.state === 'accepted') result = wrap(saved, true);
    else if (error instanceof TurnAuthorizationError) result = fresh && saved?.state === 'outcome_unknown' ? reject(403) : { error: 403 };
    else if (error instanceof SessionDeletionConflict) result = fresh && saved?.state === 'outcome_unknown' ? reject(409) : { error: 409 };
    else if (error instanceof CommandConflict) result = { error: 409 };
    else if (error instanceof CommandCapacity) result = { error: 503 };
    else throw error; // unproven effects remain unknown; never replay
  }
  if (!validConnectorSdkMessageOutput(kind, result)) throw Error('connector_storage_unavailable');
  return result as ConnectorSdkMessageCommands[K]['output'];
}
