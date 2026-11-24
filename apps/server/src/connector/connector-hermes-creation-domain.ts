import { randomUUID } from 'node:crypto';
import type { CommandReceipt } from '@agentopsdeck/shared';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { CommandCapacity, CommandConflict } from '../commands/receipts.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { validApplicationTransactionEvidence, type ApplicationTransactionEvidence, type ApplicationTransactionClient } from '../auth/application-transaction-gate.js';
import { applicationControlTransaction } from './application-stop-transaction.js';

type Scope = { authorization: string; commandKey: string };
export type HermesCreationIntent = { key: string; title: string; receiptId: string };
type Ref = { intent: HermesCreationIntent };
export type HermesCreationResult = { commandKey: string; receipt: CommandReceipt; intent: HermesCreationIntent | null; admitted: boolean };
export type ConnectorHermesCreationCommands = {
  hermesCreationClaim: { input: Scope & { payloadJson: string; rejectFresh?: 'runtime_unavailable'; application?: ApplicationTransactionEvidence }; output: { error: 401 | 403 | 409 | 503 } | HermesCreationResult };
  hermesCreationReady: { input: Ref & { authorization: string }; output: boolean };
  hermesCreationSettle: { input: Ref & { stored: string | null }; output: false | HermesCreationResult };
  hermesCreationReceiptRead: { input: Scope; output: { error: 401 | 403 } | { commandKey: string; receipt: CommandReceipt | null } };
};
export type ConnectorHermesCreationKind = keyof ConnectorHermesCreationCommands;
export const connectorHermesCreationSteps = Object.freeze({ hermesCreationClaim: 176, hermesCreationReady: 177,
  hermesCreationSettle: 178, hermesCreationReceiptRead: 179 });
