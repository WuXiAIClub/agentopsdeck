import { createHash, randomUUID } from 'node:crypto';
import { APPLICATION_TRANSACTION_COMMAND_OVERHEAD, validApplicationTransactionEvidence,
  type ApplicationTransactionClient, type ApplicationTransactionEvidence, type OriginalTransactionWrite } from '../auth/application-transaction-gate.js';
import { MAX_MESSAGE_CHARS, sessionRuntimeId, type CommandReceipt, type CommandQueueObservation, type ChatMessageMedia } from '@agentopsdeck/shared';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { CommandCapacity, CommandConflict } from '../commands/receipts.js';
import { SessionDeletionConflict, TurnAuthorizationError } from '../commands/turn-queue.js';
import type { ExecutionGrantAuthority } from './execution-grants.js';
import { MAX_MEDIA_BYTES, MAX_TOTAL_MEDIA_BYTES, normalizeSendMessageRequest } from '../messages/send-message.js';
import { codexQueueDisposition } from '../codex/queued-turn-projection.js';
import { resolveExecutionActor, EXECUTION_GRANT_HEADER } from './execution-authority.js';
import { EXPECTED_NODE_HEADER } from './node-identity.js';
import type { ConnectorUserStore } from './connector-user-store.js';

export type CodexMessageScope = { key: string; authorization: string; commandKey: string; grantId?: string; expectedNode?: string };
export type CodexMessageIntent = { key: string; id: string; receiptId: string };
export type CodexMessageImage = { filePath: string; media: ChatMessageMedia };
export type CodexMessageAdmission = { runId: string; idempotencyKey: string; status: 'queued'; media: ChatMessageMedia[];
  admission: { createdAt: number; queueVersion: string; disposition: 'waiting' | 'preparing' } };
export type CodexMessageResult = { key: string; commandKey: string; receipt: CommandReceipt | null;
  queue: CommandQueueObservation; intent: CodexMessageIntent | null; admitted: boolean };
type Failure = { error: 401 | 403 | 409 | 503 };
type Ref = CodexMessageScope & { intent: CodexMessageIntent };
export type ConnectorCodexMessageCommands = {
  codexMessageClaim: { input: CodexMessageScope & { payloadJson: string; rejectFresh?: 'runtime_unavailable' | 'session_missing'; application?: ApplicationTransactionEvidence }; output: Failure | CodexMessageResult };
  codexMessageReady: { input: Ref; output: Failure | boolean };
  codexMessageCommit: { input: Ref & { images: CodexMessageImage[]; displayBlocked: boolean }; output: Failure | CodexMessageResult };
  codexMessageReceiptRead: { input: CodexMessageScope; output: Failure | CodexMessageResult };
  codexMessageSendReceiptRead: { input: CodexMessageScope; output: Failure | CodexMessageResult };
  codexMessageRelease: { input: { intent: CodexMessageIntent }; output: boolean };
};
export type ConnectorCodexMessageKind = keyof ConnectorCodexMessageCommands;
export const connectorCodexMessageSteps = Object.freeze({ codexMessageClaim: 227, codexMessageReady: 228,
  codexMessageCommit: 229, codexMessageReceiptRead: 230, codexMessageSendReceiptRead: 231, codexMessageRelease: 232 });
