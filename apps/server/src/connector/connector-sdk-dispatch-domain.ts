import { createHash, randomUUID } from 'node:crypto';
import { MAX_MESSAGE_CHARS, sessionRuntimeId, type InteractionScope } from '@agentopsdeck/shared';
import { waitingBatch, describeBatch, type CodexBatch } from '../codex/queued-batch.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { createTurnAuthorizer, type ExecutionGrantAuthority } from './execution-grants.js';
import type { SdkTextInput } from './sdk-dispatch.js';
import type { SdkAgentId, SdkExecution, SdkCompactRef } from './sdk-execution-journal.js';
import { validSdkJournalSnapshot } from './connector-sdk-journal-domain.js';

export type SdkDispatchPlan = { key: string; digest: string; text: string; actor: Omit<SdkTextInput, 'text'>;
  members: string[]; batch?: CodexBatch };
type Scope = { runtime: SdkAgentId; key: string };
type ExecutionScope = { runtime: SdkAgentId; ref: SdkCompactRef };
export type SdkInteractionBinding = { bindingId: string; ref: SdkCompactRef; scope: InteractionScope };
const bindings = new WeakMap<ConnectorUserStore, Map<string, SdkInteractionBinding>>();
export type ConnectorSdkDispatchCommands = {
  sdkNativeReady: { input: ExecutionScope; output: boolean };
  sdkInteractionPrepare: { input: ExecutionScope; output: SdkInteractionBinding | null };
  sdkInteractionCheck: { input: ExecutionScope & { bindingId: string }; output: boolean };
  sdkInteractionRelease: { input: ExecutionScope & { bindingId: string }; output: boolean };
  sdkDispatchPlan: { input: Scope; output: SdkDispatchPlan | 'blocked' | null };
  sdkDispatchClaim: { input: Scope & { id: string; epoch: string; digest: string; separator?: string }; output: SdkExecution | null };
  sdkInterruptClaim: { input: { runtime: SdkAgentId; ref: SdkCompactRef; actorId: string; executionGrant?: ExecutionGrantAuthority };
    output: SdkExecution | 'blocked' | null };
};
export type ConnectorSdkDispatchKind = keyof ConnectorSdkDispatchCommands;
export const connectorSdkDispatchSteps = Object.freeze({ sdkDispatchPlan: 76, sdkDispatchClaim: 77, sdkInterruptClaim: 78,
  sdkNativeReady: 102, sdkInteractionPrepare: 103, sdkInteractionCheck: 104, sdkInteractionRelease: 105 });
export const isConnectorSdkDispatchKind = (kind: string): kind is ConnectorSdkDispatchKind => Object.hasOwn(connectorSdkDispatchSteps, kind);
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => !!v
  && typeof v === 'object' && !Array.isArray(v) && required.every(k => Object.hasOwn(v, k))
  && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\u0000-\u001f\u007f]/.test(v);
const runtime = (v: unknown): v is SdkAgentId => v === 'claude-code' || v === 'ghcp' || v === 'antigravity';
const key = (v: unknown, r?: unknown): v is string => id(v) && runtime(sessionRuntimeId(v))
  && v !== `${sessionRuntimeId(v)}:` && (r === undefined || sessionRuntimeId(v) === r);
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const separator = (v: unknown): v is string => typeof v === 'string' && /^\n\n\[Queued message boundary [a-f0-9-]{36}\]\n\n$/.test(v);
const grant = (v: unknown) => fields(v, ['id', 'actorId', 'issuerTokenId']) && id(v.id) && id(v.actorId) && id(v.issuerTokenId);
const ref = (v: unknown, r?: unknown): v is SdkCompactRef => fields(v, ['id', 'key', 'epoch', 'nativeSessionId'])
  && id(v.id) && key(v.key, r) && id(v.epoch) && id(v.nativeSessionId);
const same = (a: SdkCompactRef, b: SdkCompactRef) => a.id === b.id && a.key === b.key
  && a.epoch === b.epoch && a.nativeSessionId === b.nativeSessionId;
