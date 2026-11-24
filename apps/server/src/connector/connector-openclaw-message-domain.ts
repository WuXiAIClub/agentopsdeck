import { createHash, randomUUID } from 'node:crypto';
import { APPLICATION_TRANSACTION_COMMAND_OVERHEAD, validApplicationTransactionEvidence,
  type ApplicationTransactionClient, type ApplicationTransactionEvidence, type OriginalTransactionWrite } from '../auth/application-transaction-gate.js';
import { MAX_MESSAGE_CHARS, sessionRuntimeId, type CommandReceipt, type CommandQueueObservation, type ChatMessageMedia } from '@agentopsdeck/shared';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { CommandCapacity, CommandConflict } from '../commands/receipts.js';
import { SessionDeletionConflict, TurnAuthorizationError } from '../commands/turn-queue.js';
import { MAX_MEDIA_BYTES, MAX_TOTAL_MEDIA_BYTES, normalizeSendMessageRequest } from '../messages/send-message.js';
import { resolveExplicitChannelRoute } from '../messages/channel-route.js';
import { openClawMessageCommit } from '../openclaw/message-admission.js';
import type { OpenClawQueuedTurn } from '../openclaw/turn-queue.js';
import { resolveExecutionActor, EXECUTION_GRANT_HEADER } from './execution-authority.js';
import { createTurnAuthorizer } from './execution-grants.js';
import { EXPECTED_NODE_HEADER } from './node-identity.js';
import type { ConnectorUserStore } from './connector-user-store.js';

export type OpenClawMessageScope = { key: string; authorization: string; commandKey: string; grantId?: string; expectedNode?: string };
export type OpenClawMessageIntent = { key: string; id: string; receiptId: string };
export type OpenClawMessageMedia = { filePath: string; media: ChatMessageMedia };
type Ref = OpenClawMessageScope & { intent: OpenClawMessageIntent };
export type OpenClawMessageResult = { key: string; commandKey: string; receipt: CommandReceipt | null;
  queue: CommandQueueObservation; intent: OpenClawMessageIntent | null; admitted: boolean };
type Failure = { error: 401 | 403 | 409 | 503 };
export type ConnectorOpenClawMessageCommands = {
  openClawMessageClaim: { input: OpenClawMessageScope & { payloadJson: string; defaultAgentId: string; rejectFresh?: 'runtime_unavailable' | 'session_missing'; application?: ApplicationTransactionEvidence }; output: Failure | OpenClawMessageResult };
  openClawMessageReady: { input: Ref; output: Failure | boolean };
  openClawMessageCommit: { input: Ref & { media: OpenClawMessageMedia[] }; output: Failure | OpenClawMessageResult };
  openClawMessageReceiptRead: { input: OpenClawMessageScope; output: Failure | OpenClawMessageResult };
  openClawMessageSendReceiptRead: { input: OpenClawMessageScope; output: Failure | OpenClawMessageResult };
  openClawMessageRelease: { input: { intent: OpenClawMessageIntent }; output: boolean };
};
export type ConnectorOpenClawMessageKind = keyof ConnectorOpenClawMessageCommands;
export const connectorOpenClawMessageSteps = Object.freeze({ openClawMessageClaim: 195, openClawMessageReady: 196,
  openClawMessageCommit: 197, openClawMessageReceiptRead: 198, openClawMessageSendReceiptRead: 199, openClawMessageRelease: 200 });
