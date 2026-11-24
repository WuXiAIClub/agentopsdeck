import { createHash } from 'node:crypto';
import type { HubStore } from './hub-store.js';
import type { HubPrincipal } from './identity.js';
import type { QuickChatProfile, QuickChatReceipt } from './quick-chat-store.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

/** Query the original receipt only. This protocol cannot admit, claim, cancel,
 * replay, clear, expire or settle a provider request. It is not application
 * activation and never opens a second writer beside the complete Hub owner. */
export type HubQuickChatStateCommand = { action: 'list' } | { action: 'inspect'; requestId: string };
type State = { action: HubQuickChatStateCommand['action']; digest: string;
  profiles: QuickChatProfile[] | null; receipts: QuickChatReceipt[] | null;
  receipt: QuickChatReceipt | null; output: string | null };
export type HubQuickChatStateResult = State | null;
export const HUB_QUICK_CHAT_STATE_COMMAND_BYTES = 16_384;
// A list contains up to 32 current profiles and 32 receipt-pinned profiles.
// Legal legacy strings can contain lone surrogate code units, each of which
// JSON escapes to six bytes. Reserve the complete list, not just one output;
// the worker's existing aggregate reservation still bounds concurrent reads.
export const HUB_QUICK_CHAT_STATE_RESULT_BYTES = 1_048_576;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v,k));
const text = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
  && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function validHubQuickChatStateCommand(v: unknown): v is HubQuickChatStateCommand {
  return object(v) && (v.action === 'list' ? fields(v,['action'])
    : v.action === 'inspect' && fields(v,['action','requestId']) && text(v.requestId));
}
export function profile(v: unknown): v is QuickChatProfile {
  return object(v) && fields(v,['id','revision','name','target','model','outputLimit']) && text(v.id)
    && integer(v.revision) && v.revision > 0 && text(v.name,80) && text(v.target) && text(v.model,128)
    && integer(v.outputLimit) && v.outputLimit > 0;
}
export function receipt(v: unknown): v is QuickChatReceipt {
  return object(v) && fields(v,['requestId','profile','capabilityEpoch','fingerprint','state','createdAt','resultRef','resultExpiresAt'])
    && text(v.requestId) && profile(v.profile) && text(v.capabilityEpoch) && hash(v.fingerprint)
    && ['admitted','unknown','completed','failed'].includes(String(v.state)) && integer(v.createdAt)
    && (v.resultRef === null || typeof v.resultRef === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v.resultRef))
    && (v.resultExpiresAt === null || integer(v.resultExpiresAt) && v.resultExpiresAt >= v.createdAt)
    && (v.resultRef === null || v.state === 'completed' && v.resultExpiresAt !== null);
}
export function validHubQuickChatStateResult(v: unknown): v is HubQuickChatStateResult {
  if (v === null) return true;
  if (!object(v) || !fields(v,['action','digest','profiles','receipts','receipt','output']) || !hash(v.digest)) return false;
  if (v.action === 'list') return Array.isArray(v.profiles) && v.profiles.length <= 32 && v.profiles.every(profile)
    && new Set(v.profiles.map(p=>p.id)).size === v.profiles.length
    && Array.isArray(v.receipts) && v.receipts.length <= 32 && v.receipts.every(receipt)
    && new Set(v.receipts.map(r=>r.requestId)).size === v.receipts.length && v.receipt === null && v.output === null;
  return v.action === 'inspect' && v.profiles === null && v.receipts === null
    && (v.receipt === null ? v.output === null : receipt(v.receipt)
      && (v.output === null || typeof v.output === 'string' && v.output.trim().length > 0 && v.output.length <= 32000
        && v.receipt.state === 'completed' && v.receipt.resultRef !== null));
}
export function validHubQuickChatStateReply(command: HubQuickChatStateCommand, value: unknown): value is HubQuickChatStateResult {
  return validHubQuickChatStateResult(value) && (value === null || value.action === command.action && value.digest === digest(command)
    && (command.action !== 'inspect' || value.receipt === null || value.receipt.requestId === command.requestId));
}
export function executeHubQuickChatStateCommand(owner: HubStore, principal: HubPrincipal,
  fresh: () => HubPrincipal | undefined, command: HubQuickChatStateCommand,
  diagnostics: PerformanceDiagnostics = performanceDiagnostics): HubQuickChatStateResult {
  let trace: ReturnType<PerformanceDiagnostics['start']> | undefined, failed = true;
  try { trace = diagnostics.start('hub-quick-chat'); trace.add('step',command.action === 'list' ? 8 : 9); } catch { /* Observation only. */ }
  try {
    const check = () => fresh()?.userId === principal.userId;
    if (!check()) return null;
    const state: State = { action:command.action,digest:digest(command),profiles:null,receipts:null,receipt:null,output:null };
    if (command.action === 'list') {
      state.profiles = owner.quickChat.profiles(principal.userId);
      state.receipts = owner.quickChat.receipts(principal.userId);
    } else {
      state.receipt = owner.quickChat.receipt(principal.userId,command.requestId) ?? null;
      state.output = owner.quickChat.peekResult(principal.userId,command.requestId) ?? null;
    }
    if (!check()) return null;
    if (!validHubQuickChatStateReply(command,state)) throw Error('hub_member_storage_unavailable');
    failed = false;
    try { trace?.add(state.receipt?.state === 'unknown' ? 'unknown' : 'settled',1); } catch { /* Keep the original result. */ }
    return state;
  } finally { try { trace?.finish(failed); } catch { /* No state effect to report diagnostics. */ } }
}