export const isConnectorCodexMessageKind = (kind: string): kind is ConnectorCodexMessageKind => Object.hasOwn(connectorCodexMessageSteps, kind);
export const CODEX_MESSAGE_PAYLOAD_BYTES = Math.ceil(MAX_TOTAL_MEDIA_BYTES * 4 / 3) + 6 * MAX_MESSAGE_CHARS + 128 * 1024;
export const CODEX_MESSAGE_COMMAND_BYTES = 2 * CODEX_MESSAGE_PAYLOAD_BYTES + APPLICATION_TRANSACTION_COMMAND_OVERHEAD;
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const id = (v: unknown, max = 512): v is string => typeof v === 'string' && !!v && Buffer.byteLength(v) <= max && !/[\x00-\x1f\x7f]/.test(v);
const key = (v: unknown): v is string => id(v, 4096) && sessionRuntimeId(v) === 'codex';
const commandKey = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
const validIntent = (v: unknown): v is CodexMessageIntent => fields(v, ['key', 'id', 'receiptId']) && key(v.key) && id(v.id, 8192) && id(v.receiptId);
function payload(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'string' || Buffer.byteLength(v) > CODEX_MESSAGE_PAYLOAD_BYTES) return null;
  try { const p: unknown = JSON.parse(v); return p && typeof p === 'object' && !Array.isArray(p) && !Object.hasOwn(p, 'idempotencyKey') ? p as Record<string, unknown> : null; }
  catch { return null; }
}
function validImages(v: unknown): v is CodexMessageImage[] {
  return Array.isArray(v) && v.length <= 8 && v.every(m => fields(m, ['filePath', 'media']) && id(m.filePath, 4096)
    && fields(m.media, ['type', 'url', 'name'], ['mimeType', 'size']) && m.media.type === 'image'
    && id(m.media.url, 4096) && id(m.media.name, 1024) && (m.media.mimeType === undefined || id(m.media.mimeType) && m.media.mimeType.startsWith('image/'))
    && (m.media.size === undefined || Number.isSafeInteger(m.media.size) && Number(m.media.size) >= 0 && Number(m.media.size) <= MAX_MEDIA_BYTES))
    && v.reduce((sum, m) => sum + (m.media.size ?? 0), 0) <= MAX_TOTAL_MEDIA_BYTES;
}
export function validConnectorCodexMessageInput(kind: ConnectorCodexMessageKind, v: unknown): boolean {
  if (kind === 'codexMessageRelease') return fields(v, ['intent']) && validIntent(v.intent);
  const extra = kind === 'codexMessageClaim' ? ['payloadJson'] : kind === 'codexMessageReady' ? ['intent'] : kind === 'codexMessageCommit' ? ['intent', 'images', 'displayBlocked'] : [];
  return fields(v, ['key', 'authorization', 'commandKey', ...extra], ['grantId', 'expectedNode', ...(kind === 'codexMessageClaim' ? ['rejectFresh', 'application'] : [])])
    && key(v.key) && commandKey(v.commandKey) && id(v.authorization, 4096)
    && (v.grantId === undefined || id(v.grantId)) && (v.expectedNode === undefined || id(v.expectedNode))
    && (kind !== 'codexMessageClaim' || payload(v.payloadJson) !== null && (v.rejectFresh === undefined || v.rejectFresh === 'runtime_unavailable' || v.rejectFresh === 'session_missing'))
    && (!Object.hasOwn(v, 'application') || validApplicationTransactionEvidence(v.application))
    && (!extra.includes('intent') || validIntent(v.intent) && v.intent.key === v.key)
    && (kind !== 'codexMessageCommit' || validImages(v.images) && typeof v.displayBlocked === 'boolean');
}
function receipt(v: unknown): v is CommandReceipt {
  if (!fields(v, ['id', 'key', 'state', 'createdAt', 'updatedAt'], ['result']) || !id(v.id) || !commandKey(v.key)
    || !Number.isSafeInteger(v.createdAt) || Number(v.createdAt) < 0 || !Number.isSafeInteger(v.updatedAt) || Number(v.updatedAt) < 0) return false;
  if (v.state === 'outcome_unknown') return !Object.hasOwn(v, 'result');
  return ['accepted', 'rejected'].includes(String(v.state)) && fields(v.result, ['status', 'body'])
    && Number.isInteger(v.result.status) && Number(v.result.status) >= (v.state === 'accepted' ? 200 : 400)
    && Number(v.result.status) <= (v.state === 'accepted' ? 399 : 599) && !!v.result.body && typeof v.result.body === 'object' && !Array.isArray(v.result.body);
}
export function codexMessageAdmission(v: unknown): v is CodexMessageAdmission {
  return fields(v, ['runId', 'idempotencyKey', 'status', 'media', 'admission'], ['ok'])
    && id(v.runId, 8192) && v.idempotencyKey === v.runId && v.status === 'queued' && (v.ok === undefined || v.ok === true)
    && Array.isArray(v.media) && v.media.length <= 8 && validImages(v.media.map(media => ({ filePath: 'display-only', media })))
    && fields(v.admission, ['createdAt', 'queueVersion', 'disposition']) && Number.isSafeInteger(v.admission.createdAt) && Number(v.admission.createdAt) >= 0
    && typeof v.admission.queueVersion === 'string' && /^[1-9]\d{0,15}:[1-9]\d{0,15}$/.test(v.admission.queueVersion)
    && (v.admission.disposition === 'waiting' || v.admission.disposition === 'preparing');
}
export function validConnectorCodexMessageOutput(kind: ConnectorCodexMessageKind, v: unknown): boolean {
  if (fields(v, ['error'])) return typeof v.error === 'number' && [401, 403, 409, 503].includes(v.error);
  if (kind === 'codexMessageReady' || kind === 'codexMessageRelease') return typeof v === 'boolean';
  if (!fields(v, ['key', 'commandKey', 'receipt', 'queue', 'intent', 'admitted']) || !key(v.key) || !commandKey(v.commandKey)
    || !(v.receipt === null || receipt(v.receipt) && v.receipt.key === v.commandKey) || typeof v.admitted !== 'boolean'
    || !(v.intent === null || kind === 'codexMessageClaim' && validIntent(v.intent) && v.intent.key === v.key
      && v.intent.receiptId === (v.receipt as CommandReceipt | null)?.id && (v.receipt as CommandReceipt).state === 'outcome_unknown')
    || v.admitted && (!(v.receipt as CommandReceipt | null)?.result || !codexMessageAdmission((v.receipt as CommandReceipt).result!.body)
      || (v.receipt as CommandReceipt).state !== 'accepted' || v.intent !== null)) return false;
  return fields(v.queue, ['presence']) && (v.queue.presence === 'unknown' || v.queue.presence === 'absent')
    || fields(v.queue, ['presence', 'state', 'createdAt', 'version']) && v.queue.presence === 'present'
      && ['queued', 'blocked', 'dispatching', 'outcome_unknown'].includes(String(v.queue.state))
      && Number.isSafeInteger(v.queue.createdAt) && Number(v.queue.createdAt) >= 0 && typeof v.queue.version === 'string' && /^[1-9]\d{0,15}:[1-9]\d{0,15}$/.test(v.queue.version);
}
type Actor = ReturnType<typeof resolveExecutionActor>;
type Binding = { scope: string; commandKey: string; actor: Actor; intent: CodexMessageIntent; text: string; mediaCount: number; bytes: number; createdAt: number; ready: boolean; committing: boolean;
  application?: ApplicationTransactionEvidence; payloadDigest: string };
