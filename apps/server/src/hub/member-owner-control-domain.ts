import type { CommandReceipt } from '../commands/receipts.js';
import { CommandCapacity, CommandConflict, MAX_COMMAND_RESULT_BYTES } from '../commands/receipts.js';
import type { HubStore } from './hub-store.js';
import type { HubPrincipal } from './identity.js';
import { decodeHubSessionId, encodeHubSessionId } from './session-id.js';
import { StorageAdmissionDeferred } from '../storage/work-admission.js';
import { readSessionSettingsResult } from '@agentopsdeck/shared';
import { sessionRef } from './session-ref.js';

export type OwnerControlTarget = { operation: 'message' | 'queue' | 'delete' | 'create' | 'settings' | 'compact';
  connectionId: string; sessionId?: string; agentId?: string; messageId?: string };
export type HubOwnerControlCommand = { target: OwnerControlTarget; epoch: number } & (
  { action: 'check' } | { [A in 'get' | 'delivery' | 'released' | 'cleanup']: { action: A; key: string } }['get' | 'delivery' | 'released' | 'cleanup']
  | { action: 'claim'; key: string; payload: unknown }
  | { action: 'claimDigest'; key: string; digest: string }
  | { action: 'settle'; key: string; receipt: CommandReceipt });
export type HubOwnerControlResult = null | { error: 401 | 403 | 404 | 409 | 503 }
  | { ok: true } | { receipt: CommandReceipt | null } | { delivery: string } | { released: boolean }
  | { fresh: boolean; receipt: CommandReceipt };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && !!v && Buffer.byteLength(v) <= 4096 && !/[\x00-\x1f\x7f]/.test(v);
const key = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
// Original receipt results can be 64KiB. Leave bounded room for the private
// evidence/target envelope, not for message text or inline attachment copies.
export const HUB_OWNER_CONTROL_COMMAND_BYTES = MAX_COMMAND_RESULT_BYTES + 32 * 1024;
export const HUB_OWNER_CONTROL_RESULT_BYTES = MAX_COMMAND_RESULT_BYTES + 16 * 1024;
export function validOwnerControlTarget(v: unknown): v is OwnerControlTarget {
  if (!object(v) || !Object.keys(v).every(k => ['operation','connectionId','sessionId','agentId','messageId'].includes(k))
    || !['message','queue','delete','create','settings','compact'].includes(String(v.operation)) || !id(v.connectionId)) return false;
  if (v.operation === 'create') return id(v.agentId) && v.sessionId === undefined && v.messageId === undefined;
  if (!id(v.sessionId) || v.agentId !== undefined || v.operation !== 'queue' && v.messageId !== undefined
    || v.messageId !== undefined && !id(v.messageId)) return false;
  const decoded = decodeHubSessionId(v.sessionId);
  return !!decoded && decoded.connectionId === v.connectionId && encodeHubSessionId(decoded.connectionId, decoded.remoteSessionKey) === v.sessionId;
}
export function validOwnerControlReceipt(v: unknown): v is CommandReceipt {
  return object(v) && Object.keys(v).every(k => ['id','key','state','createdAt','updatedAt','result','settingsStartReleased'].includes(k))
    && id(v.id) && v.id.length <= 200 && key(v.key) && ['outcome_unknown','accepted','rejected'].includes(String(v.state))
    && Number.isSafeInteger(v.createdAt) && Number(v.createdAt) >= 0 && Number.isSafeInteger(v.updatedAt) && Number(v.updatedAt) >= 0
    && (v.settingsStartReleased === undefined || v.settingsStartReleased === true)
    && (v.result === undefined || object(v.result) && Object.keys(v.result).sort().join() === 'body,status'
      && Number.isInteger(v.result.status) && Number(v.result.status) >= 100 && Number(v.result.status) <= 599 && object(v.result.body));
}
/** Only the private background stop lane needs a message's original payload
 * in SQL. Ordinary messages still send digests, never text/attachments. */
