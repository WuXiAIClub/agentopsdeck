import type { DatabaseSync } from 'node:sqlite';
import type { HubPrincipal } from './identity.js';
import { readUsers } from './user-read.js';
import { USER_BYTE_LIMIT, validUserRows, type UserRows } from './delivery-reader-protocol.js';

/** Independent user projection: a large connection directory must not make
 * the account list unavailable. Authority is checked by the original owner. */
export type HubUserDirectoryResult = { principal: HubPrincipal; users: UserRows } | null;
export const HUB_USER_DIRECTORY_BYTES = USER_BYTE_LIMIT + 32 * 1024;
export function validHubUserDirectoryResult(value: unknown): value is HubUserDirectoryResult {
  try {
    if (value === null) return true;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const v = value as Record<string, unknown>;
    if (Object.keys(v).length !== 2 || !Object.hasOwn(v, 'users') || !Object.hasOwn(v, 'principal')
      || !v.principal || typeof v.principal !== 'object' || Array.isArray(v.principal)) return false;
    const p = v.principal as Record<string, unknown>;
    return Object.keys(p).length === 2 && Object.hasOwn(p, 'userId') && Object.hasOwn(p, 'admin')
      && typeof p.userId === 'string' && !!p.userId && !p.userId.includes('\0')
      && Buffer.byteLength(p.userId) <= 16_384 && typeof p.admin === 'boolean'
      && validUserRows(v.users, { owner: p.userId, admin: p.admin })
      && Buffer.byteLength(JSON.stringify(v)) <= HUB_USER_DIRECTORY_BYTES;
  } catch { return false; }
}
export function readHubUserDirectory(db: DatabaseSync, principal: HubPrincipal): NonNullable<HubUserDirectoryResult> {
  const result = { principal: { ...principal }, users: readUsers(db, { owner: principal.userId, admin: principal.admin }) };
  if (!validHubUserDirectoryResult(result)) throw new Error('hub_users_unavailable');
  return result;
}