const active = new WeakMap<ConnectorUserStore, Map<string, Binding>>();
export function disposeCodexMessageIntents(owner: ConnectorUserStore) { active.delete(owner); }
const sameActor = (a: Actor, b: Actor) => a.actorId === b.actorId && a.principal.tokenId === b.principal.tokenId
  && a.executionGrant?.id === b.executionGrant?.id && a.executionGrant?.issuerTokenId === b.executionGrant?.issuerTokenId;
export async function executeConnectorCodexMessage<K extends ConnectorCodexMessageKind>(kind: K,
  request: ConnectorCodexMessageCommands[K]['input'], owner: ConnectorUserStore, tokens?: ConnectorTokenStore,
  applicationTransactions?: ApplicationTransactionClient): Promise<ConnectorCodexMessageCommands[K]['output']> {
  if (!validConnectorCodexMessageInput(kind, request)) throw Error('connector_storage_unavailable');
  const bindings = active.get(owner) ?? new Map<string, Binding>(); active.set(owner, bindings);
  if (kind === 'codexMessageRelease') {
    const { intent } = request as { intent: CodexMessageIntent }, b = bindings.get(intent.receiptId);
    return (b?.intent.id === intent.id && b.intent.key === intent.key && bindings.delete(intent.receiptId)) as ConnectorCodexMessageCommands[K]['output'];
  }
  const input = structuredClone(request) as CodexMessageScope;
  const transactionWrite = (phase: 'claim' | 'queue', application: ApplicationTransactionEvidence | undefined,
    payloadDigest: string): OriginalTransactionWrite | undefined => {
    if (!application) return undefined;
    if (!applicationTransactions) throw Error('application_transaction_unavailable');
    return write => applicationTransactions.run({ runtime: 'codex', resource: input.key,
      commandKey: input.commandKey, phase, evidence: application, payloadDigest }, write);
  };
  const actor = (): Actor => {
    if (!tokens?.authenticateAuthorization(input.authorization)) throw new TurnAuthorizationError();
    const headers = new Headers({ authorization: input.authorization });
    if (input.grantId !== undefined) headers.set(EXECUTION_GRANT_HEADER, input.grantId);
    if (input.expectedNode !== undefined) { if (input.expectedNode !== owner.nodeId) throw new TurnAuthorizationError(); headers.set(EXPECTED_NODE_HEADER, input.expectedNode); }
    try {
      const read = kind === 'codexMessageReceiptRead';
      const a = resolveExecutionActor(new Request('http://connector.invalid', { headers }), { tokens, grants: owner.executionGrants, nodeId: owner.nodeId },
        { runtime: 'codex', sessionKey: input.key }, read ? undefined : 'messages:send');
      if (!a.principal.scopes.includes(read ? 'messages:read' : 'messages:send')) throw new TurnAuthorizationError();
      return a;
    } catch { throw new TurnAuthorizationError(); }
  };
  if (!tokens?.authenticateAuthorization(input.authorization)) return { error: 401 };
  let original: Actor;
  try { original = actor(); } catch { return { error: 403 }; }
  const scope = JSON.stringify([original.actorId, input.key]);
  const wrap = (r: CommandReceipt | null, intent: CodexMessageIntent | null = null, admitted = false): CodexMessageResult => {
    const turnId = r?.state === 'accepted' && r.result?.body.status === 'queued' ? r.result.body.idempotencyKey : undefined;
    return { key: input.key, commandKey: input.commandKey, receipt: r, intent, admitted,
      queue: typeof turnId === 'string' ? owner.turns.commandState('codex', input.key, turnId, original.actorId) : { presence: 'unknown' } };
  };
  const check = (b?: Binding) => { if (!sameActor(actor(), b?.actor ?? original)) throw new TurnAuthorizationError(); };
  let value: unknown, owned: Binding | undefined;
  try {
    if (kind === 'codexMessageReceiptRead' || kind === 'codexMessageSendReceiptRead') value = wrap(owner.commands.get(scope, input.commandKey) ?? null);
    else if (kind === 'codexMessageClaim') {
      const v = input as ConnectorCodexMessageCommands['codexMessageClaim']['input'], p = payload(v.payloadJson)!;
      const payloadDigest = createHash('sha256').update(v.payloadJson).digest('hex');
      const claimed = await owner.commands.claimAsync(scope, input.commandKey, p, false, undefined,
        () => bindings.size < 128 && [...bindings.values()].reduce((n, b) => n + b.bytes, 0) + Buffer.byteLength(v.payloadJson) <= 2 * CODEX_MESSAGE_PAYLOAD_BYTES && owner.sdkCommandAdmissionOpen,
        receiptId => ({ metadata: { runtime: 'codex', intent: { key: input.key, receiptId, id: `${input.key}:codex-queued-${randomUUID()}` } } }),
        false, () => check(), () => check(), transactionWrite('claim', v.application, payloadDigest));
      check();
      if (!claimed.fresh || claimed.receipt.state !== 'outcome_unknown') value = wrap(claimed.receipt);
      else {
        const intent = owner.commands.binding(scope, input.commandKey)?.intent;
        if (!validIntent(intent)) throw Error('connector_storage_unavailable');
        const normalized = normalizeSendMessageRequest(p);
        const imageOnly = !('error' in normalized) && normalized.media.every(m => (m.mimeType || m.dataUrl.match(/^data:([^;,]+);base64,/)?.[1] || '').toLowerCase().startsWith('image/'));
        const rejection = 'error' in normalized || !imageOnly || Buffer.byteLength(intent.id) > 512 ? 400 : v.rejectFresh === 'session_missing' ? 404
          : v.rejectFresh === 'runtime_unavailable' || normalized.message === '/stop' || normalized.deliveryMode === 'mirror' || !owner.sdkCommandAdmissionOpen ? 409 : 0;
        if (rejection) value = wrap(owner.commands.settle(scope, input.commandKey, { status: rejection, body: { error: 'Command rejected' } }));
        else {
          if ('error' in normalized) throw Error('connector_storage_unavailable');
          owned = { scope, commandKey: input.commandKey, actor: original, intent, text: normalized.message, mediaCount: normalized.media.length,
            ...(v.application ? { application: v.application } : {}), payloadDigest,
            bytes: Buffer.byteLength(v.payloadJson), createdAt: Date.now(), ready: false, committing: false };
          check(owned); bindings.set(intent.receiptId, owned); value = wrap(claimed.receipt, intent);
        }
      }
    } else {
      const v = input as ConnectorCodexMessageCommands['codexMessageCommit']['input'], b = bindings.get(v.intent.receiptId);
      const saved = owner.commands.get(scope, input.commandKey);
      if (!b || b.scope !== scope || b.commandKey !== input.commandKey || b.intent.id !== v.intent.id || b.intent.key !== input.key
        || saved?.id !== b.intent.receiptId || saved.state !== 'outcome_unknown') value = kind === 'codexMessageReady' ? false : wrap(saved ?? null);
      else {
        owned = b; check(b);
        if (kind === 'codexMessageReady') { value = !b.ready && owner.sdkCommandAdmissionOpen && !owner.commands.sessionDeletion(input.key); if (value) b.ready = true; }
        else if (!b.ready || b.committing || v.images.length !== b.mediaCount) value = { error: 409 };
        else {
          b.committing = true;
          const turn = { id: b.intent.id, sessionKey: input.key, createdAt: b.createdAt, payload: { text: b.text, images: v.images,
            actorId: original.actorId, ...(original.executionGrant ? { executionGrant: original.executionGrant as ExecutionGrantAuthority } : {}) } };
          const result: CodexMessageAdmission = { runId: turn.id, idempotencyKey: turn.id, status: 'queued', media: v.images.map(m => m.media),
            admission: { createdAt: turn.createdAt, queueVersion: '', disposition: 'waiting' } };
          await owner.turns.enqueueAsync('codex', turn, (db, entry) => {
            check(b);
            const version = owner.turns.version('codex', input.key, turn.id);
            if (!version) throw Error('connector_storage_unavailable');
            result.admission.queueVersion = version;
            result.admission.disposition = codexQueueDisposition(turn.id, { headId: owner.turns.head('codex', input.key)?.id ?? null,
              executionCommandId: owner.codexExecutions.get(input.key)?.commandId ?? null }, v.displayBlocked ? { hasActiveRun: true, status: 'running' } : undefined);
            owner.commands.queueCommit(scope, input.commandKey, { status: 200, body: { ok: true, ...result } })(db, entry);
          }, () => { check(b); if (!owner.sdkCommandAdmissionOpen) throw new SessionDeletionConflict(); },
          transactionWrite('queue', b.application, b.payloadDigest));
          bindings.delete(b.intent.receiptId); value = wrap(owner.commands.get(scope, input.commandKey)!, null, true);
        }
      }
    }
  } catch (error) {
    const saved = owner.commands.get(scope, input.commandKey);
    if (owned?.committing && saved?.id === owned.intent.receiptId && saved.state === 'accepted') { bindings.delete(owned.intent.receiptId); value = wrap(saved, null, true); }
    else if (error instanceof TurnAuthorizationError || error instanceof SessionDeletionConflict) {
      if (owned && saved?.id === owned.intent.receiptId && saved.state === 'outcome_unknown') {
        owner.commands.settle(scope, input.commandKey, { status: error instanceof TurnAuthorizationError ? 403 : 409, body: { error: 'Command rejected' } });
        bindings.delete(owned.intent.receiptId);
      }
      value = { error: error instanceof TurnAuthorizationError ? 403 : 409 };
    } else if (error instanceof CommandConflict) value = { error: 409 };
    else if (error instanceof CommandCapacity) value = { error: 503 };
    else throw error;
  }
  if (!validConnectorCodexMessageOutput(kind, value)) throw Error('connector_storage_unavailable');
  return value as ConnectorCodexMessageCommands[K]['output'];
}