export const isConnectorHermesCreationKind = (v: string): v is ConnectorHermesCreationKind => Object.hasOwn(connectorHermesCreationSteps, v);
const fields = (v: unknown, keys: string[], optional: string[] = []): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && keys.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => keys.includes(k) || optional.includes(k));
const id = (v: unknown): v is string => typeof v === 'string' && !!v && Buffer.byteLength(v) <= 512 && !/[\x00-\x1f\x7f]/.test(v);
const key = (v: unknown): v is string => id(v) && v.startsWith('hermes:') && v.length > 7;
const title = (v: unknown): v is string => typeof v === 'string' && !!v && v.length <= 120 && !/[\x00-\x1f\x7f]/.test(v);
const commandKey = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
const authorization = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && Buffer.byteLength(v) <= 4096 && !/[\r\n\x00]/.test(v);
const intent = (v: unknown): v is HermesCreationIntent => fields(v, ['key', 'title', 'receiptId']) && key(v.key) && title(v.title) && id(v.receiptId);
const same = (a: HermesCreationIntent, b: HermesCreationIntent) => a.key === b.key && a.title === b.title && a.receiptId === b.receiptId;
function payload(v: unknown): Record<string, unknown> | null {
  if (typeof v !== 'string' || Buffer.byteLength(v) > 8192) return null;
  try {
    const p: unknown = JSON.parse(v);
    return fields(p, [], ['title', 'label', 'model']) && ['title', 'label', 'model'].every(k => !Object.hasOwn(p, k) || typeof p[k] === 'string' || p[k] === null) ? p : null;
  } catch { return null; }
}
function receipt(v: unknown): v is CommandReceipt {
  if (!fields(v, ['id', 'key', 'state', 'createdAt', 'updatedAt'], ['result']) || !id(v.id) || !commandKey(v.key)
    || !Number.isSafeInteger(v.createdAt) || Number(v.createdAt) < 0 || !Number.isSafeInteger(v.updatedAt) || Number(v.updatedAt) < 0) return false;
  if (v.state === 'outcome_unknown') return !Object.hasOwn(v, 'result');
  if (!fields(v.result, ['status', 'body'])) return false;
  const r = v.result;
  return v.state === 'accepted' && r.status === 201 && fields(r.body, ['key', 'agentId', 'title']) && key(r.body.key) && r.body.agentId === 'hermes' && title(r.body.title)
    || v.state === 'rejected' && Number.isInteger(r.status) && Number(r.status) >= 400 && Number(r.status) < 500
      && fields(r.body, ['error']) && r.body.error === 'Command rejected';
}
export function validConnectorHermesCreationInput(k: ConnectorHermesCreationKind, v: unknown): boolean {
  if (k === 'hermesCreationClaim') return fields(v, ['authorization', 'commandKey', 'payloadJson'], ['rejectFresh', 'application'])
    && (!Object.hasOwn(v, 'application') || validApplicationTransactionEvidence(v.application)) && authorization(v.authorization)
    && commandKey(v.commandKey) && payload(v.payloadJson) !== null && (!Object.hasOwn(v, 'rejectFresh') || v.rejectFresh === 'runtime_unavailable');
  if (k === 'hermesCreationReceiptRead') return fields(v, ['authorization', 'commandKey']) && authorization(v.authorization) && commandKey(v.commandKey);
  if (k === 'hermesCreationReady') return fields(v, ['intent', 'authorization']) && intent(v.intent) && authorization(v.authorization);
  return fields(v, ['intent', 'stored']) && intent(v.intent) && (v.stored === null || id(v.stored));
}
export function validConnectorHermesCreationOutput(k: ConnectorHermesCreationKind, v: unknown): boolean {
  if (k === 'hermesCreationReady') return typeof v === 'boolean';
  if (k === 'hermesCreationSettle' && v === false) return true;
  if (fields(v, ['error'])) return typeof v.error === 'number' && (k === 'hermesCreationClaim' ? [401, 403, 409, 503] : k === 'hermesCreationReceiptRead' ? [401, 403] : []).includes(v.error);
  if (k === 'hermesCreationReceiptRead') return fields(v, ['commandKey', 'receipt']) && commandKey(v.commandKey)
    && (v.receipt === null || receipt(v.receipt) && v.receipt.key === v.commandKey);
  return fields(v, ['commandKey', 'receipt', 'intent', 'admitted']) && commandKey(v.commandKey) && receipt(v.receipt) && v.receipt.key === v.commandKey
    && typeof v.admitted === 'boolean' && (v.admitted === true ? k === 'hermesCreationClaim' && v.receipt.state === 'outcome_unknown'
      && intent(v.intent) && v.intent.receiptId === v.receipt.id : v.intent === null);
}
type Binding = { scope: string; commandKey: string; actorId: string; intent: HermesCreationIntent; ready: boolean;
  control?: NonNullable<ReturnType<typeof applicationControlTransaction>> };
const active = new WeakMap<ConnectorUserStore, Map<string, Binding>>();
class Denied extends Error {}

