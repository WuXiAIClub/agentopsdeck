import { sessionRuntimeId, type ChatMessage, type CommandReceipt } from '@agentopsdeck/shared';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { CommandCapacity, CommandConflict } from '../commands/receipts.js';
import { claudeHistoryPage } from '../claude/history.js';
import { antigravityHistoryPage, copilotHistoryPage } from '../copilot/history.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import type { SdkAgentId, SdkDeletion, SdkJournalSnapshot } from './sdk-execution-journal.js';
import { validSdkJournalSnapshot } from './connector-sdk-journal-domain.js';
import { validApplicationTransactionEvidence, type ApplicationTransactionClient, type ApplicationTransactionEvidence } from '../auth/application-transaction-gate.js';
import { applicationControlTransaction } from './application-stop-transaction.js';

type Scope = { runtime: SdkAgentId; key: string };
type Claim = Scope & { authorization: string; commandKey: string };
type Ref = Scope & { intent: SdkDeletion; receiptId: string };
type Failure = { error: 401 | 403 | 409 | 503 };
export type SdkLifecycleView = Scope & { snapshot: SdkJournalSnapshot;
  page: { messages: ChatMessage[]; totalCount: number; hiddenCount: number } | null };
export type SdkDeletionAdmission = Scope & { receipt: CommandReceipt; intent: SdkDeletion | null; admitted: boolean; nativeRequired: boolean };
export type SdkDeletionReceipt = Scope & { commandKey: string; receipt: CommandReceipt | null };
export type ConnectorSdkLifecycleCommands = {
  sdkLifecycleRead: { input: Scope & { history: boolean }; output: SdkLifecycleView };
  sdkDeletionClaim: { input: Claim & { application?: ApplicationTransactionEvidence }; output: Failure | SdkDeletionAdmission };
  sdkDeletionReady: { input: Ref & { authorization: string }; output: boolean };
  sdkDeletionSettle: { input: Ref & { accepted: boolean; nativeQuiescent: boolean }; output: false | SdkDeletionAdmission };
  sdkDeletionReceiptRead: { input: Claim; output: SdkDeletionReceipt | { error: 401 | 403 } };
};
export type ConnectorSdkLifecycleKind = keyof ConnectorSdkLifecycleCommands;
export const connectorSdkLifecycleSteps = Object.freeze({ sdkLifecycleRead: 106, sdkDeletionClaim: 107,
  sdkDeletionReady: 108, sdkDeletionSettle: 109, sdkDeletionReceiptRead: 110 });
export const isConnectorSdkLifecycleKind = (v: string): v is ConnectorSdkLifecycleKind => Object.hasOwn(connectorSdkLifecycleSteps, v);
const fields = (v: unknown, keys: string[], optional: string[] = []): v is Record<string, unknown> => !!v
  && typeof v === 'object' && !Array.isArray(v) && keys.every(k => Object.hasOwn(v, k))
  && Object.keys(v).every(k => keys.includes(k) || optional.includes(k));
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\u0000-\u001f\u007f]/.test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const authorization = (v: unknown) => typeof v === 'string' && !!v.trim() && Buffer.byteLength(v) <= 4096 && !/[\r\n\u0000]/.test(v);
const commandKey = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
const scope = (v: Record<string, unknown>) => (v.runtime === 'claude-code' || v.runtime === 'ghcp' || v.runtime === 'antigravity')
  && id(v.key) && sessionRuntimeId(v.key) === v.runtime && v.key !== `${v.runtime}:`;
const intent = (v: unknown, key: unknown): v is SdkDeletion => fields(v, ['id', 'key', 'nativeSessionId', 'phase', 'createdAt'])
  && v.key === key && id(v.id) && id(v.nativeSessionId) && v.phase === 'pending' && integer(v.createdAt);
