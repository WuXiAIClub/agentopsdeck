import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { HubStore } from './hub-store.js';
import type { HubPrincipal } from './identity.js';
import { QuickChatConflict, type QuickChatCapability, type QuickChatProfile, type QuickChatReceipt } from './quick-chat-store.js';
import { profile, receipt } from './member-quick-chat-state-domain.js';

/** Fixed commands over the original owner. No network, callback, browser-supplied
 * principal or nested savepoint. Each mutation retains the store's root COMMIT. */
export type HubQuickChatExecutionCommand =
  | { action: 'lookup'; requestId: string; profileId: string }
  | { action: 'save'; revision: number; profile: Omit<QuickChatProfile, 'revision'>; capability: QuickChatCapability }
  | { action: 'admit'; requestId: string; profileId: string; revision: number; identityInput: string; capability: QuickChatCapability }
  | { action: 'claim'; requestId: string; identityInput: string; capability: QuickChatCapability };
export type HubQuickChatExecutionResult = null | {
  action: HubQuickChatExecutionCommand['action']; digest: string; error: string | null;
  profile: QuickChatProfile | null; receipt: QuickChatReceipt | null; claimed: boolean; settlementProof: string | null;
};
export type HubQuickChatEffectCommand = { action: 'expire' }
  | { action: 'settle'; ownerUserId: string; requestId: string; proof: string; output: string };
export type HubQuickChatEffectResult = { action: HubQuickChatEffectCommand['action']; digest: string; ok: boolean };
export const HUB_QUICK_CHAT_EXECUTION_BYTES = 262_144;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const text = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
  && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const input = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
function capability(v: unknown): v is QuickChatCapability {
  return object(v) && fields(v, ['ephemeralRequest', 'noPersistentThread', 'originalLookup', 'maxOutput', 'epoch'])
    && v.ephemeralRequest === true && v.noPersistentThread === true && v.originalLookup === true
    && integer(v.maxOutput) && v.maxOutput > 0 && v.maxOutput <= 2000 && text(v.epoch);
}
const conflicts = new Set(['already-dispatched', 'clock', 'inflight-capacity', 'input', 'input-changed', 'missing',
  'not-terminal', 'outer-transaction', 'preflight', 'profile-capacity', 'profile-changed-or-unsupported',
  'provider-rate-capacity', 'rate-capacity', 'receipt-capacity', 'request-reused', 'result', 'revision',
  'scope', 'transition', 'unsupported-profile']);
