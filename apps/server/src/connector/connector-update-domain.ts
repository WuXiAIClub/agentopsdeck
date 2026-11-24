import type { CommandReceipt } from '@agentopsdeck/shared';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import { CommandCapacity, CommandConflict, MAX_COMMAND_RESULT_BYTES, type CommandResult } from '../commands/receipts.js';
import { StorageAdmissionDeferred } from '../storage/work-admission.js';
import type { ConnectorUserStore } from './connector-user-store.js';

export type UpdateOperatorEvidence = { authorization: string; expectedNode: string; protocol: string; originPresent: boolean };
export type UpdateOperatorMode = 'status' | 'update' | 'maintenance' | 'readiness';
type Ref = { scope: string; key: string };
type Failure = { status: 403 | 409 | 503; error: 'authority' | 'conflict' | 'capacity' | 'storage' };
type Reply<T> = Failure | { status: 200; value: T };
type ReceiptValue = Ref & { receipt: CommandReceipt | null };
export type ConnectorUpdateCommands = {
  updateOperatorCheck: { input: UpdateOperatorEvidence & { mode: UpdateOperatorMode; actorId?: string };
    output: Reply<{ actorId: string; recover: boolean }> };
  // Private root inspection: recovery only. This is NOT permission for effects.
  updateReceiptInspect: { input: Ref; output: Reply<ReceiptValue> };
  updateReceiptClaim: { input: Ref & UpdateOperatorEvidence & { actorId: string; payload: unknown; existing: boolean };
    output: Reply<ReceiptValue & { fresh: boolean }> };
  // Completion is bound to the original durable claim, not a new permission.
  updateReceiptSettle: { input: Ref & { receiptId: string; result: CommandResult }; output: Reply<ReceiptValue> };
};
export type ConnectorUpdateKind = keyof ConnectorUpdateCommands;
export const connectorUpdateSteps = Object.freeze({ updateOperatorCheck: 341, updateReceiptInspect: 342,
  updateReceiptClaim: 343, updateReceiptSettle: 344 });
export const isConnectorUpdateKind = (kind: string): kind is ConnectorUpdateKind => Object.hasOwn(connectorUpdateSteps, kind);
const fields = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && required.every(k => Object.hasOwn(v, k))
  && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= 4096 && !/[\x00-\x1f\x7f]/.test(v);
const header = (v: unknown): v is string => v === '' || text(v);
const key = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
const count = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
function validPayload(scope: unknown, payload: unknown): boolean {
  const identity = updateScopeIdentity(scope);
  if (!identity) return false;
  if (identity.operation === 'pause' || identity.operation === 'rollback') return fields(payload, []);
  if (identity.operation === 'resume') return fields(payload, ['fenceId']) && typeof payload.fenceId === 'string'
    && /^[a-f0-9-]{36}$/.test(payload.fenceId);
  const segment = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value)
    && !value.includes('..') && value.length <= 4096;
  return fields(payload, ['version', 'manifestSha256'], ['revision']) && segment(payload.version)
    && typeof payload.manifestSha256 === 'string' && /^[a-f0-9]{64}$/.test(payload.manifestSha256)
    && (!Object.hasOwn(payload, 'revision') || segment(payload.revision));
}
export function updateScopeIdentity(scope: unknown): { domain: 'update' | 'maintenance'; nodeId: string; actorId: string; operation: string } | undefined {
  if (!text(scope)) return;
  try {
    const outer = JSON.parse(scope);
    if (!Array.isArray(outer) || outer.length !== 2 || !['update', 'maintenance'].includes(outer[0]) || typeof outer[1] !== 'string') return;
    const inner = JSON.parse(outer[1]);
    if (!Array.isArray(inner) || inner.length !== 3 || !inner.every(text)
      || !(outer[0] === 'update' ? ['apply', 'rollback'] : ['pause', 'resume']).includes(inner[2]!)
      || JSON.stringify([outer[0], JSON.stringify(inner)]) !== scope) return;
    return { domain: outer[0], nodeId: inner[0]!, actorId: inner[1]!, operation: inner[2]! };
  } catch { return; }
}
function result(v: unknown): v is CommandResult {
  return fields(v, ['status', 'body']) && (v.status === 200 || v.status === 403)
    && !!v.body && typeof v.body === 'object' && !Array.isArray(v.body)
    && Buffer.byteLength(JSON.stringify(v)) <= MAX_COMMAND_RESULT_BYTES;
}
function receipt(v: unknown): v is CommandReceipt {
  return fields(v, ['id', 'key', 'state', 'createdAt', 'updatedAt'], ['result']) && text(v.id) && key(v.key)
    && count(v.createdAt) && count(v.updatedAt) && (v.state === 'outcome_unknown' ? !Object.hasOwn(v, 'result')
      : result(v.result) && (v.state === 'accepted' && v.result.status === 200 || v.state === 'rejected' && v.result.status === 403));
}
const evidenceFields = ['authorization', 'expectedNode', 'protocol', 'originPresent'];
const evidence = (v: Record<string, unknown>) => header(v.authorization) && header(v.expectedNode)
  && header(v.protocol) && typeof v.originPresent === 'boolean';
