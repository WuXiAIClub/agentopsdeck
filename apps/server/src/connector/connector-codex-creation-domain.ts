import { validBoardUuid, type CommandReceipt } from '@agentopsdeck/shared';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { CommandCapacity, CommandConflict } from '../commands/receipts.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { validApplicationTransactionEvidence, type ApplicationTransactionEvidence, type ApplicationTransactionClient } from '../auth/application-transaction-gate.js';
import { applicationControlTransaction } from './application-stop-transaction.js';

type Scope = { authorization: string; commandKey: string };
export type CodexCreationIntent = { receiptId: string; title: string; model: string | null; boardTools: boolean };
type Ref = { intent: CodexCreationIntent };
export type CodexCreationResult = { commandKey: string; receipt: CommandReceipt; intent: CodexCreationIntent | null; admitted: boolean };
export type ConnectorCodexCreationCommands = {
  codexCreationClaim: { input: Scope & { payloadJson: string; rejectFresh?: 'runtime_unavailable'; application?: ApplicationTransactionEvidence }; output: { error: 401 | 403 | 409 | 503 } | CodexCreationResult };
  codexCreationReceiptRead: { input: Scope; output: { error: 401 | 403 } | { commandKey: string; receipt: CommandReceipt | null } };
  codexCreationReady: { input: Ref & { authorization: string }; output: boolean };
  codexCreationIdentify: { input: Ref & { threadId: string }; output: boolean };
  codexCreationNameReady: { input: Ref & { authorization: string }; output: boolean };
  codexCreationAccept: { input: Ref; output: false | CodexCreationResult };
  codexCreationAbandon: { input: Ref; output: false | CodexCreationResult };
};
export type ConnectorCodexCreationKind = keyof ConnectorCodexCreationCommands;
export const connectorCodexCreationSteps = Object.freeze({ codexCreationClaim: 281, codexCreationReceiptRead: 282,
  codexCreationReady: 283, codexCreationIdentify: 284, codexCreationNameReady: 285, codexCreationAccept: 286, codexCreationAbandon: 287 });
export const isConnectorCodexCreationKind = (v: string): v is ConnectorCodexCreationKind => Object.hasOwn(connectorCodexCreationSteps, v);
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const text = (v: unknown, max: number): v is string => typeof v === 'string' && !!v && Buffer.byteLength(v) <= max;
const thread = (v: unknown): v is string => text(v, 512) && !/[\x00-\x1f\x7f]/.test(v);
const title = (v: unknown): v is string => text(v, 8192) && !!v.trim();
const commandKey = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
const authorization = (v: unknown): v is string => text(v, 4096) && !!v.trim() && !/[\r\n\x00]/.test(v);
function payload(v: unknown): Record<string, unknown> | null {
  if (!text(v, 8192)) return null;
  try { const p: unknown = JSON.parse(v);
    return fields(p, [], ['title', 'label', 'model']) && (!Object.hasOwn(p, 'model') || p.model === null || typeof p.model === 'string') ? p : null;
  } catch { return null; }
}
const intent = (v: unknown): v is CodexCreationIntent => fields(v, ['receiptId', 'title', 'model', 'boardTools']) && thread(v.receiptId)
  && title(v.title) && (v.model === null || text(v.model, 8192)) && typeof v.boardTools === 'boolean';
