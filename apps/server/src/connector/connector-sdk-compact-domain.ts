import { sessionRuntimeId, type CommandReceipt } from '@agentopsdeck/shared';
import { CommandCapacity, CommandConflict } from '../commands/receipts.js';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import type { ConnectorUserStore } from './connector-user-store.js';
import type { SdkAgentId, SdkCompactRef } from './sdk-execution-journal.js';
import type { SdkCompactExecution } from './sdk-compact-dispatch.js';
import { validSdkJournalSnapshot } from './connector-sdk-journal-domain.js';
import { validSdkModel } from './sdk-models.js';
import { validApplicationTransactionEvidence, type ApplicationTransactionClient, type ApplicationTransactionEvidence } from '../auth/application-transaction-gate.js';
import { applicationControlTransaction } from './application-stop-transaction.js';

type Scope = { runtime: SdkAgentId; authorization: string };
type Failure = { error: 401 | 403 | 409 | 503 };
export type SdkCompactAdmission = { key: string; receipt: CommandReceipt; execution: SdkCompactExecution | null; admitted: boolean };
export type ConnectorSdkCompactCommands = {
  sdkCompactClaim: { input: Scope & { key: string; id: string; epoch: string; commandKey: string; nativeSessionId: string; model: string | null; application?: ApplicationTransactionEvidence };
    output: Failure | SdkCompactAdmission };
  sdkCompactReady: { input: Scope & { ref: SdkCompactRef; action: 'dispatch' | 'interrupt' }; output: boolean };
  sdkCompactInterruptClaim: { input: Scope & { ref: SdkCompactRef }; output: SdkCompactExecution | 'blocked' | null };
  sdkCompactReceiptRead: { input: Scope & { key: string; commandKey: string; purpose: 'read' | 'mutation' };
    output: { error: 401 | 403 } | { runtime: SdkAgentId; key: string; commandKey: string; receipt: CommandReceipt | null } };
};
export type ConnectorSdkCompactKind = keyof ConnectorSdkCompactCommands;
export const connectorSdkCompactSteps = Object.freeze({ sdkCompactClaim: 86, sdkCompactReady: 87, sdkCompactInterruptClaim: 88, sdkCompactReceiptRead: 111 });
export const isConnectorSdkCompactKind = (kind: string): kind is ConnectorSdkCompactKind => Object.hasOwn(connectorSdkCompactSteps, kind);
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> => !!v
  && typeof v === 'object' && !Array.isArray(v) && required.every(k => Object.hasOwn(v, k))
  && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const id = (v: unknown): v is string => typeof v === 'string' && !!v && Buffer.byteLength(v) <= 512 && !/[\u0000-\u001f\u007f]/.test(v);
const commandKey = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
const runtime = (v: unknown): v is SdkAgentId => v === 'claude-code' || v === 'ghcp' || v === 'antigravity';
const key = (v: unknown, r?: unknown): v is string => id(v) && runtime(sessionRuntimeId(v))
  && v !== `${sessionRuntimeId(v)}:` && (r === undefined || sessionRuntimeId(v) === r);
const ref = (v: unknown, r?: unknown): v is SdkCompactRef => fields(v, ['key', 'id', 'epoch', 'nativeSessionId'])
  && key(v.key, r) && id(v.id) && id(v.epoch) && id(v.nativeSessionId);
export const sameSdkCompactRef = (actual: SdkCompactRef, expected: SdkCompactRef): boolean => actual.key === expected.key
  && actual.id === expected.id && actual.epoch === expected.epoch && actual.nativeSessionId === expected.nativeSessionId;