/** Private original execution capability; never reconstruct a scope from HTTP. */
export function originalSdkInteractionBinding(owner: ConnectorUserStore, runtime: SdkAgentId,
  ref: SdkCompactRef, bindingId: string): SdkInteractionBinding | undefined {
  const binding = bindings.get(owner)?.get(bindingId);
  return binding && sessionRuntimeId(binding.ref.key) === runtime && same(binding.ref, ref)
    ? structuredClone(binding) : undefined;
}
export function validSdkDispatchPayload(v: unknown): v is SdkTextInput {
  return fields(v, ['text', 'images', 'actorId'], ['attachmentCount', 'executionGrant'])
    && typeof v.text === 'string' && !!v.text.trim() && v.text.length <= MAX_MESSAGE_CHARS && id(v.actorId)
    && Array.isArray(v.images) && v.images.length === 0
    && (!Object.hasOwn(v, 'attachmentCount') || Number.isSafeInteger(v.attachmentCount) && Number(v.attachmentCount) >= 1 && Number(v.attachmentCount) <= 8)
    && (!Object.hasOwn(v, 'executionGrant') || grant(v.executionGrant));
}
export function validConnectorSdkDispatchInput(kind: ConnectorSdkDispatchKind, v: unknown): boolean {
  if (kind === 'sdkNativeReady' || kind === 'sdkInteractionPrepare' || kind === 'sdkInteractionCheck' || kind === 'sdkInteractionRelease') {
    const bound = kind === 'sdkInteractionCheck' || kind === 'sdkInteractionRelease';
    return fields(v, ['runtime', 'ref', ...(bound ? ['bindingId'] : [])]) && runtime(v.runtime)
      && ref(v.ref, v.runtime) && (!bound || id(v.bindingId));
  }
  if (kind === 'sdkInterruptClaim') return fields(v, ['runtime', 'ref', 'actorId'], ['executionGrant']) && runtime(v.runtime)
    && id(v.actorId) && (!Object.hasOwn(v, 'executionGrant') || grant(v.executionGrant))
    && fields(v.ref, ['id', 'key', 'epoch', 'nativeSessionId']) && id(v.ref.id) && key(v.ref.key, v.runtime)
    && id(v.ref.epoch) && id(v.ref.nativeSessionId);
  return fields(v, kind === 'sdkDispatchPlan' ? ['runtime', 'key'] : ['runtime', 'key', 'id', 'epoch', 'digest'],
    kind === 'sdkDispatchPlan' ? [] : ['separator']) && runtime(v.runtime) && key(v.key, v.runtime)
    && (kind === 'sdkDispatchPlan' || id(v.id) && id(v.epoch) && digest(v.digest)
      && (!Object.hasOwn(v, 'separator') || separator(v.separator)));
}
export function validSdkDispatchExecution(v: unknown): v is SdkExecution {
  if (!fields(v, ['id', 'key', 'epoch', 'nativeSessionId', 'members', 'nativeMode', 'phase', 'stopRequested', 'createdAt', 'updatedAt'],
    ['kind', 'model', 'batch', 'outcome', 'nativeRequestId'])) return false;
  return validSdkJournalSnapshot({ session: null, execution: v, deletion: null, canStart: false,
    unresolved: !['completed', 'failed', 'interrupted'].includes(v.phase as string) });
}
export function validConnectorSdkDispatchOutput(kind: ConnectorSdkDispatchKind, v: unknown): boolean {
  if (kind === 'sdkNativeReady' || kind === 'sdkInteractionCheck' || kind === 'sdkInteractionRelease') return typeof v === 'boolean';
  if (kind === 'sdkInteractionPrepare') return v === null || fields(v, ['bindingId', 'ref', 'scope']) && id(v.bindingId)
    && ref(v.ref) && fields(v.scope, ['ownerId', 'nodeId', 'sessionKey', 'runId'])
    && id(v.scope.ownerId) && id(v.scope.nodeId) && v.scope.sessionKey === v.ref.key && v.scope.runId === v.ref.id;
  if (v === null) return true;
  if (kind !== 'sdkDispatchPlan') return kind === 'sdkInterruptClaim' && v === 'blocked' || validSdkDispatchExecution(v);
  if (v === 'blocked') return true;
  if (!fields(v, ['key', 'digest', 'text', 'actor', 'members'], ['batch']) || !key(v.key) || !digest(v.digest)
    || !fields(v.actor, ['images', 'actorId'], ['attachmentCount', 'executionGrant'])
    || !validSdkDispatchPayload({ ...v.actor, text: 'metadata' }) || typeof v.text !== 'string' || !v.text.trim() || v.text.length > MAX_MESSAGE_CHARS
    || !Array.isArray(v.members) || v.members.length < 1 || v.members.length > 16 || !v.members.every(id)
    || new Set(v.members).size !== v.members.length) return false;
  if (v.members.length === 1) return !Object.hasOwn(v, 'batch');
  if (!fields(v.batch, ['separator', 'members']) || !separator(v.batch.separator) || !Array.isArray(v.batch.members)
    || v.batch.members.length !== v.members.length || v.actor.attachmentCount !== undefined
    || (v.text as string).split(v.batch.separator).length !== v.members.length) return false;
  return v.batch.members.every((m, i) => fields(m, ['id', 'createdAt', 'imageCount']) && m.id === (v.members as string[])[i]
    && Number.isSafeInteger(m.createdAt) && Number(m.createdAt) >= 0 && m.imageCount === 0);
}