const same = (a: CodexCreationIntent, b: CodexCreationIntent) => a.receiptId === b.receiptId && a.title === b.title && a.model === b.model && a.boardTools === b.boardTools;
function receipt(v: unknown): v is CommandReceipt {
  if (!fields(v, ['id', 'key', 'state', 'createdAt', 'updatedAt'], ['result']) || !thread(v.id) || !commandKey(v.key)
    || !Number.isSafeInteger(v.createdAt) || Number(v.createdAt) < 0 || !Number.isSafeInteger(v.updatedAt) || Number(v.updatedAt) < 0) return false;
  if (v.state === 'outcome_unknown') return !Object.hasOwn(v, 'result');
  if (!fields(v.result, ['status', 'body'])) return false;
  const r = v.result;
  return v.state === 'accepted' && r.status === 201 && fields(r.body, ['key', 'agentId', 'title']) && text(r.body.key, 518)
    && r.body.key.startsWith('codex:') && thread(r.body.key.slice(6)) && r.body.agentId === 'codex' && title(r.body.title)
    || v.state === 'rejected' && Number.isInteger(r.status) && Number(r.status) >= 400 && Number(r.status) < 500
      && fields(r.body, ['error']) && r.body.error === 'Command rejected';
}
export function validConnectorCodexCreationInput(k: ConnectorCodexCreationKind, v: unknown): boolean {
  if (k === 'codexCreationClaim') return fields(v, ['authorization', 'commandKey', 'payloadJson'], ['rejectFresh', 'application'])
    && (!Object.hasOwn(v, 'application') || validApplicationTransactionEvidence(v.application)) && authorization(v.authorization)
    && commandKey(v.commandKey) && payload(v.payloadJson) !== null && (!Object.hasOwn(v, 'rejectFresh') || v.rejectFresh === 'runtime_unavailable');
  if (k === 'codexCreationReceiptRead') return fields(v, ['authorization', 'commandKey']) && authorization(v.authorization) && commandKey(v.commandKey);
  if (k === 'codexCreationReady' || k === 'codexCreationNameReady') return fields(v, ['intent', 'authorization']) && intent(v.intent) && authorization(v.authorization);
  if (k === 'codexCreationIdentify') return fields(v, ['intent', 'threadId']) && intent(v.intent) && thread(v.threadId);
  return fields(v, ['intent']) && intent(v.intent);
}
export function validConnectorCodexCreationOutput(k: ConnectorCodexCreationKind, v: unknown): boolean {
  if (k === 'codexCreationReady' || k === 'codexCreationIdentify' || k === 'codexCreationNameReady') return typeof v === 'boolean';
  if (k === 'codexCreationReceiptRead') return fields(v, ['error']) && [401, 403].includes(Number(v.error)) && typeof v.error === 'number'
    || fields(v, ['commandKey', 'receipt']) && commandKey(v.commandKey) && (v.receipt === null || receipt(v.receipt) && v.receipt.key === v.commandKey);
  if (k === 'codexCreationClaim' && fields(v, ['error'])) return [401, 403, 409, 503].includes(Number(v.error)) && typeof v.error === 'number';
  if (v === false) return k === 'codexCreationAccept' || k === 'codexCreationAbandon';
  return fields(v, ['commandKey', 'receipt', 'intent', 'admitted']) && commandKey(v.commandKey) && receipt(v.receipt) && v.receipt.key === v.commandKey
    && typeof v.admitted === 'boolean' && (v.admitted ? k === 'codexCreationClaim' && v.receipt.state === 'outcome_unknown'
      && intent(v.intent) && v.intent.receiptId === v.receipt.id : v.intent === null);
}
type Binding = { scope: string; commandKey: string; actorId: string; intent: CodexCreationIntent;
  control?: NonNullable<ReturnType<typeof applicationControlTransaction>> };
class Denied extends Error {}

/** Capabilities exist only in this owner generation. A durable duplicate after
 * restart has a receipt but can never recover a dispatch capability. */
