import type { HubUser } from './hub-store.js';
import { validHubUserAccess, validHubUserAccessCommand, type HubUserAccess, type HubUserAccessCommand } from './user-access.js';

/** Existing HTTP/store normalization, performed before an awaited permission
 * check. No input callbacks or arbitrary methods cross the owner boundary. */
export function prepareHubUserLabel(value: string): string {
  if (typeof value !== 'string') throw new Error('label is required');
  // Keep one lookahead character: when the original 120th character is a
  // separator, a second trim must not erase it before the store's slice(120).
  const label = value.trim().replace(/\s+/g, ' ').slice(0, 121);
  if (!label) throw new Error('label is required');
  return label;
}
export type HubUserChange = { action: 'create'; label: string }
  | { action: 'update'; userId: string; label: string } | HubUserAccessCommand;
export type HubUserChangeResult = { user: HubUser } | { access: HubUserAccess }
  | { error: 'missing' | 'conflict' | 'protected' } | null;
export function validHubUserChange(value: unknown): value is HubUserChange {
  if (validHubUserAccessCommand(value)) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.label !== 'string' || !v.label.trim() || v.label.length > 121) return false;
  return v.action === 'create' && Object.keys(v).sort().join() === 'action,label'
    || v.action === 'update' && Object.keys(v).sort().join() === 'action,label,userId'
      && typeof v.userId === 'string' && Buffer.byteLength(v.userId) <= 16_384;
}
export function validHubUserChangeResult(value: unknown): value is HubUserChangeResult {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1) return false;
  const v = value as Record<string, unknown>;
  if (v.error === 'missing' || v.error === 'conflict' || v.error === 'protected') return true;
  if ('access' in v) return validHubUserAccess(v.access);
  if (!v.user || typeof v.user !== 'object' || Array.isArray(v.user)) return false;
  const user = v.user as Record<string, unknown>;
  return Object.keys(user).sort().join() === 'createdAt,id,label,updatedAt'
    && typeof user.id === 'string' && !!user.id && Buffer.byteLength(user.id) <= 16_384
    && typeof user.label === 'string' && !!user.label && user.label.length <= 120
    && Number.isSafeInteger(user.createdAt) && Number(user.createdAt) >= 0
    && Number.isSafeInteger(user.updatedAt) && Number(user.updatedAt) >= 0;
}
