import type { CommandReceipt } from '@agentopsdeck/shared';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { CommandCapacity, CommandConflict } from '../commands/receipts.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { validApplicationTransactionEvidence, type ApplicationTransactionClient, type ApplicationTransactionEvidence } from '../auth/application-transaction-gate.js';
import { applicationControlTransaction } from './application-stop-transaction.js';

type Scope = { key: string; authorization: string; commandKey: string };
export type HermesDeletionIntent = { key: string; stored: string; receiptId: string };
type Ref = { intent: HermesDeletionIntent };
export type HermesDeletionResult = { key: string; commandKey: string; receipt: CommandReceipt; intent: HermesDeletionIntent | null; admitted: boolean };
export type ConnectorHermesDeletionCommands = {
  hermesDeletionClaim: { input: Scope & { application?: ApplicationTransactionEvidence }; output: { error: 401 | 403 | 409 | 503 } | HermesDeletionResult };
  hermesDeletionReady: { input: Ref & { authorization: string; stage: 'close' | 'delete' }; output: boolean };
  hermesDeletionSettle: { input: Ref & { accepted: boolean }; output: false | HermesDeletionResult };
  hermesDeletionReceiptRead: { input: Scope; output: { error: 401 | 403 } | { key: string; commandKey: string; receipt: CommandReceipt | null } };
};
export type ConnectorHermesDeletionKind = keyof ConnectorHermesDeletionCommands;
export const connectorHermesDeletionSteps = Object.freeze({ hermesDeletionClaim: 161, hermesDeletionReady: 162,
  hermesDeletionSettle: 163, hermesDeletionReceiptRead: 164 });
export const isConnectorHermesDeletionKind = (v: string): v is ConnectorHermesDeletionKind => Object.hasOwn(connectorHermesDeletionSteps, v);
const fields = (v: unknown, keys: string[], optional: string[] = []): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && keys.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => keys.includes(k) || optional.includes(k));
const id = (v: unknown): v is string => typeof v === 'string' && !!v && Buffer.byteLength(v) <= 512 && !/[\x00-\x1f\x7f]/.test(v);
const key = (v: unknown): v is string => id(v) && v.startsWith('hermes:') && v.length > 7;
const commandKey = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
const authorization = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && Buffer.byteLength(v) <= 4096 && !/[\r\n\x00]/.test(v);
const intent = (v: unknown): v is HermesDeletionIntent => fields(v, ['key', 'stored', 'receiptId']) && key(v.key) && id(v.stored) && id(v.receiptId);
const same = (a: HermesDeletionIntent, b: HermesDeletionIntent) => a.key === b.key && a.stored === b.stored && a.receiptId === b.receiptId;
function receipt(v: unknown): v is CommandReceipt {
  if (!fields(v, ['id', 'key', 'state', 'createdAt', 'updatedAt'], ['result']) || !id(v.id) || !commandKey(v.key)
    || !Number.isSafeInteger(v.createdAt) || Number(v.createdAt) < 0 || !Number.isSafeInteger(v.updatedAt) || Number(v.updatedAt) < 0) return false;
  if (v.state === 'outcome_unknown') return !Object.hasOwn(v, 'result');
  if (!fields(v.result, ['status', 'body'])) return false;
  const r = v.result;
  return v.state === 'accepted' && r.status === 200 && fields(r.body, ['ok', 'status']) && r.body.ok === true && r.body.status === 'delete_accepted'
    || v.state === 'rejected' && Number.isInteger(r.status) && Number(r.status) >= 400 && Number(r.status) < 500
      && fields(r.body, ['error']) && r.body.error === 'Command rejected';
}
export function validConnectorHermesDeletionInput(k: ConnectorHermesDeletionKind, v: unknown): boolean {
  if (k === 'hermesDeletionClaim' || k === 'hermesDeletionReceiptRead') return fields(v, ['key', 'authorization', 'commandKey'], k === 'hermesDeletionClaim' ? ['application'] : [])
    && key(v.key) && authorization(v.authorization) && commandKey(v.commandKey)
    && (!Object.hasOwn(v, 'application') || validApplicationTransactionEvidence(v.application));
  if (k === 'hermesDeletionReady') return fields(v, ['intent', 'authorization', 'stage']) && intent(v.intent)
    && authorization(v.authorization) && (v.stage === 'close' || v.stage === 'delete');
  return fields(v, ['intent', 'accepted']) && intent(v.intent) && typeof v.accepted === 'boolean';
}
export function validConnectorHermesDeletionOutput(k: ConnectorHermesDeletionKind, v: unknown): boolean {
  if (k === 'hermesDeletionReady') return typeof v === 'boolean';
  if (k === 'hermesDeletionSettle' && v === false) return true;
  if (fields(v, ['error'])) return typeof v.error === 'number' && (k === 'hermesDeletionClaim' ? [401, 403, 409, 503] : k === 'hermesDeletionReceiptRead' ? [401, 403] : []).includes(v.error);
  if (k === 'hermesDeletionReceiptRead') return fields(v, ['key', 'commandKey', 'receipt']) && key(v.key) && commandKey(v.commandKey)
    && (v.receipt === null || receipt(v.receipt) && v.receipt.key === v.commandKey);
  return fields(v, ['key', 'commandKey', 'receipt', 'intent', 'admitted']) && key(v.key) && commandKey(v.commandKey)
    && receipt(v.receipt) && v.receipt.key === v.commandKey && typeof v.admitted === 'boolean'
    && (v.admitted === true ? k === 'hermesDeletionClaim' && intent(v.intent) && v.intent.key === v.key && v.intent.receiptId === v.receipt.id
      && v.receipt.state === 'outcome_unknown' : v.intent === null);
}
type Binding = { scope: string; commandKey: string; actorId: string; intent: HermesDeletionIntent; stage: number; control?: NonNullable<ReturnType<typeof applicationControlTransaction>> };
const active = new WeakMap<ConnectorUserStore, Map<string, Binding>>();
class Denied extends Error {}