/** A plan is NOT a lease or authorization witness. Claim reloads original
 * rows and fresh issuer authority INSIDE the original journal/queue savepoint.
 * No caller body, permission bool, receipt callback or native RPC is accepted. */
export function executeConnectorSdkDispatch<K extends ConnectorSdkDispatchKind>(kind: K,
  input: ConnectorSdkDispatchCommands[K]['input'], owner: ConnectorUserStore, tokens?: ConnectorTokenStore): ConnectorSdkDispatchCommands[K]['output'] {
  if (!validConnectorSdkDispatchInput(kind, input) || !tokens) throw Error('connector_storage_unavailable');
  const journal = input.runtime === 'claude-code' ? owner.claudeJournal : input.runtime === 'ghcp' ? owner.copilotJournal : owner.antigravityJournal;
  const authorize = createTurnAuthorizer(owner.executionGrants, (token, scope) => tokens.hasScope(token, scope));
  const live = (r: SdkCompactRef, dispatchOnly = false) => {
    const snapshot = journal.readSnapshot(r.key), e = snapshot.execution;
    if (!validSdkJournalSnapshot(snapshot)) throw Error('connector_storage_unavailable');
    return owner.sdkCommandAdmissionOpen && !!e && e.kind !== 'compact' && same(e, r) && !e.stopRequested
      && (dispatchOnly ? e.phase === 'dispatching' : ['dispatching', 'running'].includes(e.phase))
      && !!snapshot.session && snapshot.session.nativeSessionId === r.nativeSessionId
      && !owner.commands.sessionDeletion(r.key) && !snapshot.deletion;
  };
  const nativeReady = (r: SdkCompactRef) => {
    if (!live(r, true)) return false;
    const e = journal.current(r.key)!;
    const rows = owner.turns.dispatchPrefix<SdkTextInput>(input.runtime, r.key);
    return e.members.length > 0 && e.members.every((member, index) => {
      const row = rows[index];
      return !!row && row.id === member && row.state === 'dispatching' && validSdkDispatchPayload(row.payload)
        && authorize(row.payload.actorId, { runtime: input.runtime, sessionKey: r.key }, 'messages:send', row.payload.executionGrant);
    });
  };
  if (kind === 'sdkNativeReady' || kind === 'sdkInteractionPrepare' || kind === 'sdkInteractionCheck' || kind === 'sdkInteractionRelease') {
    const v = input as ExecutionScope & { bindingId?: string };
    let map = bindings.get(owner);
    if (!map) { map = new Map(); bindings.set(owner, map); }
    if (kind === 'sdkNativeReady') return nativeReady(v.ref) as ConnectorSdkDispatchCommands[K]['output'];
    if (kind === 'sdkInteractionPrepare') {
      if (!nativeReady(v.ref)) throw Error('connector_storage_unavailable');
      const e = journal.current(v.ref.key)!;
      const ownerId = owner.turns.interactionOwner(v.runtime, v.ref.key, e.members);
      if (!ownerId) return null as ConnectorSdkDispatchCommands[K]['output'];
      const scope = { ownerId, nodeId: owner.nodeId, sessionKey: v.ref.key, runId: v.ref.id };
      if (owner.interactions.mode(scope) !== 'interactive') return null as ConnectorSdkDispatchCommands[K]['output'];
      const existing = [...map.values()].find(b => same(b.ref, v.ref));
      if (existing) return structuredClone(existing) as ConnectorSdkDispatchCommands[K]['output'];
      if (map.size >= 128) throw Error('connector_storage_unavailable');
      const binding = { bindingId: randomUUID(), ref: { ...v.ref }, scope };
      map.set(binding.bindingId, binding);
      return structuredClone(binding) as ConnectorSdkDispatchCommands[K]['output'];
    }
    const binding = map.get(v.bindingId!);
    if (!binding || !same(binding.ref, v.ref)) return false as ConnectorSdkDispatchCommands[K]['output'];
    if (kind === 'sdkInteractionRelease') return map.delete(v.bindingId!) as ConnectorSdkDispatchCommands[K]['output'];
    return (live(v.ref) && authorize(binding.scope.ownerId, { runtime: v.runtime, sessionKey: v.ref.key }, 'messages:send')) as ConnectorSdkDispatchCommands[K]['output'];
  }
  const plan = (key: string, fixedSeparator?: string, block = false): SdkDispatchPlan | 'blocked' | null => {
    const snapshot = journal.readSnapshot(key);
    if (!validSdkJournalSnapshot(snapshot)) throw Error('connector_storage_unavailable');
    if (!snapshot.canStart) return null;
    const prefix = owner.turns.dispatchPrefix<SdkTextInput>(input.runtime, key), head = prefix[0];
    if (!head || head.state !== 'queued') return null;
    const allowed = (p: SdkTextInput) => validSdkDispatchPayload(p)
      && authorize(p.actorId, { runtime: input.runtime, sessionKey: key }, 'messages:send', p.executionGrant);
    if (!allowed(head.payload)) { if (block) owner.turns.block(input.runtime, head.id); return 'blocked'; }
    const entries = waitingBatch(prefix, e => allowed(e.payload));
    const media = entries.findIndex(e => !!e.payload.attachmentCount);
    if (media >= 0) entries.splice(media === 0 ? 1 : media);
    const batchFor = (): CodexBatch | undefined => {
      if (entries.length < 2) return;
      if (fixedSeparator !== undefined) {
        if (entries.some(e => e.payload.text.includes(fixedSeparator))) throw Error('connector_storage_unavailable');
        return { separator: fixedSeparator, members: entries.map(e => ({ id: e.id, createdAt: e.createdAt, imageCount: 0 })) };
      }
      return describeBatch(entries);
    };
    let batch = batchFor(), text = entries.map(e => e.payload.text).join(batch?.separator ?? '');
    while (text.length > MAX_MESSAGE_CHARS && entries.length > 1) {
      entries.pop(); batch = batchFor(); text = entries.map(e => e.payload.text).join(batch?.separator ?? '');
    }
    if (!entries.length) return null;
    const { text: _headText, ...actor } = head.payload;
    const value = { key, text, actor, members: entries.map(e => e.id), ...(batch ? { batch } : {}) };
    // Bind settings/native identity as well as queue bodies and member times.
    return { ...value, digest: createHash('sha256').update(JSON.stringify({ value, session: snapshot.session })).digest('hex') };
  };
  let result: unknown;
  if (kind === 'sdkDispatchPlan') result = plan((input as Scope).key, undefined, true);
  else if (kind === 'sdkDispatchClaim') {
    const v = input as ConnectorSdkDispatchCommands['sdkDispatchClaim']['input'];
    const selected = plan(v.key, v.separator);
    result = selected && selected !== 'blocked' && selected.digest === v.digest
      ? journal.begin(v, selected.members, owner.turns, selected.batch, () => {
        const fresh = plan(v.key, v.separator);
        return !!fresh && fresh !== 'blocked' && fresh.digest === v.digest;
      }) ?? null : null;
  } else {
    const v = input as ConnectorSdkDispatchCommands['sdkInterruptClaim']['input'];
    const snapshot = journal.readSnapshot(v.ref.key);
    if (!validSdkJournalSnapshot(snapshot)) throw Error('connector_storage_unavailable');
    const e = snapshot.execution;
    if (!e || e.kind === 'compact' || e.id !== v.ref.id || e.epoch !== v.ref.epoch || e.nativeSessionId !== v.ref.nativeSessionId) result = null;
    else if (!authorize(v.actorId, { runtime: v.runtime, sessionKey: v.ref.key }, 'runs:interrupt', v.executionGrant)) result = 'blocked';
    else result = journal.requestStop(v.ref) ? { ...e, stopRequested: true } : null;
  }
  if (!validConnectorSdkDispatchOutput(kind, result)) throw Error('connector_storage_unavailable');
  return result as ConnectorSdkDispatchCommands[K]['output'];
}