/** Original receipt transaction; a persistent unknown is never a new handoff. */
export async function executeConnectorHermesCreation<K extends ConnectorHermesCreationKind>(kind: K,
  request: ConnectorHermesCreationCommands[K]['input'], owner: ConnectorUserStore, tokens?: ConnectorTokenStore,
  transactions?: ApplicationTransactionClient): Promise<ConnectorHermesCreationCommands[K]['output']> {
  if (!validConnectorHermesCreationInput(kind, request)) throw Error('connector_storage_unavailable');
  const input = structuredClone(request), journal = owner.hermesJournal;
  let bindings = active.get(owner);
  if (!bindings) { bindings = new Map(); active.set(owner, bindings); }
  const permitted = (auth: string, actorId?: string) => {
    const p = tokens?.authenticateAuthorization(auth);
    return !!p && (!actorId || p.tokenId === actorId) && !p.tokenId.startsWith('actor_')
      && p.scopes.includes('sessions:create') && !p.scopes.includes('execution:delegate');
  };
  let value: unknown;
  if (kind === 'hermesCreationClaim' || kind === 'hermesCreationReceiptRead') {
    const v = input as ConnectorHermesCreationCommands['hermesCreationClaim']['input'];
    const actor = tokens?.authenticateAuthorization(v.authorization);
    if (!actor) value = { error: 401 };
    else if (!permitted(v.authorization, actor.tokenId)) value = { error: 403 };
    else {
      const scope = JSON.stringify(['create', JSON.stringify([actor.tokenId, 'hermes'])]);
      if (kind === 'hermesCreationReceiptRead') value = { commandKey: v.commandKey, receipt: owner.commands.get(scope, v.commandKey) ?? null };
      else {
        const check = () => { if (!permitted(v.authorization, actor.tokenId)) throw new Denied(); };
        const control = applicationControlTransaction('hermes', { ...v, key: 'hermes:create' }, transactions);
        const p = payload(v.payloadJson)!, normalized = String(p.title ?? p.label ?? 'New chat').trim() || 'New chat';
        let original: HermesCreationIntent | undefined;
        try {
          const claimed = await owner.commands.claimAsync(scope, v.commandKey, p, false, undefined,
            () => owner.sdkCommandAdmissionOpen && bindings.size < 128 && v.rejectFresh !== 'runtime_unavailable' && title(normalized) && !p.model,
            receiptId => {
              check(); original = { key: `hermes:${randomUUID()}`, title: normalized, receiptId };
              return { metadata: { runtime: 'hermes', intent: original } };
            }, false, check, check, control?.claim);
          if (claimed.fresh && original) bindings.set(claimed.receipt.id, { scope, commandKey: v.commandKey, actorId: actor.tokenId, intent: original, ready: false,
            ...(control ? { control } : {}) });
          value = { commandKey: v.commandKey, receipt: claimed.receipt, intent: claimed.fresh ? original ?? null : null, admitted: claimed.fresh && !!original };
        } catch (error) {
          if (error instanceof Denied) value = { error: 403 };
          else if (error instanceof CommandCapacity) value = { error: 503 };
          else if (error instanceof CommandConflict) value = { error: 409 };
          else throw error;
        }
      }
    }
  } else {
    const v = input as Ref & { authorization?: string; stored?: string | null };
    const b = bindings.get(v.intent.receiptId), original = b ? owner.commands.get(b.scope, b.commandKey) : undefined;
    if (!b || !same(b.intent, v.intent) || original?.id !== v.intent.receiptId || original.state !== 'outcome_unknown') value = false;
    else if (kind === 'hermesCreationReady') {
      const ready = () => {
        const current = owner.commands.get(b.scope, b.commandKey);
        const allowed = bindings.get(v.intent.receiptId) === b && current?.id === v.intent.receiptId && current.state === 'outcome_unknown'
          && !b.ready && owner.sdkCommandAdmissionOpen && !journal.session(v.intent.key) && !journal.deletion(v.intent.key) && permitted(v.authorization!, b.actorId);
        if (allowed) b.ready = true;
        return allowed;
      };
      value = b.control ? await b.control.ready(ready) : ready();
    } else if (v.stored !== null && !b.ready) value = false;
    else {
      // Do not reauthorize settlement after an irreversible original effect.
      if (v.stored !== null) journal.create({ key: b.intent.key, stored: v.stored!, title: b.intent.title, started: false,
        nativeAllocated: true, messages: [] }, db => {
        owner.commands.creationCommit(b.scope, b.commandKey, { status: 201, body: { key: b.intent.key, agentId: 'hermes', title: b.intent.title } })(db);
        owner.events.appendInTransaction(db, { id: '', ts: Date.now(), type: 'session.updated', sessionKey: b.intent.key,
          agentId: 'hermes', payload: { sessionKey: b.intent.key, status: 'idle' } });
      });
      const current = owner.commands.get(b.scope, b.commandKey);
      if (!current || current.id !== v.intent.receiptId) throw Error('connector_storage_unavailable');
      bindings.delete(v.intent.receiptId);
      if (v.stored !== null) { try { owner.events.changes.notify(); } catch { /* durable acceptance wins */ } }
      value = { commandKey: b.commandKey, receipt: current, intent: null, admitted: false };
    }
  }
  if (!validConnectorHermesCreationOutput(kind, value)) throw Error('connector_storage_unavailable');
  return value as ConnectorHermesCreationCommands[K]['output'];
}
