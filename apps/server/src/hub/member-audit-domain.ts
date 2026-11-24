import type { AuthAuditLog, AuthAuditRecord } from '../auth/security.js';
import { types } from 'node:util';

export type HubAuditAppend = Parameters<AuthAuditLog['append']>[0];
export type HubAuditPage = ReturnType<AuthAuditLog['page']>;
export type HubAuditOptions = NonNullable<Parameters<AuthAuditLog['page']>[0]>;
/** Optional undefined values are normal on the existing HTTP route. Copy
 * before the first await without observing getters/proxy traps or toJSON. */
export function copyHubAuditOptions(value: HubAuditOptions): HubAuditOptions {
  if (!value || typeof value !== 'object' || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error('hub_member_storage_unavailable');
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw Error('hub_member_storage_unavailable');
    const field = Object.getOwnPropertyDescriptor(value, key)!;
    if (!field.enumerable || !Object.hasOwn(field, 'value')) throw Error('hub_member_storage_unavailable');
    if (field.value !== undefined) copy[key] = field.value;
  }
  if (!validHubAuditOptions(copy)) throw Error('hub_member_storage_unavailable');
  return copy;
}
const events = ['user_access_changed', 'role_changed', 'access_key_login', 'access_key_logout', 'member_key_issued', 'member_key_revoked',
  'api_authz', 'passkey_bind', 'passkey_revoke', 'passkey_assertion'];
const fields = ['event', 'outcome', 'ts', 'keyIdentityHash', 'ipHash', 'userAgentHash', 'reason', 'failureCount',
  'retryAfterSeconds', 'passkeyCredentialHash', 'userId', 'keyId', 'actorUserId', 'authMethod'];
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const nonnegative = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
/** Parsed, descriptor-safe input only. These are trusted server-generated
 * audit facts, NOT principal evidence or an authorization callback. Raw keys,
 * session tokens, request objects and SQL never belong to a record. */
export function validHubAuditRecord(v: unknown, stored = false): v is AuthAuditRecord {
  if (!object(v) || !Object.keys(v).every(k => fields.includes(k) || stored && k === 'id')
    || !events.includes(v.event as string) || !['success', 'failure', 'throttled'].includes(v.outcome as string)) return false;
  if (stored && (typeof v.id !== 'string' || !/^[a-f0-9-]{36}$/.test(v.id) || !nonnegative(v.ts))) return false;
  if (v.ts !== undefined && !nonnegative(v.ts)) return false;
  for (const key of ['keyIdentityHash', 'ipHash', 'userAgentHash', 'passkeyCredentialHash'])
    if (v[key] !== undefined && (typeof v[key] !== 'string' || !/^[a-f0-9]{24}$/.test(v[key] as string))) return false;
  for (const key of ['failureCount', 'retryAfterSeconds']) if (v[key] !== undefined && !nonnegative(v[key])) return false;
  for (const key of ['userId', 'keyId', 'actorUserId'])
    if (v[key] !== undefined && (typeof v[key] !== 'string' || !v[key] || Buffer.byteLength(v[key] as string) > 4096
      || /[\x00-\x1f\x7f]/.test(v[key] as string))) return false;
  if (v.reason !== undefined && (typeof v.reason !== 'string' || Buffer.byteLength(v.reason) > (stored ? 64 : 8192))) return false;
  return v.authMethod === undefined || v.authMethod === 'member' || v.authMethod === 'administrator';
}
export function validHubAuditOptions(v: unknown): v is HubAuditOptions {
  return object(v) && Object.keys(v).every(k => ['limit', 'userId', 'before'].includes(k))
    && (v.limit === undefined || typeof v.limit === 'number' && Number.isFinite(v.limit))
    && (v.before === undefined || Number.isSafeInteger(v.before) && Number(v.before) > 0)
    && (v.userId === undefined || typeof v.userId === 'string' && Buffer.byteLength(v.userId) <= 4096
      && !/[\x00-\x1f\x7f]/.test(v.userId));
}
export function validHubAuditList(v: unknown): v is AuthAuditRecord[] {
  return Array.isArray(v) && v.length <= 10000 && v.every(row => validHubAuditRecord(row, true));
}
export function validHubAuditPage(v: unknown): v is HubAuditPage {
  return object(v) && Object.keys(v).every(k => ['records', 'nextCursor', 'retentionDays', 'maxRecords', 'persistent', 'startedAt'].includes(k))
    && validHubAuditList(v.records) && v.records.length <= 100 && v.retentionDays === 90
    && v.maxRecords === 10000 && v.persistent === true && nonnegative(v.startedAt)
    && (v.nextCursor === undefined || typeof v.nextCursor === 'string' && /^[1-9][0-9]*$/.test(v.nextCursor)
      && Number.isSafeInteger(Number(v.nextCursor)));
}
