import type { SendDeliveryMode, SendMessageUpload } from '@agentopsdeck/shared';
import { copySharedMessageInput } from '@agentopsdeck/shared';
import { CommandNotSubmittedError } from './command-recovery.js';

export type SharedSessionTarget = { ownerUserId: string; sessionId: string };
export type SessionTarget = string | SharedSessionTarget;
export type SharedGrantTarget = { ownerUserId: string; connectionId: string; id: string };
type SessionAddress = { key: string; path: string; shared: boolean };
const TAG = 'shared-session-v1';

function segment(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || value === '.' || value === '..'
    || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid session address');
  // Also rejects unpaired surrogates; never let URL normalization change a target.
  return encodeURIComponent(value);
}

export function sharedGrantSessionsPath(target: SharedGrantTarget) {
  return `/api/hub/v1/shared/${segment(target.ownerUserId)}/connections/${segment(target.connectionId)}/grants/${segment(target.id)}/sessions`;
}

/** One identity for API reads, caches and the existing recovery journal. Owner
 * keys stay unchanged. Reserved array encodings fail closed, including unknown
 * versions, noncanonical JSON and damaged saved shared keys. This is routing,
 * not authorization: the Hub still derives the actor from the current account.
 */
export function sessionAddress(target: SessionTarget): SessionAddress {
  if (typeof target === 'string') {
    if (/^\s*\[/.test(target)) {
      let tuple: unknown;
      try { tuple = JSON.parse(target); } catch { throw new Error('Invalid shared session address'); }
      if (!Array.isArray(tuple) || tuple.length !== 3 || tuple[0] !== TAG) throw new Error('Invalid shared session address');
      const address = sessionAddress({ ownerUserId: tuple[1], sessionId: tuple[2] });
      if (address.key !== target) throw new Error('Noncanonical shared session address');
      return address;
    }
    return { key: target, path: `/api/hub/v1/sessions/${segment(target)}`, shared: false };
  }
  if (!target || typeof target !== 'object' || Object.keys(target).length !== 2
    || !Object.hasOwn(target, 'ownerUserId') || !Object.hasOwn(target, 'sessionId')) throw new Error('Invalid shared session address');
  const owner = segment(target.ownerUserId), session = segment(target.sessionId);
  const key = JSON.stringify([TAG, target.ownerUserId, target.sessionId]);
  if (key.length > 4096) throw new Error('Shared session address exceeds recovery storage limit');
  return { key, path: `/api/hub/v1/shared/${owner}/sessions/${session}`, shared: true };
}

export type SharedSessionRoute = { kind: 'owner' } | { kind: 'invalid' } | { kind: 'directory' }
  | { kind: 'shared'; target: SharedSessionTarget; key: string };

/** Intercept shared deep links before an owner shell tries catalog fallback.
 * Broken reserved links are errors, not a request to open the first session. */
export function sharedSessionRoute(hash: string): SharedSessionRoute {
  const raw = hash.replace(/^#\/?/, '');
  if (raw === 'shared') return { kind: 'directory' };
  if (!raw.startsWith('session/')) return { kind: 'owner' };
  try {
    const address = sessionAddress(decodeURIComponent(raw.slice('session/'.length)));
    if (!address.shared) return { kind: 'owner' };
    const [, ownerUserId, sessionId] = JSON.parse(address.key) as [string, string, string];
    return { kind: 'shared', target: { ownerUserId, sessionId }, key: address.key };
  } catch { return { kind: 'invalid' }; }
}

export function ownerSessionPath(target: SessionTarget, legacy = false): string {
  const address = sessionAddress(target);
  if (address.shared) throw new CommandNotSubmittedError('This operation is not available for shared sessions');
  return legacy ? `/api/sessions/${segment(address.key)}` : address.path;
}

/** For shared sessions the target is the original browser command key, NEVER
 * a runtime queue ID. Saved queue.messageId retains this target for exact GET.
 */
export function queueMutationPath(target: SessionTarget, queueTarget: string): string {
  const address = sessionAddress(target);
  if (address.shared && !/^[A-Za-z0-9._:-]{1,200}$/.test(queueTarget)) throw new Error('Invalid original command key');
  const id = segment(queueTarget);
  return address.shared ? `${address.path}/commands/${id}/queue` : `${address.path}/queue/${id}`;
}

/** Call before journaling, and again at the API boundary. Do not silently drop
 * uploads, mirror delivery or a targeted control when only text is supported.
 */
export function sessionMessagePayload(target: SessionTarget, message: string, deliveryMode: SendDeliveryMode,
  media: SendMessageUpload[], idempotencyKey: string, expectedRunId?: string) {
  if (!sessionAddress(target).shared) return { message, deliveryMode, media, idempotencyKey, ...(expectedRunId ? { expectedRunId } : {}) };
  try {
    if (expectedRunId !== undefined) throw new Error('Shared control');
    return { ...copySharedMessageInput({ message, deliveryMode, media }), idempotencyKey };
  } catch { throw new CommandNotSubmittedError('Invalid shared message or attachment; controls are unavailable'); }
}