export function validHubQuickChatExecutionCommand(v: unknown): v is HubQuickChatExecutionCommand {
  if (!object(v)) return false;
  if (v.action === 'lookup') return fields(v, ['action', 'requestId', 'profileId']) && text(v.requestId) && text(v.profileId);
  if (v.action === 'save') return fields(v, ['action', 'revision', 'profile', 'capability']) && integer(v.revision)
    && object(v.profile) && profile({ ...v.profile, revision: 1 }) && !Object.hasOwn(v.profile, 'revision') && capability(v.capability);
  if (v.action === 'claim') return fields(v, ['action', 'requestId', 'identityInput', 'capability'])
    && text(v.requestId) && input(v.identityInput, 8000) && capability(v.capability);
  return v.action === 'admit' && fields(v, ['action', 'requestId', 'profileId', 'revision', 'identityInput', 'capability'])
    && text(v.requestId) && text(v.profileId) && integer(v.revision) && input(v.identityInput, 8000) && capability(v.capability);
}
export function validHubQuickChatExecutionResult(v: unknown): v is HubQuickChatExecutionResult {
  if (v === null) return true;
  if (!object(v) || !fields(v, ['action', 'digest', 'error', 'profile', 'receipt', 'claimed', 'settlementProof'])
    || !['lookup', 'save', 'admit', 'claim'].includes(String(v.action)) || !hash(v.digest)
    || !(v.error === null || typeof v.error === 'string' && conflicts.has(v.error))
    || !(v.profile === null || profile(v.profile)) || !(v.receipt === null || receipt(v.receipt))
    || typeof v.claimed !== 'boolean') return false;
  if (v.error !== null) return v.profile === null && v.receipt === null && !v.claimed && v.settlementProof === null;
  if (v.action === 'lookup') return !v.claimed && v.settlementProof === null;
  if (v.action === 'save') return v.profile !== null && v.receipt === null && !v.claimed && v.settlementProof === null;
  if (v.action === 'admit') return v.profile === null && v.receipt !== null && !v.claimed && v.settlementProof === null;
  return v.profile === null && v.receipt !== null && (v.claimed
    ? v.receipt.state === 'unknown' && hash(v.settlementProof) : v.settlementProof === null);
}
export function validHubQuickChatExecutionReply(command: HubQuickChatExecutionCommand, value: unknown): value is HubQuickChatExecutionResult {
  return validHubQuickChatExecutionResult(value) && (value === null || value.action === command.action && value.digest === digest(command)
    && (command.action === 'save' ? value.profile === null || value.profile.id === command.profile.id
      : value.receipt === null || value.receipt.requestId === command.requestId));
}
export function validHubQuickChatEffectCommand(v: unknown): v is HubQuickChatEffectCommand {
  return object(v) && (v.action === 'expire' ? fields(v, ['action'])
    : v.action === 'settle' && fields(v, ['action', 'ownerUserId', 'requestId', 'proof', 'output'])
      && text(v.ownerUserId) && text(v.requestId) && hash(v.proof) && input(v.output, 32000));
}
export function validHubQuickChatEffectResult(v: unknown): v is HubQuickChatEffectResult {
  return object(v) && fields(v, ['action', 'digest', 'ok']) && (v.action === 'settle' || v.action === 'expire')
    && hash(v.digest) && typeof v.ok === 'boolean';
}
export function validHubQuickChatEffectReply(command: HubQuickChatEffectCommand, value: unknown): value is HubQuickChatEffectResult {
  return validHubQuickChatEffectResult(value) && value.action === command.action && value.digest === digest(command);
}
// Constant space per owner generation. Never persisted or logged; reopening the
// owner invalidates old execution proofs. Receipt state is deliberately absent:
// repeated original settlement is idempotent and cannot restore cleared output.
const generations = new WeakMap<HubStore, Buffer>();
function proof(owner: HubStore, user: string, r: QuickChatReceipt) {
  let key = generations.get(owner);
  if (!key) { key = randomBytes(32); generations.set(owner, key); }
  return createHmac('sha256', key).update(JSON.stringify([user, r.requestId, r.fingerprint, r.capabilityEpoch])).digest('hex');
}
export function executeHubQuickChatExecutionCommand(owner: HubStore, principal: HubPrincipal,
  fresh: () => HubPrincipal | undefined, command: HubQuickChatExecutionCommand): HubQuickChatExecutionResult {
  let denied = false;
  const authorized = () => {
    if (denied || fresh()?.userId !== principal.userId) { denied = true; return false; }
    return true;
  };
  if (!authorized()) return null;
  const result: NonNullable<HubQuickChatExecutionResult> = { action: command.action, digest: digest(command),
    error: null, profile: null, receipt: null, claimed: false, settlementProof: null };
  try {
    const user = principal.userId, store = owner.quickChat;
    if (command.action === 'lookup') {
      result.receipt = store.receipt(user, command.requestId) ?? null;
      result.profile = store.profile(user, command.profileId) ?? null;
    } else if (command.action === 'save') result.profile = store.saveProfile(user, command.revision, command.profile, command.capability, authorized);
    else if (command.action === 'admit') result.receipt = store.admit(user, command.requestId, command.profileId,
      command.revision, command.identityInput, command.capability, authorized);
    else {
      const claim = store.claim(user, command.requestId, command.identityInput, command.capability, authorized);
      result.receipt = claim.receipt; result.claimed = claim.claimed;
      // Mint only after the ORIGINAL root transaction has actually returned.
      if (claim.claimed) result.settlementProof = proof(owner, user, claim.receipt);
    }
  } catch (error) {
    if (denied) return null;
    if (!(error instanceof QuickChatConflict) || !conflicts.has(error.message)) throw error;
    result.error = error.message;
  }
  if (!authorized()) return null;
  if (!validHubQuickChatExecutionReply(command, result)) throw Error('hub_member_storage_unavailable');
  return result;
}
export function executeHubQuickChatEffectCommand(owner: HubStore, command: HubQuickChatEffectCommand): HubQuickChatEffectResult {
  let ok = false;
  if (command.action === 'expire') { owner.quickChat.purgeExpired(); ok = true; }
  else {
    const r = owner.quickChat.receipt(command.ownerUserId, command.requestId);
    if (r && generations.has(owner) && (r.state === 'unknown' || r.state === 'completed')
      && timingSafeEqual(Buffer.from(command.proof, 'hex'), Buffer.from(proof(owner, command.ownerUserId, r), 'hex'))) {
      owner.quickChat.complete(command.ownerUserId, command.requestId, command.output); ok = true;
    }
  }
  return { action: command.action, digest: digest(command), ok };
}
