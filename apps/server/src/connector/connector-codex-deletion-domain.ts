import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CommandReceipt } from '@agentopsdeck/shared';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { CommandCapacity, CommandConflict } from '../commands/receipts.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import { validApplicationTransactionEvidence, type ApplicationTransactionClient, type ApplicationTransactionEvidence } from '../auth/application-transaction-gate.js';
import { applicationControlTransaction } from './application-stop-transaction.js';

type Scope = { authorization: string; key: string; commandKey: string };
export type CodexDeletionIntent = { id: string; key: string; receiptId: string; commandKey: string };
type Ref = { intent: CodexDeletionIntent };
export type CodexDeletionResult = { key: string; commandKey: string; receipt: CommandReceipt; intent: CodexDeletionIntent | null };
export type ConnectorCodexDeletionCommands = {
  codexDeletionClaim: { input: Scope & { rejectFresh?: 'runtime_unavailable'; application?: ApplicationTransactionEvidence }; output: CodexDeletionResult | { error: 401 | 403 | 409 | 503 } };
  codexDeletionReceipt: { input: Scope; output: { key: string; commandKey: string; receipt: CommandReceipt | null } | { error: 401 | 403 } };
  codexDeletionBegin: { input: Ref & { authorization: string }; output: boolean };
  codexDeletionAccept: { input: Ref; output: CodexDeletionResult | false };
  codexDeletionAbandon: { input: Ref; output: CodexDeletionResult | false };
};
export type ConnectorCodexDeletionKind = keyof ConnectorCodexDeletionCommands;
export const connectorCodexDeletionSteps = Object.freeze({ codexDeletionClaim: 296, codexDeletionReceipt: 297,
  codexDeletionBegin: 298, codexDeletionAccept: 299, codexDeletionAbandon: 300 });
export const isConnectorCodexDeletionKind = (v: string): v is ConnectorCodexDeletionKind => Object.hasOwn(connectorCodexDeletionSteps, v);
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const text = (v: unknown): v is string => typeof v === 'string' && !!v && Buffer.byteLength(v) <= 512 && !/[\x00-\x1f\x7f]/.test(v);
const key = (v: unknown): v is string => text(v) && v.startsWith('codex:') && v.length > 6;
const commandKey = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
const authorization = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && Buffer.byteLength(v) <= 4096 && !/[\x00-\x1f\x7f]/.test(v);
const intent = (v: unknown): v is CodexDeletionIntent => fields(v, ['id', 'key', 'receiptId', 'commandKey'])
  && text(v.id) && key(v.key) && text(v.receiptId) && commandKey(v.commandKey);
function receipt(v: unknown): v is CommandReceipt {
  if (!fields(v, ['id', 'key', 'state', 'createdAt', 'updatedAt'], ['result']) || !text(v.id) || !commandKey(v.key)
    || !Number.isSafeInteger(v.createdAt) || Number(v.createdAt) < 0 || !Number.isSafeInteger(v.updatedAt) || Number(v.updatedAt) < 0) return false;
  if (v.state === 'outcome_unknown') return !Object.hasOwn(v, 'result');
  if (!fields(v.result, ['status', 'body'])) return false;
  return v.state === 'accepted' && v.result.status === 200 && fields(v.result.body, ['ok', 'status'])
    && v.result.body.ok === true && v.result.body.status === 'delete_accepted'
    || v.state === 'rejected' && Number.isInteger(v.result.status) && Number(v.result.status) >= 400 && Number(v.result.status) < 500
      && fields(v.result.body, ['error']) && v.result.body.error === 'Command rejected';
}
export function validConnectorCodexDeletionInput(k: ConnectorCodexDeletionKind, v: unknown): boolean {
  if (k === 'codexDeletionClaim' || k === 'codexDeletionReceipt') return fields(v, ['authorization', 'key', 'commandKey'], k === 'codexDeletionClaim' ? ['rejectFresh', 'application'] : [])
    && authorization(v.authorization) && key(v.key) && commandKey(v.commandKey)
    && (!Object.hasOwn(v, 'rejectFresh') || v.rejectFresh === 'runtime_unavailable')
    && (!Object.hasOwn(v, 'application') || validApplicationTransactionEvidence(v.application));
  return fields(v, ['intent'], k === 'codexDeletionBegin' ? ['authorization'] : []) && intent(v.intent)
    && (k !== 'codexDeletionBegin' || authorization(v.authorization));
}
export function validConnectorCodexDeletionOutput(k: ConnectorCodexDeletionKind, v: unknown): boolean {
  if (k === 'codexDeletionBegin') return typeof v === 'boolean';
  if (v === false) return k === 'codexDeletionAccept' || k === 'codexDeletionAbandon';
  if (fields(v, ['error'])) return typeof v.error === 'number' && (k === 'codexDeletionClaim' ? [401, 403, 409, 503]
    : k === 'codexDeletionReceipt' ? [401, 403] : []).includes(v.error);
  if (k === 'codexDeletionReceipt') return fields(v, ['key', 'commandKey', 'receipt']) && key(v.key) && commandKey(v.commandKey)
    && (v.receipt === null || receipt(v.receipt) && v.receipt.key === v.commandKey);
  return fields(v, ['key', 'commandKey', 'receipt', 'intent']) && key(v.key) && commandKey(v.commandKey) && receipt(v.receipt) && v.receipt.key === v.commandKey
    && (v.intent === null || k === 'codexDeletionClaim' && intent(v.intent) && v.intent.key === v.key && v.intent.commandKey === v.commandKey
      && v.intent.receiptId === v.receipt.id && v.receipt.state === 'outcome_unknown');
}
type Binding = { scope: string; actor: string; intent: CodexDeletionIntent; dispatched: boolean; control?: NonNullable<ReturnType<typeof applicationControlTransaction>> };
class Denied extends Error {}