export function validConnectorUpdateInput(kind: ConnectorUpdateKind, v: unknown): boolean {
  if (kind === 'updateOperatorCheck') return fields(v, [...evidenceFields, 'mode'], ['actorId']) && evidence(v)
    && ['status', 'update', 'maintenance', 'readiness'].includes(v.mode as string) && (!Object.hasOwn(v, 'actorId') || text(v.actorId));
  if (!v || typeof v !== 'object') return false;
  if (kind === 'updateReceiptInspect') return fields(v, ['scope', 'key']) && !!updateScopeIdentity(v.scope) && key(v.key);
  if (kind === 'updateReceiptSettle') return fields(v, ['scope', 'key', 'receiptId', 'result']) && !!updateScopeIdentity(v.scope)
    && key(v.key) && text(v.receiptId) && result(v.result);
  return fields(v, ['scope', 'key', ...evidenceFields, 'actorId', 'payload', 'existing']) && !!updateScopeIdentity(v.scope)
    && key(v.key) && evidence(v) && text(v.actorId) && typeof v.existing === 'boolean'
    && validPayload(v.scope, v.payload);
}
export function validConnectorUpdateOutput(kind: ConnectorUpdateKind, v: unknown): boolean {
  if (fields(v, ['status', 'error'])) return v.status === 403 && v.error === 'authority'
    || v.status === 409 && v.error === 'conflict' || v.status === 503 && ['capacity', 'storage'].includes(v.error as string);
  if (!fields(v, ['status', 'value']) || v.status !== 200) return false;
  if (kind === 'updateOperatorCheck') return fields(v.value, ['actorId', 'recover']) && text(v.value.actorId) && typeof v.value.recover === 'boolean';
  return fields(v.value, ['scope', 'key', 'receipt'], kind === 'updateReceiptClaim' ? ['fresh'] : [])
    && !!updateScopeIdentity(v.value.scope) && key(v.value.key)
    && (v.value.receipt === null || receipt(v.value.receipt) && v.value.receipt.key === v.value.key)
    && (kind !== 'updateReceiptClaim' || typeof v.value.fresh === 'boolean' && v.value.receipt !== null);
}
export class UpdateOperatorDenied extends Error {}
/** The sole current-credential verifier for updater and readiness transactions.
 * Evidence is ephemeral: never persist it in an execution intent or receipt. */
export function createUpdateOperatorVerifier(owner: Pick<ConnectorUserStore, 'nodeId'>, tokens?: ConnectorTokenStore) {
  return (input: UpdateOperatorEvidence, mode: UpdateOperatorMode, actorId?: string) => {
    const principal = tokens?.authenticateAuthorization(input.authorization);
    const updater = principal?.scopes.includes('connector:update');
    const lifecycle = !input.originPresent && input.protocol === '1' && input.expectedNode === owner.nodeId
      && principal?.scopes.includes('connector:lifecycle');
    // Readiness can inspect business history under a retained fence. Unlike
    // ordinary maintenance, updater scope alone must NEVER grant that ability.
    const allowed = mode === 'readiness' ? lifecycle : updater
      || mode === 'status' && principal?.scopes.includes('sessions:read') || mode === 'maintenance' && lifecycle;
    if (!allowed || !principal || actorId !== undefined && actorId !== principal.tokenId) throw new UpdateOperatorDenied();
    return { actorId: principal.tokenId, recover: !!updater };
  };
}
export function createConnectorUpdateCommands(owner: ConnectorUserStore, tokens?: ConnectorTokenStore) {
  const operator = createUpdateOperatorVerifier(owner, tokens);
  return async function execute<K extends ConnectorUpdateKind>(kind: K,
    input: ConnectorUpdateCommands[K]['input']): Promise<ConnectorUpdateCommands[K]['output']> {
    if (!validConnectorUpdateInput(kind, input)) throw Error('Invalid update command');
    try {
      if (kind === 'updateOperatorCheck') {
        const v = input as ConnectorUpdateCommands['updateOperatorCheck']['input'];
        return { status: 200, value: operator(v, v.mode, v.actorId) } as ConnectorUpdateCommands[K]['output'];
      }
      const v = input as ConnectorUpdateCommands['updateReceiptClaim']['input'];
      const identity = updateScopeIdentity(v.scope)!;
      if (identity.nodeId !== owner.nodeId) throw new CommandConflict();
      if (kind === 'updateReceiptClaim') {
        if (identity.actorId !== v.actorId) throw new UpdateOperatorDenied();
        const check = () => { operator(v, identity.domain === 'update' ? 'update' : 'maintenance', v.actorId); };
        check();
        if (v.existing && !owner.commands.get(v.scope, v.key)) throw new CommandConflict();
        const claimed = await owner.commands.claimAsync(v.scope, v.key, v.payload, false, undefined,
          undefined, undefined, false, check, check);
        return { status: 200, value: { scope: v.scope, key: v.key, ...claimed } } as ConnectorUpdateCommands[K]['output'];
      }
      let original = owner.commands.get(v.scope, v.key) ?? null;
      if (kind === 'updateReceiptSettle') {
        const completion = input as ConnectorUpdateCommands['updateReceiptSettle']['input'];
        if (!original || original.id !== completion.receiptId) throw new CommandConflict();
        original = owner.commands.settle(v.scope, v.key, completion.result);
      }
      return { status: 200, value: { scope: v.scope, key: v.key, receipt: original } } as ConnectorUpdateCommands[K]['output'];
    } catch (error) {
      if (error instanceof UpdateOperatorDenied) return { status: 403, error: 'authority' };
      if (error instanceof CommandConflict) return { status: 409, error: 'conflict' };
      if (error instanceof CommandCapacity) return { status: 503, error: 'capacity' };
      if (error instanceof StorageAdmissionDeferred) return { status: 503, error: 'storage' };
      throw error;
    }
  };
}