export function validConnectorSdkCompactInput(kind: ConnectorSdkCompactKind, v: unknown): boolean {
  return fields(v, kind === 'sdkCompactClaim'
    ? ['runtime', 'authorization', 'key', 'id', 'epoch', 'commandKey', 'nativeSessionId', 'model']
    : kind === 'sdkCompactReceiptRead' ? ['runtime', 'authorization', 'key', 'commandKey', 'purpose']
    : ['runtime', 'authorization', 'ref', ...(kind === 'sdkCompactReady' ? ['action'] : [])], kind === 'sdkCompactClaim' ? ['application'] : [])
    && (!Object.hasOwn(v, 'application') || validApplicationTransactionEvidence(v.application))
    && runtime(v.runtime) && typeof v.authorization === 'string' && !!v.authorization.trim()
    && Buffer.byteLength(v.authorization) <= 4096 && !/[\r\n\u0000]/.test(v.authorization)
    && (kind === 'sdkCompactClaim' ? key(v.key, v.runtime) && id(v.id) && id(v.epoch) && id(v.nativeSessionId)
      && commandKey(v.commandKey) && (v.model === null || validSdkModel(v.model))
      : kind === 'sdkCompactReceiptRead' ? key(v.key, v.runtime) && commandKey(v.commandKey) && (v.purpose === 'read' || v.purpose === 'mutation')
      : ref(v.ref, v.runtime)
        && (kind !== 'sdkCompactReady' || v.action === 'dispatch' || v.action === 'interrupt'));
}
export function validSdkCompactExecution(v: unknown): v is SdkCompactExecution {
  return !!v && typeof v === 'object' && (v as SdkCompactExecution).kind === 'compact'
    && validSdkJournalSnapshot({ session: null, execution: v, deletion: null, canStart: false,
      unresolved: !['completed', 'failed', 'interrupted'].includes((v as SdkCompactExecution).phase) });
}
export function validSdkCompactReceipt(v: unknown): v is CommandReceipt {
  if (!fields(v, ['id', 'key', 'state', 'createdAt', 'updatedAt'], ['result']) || !id(v.id) || !commandKey(v.key)
    || !Number.isSafeInteger(v.createdAt) || Number(v.createdAt) < 0 || !Number.isSafeInteger(v.updatedAt) || Number(v.updatedAt) < 0) return false;
  if (v.state === 'outcome_unknown') return !Object.hasOwn(v, 'result');
  return fields(v.result, ['status', 'body']) && (v.state === 'accepted' ? v.result.status === 200
    && fields(v.result.body, ['ok', 'status', 'runId']) && v.result.body.ok === true && v.result.body.status === 'compacting' && id(v.result.body.runId)
    : v.state === 'rejected' && [403, 409].includes(Number(v.result.status)) && fields(v.result.body, ['error'])
      && v.result.body.error === 'Command rejected');
}
export function validConnectorSdkCompactOutput(kind: ConnectorSdkCompactKind, v: unknown): boolean {
  if (kind === 'sdkCompactReceiptRead') return fields(v, ['error']) && (v.error === 401 || v.error === 403)
    || fields(v, ['runtime', 'key', 'commandKey', 'receipt']) && runtime(v.runtime) && key(v.key, v.runtime) && commandKey(v.commandKey)
      && (v.receipt === null || validSdkCompactReceipt(v.receipt) && v.receipt.key === v.commandKey);
  if (kind === 'sdkCompactReady') return typeof v === 'boolean';
  if (kind === 'sdkCompactInterruptClaim') return v === null || v === 'blocked' || validSdkCompactExecution(v) && v.stopRequested;
  return fields(v, ['error']) && [401, 403, 409, 503].includes(Number(v.error)) && typeof v.error === 'number'
    || fields(v, ['key', 'receipt', 'execution', 'admitted']) && key(v.key) && validSdkCompactReceipt(v.receipt)
      && typeof v.admitted === 'boolean' && (v.admitted ? validSdkCompactExecution(v.execution)
        && v.execution.key === v.key && v.execution.phase === 'dispatching' && !v.execution.stopRequested
        && v.receipt.state === 'accepted' && v.receipt.result?.body.runId === v.execution.id : v.execution === null);
}
class CompactAuthorityDenied extends Error {}
type Binding = { ref: SdkCompactRef; actorId: string; dispatched: boolean;
  ready: NonNullable<ReturnType<typeof applicationControlTransaction>> };
const active = new WeakMap<ConnectorUserStore, Map<string, Binding>>();
export function disposeSdkCompactIntents(owner: ConnectorUserStore) { active.delete(owner); }

/** Candidate original-owner domain. Native calls and trusted runtime catalog
 * stay in the caller. Receipt scope/fingerprint and BEGIN/COMMIT are the legacy
 * ones, never caller-provided actor/permission/SQL/callback. No replay. */