export function validOwnerStopPayload(v: unknown): boolean {
  return object(v) && Object.keys(v).sort().join() === 'deliveryMode,expectedRunId,media,message'
    && v.message === '/stop' && id(v.expectedRunId) && v.deliveryMode === 'web-only'
    && Array.isArray(v.media) && v.media.length === 0;
}
export function validHubOwnerControlCommand(v: unknown): v is HubOwnerControlCommand {
  if (!object(v) || !validOwnerControlTarget(v.target) || !Number.isSafeInteger(v.epoch) || Number(v.epoch) < 1) return false;
  const expected = v.action === 'check' ? ['action','target','epoch'] : v.action === 'claimDigest' ? ['action','target','epoch','key','digest']
    : v.action === 'claim' ? ['action','target','epoch','key','payload']
    : v.action === 'settle' ? ['action','target','epoch','key','receipt'] : ['action','target','epoch','key'];
  return Object.keys(v).length === expected.length && Object.keys(v).every(k => expected.includes(k))
    && (v.action === 'check' || ['get','delivery','released','cleanup','claim','claimDigest','settle'].includes(String(v.action)) && key(v.key))
    && (v.action !== 'claim' || v.target.operation !== 'message' || validOwnerStopPayload(v.payload))
    && (v.action !== 'claimDigest' || v.target.operation === 'message' && typeof v.digest === 'string' && /^[a-f0-9]{64}$/.test(v.digest))
    && (v.action !== 'cleanup' || v.target.operation === 'delete')
    && (v.action !== 'settle' || validOwnerControlReceipt(v.receipt));
}
export function validHubOwnerControlResult(v: unknown): v is HubOwnerControlResult {
  if (v === null) return true;
  if (!object(v)) return false;
  const fields = Object.keys(v).sort().join();
  return fields === 'error' && [401,403,404,409,503].includes(Number(v.error))
    || fields === 'ok' && v.ok === true
    || fields === 'delivery' && key(v.delivery)
    || fields === 'released' && typeof v.released === 'boolean'
    || fields === 'receipt' && (v.receipt === null || validOwnerControlReceipt(v.receipt))
    || fields === 'fresh,receipt' && typeof v.fresh === 'boolean' && validOwnerControlReceipt(v.receipt);
}
export function validHubOwnerControlReply(c: HubOwnerControlCommand, v: unknown) {
  if (!validHubOwnerControlResult(v)) return false;
  if (v === null || 'error' in v) return true;
  if (c.action === 'check' || c.action === 'cleanup') return 'ok' in v;
  if (c.action === 'delivery') return 'delivery' in v;
  if (c.action === 'released') return 'released' in v;
  if (c.action === 'claim' || c.action === 'claimDigest') return 'fresh' in v && v.receipt.key === c.key;
  return 'receipt' in v && !('fresh' in v) && (v.receipt === null ? c.action === 'get' : v.receipt.key === c.key);
}
// Derive the saved 2.3.7 scope on the original owner, never accept an arbitrary
// scope/owner/admin assertion over RPC. Old receipts keep their wire identity.
export function ownerControlScope(owner: string, t: OwnerControlTarget) {
  return JSON.stringify(t.operation === 'message' ? [owner, t.sessionId]
    : t.operation === 'create' ? ['create', JSON.stringify(['owner-session-create-v1', owner, t.connectionId, t.agentId])]
    : t.operation === 'settings' ? ['settings', JSON.stringify(['owner-session-settings-v1', owner, t.sessionId])]
    : t.operation === 'compact' ? ['compact', JSON.stringify(['owner-session-compact-v1', owner, t.sessionId])]
    : t.operation === 'queue' ? ['owner-queue-mutation-v1', owner, t.sessionId, t.messageId]
    : ['owner-session-delete-v1', owner, t.sessionId]);
}
export function executeHubOwnerControl(owner: HubStore, actor: HubPrincipal, c: Exclude<HubOwnerControlCommand, {action:'claim' | 'claimDigest'}>): Exclude<HubOwnerControlResult, null> {
  const connection = owner.getConnection(c.target.connectionId, actor.userId);
  if (!connection || connection.status === 'disabled') return { error: 404 };
  if (owner.connectionAuthority(connection.id, actor.userId) !== c.epoch) return { error: 403 };
  if (c.action === 'check') return { ok: true };
  const scope = ownerControlScope(actor.userId, c.target), receipts = owner.commands;
  const receipt = receipts.get(scope, c.key);
  if (!receipt) return c.action === 'get' ? { receipt: null } : { error: 404 };
  // Original ordinary-message receipts have no authority_id. Keep their scope,
  // fingerprint and delivery key unchanged; the request's current connection
  // epoch is still checked above, including after every transport wait.
  if (c.target.operation !== 'message' && receipts.authorityId(scope, c.key) !== c.epoch) return { error: 409 };
  if (c.action === 'get') return { receipt };
  if (c.action === 'delivery') return { delivery: receipts.deliveryKey(scope, c.key) };
  if (c.action === 'released') return { released: receipts.settingsStartReleased(scope, c.key) };
  if (c.action === 'cleanup') {
    if (receipt.state !== 'accepted') return { error: 409 };
    owner.removeSessionPreferences(c.target.sessionId!, actor.userId);
    return { ok: true };
  }
  const upstream = c.receipt, result = upstream.result;
  if (c.target.operation === 'message') return { receipt: receipts.settleFromReceipt(scope, c.key, upstream) };
  let safe: CommandReceipt['result'];
  if (result && upstream.state === 'rejected' && result.status >= 400 && result.status < 500) {
    const label = { compact: 'Compaction', queue: 'Queue mutation', create: 'Creation', settings: 'Settings', delete: 'Deletion' }[c.target.operation];
    safe = { status: result.status, body: { error: `${label} rejected` } };
  } else if (result && upstream.state === 'accepted') {
    if (c.target.operation === 'create' && result.status === 201 && typeof result.body.key === 'string' && connection.nodeId) {
      try { safe = { status: 201, body: { key: encodeHubSessionId(connection.id, result.body.key),
        remoteSessionKey: result.body.key, sessionRef: sessionRef(connection.nodeId, result.body.key) } }; } catch { /* Remain unknown. */ }
    } else if (c.target.operation === 'settings' && result.status === 200) {
      const native = readSessionSettingsResult(result.body, decodeHubSessionId(c.target.sessionId!)!.remoteSessionKey);
      if (native) safe = { status: 200, body: { ...native, sessionKey: c.target.sessionId } };
    } else if (c.target.operation === 'compact' && result.status === 200 && result.body.ok === true && result.body.status === 'compacting'
      && typeof result.body.runId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(result.body.runId)) {
      safe = { status: 200, body: { ok: true, status: 'compacting', runId: result.body.runId } };
    } else if (['queue','delete'].includes(c.target.operation) && result.status === 200 && result.body.ok === true) {
      safe = { status: 200, body: c.target.operation === 'queue' ? { ok: true } : { ok: true, status: 'delete_accepted' } };
    }
  }
  return { receipt: safe ? receipts.settleFromReceipt(scope, c.key, { ...upstream, result: safe }) : receipt };
}
export async function claimHubOwnerControl(owner: HubStore, request: Request, expectedScope: string,
  c: Extract<HubOwnerControlCommand, {action:'claim' | 'claimDigest'}>): Promise<HubOwnerControlResult> {
  const check = () => {
    if (!owner.identities.weixinOwnerControlAllowed(request, owner, c)) throw new OwnerControlRefused(403);
    const result = owner.identities.memberOwnerControlCommand(request, expectedScope, owner, { target: c.target, epoch: c.epoch, action: 'check' });
    if (!result || 'error' in result) throw new OwnerControlRefused(result?.error ?? 401);
  };
  // The original actor is derived again under the receipt transaction, for
  // both a fresh claim and a duplicate, after physical admission has waited.
  const actor = owner.identities.commandPrincipal(request);
  if (!actor || owner.identities.recoveryScope(actor) !== expectedScope) return null;
  try {
    const scope = ownerControlScope(actor.userId, c.target);
    const value = c.action === 'claimDigest'
      ? await owner.commands.claimDigestAsync(scope, c.key, c.digest, check, check)
      : await owner.commands.claimAsync(scope, c.key, c.payload, true, c.epoch, undefined, undefined, false, check, check);
    check(); return value;
  } catch (error) {
    if (error instanceof OwnerControlRefused) return { error: error.status };
    if (error instanceof CommandConflict) return { error: 409 };
    if (error instanceof CommandCapacity || error instanceof StorageAdmissionDeferred) return { error: 503 };
    throw error; // Unknown SQL/ACK outcome must never become a new claim.
  }
}
class OwnerControlRefused extends Error { constructor(readonly status: 401 | 403 | 404 | 409 | 503) { super('owner_control_unavailable'); } }
