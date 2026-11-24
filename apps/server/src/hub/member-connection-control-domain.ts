import type { CommandReceipt } from '@agentopsdeck/shared';
import { CommandConflict, commandPayloadFingerprint } from '../commands/receipts.js';
import type { HubStore, HubAuditAction } from './hub-store.js';
import { validOwnerControlReceipt } from './member-owner-control-domain.js';
import { validConnectionEpoch } from './member-connection-change-domain.js';
import { validConnectionControlOperation, validConnectionControlObservation,
  type ConnectionControlOperation, type ConnectionControlObservation } from './connection-control-contract.js';

export type HubConnectionControlCommand = { action: 'claim'; id: string; expectedEpoch: number; key: string; control: ConnectionControlOperation }
  | { action: 'receipt'; id: string; expectedEpoch: number; key: string; operation: 'reconcile' | 'updateCheck' };
export type ConnectionControlReceipt = { key: string; operation: 'reconcile' | 'updateCheck'; state: 'outcome_unknown' | 'accepted' | 'rejected'; status?: number };
export type HubConnectionControlResult = null | { error: 403 | 404 | 409 }
  | { action: 'receipt'; receipt: ConnectionControlReceipt }
  | { action: 'claim'; fresh: boolean; receipt: CommandReceipt; reference: ConnectionControlReference };
export type ConnectionControlReference = { ownerUserId: string; connectionId: string; key: string; receiptId: string };
export type ConnectionControlSettlement = { reference: ConnectionControlReference; observation: ConnectionControlObservation };
export type ConnectionControlSettlementResult = { reference: ConnectionControlReference; state: 'accepted' | 'rejected' };
export type ConnectionControlSettlementOwner = { command(input: ConnectionControlSettlement): Promise<ConnectionControlSettlementResult> };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, expected: string[]) => Object.keys(v).length === expected.length && expected.every(k => Object.hasOwn(v, k));
const id = (v: unknown): v is string => typeof v === 'string' && !!v && Buffer.byteLength(v) <= 512 && !/[\x00-\x1f\x7f]/.test(v);
const key = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
const scope = (r: Pick<ConnectionControlReference, 'ownerUserId' | 'connectionId'>) => JSON.stringify(['connection-control', JSON.stringify([r.ownerUserId, r.connectionId])]);
export function validHubConnectionControlCommand(v: unknown): v is HubConnectionControlCommand {
  return object(v) && id(v.id) && validConnectionEpoch(v.expectedEpoch) && key(v.key)
    && (v.action === 'claim' && fields(v, ['action','id','expectedEpoch','key','control']) && validConnectionControlOperation(v.control)
      || v.action === 'receipt' && fields(v, ['action','id','expectedEpoch','key','operation']) && (v.operation === 'reconcile' || v.operation === 'updateCheck'));
}
function validReceipt(v: unknown): v is ConnectionControlReceipt {
  return object(v) && key(v.key) && (v.operation === 'reconcile' || v.operation === 'updateCheck')
    && (v.state === 'outcome_unknown' ? fields(v, ['key','operation','state'])
      : (v.state === 'accepted' || v.state === 'rejected') && fields(v, ['key','operation','state','status'])
        && Number.isInteger(v.status) && (v.state === 'accepted' ? Number(v.status) >= 200 && Number(v.status) < 300 : Number(v.status) >= 400 && Number(v.status) < 500));
}
export function validConnectionControlReference(v: unknown): v is ConnectionControlReference {
  return object(v) && fields(v, ['ownerUserId','connectionId','key','receiptId']) && id(v.ownerUserId) && id(v.connectionId) && key(v.key) && id(v.receiptId);
}
export function validHubConnectionControlResult(v: unknown): v is HubConnectionControlResult {
  return v === null || object(v) && (fields(v, ['error']) && [403,404,409].includes(Number(v.error))
    || fields(v, ['action','receipt']) && v.action === 'receipt' && validReceipt(v.receipt)
    || fields(v, ['action','fresh','receipt','reference']) && v.action === 'claim' && typeof v.fresh === 'boolean'
      && validOwnerControlReceipt(v.receipt) && validConnectionControlReference(v.reference)
      && v.receipt.id === v.reference.receiptId && v.receipt.key === v.reference.key);
}
export function validConnectionControlSettlement(v: unknown): v is ConnectionControlSettlement {
  return object(v) && fields(v, ['reference','observation']) && validConnectionControlReference(v.reference) && validConnectionControlObservation(v.observation);
}
export function validConnectionControlSettlementResult(v: unknown): v is ConnectionControlSettlementResult {
  return object(v) && fields(v, ['reference','state']) && validConnectionControlReference(v.reference) && (v.state === 'accepted' || v.state === 'rejected');
}
export function matchesConnectionControlSettlement(input: ConnectionControlSettlement, result: ConnectionControlSettlementResult) {
  const a = input.reference, b = result.reference;
  return a.ownerUserId === b.ownerUserId && a.connectionId === b.connectionId && a.key === b.key && a.receiptId === b.receiptId
    && result.state === (input.observation.status < 300 ? 'accepted' : 'rejected');
}
class ControlAuthorityUnavailable extends Error {}
/** Await capacity outside SQL; original credentials, scope and epoch are checked
 * again under the claim BEGIN, including duplicates. No second ledger/writer. */
