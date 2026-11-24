import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { tokenSnapshotRequestId } from '@agentopsdeck/shared';
import type { HubStore } from './hub-store.js';
import type { HubPrincipal } from './identity.js';
import { decodeHubSessionId } from './session-id.js';
import { GuidanceConflict, type GuidanceSubmission } from './session-guidance-store.js';
import { requireConnectionReady } from '../storage/connection-recovery.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

type Session = { sessionId: string };
type Write = Session & { nodeVersion: number };
export type HubGuidanceCommand =
  | Session & { action: 'authorize' | 'inspect' }
  | Session & { action: 'receipt'; requestId: string }
  | Write & { action: 'save'; revision: number; text: string; enabled: boolean }
  | Write & { action: 'prepare'; requestId: string; revision: number; input: string }
  | Write & { action: 'cancel' | 'claim'; requestId: string }
  // Internal Connector response adapter only; never a browser-supplied
  // "submitted" flag. The owner matches the original durable command key.
  | Write & { action: 'reconcile'; requestId: string; ack: { key: string; id: string; state: 'accepted' | 'rejected' } };
type Config = { revision: number; text: string; hash: string; enabled: boolean };
type State = 'confirmed_present' | 'confirmed_absent' | 'unknown' | 'submitted' | 'not_submitted';
export type HubGuidanceResult = null | {
  action: HubGuidanceCommand['action']; digest: string; status: 200 | 201 | 404 | 409;
  nodeVersion: number | null; config: Config | null; state: State | null;
  receipt: GuidanceSubmission | null; claimed: boolean | null; cancelled: boolean | null;
};
// Worst-case escaped 8k text/input and the original 16k combined preview.
// Keep bounded admission without truncating otherwise valid Chinese input.
export const HUB_GUIDANCE_COMMAND_BYTES = 128 * 1024;
export const HUB_GUIDANCE_RESULT_BYTES = 256 * 1024;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && Object.keys(v).every(k => names.includes(k));
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const version = (v: unknown): v is number => integer(v) && v > 0;
const identity = (v: unknown, max = 8192): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !v.includes('\0');
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const requestId = (v: unknown): v is string => { try { return tokenSnapshotRequestId(v) === v; } catch { return false; } };
export function validHubGuidanceCommand(v: unknown): v is HubGuidanceCommand {
  if (!object(v) || !identity(v.sessionId, 4096)) return false;
  if (v.action === 'authorize' || v.action === 'inspect') return fields(v, ['action','sessionId']);
  if (v.action === 'receipt') return fields(v, ['action','sessionId','requestId']) && requestId(v.requestId);
  if (!version(v.nodeVersion)) return false;
  const base = ['action','sessionId','nodeVersion'];
  if (v.action === 'save') return fields(v, [...base,'revision','text','enabled']) && integer(v.revision)
    && integer(v.revision + 1) && text(v.text,8000) && typeof v.enabled === 'boolean';
  if (!requestId(v.requestId)) return false;
  if (v.action === 'prepare') return fields(v, [...base,'requestId','revision','input']) && integer(v.revision) && text(v.input,8000);
  if (v.action === 'claim' || v.action === 'cancel') return fields(v, [...base,'requestId']);
  return v.action === 'reconcile' && fields(v, [...base,'requestId','ack']) && object(v.ack)
    && fields(v.ack, ['key','id','state']) && identity(v.ack.key) && identity(v.ack.id,512)
    && (v.ack.state === 'accepted' || v.ack.state === 'rejected');
}
function validConfig(v: unknown): v is Config {
  return object(v) && fields(v,['revision','text','hash','enabled']) && version(v.revision)
    && text(v.text,8000) && hash(v.hash) && sha(v.text) === v.hash && typeof v.enabled === 'boolean';
}
function validReceipt(v: unknown): v is GuidanceSubmission {
  if (!object(v) || !Object.keys(v).every(k => ['requestId','revision','hash','text','inputHash','state','queueReceipt','contextEpoch','commandKey','createdAt','expiresAt'].includes(k))
    || !['requestId','revision','hash','text','inputHash','state','queueReceipt','contextEpoch'].every(k => Object.hasOwn(v,k))
    || !identity(v.requestId) || !integer(v.revision) || !hash(v.hash) || !hash(v.inputHash) || !text(v.text,16002)
    || !['prepared','unknown','submitted','rejected','cancelled'].includes(String(v.state))
    || !(v.contextEpoch === null || identity(v.contextEpoch))) return false;
  if (v.state === 'submitted' ? !identity(v.queueReceipt) : v.queueReceipt !== null) return false;
  // Legacy receipts lack these fields. Preserve that shape, but never turn a
  // legacy preview into a fresh dispatchable claim in this adapter.
  const timed = ['commandKey','createdAt','expiresAt'].filter(k => Object.hasOwn(v,k));
  // Original versions sampled creation/expiry separately. A committed old
  // receipt can therefore exceed five minutes by a clock tick. Observation,
  // idempotent preparation and exact-ACK reconciliation preserve those facts;
  // they do not issue a new sending permit or renew the original deadline.
  return timed.length === 0 || timed.length === 3 && identity(v.commandKey) && integer(v.createdAt)
    && integer(v.expiresAt) && v.expiresAt > v.createdAt;
}
function dispatchableReceipt(v: GuidanceSubmission): boolean {
  return identity(v.commandKey!) && integer(v.createdAt) && integer(v.expiresAt)
    && v.expiresAt > v.createdAt && v.expiresAt - v.createdAt <= 300_000;
}
export function validHubGuidanceResult(v: unknown): v is HubGuidanceResult {
  if (v === null) return true;
  if (!object(v) || !fields(v,['action','digest','status','nodeVersion','config','state','receipt','claimed','cancelled'])
    || !['authorize','inspect','receipt','save','prepare','cancel','claim','reconcile'].includes(String(v.action)) || !hash(v.digest)) return false;
  if (v.status === 404 || v.status === 409) return v.nodeVersion === null && v.config === null && v.state === null
    && v.receipt === null && v.claimed === null && v.cancelled === null;
  if (!version(v.nodeVersion) || (v.status !== 200 && v.status !== 201)) return false;
  if (v.action === 'authorize') return v.status === 200 && v.config === null && v.state === null && v.receipt === null && v.claimed === null && v.cancelled === null;
  if (v.action === 'inspect' || v.action === 'save') return v.status === 200 && v.receipt === null && v.claimed === null && v.cancelled === null
    && (v.config === null ? v.action === 'inspect' && v.state === null : validConfig(v.config)
      && ['confirmed_present','confirmed_absent','unknown','submitted','not_submitted'].includes(String(v.state)));
  if (v.config !== null || v.state !== null) return false;
  if (v.action === 'cancel') return v.status === 200 && v.receipt === null && v.claimed === null && v.cancelled === true;
  if (v.action === 'receipt' && v.cancelled === true) return v.status === 200 && v.receipt === null && v.claimed === null;
  if (!validReceipt(v.receipt) || v.cancelled !== null) return false;
  if (v.action === 'claim') return v.status === 200 && typeof v.claimed === 'boolean'
    && (!v.claimed || v.receipt.state === 'unknown' && dispatchableReceipt(v.receipt));
  return v.claimed === null && (v.action === 'prepare' ? v.status === 201 : v.status === 200
    && (v.action !== 'reconcile' || v.receipt.state === 'submitted' || v.receipt.state === 'rejected'));
}
export type HubGuidanceReplyExpectation = { digest: string; action: HubGuidanceCommand['action']; requestId?: string;
  revision?: number; textHash?: string; enabled?: boolean; inputHash?: string; ackState?: 'accepted' | 'rejected'; ackId?: string };