export const isConnectorOpenClawMessageKind = (kind: string): kind is ConnectorOpenClawMessageKind => Object.hasOwn(connectorOpenClawMessageSteps, kind);
// Original base64 input (24MiB decoded), text, and bounded JSON overhead.
export const OPENCLAW_MESSAGE_PAYLOAD_BYTES = Math.ceil(MAX_TOTAL_MEDIA_BYTES * 4 / 3) + 6 * MAX_MESSAGE_CHARS + 128 * 1024;
export const OPENCLAW_MESSAGE_COMMAND_BYTES = 2 * OPENCLAW_MESSAGE_PAYLOAD_BYTES + APPLICATION_TRANSACTION_COMMAND_OVERHEAD;
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const id = (v: unknown, max = 512): v is string => typeof v === 'string' && !!v && Buffer.byteLength(v) <= max && !/[\x00-\x1f\x7f]/.test(v);
const key = (v: unknown): v is string => id(v, 4096) && sessionRuntimeId(v) === 'openclaw';
const commandKey = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
const validIntent = (v: unknown): v is OpenClawMessageIntent => fields(v, ['key', 'id', 'receiptId']) && key(v.key) && id(v.id) && id(v.receiptId);
function payload(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'string' || Buffer.byteLength(v) > OPENCLAW_MESSAGE_PAYLOAD_BYTES) return null;
  try { const p: unknown = JSON.parse(v); return p && typeof p === 'object' && !Array.isArray(p) && !Object.hasOwn(p, 'idempotencyKey') ? p as Record<string, unknown> : null; }
  catch { return null; }
}
function validMedia(v: unknown): v is OpenClawMessageMedia[] {
  return Array.isArray(v) && v.length <= 8 && v.every(m => fields(m, ['filePath', 'media']) && id(m.filePath, 4096)
    && fields(m.media, ['type', 'url', 'name'], ['mimeType', 'size']) && ['image', 'file'].includes(String(m.media.type))
    && id(m.media.url, 4096) && id(m.media.name, 1024) && (m.media.mimeType === undefined || id(m.media.mimeType))
    && (m.media.size === undefined || Number.isSafeInteger(m.media.size) && Number(m.media.size) >= 0 && Number(m.media.size) <= MAX_MEDIA_BYTES))
    && v.reduce((sum, m) => sum + (m.media.size ?? 0), 0) <= MAX_TOTAL_MEDIA_BYTES;
}
export function validConnectorOpenClawMessageInput(kind: ConnectorOpenClawMessageKind, v: unknown): boolean {
  if (kind === 'openClawMessageRelease') return fields(v, ['intent']) && validIntent(v.intent);
  const extras = kind === 'openClawMessageClaim' ? ['payloadJson', 'defaultAgentId'] : kind === 'openClawMessageReady' ? ['intent'] : kind === 'openClawMessageCommit' ? ['intent', 'media'] : [];
  return fields(v, ['key', 'authorization', 'commandKey', ...extras], ['grantId', 'expectedNode', ...(kind === 'openClawMessageClaim' ? ['rejectFresh', 'application'] : [])])
    && key(v.key) && commandKey(v.commandKey) && id(v.authorization, 4096)
    && (v.grantId === undefined || id(v.grantId)) && (v.expectedNode === undefined || id(v.expectedNode))
    && (kind !== 'openClawMessageClaim' || payload(v.payloadJson) !== null && id(v.defaultAgentId) && (v.rejectFresh === undefined || v.rejectFresh === 'runtime_unavailable' || v.rejectFresh === 'session_missing'))
    && (!Object.hasOwn(v, 'application') || validApplicationTransactionEvidence(v.application))
    && (!extras.includes('intent') || validIntent(v.intent) && v.intent.key === v.key)
    && (kind !== 'openClawMessageCommit' || validMedia(v.media));
}
function receipt(v: unknown): v is CommandReceipt {
  if (!fields(v, ['id', 'key', 'state', 'createdAt', 'updatedAt'], ['result']) || !id(v.id) || !commandKey(v.key)
    || !Number.isSafeInteger(v.createdAt) || Number(v.createdAt) < 0 || !Number.isSafeInteger(v.updatedAt) || Number(v.updatedAt) < 0) return false;
  if (v.state === 'outcome_unknown') return !Object.hasOwn(v, 'result');
  // Original legacy control receipts share the same scope. They can be returned
  // but never confer a new ordinary-message intent.
  return ['accepted', 'rejected'].includes(String(v.state)) && fields(v.result, ['status', 'body'])
    && Number.isInteger(v.result.status) && Number(v.result.status) >= (v.state === 'accepted' ? 200 : 400)
    && Number(v.result.status) < (v.state === 'accepted' ? 300 : 500) && !!v.result.body && typeof v.result.body === 'object' && !Array.isArray(v.result.body);
}
export function validConnectorOpenClawMessageOutput(kind: ConnectorOpenClawMessageKind, v: unknown): boolean {
  if (fields(v, ['error'])) return typeof v.error === 'number' && [401, 403, 409, 503].includes(v.error);
  if (kind === 'openClawMessageReady' || kind === 'openClawMessageRelease') return typeof v === 'boolean';
  if (!fields(v, ['key', 'commandKey', 'receipt', 'queue', 'intent', 'admitted']) || !key(v.key) || !commandKey(v.commandKey)
    || !(v.receipt === null || receipt(v.receipt) && v.receipt.key === v.commandKey) || typeof v.admitted !== 'boolean'
    || !(v.intent === null || kind === 'openClawMessageClaim' && validIntent(v.intent) && v.intent.key === v.key
      && v.intent.receiptId === (v.receipt as CommandReceipt | null)?.id && (v.receipt as CommandReceipt).state === 'outcome_unknown')) return false;
  return fields(v.queue, ['presence']) && (v.queue.presence === 'unknown' || v.queue.presence === 'absent')
    || fields(v.queue, ['presence', 'state', 'createdAt', 'version']) && v.queue.presence === 'present'
      && ['queued', 'blocked', 'dispatching', 'outcome_unknown'].includes(String(v.queue.state))
      && Number.isSafeInteger(v.queue.createdAt) && Number(v.queue.createdAt) >= 0 && typeof v.queue.version === 'string' && /^[1-9]\d{0,15}:[1-9]\d{0,15}$/.test(v.queue.version);
}
type Actor = ReturnType<typeof resolveExecutionActor>;
type Binding = { scope: string; commandKey: string; actor: Actor; turn: Omit<OpenClawQueuedTurn, 'state'>; intent: OpenClawMessageIntent; mediaCount: number; ready: boolean; committing: boolean;
  application?: ApplicationTransactionEvidence; payloadDigest: string };
