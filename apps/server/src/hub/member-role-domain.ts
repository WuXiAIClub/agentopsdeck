import type { HubStore } from './hub-store.js';
import type { HubPrincipal } from './identity.js';

/** Fixed original Hub role domain. Target IDs are not authority. All grant
 * invalidation and audit effects stay in RoleAccess's original savepoint. */
export type HubRoleCommand = { action: 'read'; userId: string }
  | { action: 'set'; userId: string; role: 'member' | 'admin'; version: number };
export type HubRoleResult = { userId: string; role: 'member' | 'admin'; version: number }
  | { error: 'missing' | 'self' | 'changed' } | null;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length
  && Object.keys(v).every(k => names.includes(k));
const target = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= 16_384;
const version = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
export function validHubRoleCommand(v: unknown): v is HubRoleCommand {
  if (!object(v) || !target(v.userId)) return false;
  return v.action === 'read' && fields(v, ['action', 'userId'])
    || v.action === 'set' && fields(v, ['action', 'userId', 'role', 'version'])
      && (v.role === 'admin' || v.role === 'member') && version(v.version) && v.version < Number.MAX_SAFE_INTEGER;
}
export function validHubRoleResult(v: unknown): v is HubRoleResult {
  if (v === null) return true;
  if (!object(v)) return false;
  return fields(v, ['error']) && ['missing', 'self', 'changed'].includes(v.error as string)
    || fields(v, ['userId', 'role', 'version']) && target(v.userId)
      && (v.role === 'member' || v.role === 'admin') && version(v.version);
}
/** Minimal correlation data only: no credentials, labels or callback survive
 * in pending waiters. A mismatched ACK is unknown, never a licence to replay. */
export type HubRoleReplyExpectation = { action: 'read'; userId: string }
  | { action: 'set'; userId: string; role: 'member' | 'admin'; version: number };
export function hubRoleReplyExpectation(command: HubRoleCommand): HubRoleReplyExpectation {
  return { ...command };
}
export function validHubRoleReply(expected: HubRoleReplyExpectation, value: unknown): value is HubRoleResult {
  if (!validHubRoleResult(value)) return false;
  if (value === null) return true;
  if ('error' in value) return value.error === 'missing' || expected.action === 'set';
  return value.userId === expected.userId && (expected.action === 'read'
    || value.role === expected.role && value.version === expected.version + 1);
}
/** Called only after fresh credential/admin/scope checks, inside the complete
 * owner's original identity savepoint. Do not catch SQL/commit faults here. */
export function executeHubRoleCommand(owner: HubStore, actor: HubPrincipal, command: HubRoleCommand): Exclude<HubRoleResult, null> {
  if (!validHubRoleCommand(command) || !actor.admin) throw new Error('hub_role_unavailable');
  if (!owner.getUser(command.userId)) return { error: 'missing' };
  if (command.action === 'read') return { userId: command.userId, ...owner.roles.hubRole(command.userId) };
  if (actor.userId === command.userId) return { error: 'self' };
  if (owner.roles.hubRole(command.userId).version !== command.version) return { error: 'changed' };
  return { userId: command.userId, ...owner.roles.setHubRole(actor, command.userId, command.role, command.version) };
}
