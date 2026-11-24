import { decodeHubSessionId, encodeHubSessionId } from './session-id.js';
export type HubSessionPreferenceChange = { sessionKey: string; field: 'hidden' | 'archived' | 'pinned'; value: boolean };
export type HubSessionPreferenceResult = { ok: true } | { error: 'missing' } | null;
// Transport budget, not a new saved-state/key schema limit. Never truncate an
// old key or return an empty Map when a complete preference read cannot fit.
export const HUB_SESSION_PREFERENCE_RPC_BYTES = 128 * 1024;
export function validHubSessionPreferenceChange(value: unknown): value is HubSessionPreferenceChange {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join() !== 'field,sessionKey,value' || typeof v.sessionKey !== 'string'
    || typeof v.field !== 'string' || !['hidden', 'archived', 'pinned'].includes(v.field) || typeof v.value !== 'boolean') return false;
  const decoded = decodeHubSessionId(v.sessionKey);
  return !!decoded && encodeHubSessionId(decoded.connectionId, decoded.remoteSessionKey) === v.sessionKey;
}
export function validHubSessionPreferenceResult(value: unknown): value is HubSessionPreferenceResult {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1) return false;
  return (value as { ok?: unknown }).ok === true || (value as { error?: unknown }).error === 'missing';
}