export async function executeConnectorSdkCompact<K extends ConnectorSdkCompactKind>(kind: K,
  request: ConnectorSdkCompactCommands[K]['input'], owner: ConnectorUserStore, tokens?: ConnectorTokenStore,
  applicationTransactions?: ApplicationTransactionClient): Promise<ConnectorSdkCompactCommands[K]['output']> {
  if (!tokens || !validConnectorSdkCompactInput(kind, request)) throw Error('connector_storage_unavailable');
  const input = structuredClone(request), journal = input.runtime === 'claude-code' ? owner.claudeJournal : input.runtime === 'ghcp' ? owner.copilotJournal : owner.antigravityJournal;
  const actor = tokens.authenticateAuthorization(input.authorization);
  const actorId = actor?.tokenId;
  const bindings = active.get(owner) ?? new Map<string, Binding>(); active.set(owner, bindings);
  const permitted = (scope: 'messages:read' | 'messages:send' = 'messages:send') => {
    const fresh = tokens.authenticateAuthorization(input.authorization);
    return !!actorId && !actorId.startsWith('actor_') && fresh?.tokenId === actorId && fresh.scopes.includes(scope)
      && !fresh.scopes.includes('execution:delegate');
  };
  const check = () => { if (!permitted()) throw new CompactAuthorityDenied(); };
  const snapshot = (key: string) => {
    const value = journal.readSnapshot(key);
    if (!validSdkJournalSnapshot(value) || [value.session, value.execution, value.deletion].some(v => v && v.key !== key)) throw Error('connector_storage_unavailable');
    return value;
  };
  let result: unknown;
  if (kind === 'sdkCompactReceiptRead') {
    const v = input as ConnectorSdkCompactCommands['sdkCompactReceiptRead']['input'];
    if (!actor) result = { error: 401 };
    else if (!permitted(v.purpose === 'read' ? 'messages:read' : 'messages:send')) result = { error: 403 };
    else {
      const scope = JSON.stringify(['compact', JSON.stringify([actorId, v.key])]);
      const receipt = owner.commands.get(scope, v.commandKey);
      result = { runtime: v.runtime, key: v.key, commandKey: v.commandKey, receipt: receipt ?? null };
    }
  } else if (kind !== 'sdkCompactClaim') {
    const v = input as ConnectorSdkCompactCommands['sdkCompactReady']['input'];
    const e = snapshot(v.ref.key).execution;
    const available = permitted() && owner.sdkCommandAdmissionOpen && e?.kind === 'compact' && sameSdkCompactRef(e, v.ref)
      && !owner.commands.sessionDeletion(v.ref.key) && !journal.deletion(v.ref.key);
    if (kind === 'sdkCompactReady') {
      const binding = bindings.get(v.ref.id);
      const ready = () => {
        const current = snapshot(v.ref.key).execution;
        return permitted() && owner.sdkCommandAdmissionOpen && current?.kind === 'compact' && sameSdkCompactRef(current, v.ref)
          && !owner.commands.sessionDeletion(v.ref.key) && !journal.deletion(v.ref.key)
          && (v.action === 'dispatch' ? current.phase === 'dispatching' && !current.stopRequested
            : ['dispatching', 'running'].includes(current.phase) && current.stopRequested);
      };
      if (binding && v.action === 'dispatch') {
        result = await binding.ready.ready(() => {
          if (binding.dispatched || binding.actorId !== actorId || !sameSdkCompactRef(binding.ref, v.ref)) return false;
          const allowed = ready(); if (allowed) binding.dispatched = true; return allowed;
        });
      } else result = ready();
    }
    else if (!permitted()) result = 'blocked';
    else result = available && journal.requestCompactStop(v.ref) ? { ...e, stopRequested: true } : null;
  } else if (!actor) result = { error: 401 };
  else if (!permitted()) result = { error: 403 };
  else {
    const v = input as ConnectorSdkCompactCommands['sdkCompactClaim']['input'];
    const scope = JSON.stringify(['compact', JSON.stringify([actorId, v.key])]);
    try {
      const transaction = applicationControlTransaction(v.runtime, { ...v, payloadJson: '{}' }, applicationTransactions);
      // Retire terminal private capabilities, never outstanding native work.
      for (const [id, b] of bindings) {
        const current = snapshot(b.ref.key).execution;
        if (!current || !sameSdkCompactRef(current, b.ref) || ['completed', 'failed', 'interrupted'].includes(current.phase)) bindings.delete(id);
      }
      let created: SdkCompactExecution | undefined;
      const claimed = await owner.commands.claimAsync(scope, v.commandKey, {}, false, undefined,
        () => !transaction || bindings.size < 128, () => {
          const reject = () => ({ metadata: { domain: 'sdk-compact' }, complete: { status: 409, body: { error: 'Compaction was not admitted' } } });
          const before = snapshot(v.key);
          if (!owner.sdkCommandAdmissionOpen || !before.canStart || before.session?.nativeState !== 'ready'
            || before.session.nativeSessionId !== v.nativeSessionId || (before.session.model ?? null) !== v.model
            || owner.commands.sessionDeletion(v.key) || owner.commands.sessionSettingsPending(v.key)) return reject();
          const e = journal.beginCompact(v, actorId!, owner.turns, () => {
            check();
            const current = journal.session(v.key);
            if (!current || current.nativeSessionId !== v.nativeSessionId || (current.model ?? null) !== v.model
              || !owner.sdkCommandAdmissionOpen || owner.commands.sessionDeletion(v.key)) throw new CompactAuthorityDenied();
          });
          if (!e || e.kind !== 'compact') return reject();
          created = e;
          return { metadata: { domain: 'sdk-compact' }, complete: { status: 200, body: { ok: true, status: 'compacting', runId: e.id } } };
        }, false, check, check, transaction?.claim);
      check();
      // Accepted receipts deliberately return fresh=false. Only the original
      // bind callback can supply a new native capability, never a duplicate.
      const admitted = !!created && claimed.receipt.state === 'accepted' && claimed.receipt.result?.body.runId === created.id;
      if (admitted && transaction) bindings.set(created!.id, { ref: { key: v.key, id: v.id, epoch: v.epoch,
        nativeSessionId: v.nativeSessionId }, actorId: actorId!, dispatched: false, ready: transaction });
      result = { key: v.key, receipt: claimed.receipt, execution: admitted ? created! : null, admitted };
    } catch (error) {
      if (error instanceof CompactAuthorityDenied) result = { error: 403 };
      else if (error instanceof CommandConflict) result = { error: 409 };
      else if (error instanceof CommandCapacity) result = { error: 503 };
      else throw error;
    }
  }
  if (!validConnectorSdkCompactOutput(kind, result)) throw Error('connector_storage_unavailable');
  return result as ConnectorSdkCompactCommands[K]['output'];
}