export function createConnectorCodexCreation(owner: ConnectorUserStore, tokens?: ConnectorTokenStore, boardTools = false, transactions?: ApplicationTransactionClient) {
  const bindings = new Map<string, Binding>();
  let disposed = false;
  const permitted = (auth: string, actor?: string) => {
    const p = tokens?.authenticateAuthorization(auth);
    return !!p && (!actor || p.tokenId === actor) && !p.tokenId.startsWith('actor_') && p.scopes.includes('sessions:create');
  };
  const execute = async <K extends ConnectorCodexCreationKind>(kind: K, request: ConnectorCodexCreationCommands[K]['input']): Promise<ConnectorCodexCreationCommands[K]['output']> => {
    if (disposed || !validConnectorCodexCreationInput(kind, request)) throw Error('connector_storage_unavailable');
    const input = structuredClone(request); let value: unknown;
    if (kind === 'codexCreationClaim' || kind === 'codexCreationReceiptRead') {
      const v = input as ConnectorCodexCreationCommands['codexCreationClaim']['input'], actor = tokens?.authenticateAuthorization(v.authorization);
      if (!actor) value = { error: 401 };
      else if (!permitted(v.authorization, actor.tokenId)) value = { error: 403 };
      else {
        const scope = JSON.stringify(['create', JSON.stringify([actor.tokenId, 'codex'])]);
        if (kind === 'codexCreationReceiptRead') value = { commandKey: v.commandKey, receipt: owner.commands.get(scope, v.commandKey) ?? null };
        else {
          const check = () => { if (!permitted(v.authorization, actor.tokenId)) throw new Denied(); };
          const control = applicationControlTransaction('codex', { ...v, key: 'codex:create' }, transactions);
          const p = payload(v.payloadJson)!, normalized = String(p.title ?? p.label ?? 'New chat').trim() || 'New chat';
          let original: CodexCreationIntent | undefined;
          try {
            const claimed = await owner.commands.claimAsync(scope, v.commandKey, p, false, undefined,
              () => owner.sdkCommandAdmissionOpen && bindings.size < 128 && owner.codexCreations.available(boardTools) && v.rejectFresh !== 'runtime_unavailable',
              receiptId => {
                check(); owner.codexCreations.reserve(receiptId, boardTools);
                original = { receiptId, title: normalized, model: typeof p.model === 'string' && p.model ? p.model : null, boardTools };
                return { metadata: { runtime: 'codex', receiptId } };
              }, false, check, check, control?.claim);
            if (claimed.fresh && original) bindings.set(original.receiptId, { scope, commandKey: v.commandKey, actorId: actor.tokenId, intent: original,
              ...(control ? { control } : {}) });
            value = { commandKey: v.commandKey, receipt: claimed.receipt, intent: claimed.fresh ? original ?? null : null, admitted: claimed.fresh && !!original };
          } catch (e) {
            if (e instanceof Denied) value = { error: 403 };
            else if (e instanceof CommandCapacity) value = { error: 503 };
            else if (e instanceof CommandConflict) value = { error: 409 };
            else throw e;
          }
        }
      }
    } else {
      const v = input as Ref & { authorization?: string; threadId?: string }, b = bindings.get(v.intent.receiptId);
      const original = b ? owner.commands.get(b.scope, b.commandKey) : undefined;
      const usable = (threadId: string) => !owner.commands.sessionDeletion(`codex:${threadId}`)
        && !owner.codexExecutions.get(`codex:${threadId}`) && !owner.codexExecutions.isDeletedTerminal(`codex:${threadId}`);
      if (!b || !same(b.intent, v.intent) || original?.id !== v.intent.receiptId || original.state !== 'outcome_unknown') value = false;
      else if (kind === 'codexCreationReady' || kind === 'codexCreationNameReady') {
        const row = owner.codexCreations.get(b.intent.receiptId);
        if (!owner.sdkCommandAdmissionOpen || !permitted(v.authorization!, b.actorId) || kind === 'codexCreationNameReady' && (!row?.thread || !usable(row.thread))) value = false;
        else {
          const transition = () => {
            const current = owner.commands.get(b.scope, b.commandKey), row = owner.codexCreations.get(b.intent.receiptId);
            if (disposed || bindings.get(b.intent.receiptId) !== b || current?.id !== b.intent.receiptId
              || current.state !== 'outcome_unknown' || !owner.sdkCommandAdmissionOpen || !permitted(v.authorization!, b.actorId)
              || kind === 'codexCreationNameReady' && (!row?.thread || !usable(row.thread))) throw new Denied();
            return owner.codexCreations.transition(b.intent.receiptId, kind === 'codexCreationReady' ? 'reserved' : 'identified',
              kind === 'codexCreationReady' ? 'ready' : 'naming', () => {
                if (!owner.sdkCommandAdmissionOpen || !permitted(v.authorization!, b.actorId)) throw new Denied();
              });
          };
          value = b.control ? await b.control.ready(transition) : transition();
        }
      } else if (kind === 'codexCreationIdentify') {
        value = owner.codexCreations.identify(b.intent.receiptId, v.threadId!, () => usable(v.threadId!)
          && (!boardTools || validBoardUuid(v.threadId!) && !owner.codexExecutions.hasBoardTools(v.threadId!)));
      } else {
        if (kind === 'codexCreationAccept') {
          value = owner.codexCreations.accept(b.intent.receiptId, (db, threadId, inspect) => {
            if (!usable(threadId)) throw Error('Codex creation identity unavailable');
            const key = `codex:${threadId}`;
            inspect(owner.commands.creationCommit(b.scope, b.commandKey, { status: 201, body: { key, agentId: 'codex', title: b.intent.title } })(db));
            inspect(owner.events.appendInTransaction(db, { id: '', ts: Date.now(), type: 'session.updated', sessionKey: key,
              agentId: 'codex', payload: { sessionKey: key, status: 'idle' } }));
          });
        } else { owner.codexCreations.abandon(b.intent.receiptId); value = true; }
        if (value === true) {
          bindings.delete(b.intent.receiptId);
          const current = owner.commands.get(b.scope, b.commandKey);
          if (!current || current.id !== b.intent.receiptId) throw Error('connector_storage_unavailable');
          value = { commandKey: b.commandKey, receipt: current, intent: null, admitted: false };
          if (kind === 'codexCreationAccept') { try { owner.events.changes.notify(); } catch { /* durable original acceptance wins */ } }
        }
      }
    }
    if (!validConnectorCodexCreationOutput(kind, value)) throw Error('connector_storage_unavailable');
    return value as ConnectorCodexCreationCommands[K]['output'];
  };
  return Object.assign(execute, { dispose() { disposed = true; bindings.clear(); } });
}