export function validConnectorSdkLifecycleInput(k: ConnectorSdkLifecycleKind, v: unknown): boolean {
  if (!v || typeof v !== 'object' || !scope(v as Record<string, unknown>)) return false;
  const p = v as Record<string, unknown>;
  if (k === 'sdkLifecycleRead') return fields(v, ['runtime', 'key', 'history']) && typeof p.history === 'boolean';
  if (k === 'sdkDeletionClaim' || k === 'sdkDeletionReceiptRead') return fields(v, ['runtime', 'key', 'authorization', 'commandKey'], k === 'sdkDeletionClaim' ? ['application'] : [])
    && authorization(p.authorization) && commandKey(p.commandKey) && (!Object.hasOwn(p, 'application') || validApplicationTransactionEvidence(p.application));
  return intent(p.intent, p.key) && id(p.receiptId) && (k === 'sdkDeletionReady'
    ? fields(v, ['runtime', 'key', 'intent', 'receiptId', 'authorization']) && authorization(p.authorization)
    : fields(v, ['runtime', 'key', 'intent', 'receiptId', 'accepted', 'nativeQuiescent'])
      && typeof p.accepted === 'boolean' && typeof p.nativeQuiescent === 'boolean');
}
export function validConnectorSdkLifecycleOutput(k: ConnectorSdkLifecycleKind, v: unknown): boolean {
  if (k === 'sdkDeletionReceiptRead') {
    if (fields(v, ['error'])) return v.error === 401 || v.error === 403;
    return fields(v, ['runtime', 'key', 'commandKey', 'receipt']) && scope(v) && commandKey(v.commandKey)
      && (v.receipt === null || validConnectorSdkLifecycleOutput('sdkDeletionClaim', { runtime: v.runtime, key: v.key,
        receipt: v.receipt, intent: null, admitted: false, nativeRequired: false })
        && (v.receipt as CommandReceipt).key === v.commandKey);
  }
  if (k === 'sdkDeletionReady') return typeof v === 'boolean';
  if (k === 'sdkDeletionSettle') return v === false || validConnectorSdkLifecycleOutput('sdkDeletionClaim', v)
    && fields(v, ['runtime', 'key', 'receipt', 'intent', 'admitted', 'nativeRequired']) && v.admitted === false;
  if (k === 'sdkDeletionClaim') {
    if (fields(v, ['error'])) return typeof v.error === 'number' && [401, 403, 409, 503].includes(v.error);
    if (!fields(v, ['runtime', 'key', 'receipt', 'intent', 'admitted', 'nativeRequired']) || !scope(v)
      || typeof v.admitted !== 'boolean' || typeof v.nativeRequired !== 'boolean') return false;
    const r = v.receipt;
    if (!fields(r, ['id', 'key', 'state', 'createdAt', 'updatedAt'], ['result']) || !id(r.id) || !commandKey(r.key)
      || !integer(r.createdAt) || !integer(r.updatedAt)) return false;
    const receipt = r.state === 'outcome_unknown' ? !Object.hasOwn(r, 'result')
      : fields(r.result, ['status', 'body']) && (r.state === 'accepted' ? r.result.status === 200
        && fields(r.result.body, ['ok', 'status']) && r.result.body.ok === true && r.result.body.status === 'delete_accepted'
        : r.state === 'rejected' && r.result.status === 409 && fields(r.result.body, ['error']) && r.result.body.error === 'Command rejected');
    return receipt && (v.admitted ? r.state === 'outcome_unknown' && intent(v.intent, v.key) && v.intent.id === r.id
      : v.intent === null && v.nativeRequired === false);
  }
  if (!fields(v, ['runtime', 'key', 'snapshot', 'page']) || !scope(v) || !validSdkJournalSnapshot(v.snapshot)
    || [v.snapshot.session, v.snapshot.execution, v.snapshot.deletion].some(r => r && r.key !== v.key)) return false;
  if (v.page === null) return true;
  return !!v.snapshot.session && fields(v.page, ['messages', 'totalCount', 'hiddenCount']) && integer(v.page.totalCount)
    && integer(v.page.hiddenCount) && v.page.hiddenCount <= v.page.totalCount && Array.isArray(v.page.messages)
    && v.page.messages.length <= 200 && v.page.messages.every(m => !!m && typeof m === 'object' && m.sessionKey === v.key
      && id(m.id) && typeof m.text === 'string' && ['user', 'assistant', 'system', 'tool', 'unknown'].includes(m.role))
    && Buffer.byteLength(JSON.stringify(v.page)) <= 2 * 1024 * 1024;
}
type Binding = { runtime: SdkAgentId; scope: string; commandKey: string; actorId: string; intent: SdkDeletion; checked: boolean;
  control?: NonNullable<ReturnType<typeof applicationControlTransaction>> };