const active = new WeakMap<ConnectorUserStore, Map<string, Binding>>();
export function disposeOpenClawMessageIntents(owner: ConnectorUserStore) { active.delete(owner); }
const sameActor = (a: Actor, b: Actor) => a.actorId === b.actorId && a.principal.tokenId === b.principal.tokenId
  && a.executionGrant?.id === b.executionGrant?.id && a.executionGrant?.issuerTokenId === b.executionGrant?.issuerTokenId;
export async function executeConnectorOpenClawMessage<K extends ConnectorOpenClawMessageKind>(kind: K,
  request: ConnectorOpenClawMessageCommands[K]['input'], owner: ConnectorUserStore, tokens?: ConnectorTokenStore,
  applicationTransactions?: ApplicationTransactionClient): Promise<ConnectorOpenClawMessageCommands[K]['output']> {
  if (!validConnectorOpenClawMessageInput(kind, request)) throw Error('connector_storage_unavailable');
  const bindings = active.get(owner) ?? new Map<string, Binding>(); active.set(owner, bindings);
  if (kind === 'openClawMessageRelease') {
    const { intent } = request as { intent: OpenClawMessageIntent }, b = bindings.get(intent.receiptId);
    // Retirement only. No SQL settlement, cancellation, replay or new authority.
    return (b?.intent.id === intent.id && b.intent.key === intent.key && bindings.delete(intent.receiptId)) as ConnectorOpenClawMessageCommands[K]['output'];
  }
  const input = structuredClone(request) as OpenClawMessageScope;
  const transactionWrite = (phase: 'claim' | 'queue', application: ApplicationTransactionEvidence | undefined,
    payloadDigest: string): OriginalTransactionWrite | undefined => {
    if (!application) return undefined;
    if (!applicationTransactions) throw Error('application_transaction_unavailable');
    return write => applicationTransactions.run({ runtime: 'openclaw', resource: input.key,
      commandKey: input.commandKey, phase, evidence: application, payloadDigest }, write);
  };
  const actor = (): Actor => {
    if (!tokens?.authenticateAuthorization(input.authorization)) throw new TurnAuthorizationError();
    const headers = new Headers({ authorization: input.authorization });
    if (input.grantId !== undefined) headers.set(EXECUTION_GRANT_HEADER, input.grantId);
    if (input.expectedNode !== undefined) { if (input.expectedNode !== owner.nodeId) throw new TurnAuthorizationError(); headers.set(EXPECTED_NODE_HEADER, input.expectedNode); }
    try {
      const a = resolveExecutionActor(new Request('http://connector.invalid', { headers }), { tokens, grants: owner.executionGrants, nodeId: owner.nodeId },
        { runtime: 'openclaw', sessionKey: input.key }, kind === 'openClawMessageReceiptRead' ? undefined : 'messages:send');
      if (!a.principal.scopes.includes(kind === 'openClawMessageReceiptRead' ? 'messages:read' : 'messages:send')) throw new TurnAuthorizationError();
      return a;
    } catch { throw new TurnAuthorizationError(); }
  };
  if (!tokens?.authenticateAuthorization(input.authorization)) return { error: 401 };
  let original: Actor;
  try { original = actor(); } catch { return { error: 403 }; }
  const scope = JSON.stringify([original.actorId, input.key]);
  const wrap = (r: CommandReceipt | null, intent: OpenClawMessageIntent | null = null, admitted = false): OpenClawMessageResult => {
    const turnId = r?.state === 'accepted' && r.result?.body.status === 'queued' ? r.result.body.idempotencyKey : undefined;
    return { key: input.key, commandKey: input.commandKey, receipt: r, intent, admitted,
      queue: typeof turnId === 'string' ? owner.turns.commandState('openclaw', input.key, turnId, original.actorId) : { presence: 'unknown' } };
  };
  const check = (b?: Binding) => {
    const current = actor();
    if (!sameActor(current, b?.actor ?? original)) throw new TurnAuthorizationError();
    if (b?.turn.payload.deliveryMode === 'mirror' && (!createTurnAuthorizer(owner.executionGrants, (id, s) => tokens!.hasScope(id, s))(
      current.actorId, { runtime: 'openclaw', sessionKey: input.key }, 'messages:mirror', current.executionGrant))) throw new TurnAuthorizationError();
  };
  let value: unknown, owned: Binding | undefined;
  try {
    if (kind === 'openClawMessageReceiptRead' || kind === 'openClawMessageSendReceiptRead') value = wrap(owner.commands.get(scope, input.commandKey) ?? null);
    else if (kind === 'openClawMessageClaim') {
      const v = input as ConnectorOpenClawMessageCommands['openClawMessageClaim']['input'], p = payload(v.payloadJson)!;
      const payloadDigest = createHash('sha256').update(v.payloadJson).digest('hex');
      const claimed = await owner.commands.claimAsync(scope, input.commandKey, p, false, undefined,
        () => bindings.size < 128 && [...bindings.values()].reduce((n, b) => n + Buffer.byteLength(b.turn.payload.message), 0) + Buffer.byteLength(v.payloadJson) <= 2 * OPENCLAW_MESSAGE_PAYLOAD_BYTES && owner.sdkCommandAdmissionOpen,
        receiptId => {
          const intent = { key: input.key, receiptId, id: randomUUID() };
          return { metadata: { runtime: 'openclaw', intent } };
        }, false, () => check(), () => check(), transactionWrite('claim', v.application, payloadDigest));
      check();
      if (!claimed.fresh || claimed.receipt.state !== 'outcome_unknown') value = wrap(claimed.receipt);
      else {
        const normalized = normalizeSendMessageRequest(p), meta = owner.commands.binding(scope, input.commandKey), intent = meta?.intent;
        if (!validIntent(intent)) throw Error('connector_storage_unavailable');
        let rejection: 400 | 404 | 409 | undefined;
        if ('error' in normalized) rejection = 400;
        else if (v.rejectFresh === 'session_missing') rejection = 404;
        else if (v.rejectFresh || normalized.message.trim() === '/stop'
          || ['/status', '/compact'].includes(normalized.message.trim()) && (!normalized.media.length || normalized.deliveryMode === 'mirror' || !!original.executionGrant)
          || !owner.sdkCommandAdmissionOpen) rejection = 409;
        else {
          const explicitRoute = normalized.deliveryMode === 'mirror' ? resolveExplicitChannelRoute(input.key, v.defaultAgentId) : undefined;
          if (normalized.deliveryMode === 'mirror' && !explicitRoute) rejection = 400;
          else {
            owned = { scope, commandKey: input.commandKey, actor: original, intent, ready: false, committing: false, mediaCount: normalized.media.length,
              ...(v.application ? { application: v.application } : {}), payloadDigest,
              turn: { id: intent.id, sessionKey: input.key, createdAt: Date.now(), payload: { actorId: original.actorId, message: normalized.message,
                ...(original.executionGrant ? { executionGrant: original.executionGrant } : {}), deliveryMode: normalized.deliveryMode,
                ...(explicitRoute ? { explicitRoute } : {}), media: [] } } };
            check(owned); bindings.set(intent.receiptId, owned);
            value = wrap(claimed.receipt, intent);
          }
        }
        if (rejection) value = wrap(owner.commands.settle(scope, input.commandKey, { status: rejection, body: { error: 'Command rejected' } }));
      }
    } else {
      const v = input as Ref & { media?: OpenClawMessageMedia[] }, b = bindings.get(v.intent.receiptId);
      const saved = owner.commands.get(scope, input.commandKey);
      if (!b || b.scope !== scope || b.commandKey !== input.commandKey || b.intent.id !== v.intent.id || b.intent.key !== input.key
        || saved?.id !== b.intent.receiptId || saved.state !== 'outcome_unknown') value = kind === 'openClawMessageReady' ? false : wrap(saved ?? null);
      else {
        owned = b; check(b);
        if (kind === 'openClawMessageReady') { value = !b.ready && owner.sdkCommandAdmissionOpen && !owner.commands.sessionDeletion(input.key); if (value) b.ready = true; }
        else if (!b.ready || b.committing || v.media!.length !== b.mediaCount) value = { error: 409 };
        else {
          b.committing = true;
          const turn = { ...b.turn, payload: { ...b.turn.payload, media: v.media! } };
          const result = { ok: true, runId: turn.id, idempotencyKey: turn.id, status: 'queued', media: v.media!.map(m => m.media) };
          const ready = () => { check(b); if (!owner.sdkCommandAdmissionOpen) throw new SessionDeletionConflict(); };
          await owner.turns.enqueueAsync('openclaw', turn, openClawMessageCommit(turn, owner.mirrorOutbox,
            owner.commands.queueCommit(scope, input.commandKey, { status: 200, body: result })), ready,
          transactionWrite('queue', b.application, b.payloadDigest));
          bindings.delete(b.intent.receiptId); value = wrap(owner.commands.get(scope, input.commandKey)!, null, true);
        }
      }
    }
  } catch (error) {
    const saved = owner.commands.get(scope, input.commandKey);
    if (owned?.committing && saved?.id === owned.intent.receiptId && saved.state === 'accepted') {
      bindings.delete(owned.intent.receiptId); value = wrap(saved, null, true);
    } else if (error instanceof TurnAuthorizationError || error instanceof SessionDeletionConflict) {
      if (owned && saved?.id === owned.intent.receiptId && saved.state === 'outcome_unknown') {
        owner.commands.settle(scope, input.commandKey, { status: error instanceof TurnAuthorizationError ? 403 : 409, body: { error: 'Command rejected' } });
        bindings.delete(owned.intent.receiptId);
      }
      value = { error: error instanceof TurnAuthorizationError ? 403 : 409 };
    } else if (error instanceof CommandConflict) value = { error: 409 };
    else if (error instanceof CommandCapacity) value = { error: 503 };
    else throw error;
  }
  if (!validConnectorOpenClawMessageOutput(kind, value)) throw Error('connector_storage_unavailable');
  return value as ConnectorOpenClawMessageCommands[K]['output'];
}