export function hubGuidanceReplyExpectation(command: HubGuidanceCommand): HubGuidanceReplyExpectation {
  return { digest: sha(JSON.stringify(command)), action: command.action,
    ...('requestId' in command ? {requestId:command.requestId} : {}),
    ...(command.action === 'save' ? {revision:command.revision+1,textHash:sha(command.text),enabled:command.enabled} : {}),
    ...(command.action === 'prepare' ? {revision:command.revision,inputHash:sha(command.input)} : {}),
    ...(command.action === 'reconcile' ? {ackState:command.ack.state,ackId:command.ack.id} : {}) };
}
export function validHubGuidanceReply(expected: HubGuidanceReplyExpectation, value: unknown): value is HubGuidanceResult {
  if (!validHubGuidanceResult(value)) return false;
  if (value === null) return true;
  if (value.digest !== expected.digest || value.action !== expected.action) return false;
  if (value.status === 404 || value.status === 409) return true;
  if (value.receipt && value.receipt.requestId !== expected.requestId) return false;
  if (expected.action === 'save') return value.config !== null && value.config.revision === expected.revision
    && value.config.hash === expected.textHash && value.config.enabled === expected.enabled;
  if (expected.action === 'prepare') return value.receipt !== null && value.receipt.revision === expected.revision && value.receipt.inputHash === expected.inputHash;
  if (expected.action === 'reconcile') return value.receipt !== null && value.receipt.state === (expected.ackState === 'accepted' ? 'submitted' : 'rejected')
    && value.receipt.queueReceipt === (expected.ackState === 'accepted' ? expected.ackId : null);
  return true;
}

/** The complete Hub owner is the only writer. Read authority freshly at root
 * entry and before COMMIT; never enclose guidance's original root transaction
 * in an identity savepoint, and never execute remote I/O here. */