export async function claimHubConnectionControl(owner: HubStore, request: Request, expectedScope: string,
  command: HubConnectionControlCommand): Promise<HubConnectionControlResult> {
  if (command.action === 'receipt') return owner.connectionControlReceipt(request, expectedScope, command);
  let userId: string | undefined;
  const check = () => {
    const target = owner.identities.memberConnectionTargetCommand(request, expectedScope, owner, command.id);
    if (!target || 'error' in target || target.connection.status === 'disabled' || target.epoch !== command.expectedEpoch
      || userId !== undefined && userId !== target.connection.ownerUserId) throw new ControlAuthorityUnavailable();
    userId = target.connection.ownerUserId;
  };
  try {
    check();
    const address = {ownerUserId: userId!, connectionId: command.id};
    const result = await owner.commands.claimAsync(scope(address), command.key, {epoch: command.expectedEpoch, control: command.control}, false, undefined,
      undefined, receiptId => ({metadata: {domain: 'connection-control', ...address, key: command.key, receiptId, epoch: command.expectedEpoch, control: command.control}}),
      false, check, check);
    return {action: 'claim', ...result, reference: {...address, key: command.key, receiptId: result.receipt.id}};
  } catch (error) {
    if (error instanceof ControlAuthorityUnavailable) return {error: 403};
    if (error instanceof CommandConflict) return {error: 409};
    throw error;
  }
}
/** Called inside the original owner savepoint. Recovery reads current authority
 * and original binding, never creates an intent or dispatches an effect. */
export function readHubConnectionControl(owner: HubStore, request: Request, expectedScope: string,
  command: Extract<HubConnectionControlCommand, {action: 'receipt'}>): HubConnectionControlResult {
  const target = owner.identities.memberConnectionTargetCommand(request, expectedScope, owner, command.id);
  if (!target) return null;
  if ('error' in target || target.connection.status === 'disabled' || target.epoch !== command.expectedEpoch) return {error: 403};
  const s = scope({ownerUserId: target.connection.ownerUserId, connectionId: command.id});
  const receipt = owner.commands.get(s, command.key), binding = owner.commands.binding(s, command.key);
  if (!receipt || !binding || binding.domain !== 'connection-control' || binding.ownerUserId !== target.connection.ownerUserId
    || binding.connectionId !== command.id || binding.key !== command.key || binding.receiptId !== receipt.id
    || !validConnectionEpoch(binding.epoch) || !validConnectionControlOperation(binding.control) || binding.control.operation !== command.operation) return {error: 404};
  const result: ConnectionControlReceipt = {key: command.key, operation: command.operation, state: receipt.state,
    ...(receipt.state !== 'outcome_unknown' && receipt.result ? {status: receipt.result.status} : {})};
  if (!validReceipt(result)) throw Error('connection_control_receipt_unavailable');
  return {action: 'receipt', receipt: result};
}
const auditActions: Partial<Record<ConnectionControlOperation['operation'], HubAuditAction>> = {
  capabilities: 'connector.capabilities.checked', reconcile: 'gateway.model_set.reconciled', updateCheck: 'connector.update.checked',
};
/** Private original transport capability, never a member RPC. HubStore wraps
 * audit and receipt settlement in its original savepoint. Revocation does not
 * erase already executed facts; duplicate settlement cannot append twice. */
export function settleHubConnectionControl(owner: HubStore, input: ConnectionControlSettlement): ConnectionControlSettlementResult {
  if (!validConnectionControlSettlement(input)) throw Error('connection_control_settlement_unavailable');
  const r = input.reference, s = scope(r), receipt = owner.commands.get(s, r.key), binding = owner.commands.binding(s, r.key);
  if (!receipt || receipt.id !== r.receiptId || !binding || binding.domain !== 'connection-control'
    || binding.ownerUserId !== r.ownerUserId || binding.connectionId !== r.connectionId || binding.key !== r.key || binding.receiptId !== r.receiptId
    || !validConnectionEpoch(binding.epoch) || !validConnectionControlOperation(binding.control) || binding.control.operation !== input.observation.operation) {
    throw Error('connection_control_settlement_unavailable');
  }
  const state = input.observation.status < 300 ? 'accepted' : 'rejected';
  const observationHash = commandPayloadFingerprint(input.observation);
  if (receipt.state !== 'outcome_unknown') {
    if (receipt.state !== state || receipt.result?.status !== input.observation.status || receipt.result.body.observationHash !== observationHash) throw Error('connection_control_settlement_conflict');
    return {reference: r, state};
  }
  const action = auditActions[binding.control.operation];
  if (state === 'accepted' && action) owner.audit(action, r.connectionId, {
    ...('request' in binding.control ? {request: binding.control.request} : {}), ...input.observation.facts, updatedAt: Date.now(),
  }, r.ownerUserId);
  // Fixed digest fits the existing 128-byte result reserve, rejects conflicting
  // ACKs without retaining upstream bodies or allowing duplicate audit writes.
  const settled = owner.commands.settle(s, r.key, {status: input.observation.status, body: {observationHash}});
  if (settled.state !== state) throw Error('connection_control_settlement_unavailable');
  return {reference: r, state};
}