/** Original owner and receipt transaction only. Restart cannot renew a native
 * handoff: persistent pending is observation, never execution permission. */
export async function executeConnectorHermesDeletion<K extends ConnectorHermesDeletionKind>(kind: K,
  request: ConnectorHermesDeletionCommands[K]['input'], owner: ConnectorUserStore, tokens?: ConnectorTokenStore, transactions?: ApplicationTransactionClient): Promise<ConnectorHermesDeletionCommands[K]['output']> {
  if (!validConnectorHermesDeletionInput(kind, request)) throw Error('connector_storage_unavailable');
  const input = structuredClone(request), journal = owner.hermesJournal;
  let bindings = active.get(owner);
  if (!bindings) { bindings = new Map(); active.set(owner, bindings); }
  const principal = (auth: string) => tokens?.authenticateAuthorization(auth);
  const permitted = (auth: string, actorId?: string) => {
    const p = principal(auth);
    return !!p && (!actorId || p.tokenId === actorId) && !p.tokenId.startsWith('actor_')
      && p.scopes.includes('sessions:create') && !p.scopes.includes('execution:delegate');
  };
  let value: unknown;
  if (kind === 'hermesDeletionClaim' || kind === 'hermesDeletionReceiptRead') {
    const v = input as ConnectorHermesDeletionCommands['hermesDeletionClaim']['input'], actor = principal(v.authorization);
    if (!actor) value = { error: 401 };
    else if (!permitted(v.authorization, actor.tokenId)) value = { error: 403 };
    else {
      const scope = JSON.stringify(['delete', JSON.stringify([actor.tokenId, v.key])]);
      if (kind === 'hermesDeletionReceiptRead') value = { key: v.key, commandKey: v.commandKey, receipt: owner.commands.get(scope, v.commandKey) ?? null };
      else {
        const control = applicationControlTransaction('hermes', { ...v, payloadJson: '{}' }, transactions);
        const check = () => { if (!permitted(v.authorization, actor.tokenId)) throw new Denied(); };
        let original: HermesDeletionIntent | undefined;
        try {
          const claimed = await owner.commands.claimAsync(scope, v.commandKey, {}, false, undefined,
            () => owner.sdkCommandAdmissionOpen && !!journal.session(v.key) && !journal.deletion(v.key)
              && owner.canDeleteSession(v.key) && bindings.size < 128,
            receiptId => {
              check();
              original = { key: v.key, stored: journal.session(v.key)!.stored, receiptId };
              journal.beginDeletion(v.key);
              return { metadata: { runtime: 'hermes', intent: original } };
            }, false, check, check, control?.claim);
          if (claimed.fresh && original) bindings.set(claimed.receipt.id, { scope, commandKey: v.commandKey, actorId: actor.tokenId, intent: original, stage: 0, ...(control ? { control } : {}) });
          value = { key: v.key, commandKey: v.commandKey, receipt: claimed.receipt, intent: claimed.fresh ? original ?? null : null, admitted: claimed.fresh };
        } catch (error) {
          if (error instanceof Denied) value = { error: 403 };
          else if (error instanceof CommandCapacity) value = { error: 503 };
          else if (error instanceof CommandConflict) value = { error: 409 };
          else throw error;
        }
      }
    }
  } else {
    const v = input as Ref & { authorization?: string; stage?: 'close' | 'delete'; accepted?: boolean };
    const b = bindings.get(v.intent.receiptId), original = b ? owner.commands.get(b.scope, b.commandKey) : undefined;
    const matches = b && same(b.intent, v.intent) && original?.id === v.intent.receiptId && original.state === 'outcome_unknown'
      && journal.deletion(v.intent.key) === 'pending' && journal.session(v.intent.key)?.stored === v.intent.stored;
    if (!matches) value = false;
    else if (kind === 'hermesDeletionReady') {
      const next = v.stage === 'close' ? 1 : 2;
      const ready = () => {
        const current = owner.commands.get(b.scope, b.commandKey);
        if (bindings!.get(v.intent.receiptId) !== b || current?.id !== v.intent.receiptId || current.state !== 'outcome_unknown'
          || journal.deletion(v.intent.key) !== 'pending' || journal.session(v.intent.key)?.stored !== v.intent.stored
          || b.stage !== next - 1 || !owner.sdkCommandAdmissionOpen || !journal.canStart(v.intent.key)
          || owner.turns.hasPending('hermes', v.intent.key) || !permitted(v.authorization!, b.actorId)) return false;
        b.stage = next; return true;
      };
      value = b.control ? await b.control.ready(ready) : ready();
    } else if (v.accepted && b.stage !== 2) value = false;
    else {
      if (v.accepted) journal.finishDeletion(v.intent.key, db => {
        if (owner.commands.settle(b.scope, b.commandKey, { status: 200, body: { ok: true, status: 'delete_accepted' } }).state !== 'accepted') throw Error('connector_storage_unavailable');
        owner.events.appendInTransaction(db, { id: '', ts: Date.now(), type: 'session.updated', sessionKey: v.intent.key,
          agentId: 'hermes', payload: { sessionKey: v.intent.key, status: 'deleted' } });
      });
      const current = owner.commands.get(b.scope, b.commandKey);
      if (!current || current.id !== v.intent.receiptId) throw Error('connector_storage_unavailable');
      bindings.delete(v.intent.receiptId);
      if (v.accepted) { try { owner.events.changes.notify(); } catch { /* original commit is authoritative */ } }
      value = { key: v.intent.key, commandKey: b.commandKey, receipt: current, intent: null, admitted: false };
    }
  }
  if (!validConnectorHermesDeletionOutput(kind, value)) throw Error('connector_storage_unavailable');
  return value as ConnectorHermesDeletionCommands[K]['output'];
}