export function executeHubGuidanceCommand(db: DatabaseSync, owner: HubStore, principal: HubPrincipal,
  freshPrincipal: () => HubPrincipal | undefined, command: HubGuidanceCommand,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics): HubGuidanceResult {
  const phases = {authorize:11,inspect:12,receipt:13,save:14,prepare:15,cancel:16,claim:17,reconcile:18} as const;
  let trace: ReturnType<PerformanceDiagnostics['start']> | undefined, failed = true;
  try { trace = diagnostics.start('hub-session-guidance'); } catch { /* Observation is not authority. */ }
  try {
    const result = execute(db,owner,principal,freshPrincipal,command);
    failed = result === null || result.status >= 400;
    try { trace?.add(failed ? 'deferred' : 'settled',1); } catch { /* Keep the original outcome. */ }
    return result;
  } catch (error) {
    try { trace?.add('unknown',1); } catch { /* Never retry a SQL mutation to log it. */ }
    throw error;
  } finally {
    try { trace?.add('step',phases[command.action]); trace?.finish(failed); } catch { /* Never authorize or resend. */ }
  }
}
function execute(db: DatabaseSync, owner: HubStore, principal: HubPrincipal,
  freshPrincipal: () => HubPrincipal | undefined, command: HubGuidanceCommand): HubGuidanceResult {
  requireConnectionReady(db);
  if (db.isTransaction) throw new GuidanceConflict('outer-transaction');
  const digest = hubGuidanceReplyExpectation(command).digest;
  const result: Exclude<HubGuidanceResult,null> = {action:command.action,digest,status:200,nodeVersion:null,
    config:null,state:null,receipt:null,claimed:null,cancelled:null};
  const refuse = (status:404|409) => ({...result,status});
  const decoded = decodeHubSessionId(command.sessionId);
  if (!decoded || !['codex:','claude-code:','ghcp:'].some(p => decoded.remoteSessionKey.startsWith(p))) return refuse(404);
  const connection = owner.getConnection(decoded.connectionId,principal.userId);
  const epoch = owner.connectionAuthority(decoded.connectionId,principal.userId);
  if (!connection?.nodeId || connection.status === 'disabled' || !version(epoch)) return refuse(404);
  if ('nodeVersion' in command && command.nodeVersion !== epoch) return refuse(409);
  const target = JSON.stringify([command.sessionId,connection.nodeId,epoch]);
  // Remember a denial inside the root transaction: rollback may restore
  // credentials/authority, but cannot retroactively authorize this command.
  let authorityDenied = false;
  const authorized = () => {
    const currentPrincipal = freshPrincipal(), current = owner.getConnection(decoded.connectionId,principal.userId);
    const allowed = currentPrincipal?.userId === principal.userId && !!current && current.status !== 'disabled'
      && current.nodeId === connection.nodeId && owner.connectionAuthority(decoded.connectionId,principal.userId) === epoch;
    if (!allowed) authorityDenied = true;
    return allowed && !authorityDenied;
  };
  if (!authorized()) return null;
  const store = owner.sessionGuidance;
  try {
    if (command.action === 'inspect' || command.action === 'save') {
      if (command.action === 'save') store.save(principal.userId,target,command.revision,command.text,command.enabled,authorized);
      const inspection = store.inspect(principal.userId,target); result.config = inspection?.config ?? null; result.state = inspection?.state as State ?? null;
    } else if (command.action === 'receipt') {
      if (store.cancelled(principal.userId,target,command.requestId)) result.cancelled = true;
      else { result.receipt = store.receipt(principal.userId,target,command.requestId) ?? null; if (!result.receipt) return refuse(404); }
    } else if (command.action === 'prepare') {
      result.receipt = store.prepare(principal.userId,target,command.requestId,command.revision,command.input,authorized); result.status = 201;
    } else if (command.action === 'cancel') {
      store.cancel(principal.userId,target,command.requestId,authorized); result.cancelled = true;
    } else if (command.action === 'claim' || command.action === 'reconcile') {
      const original = store.receipt(principal.userId,target,command.requestId);
      if (!original) return refuse(404);
      if (!original.commandKey) return refuse(409);
      if (command.action === 'claim') {
        // Recovery of an already-claimed/terminal fact cannot mint another
        // permit. Over-budget old PREPARED previews require explicit new
        // admission instead of being silently repaired, refreshed or sent.
        if (!validReceipt(original) || original.state === 'prepared' && !dispatchableReceipt(original)) return refuse(409);
        const claim = store.claim(principal.userId,target,command.requestId,authorized); result.receipt = claim.receipt; result.claimed = claim.claimed;
      } else if (command.action === 'reconcile') {
        if (original.commandKey !== command.ack.key) return refuse(409);
        result.receipt = store.reconcile(principal.userId,target,command.requestId,command.ack.state === 'accepted'
          ? {state:'submitted',queueReceipt:command.ack.id} : {state:'rejected',queueReceipt:null},authorized);
      }
    }
    if (!authorized()) return null;
    result.nodeVersion = epoch; return result;
  } catch (error) {
    // SQL/settlement errors are UNKNOWN, not a definite conflict or retry.
    if (!(error instanceof GuidanceConflict)) throw error;
    if (authorityDenied || error.message === 'authority') return null;
    return refuse(409);
  }
}