/** Original deletion receipt is the durable exclusion fence. A process-local
 * capability is never reconstructed from a pending receipt on restart. */
export function createConnectorCodexDeletion(owner: ConnectorUserStore, tokens?: ConnectorTokenStore, transactions?: ApplicationTransactionClient) {
  const bindings = new Map<string, Binding>(); let disposed = false;
  const actor = (auth: string, expected?: string) => { const p = tokens?.authenticateAuthorization(auth);
    return p && (!expected || p.tokenId === expected) && !p.tokenId.startsWith('actor_')
      && p.scopes.includes('sessions:create') && !p.scopes.includes('execution:delegate') ? p.tokenId : undefined; };
  const execute = async <K extends ConnectorCodexDeletionKind>(kind: K, request: ConnectorCodexDeletionCommands[K]['input']): Promise<ConnectorCodexDeletionCommands[K]['output']> => {
    if (disposed || !validConnectorCodexDeletionInput(kind, request)) throw Error('connector_storage_unavailable');
    const input = structuredClone(request); let value: unknown;
    if (kind === 'codexDeletionClaim' || kind === 'codexDeletionReceipt') {
      const p = input as ConnectorCodexDeletionCommands['codexDeletionClaim']['input'];
      const principal = tokens?.authenticateAuthorization(p.authorization), id = actor(p.authorization);
      if (!principal) value = { error: 401 };
      else if (!id) value = { error: 403 };
      else {
        const scope = JSON.stringify(['delete', JSON.stringify([id, p.key])]);
        if (kind === 'codexDeletionReceipt') value = { key: p.key, commandKey: p.commandKey, receipt: owner.commands.get(scope, p.commandKey) ?? null };
        else {
          const control = applicationControlTransaction('codex', { ...p, payloadJson: '{}' }, transactions);
          let bound: Binding | undefined;
          const check = () => { if (!actor(p.authorization, id)) throw new Denied(); };
          try {
            const claimed = await owner.commands.claimAsync(scope, p.commandKey, {}, false, undefined,
              () => owner.sdkCommandAdmissionOpen && !p.rejectFresh && bindings.size < 128
                && !owner.commands.sessionDeletion(p.key) && owner.canDeleteSession(p.key),
              receiptId => { check(); bound = { scope, actor: id, dispatched: false, ...(control ? { control } : {}),
                intent: { id: randomUUID(), key: p.key, receiptId, commandKey: p.commandKey } };
                return { metadata: { runtime: 'codex-deletion' } }; }, false, check, check, control?.claim);
            if (claimed.fresh && bound && claimed.receipt.state === 'outcome_unknown') bindings.set(bound.intent.id, bound);
            value = { key: p.key, commandKey: p.commandKey, receipt: claimed.receipt,
              intent: claimed.fresh && bound && claimed.receipt.state === 'outcome_unknown' ? bound.intent : null };
          } catch (e) {
            if (e instanceof Denied) value = { error: 403 }; else if (e instanceof CommandCapacity) value = { error: 503 };
            else if (e instanceof CommandConflict) value = { error: 409 }; else throw e;
          }
        }
      }
    } else {
      const p = input as Ref & { authorization?: string }, b = bindings.get(p.intent.id);
      const original = b && owner.commands.get(b.scope, b.intent.commandKey);
      if (!b || !isDeepStrictEqual(b.intent, p.intent) || original?.id !== b.intent.receiptId || original.state !== 'outcome_unknown') value = false;
      else if (kind === 'codexDeletionBegin') {
        const begin = () => {
          const current = owner.commands.get(b.scope, b.intent.commandKey);
          if (disposed || bindings.get(b.intent.id) !== b || current?.id !== b.intent.receiptId || current.state !== 'outcome_unknown'
            || b.dispatched || !owner.sdkCommandAdmissionOpen || !actor(p.authorization!, b.actor) || !owner.canDeleteSession(b.intent.key)) return false;
          b.dispatched = true; return true;
        };
        value = b.control ? await b.control.ready(begin) : begin();
      } else if (kind === 'codexDeletionAccept' && !b.dispatched) value = false;
      else {
        // Post-begin failure is never proof of no archive. Preserve the sole
        // capability for an original-connection late ACK, without re-dispatch.
        const current = kind === 'codexDeletionAccept' ? owner.commands.settle(b.scope, b.intent.commandKey,
          { status: 200, body: { ok: true, status: 'delete_accepted' } }) : b.dispatched ? original
          : owner.commands.settle(b.scope, b.intent.commandKey, { status: 409, body: { error: 'Deletion preflight failed' } });
        if (kind === 'codexDeletionAccept' && current.state !== 'accepted') throw new CommandCapacity('Deletion acceptance unavailable');
        if (kind === 'codexDeletionAccept' || !b.dispatched) bindings.delete(b.intent.id);
        value = { key: b.intent.key, commandKey: b.intent.commandKey, receipt: current, intent: null };
      }
    }
    if (!validConnectorCodexDeletionOutput(kind, value)) throw Error('connector_storage_unavailable');
    return value as ConnectorCodexDeletionCommands[K]['output'];
  };
  return Object.assign(execute, { dispose() { disposed = true; bindings.clear(); } });
}