const active = new WeakMap<ConnectorUserStore, Map<string, Binding>>();
class Denied extends Error {}
const same = (a: SdkDeletion, b: SdkDeletion) => a.id === b.id && a.key === b.key && a.nativeSessionId === b.nativeSessionId
  && a.createdAt === b.createdAt && a.phase === b.phase;

/** Internal projection and complete original deletion transaction. No native RPC,
 * caller permission bool, actor lookup shortcut or unknown deletion replay. */
export async function executeConnectorSdkLifecycle<K extends ConnectorSdkLifecycleKind>(kind: K,
  request: ConnectorSdkLifecycleCommands[K]['input'], owner: ConnectorUserStore, tokens?: ConnectorTokenStore, transactions?: ApplicationTransactionClient): Promise<ConnectorSdkLifecycleCommands[K]['output']> {
  if (!validConnectorSdkLifecycleInput(kind, request)) throw Error('connector_storage_unavailable');
  const input = structuredClone(request), journal = input.runtime === 'ghcp' ? owner.copilotJournal : input.runtime === 'antigravity' ? owner.antigravityJournal : owner.claudeJournal;
  let value: unknown;
  if (kind === 'sdkDeletionReceiptRead') {
    const v = input as Claim, actor = tokens?.authenticateAuthorization(v.authorization);
    if (!actor) value = { error: 401 };
    else if (actor.tokenId.startsWith('actor_') || !actor.scopes.includes('sessions:create') || actor.scopes.includes('execution:delegate')) value = { error: 403 };
    else {
      const scope = JSON.stringify(['delete', JSON.stringify([actor.tokenId, v.key])]);
      value = { runtime: v.runtime, key: v.key, commandKey: v.commandKey, receipt: owner.commands.get(scope, v.commandKey) ?? null };
    }
  } else if (kind === 'sdkLifecycleRead') {
    // No await: journal and bounded transcript share the original worker event.
    const snapshot = journal.readSnapshot(input.key);
    const history = (input as ConnectorSdkLifecycleCommands['sdkLifecycleRead']['input']).history;
    const view: SdkLifecycleView = { runtime: input.runtime, key: input.key, snapshot, page: history && snapshot.session
      ? (input.runtime === 'ghcp' ? copilotHistoryPage(owner, input.key) : input.runtime === 'antigravity' ? antigravityHistoryPage(owner, input.key) : claudeHistoryPage(owner, input.key)) ?? null : null };
    // The original history budget excludes the worker envelope/snapshot. Trim
    // oldest rows, retaining truthful hidden counts, to fit the existing RPC
    // budget rather than increasing every owner's aggregate result reservation.
    while (view.page?.messages.length && Buffer.byteLength(JSON.stringify(view)) > 1024 * 1024) {
      view.page.messages.shift(); view.page.hiddenCount++;
    }
    value = view;
  } else {
    let bindings = active.get(owner);
    if (!bindings) { bindings = new Map(); active.set(owner, bindings); }
    if (kind === 'sdkDeletionClaim') {
      const v = input as ConnectorSdkLifecycleCommands['sdkDeletionClaim']['input'], actor = tokens?.authenticateAuthorization(v.authorization);
      const permitted = () => {
        const fresh = tokens?.authenticateAuthorization(v.authorization);
        return !!actor && !actor.tokenId.startsWith('actor_') && fresh?.tokenId === actor.tokenId
          && fresh.scopes.includes('sessions:create') && !fresh.scopes.includes('execution:delegate');
      };
      const check = () => { if (!permitted()) throw new Denied(); };
      if (!actor) value = { error: 401 };
      else if (!permitted()) value = { error: 403 };
      else {
        const control = applicationControlTransaction(v.runtime, { ...v, payloadJson: '{}' }, transactions);
        const scope = JSON.stringify(['delete', JSON.stringify([actor.tokenId, v.key])]);
        let original: SdkDeletion | undefined, nativeRequired = false;
        try {
          const claimed = await owner.commands.claimAsync(scope, v.commandKey, {}, false, undefined,
            () => owner.sdkCommandAdmissionOpen && journal.canStart(v.key) && owner.canDeleteSession(v.key)
              && !owner.turns.hasPending(v.runtime, v.key) && bindings.size < 128,
            receiptId => {
              check();
              const session = journal.session(v.key)!;
              nativeRequired = session.nativeState === 'ready';
              original = journal.beginDeletion(v.key, receiptId);
              return { metadata: { runtime: v.runtime, intent: original, nativeRequired } };
            }, false, check, check, control?.claim);
          if (claimed.fresh && original) bindings.set(claimed.receipt.id,
            { runtime: v.runtime, scope, commandKey: v.commandKey, actorId: actor.tokenId, intent: original, checked: false, ...(control ? { control } : {}) });
          value = { runtime: v.runtime, key: v.key, receipt: claimed.receipt, intent: claimed.fresh ? original ?? null : null,
            admitted: claimed.fresh, nativeRequired: claimed.fresh && nativeRequired };
        } catch (error) {
          if (error instanceof Denied) value = { error: 403 };
          else if (error instanceof CommandCapacity) value = { error: 503 };
          else if (error instanceof CommandConflict) value = { error: 409 };
          else throw error;
        }
      }
    } else {
      const v = input as Ref & { authorization?: string; accepted?: boolean; nativeQuiescent?: boolean };
      const b = bindings.get(v.receiptId), current = journal.deletion(v.key);
      const matches = !!b && b.runtime === v.runtime && same(b.intent, v.intent) && !!current && same(current, v.intent)
        && owner.commands.get(b.scope, b.commandKey)?.id === v.receiptId
        && owner.commands.get(b.scope, b.commandKey)?.state === 'outcome_unknown';
      if (!matches) value = false;
      else if (kind === 'sdkDeletionReady') {
        const ready = () => {
          const actor = tokens?.authenticateAuthorization(v.authorization!), current = journal.deletion(v.key), receipt = owner.commands.get(b.scope, b.commandKey);
          if (bindings!.get(v.receiptId) !== b || !current || !same(current, b.intent) || receipt?.id !== v.receiptId || receipt.state !== 'outcome_unknown'
            // The retained pending deletion itself makes canDeleteSession false.
            // Its exact journal/receipt binding, not fresh-delete admission, is
            // the authority for this one already-admitted native operation.
            || b.checked || !owner.sdkCommandAdmissionOpen || owner.turns.hasPending(v.runtime, v.key)
            || actor?.tokenId !== b.actorId || !actor.scopes.includes('sessions:create') || actor.scopes.includes('execution:delegate')) return false;
          b.checked = true; return true;
        };
        value = b.control ? await b.control.ready(ready) : ready();
      } else {
        const accepted = v.accepted === true && v.nativeQuiescent === true && b.checked;
        if (v.accepted === true && !accepted) value = false;
        else {
          journal.settleDeletion(b.intent, accepted, db => {
            if (accepted) {
              owner.sdkAttachments.remove(v.key);
              if (owner.commands.settle(b.scope, b.commandKey, { status: 200, body: { ok: true, status: 'delete_accepted' } }).state !== 'accepted') throw Error('connector_storage_unavailable');
              owner.events.appendInTransaction(db, { id: '', ts: Date.now(), type: 'session.updated',
                sessionKey: v.key, agentId: v.runtime, payload: { sessionKey: v.key, status: 'deleted' } });
            }
          });
          // Observe the original transaction, without reauthorizing an already
          // completed native fact or turning post-success revocation into unknown.
          const receipt = owner.commands.get(b.scope, b.commandKey);
          if (!receipt || receipt.id !== v.receiptId) throw Error('connector_storage_unavailable');
          bindings.delete(v.receiptId);
          if (accepted) { try { owner.events.changes.notify(); } catch { /* original commit is authoritative */ } }
          value = { runtime: v.runtime, key: v.key, receipt, intent: null, admitted: false, nativeRequired: false };
        }
      }
    }
  }
  if (!validConnectorSdkLifecycleOutput(kind, value)) throw Error('connector_storage_unavailable');
  return value as ConnectorSdkLifecycleCommands[K]['output'];
}
