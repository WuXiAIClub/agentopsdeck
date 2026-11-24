import { CommandConflict, type CommandReceipt } from '../commands/receipts.js';
import { isNodeId } from '../connector/node-identity.js';
import { MaintenanceAuthorityUnavailable, validMaintenancePayload, type MaintenanceEffect } from './maintenance-command-facts.js';
import type { MaintenanceTarget } from './maintenance-commands.js';
import { validOwnerControlReceipt } from './member-owner-control-domain.js';
import type { HubStore } from './hub-store.js';
import type { HubPrincipal } from './identity.js';

export const HUB_MAINTENANCE_BYTES = 128 * 1024;
export type HubMaintenanceTarget = Pick<MaintenanceTarget, 'connectionId' | 'operation'>;
export type HubMaintenanceCommand = { target: HubMaintenanceTarget } & (
  { action: 'prepare' } | { action: 'get'; key: string }
  | { action: 'claim'; key: string; payload: Record<string, unknown>; pin: string | null }
  | { action: 'effect'; key: string; write: boolean }
  | { action: 'effectCheck'; key: string; write: boolean; digest: string }
  | { action: 'observe'; key: string; upstream: CommandReceipt }
);
type Reply = { target: HubMaintenanceTarget } & (
  { action: 'prepare'; pin: string | null }
  | { action: 'get'; key: string; receipt: CommandReceipt | null }
  | { action: 'claim'; key: string; receipt: CommandReceipt; fresh: boolean }
  | { action: 'effect'; key: string; effect: MaintenanceEffect }
  | { action: 'effectCheck'; key: string; digest: string }
  | { action: 'observe'; key: string; receipt: CommandReceipt }
);
export type HubMaintenanceResult = null | { error: 403 | 404 | 409 | 503 } | Reply;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const key = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
const identifier = (v: unknown): v is string => typeof v === 'string' && !!v && !v.includes('\0') && Buffer.byteLength(v) <= 512;
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const fields = (v: Record<string, unknown>, expected: string[]) => Object.keys(v).length === expected.length && Object.keys(v).every(k => expected.includes(k));
export function validHubMaintenanceTarget(v: unknown): v is HubMaintenanceTarget {
  return object(v) && fields(v, ['connectionId','operation']) && identifier(v.connectionId) && ['apply','rollback','pause','resume'].includes(String(v.operation));
}
export function validMaintenanceEffect(v: unknown): v is MaintenanceEffect {
  if (!object(v) || !fields(v, ['kind','nodeId','origin','delivery','digest', ...(v.credential === undefined ? [] : ['credential'])])
    || !isNodeId(v.nodeId) || !key(v.delivery) || !digest(v.digest) || typeof v.origin !== 'string'
    || Buffer.byteLength(v.origin) > 8192 || /[\x00-\x20\x7f]/.test(v.origin)) return false;
  if (v.kind === 'local') return v.credential === undefined;
  if (v.kind !== 'remote' || typeof v.credential !== 'string' || !v.credential || Buffer.byteLength(v.credential) > 8192 || /[\r\n]/.test(v.credential)) return false;
  try { const url = new URL(v.origin); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
}
export function validHubMaintenanceCommand(v: unknown): v is HubMaintenanceCommand {
  if (!object(v) || !validHubMaintenanceTarget(v.target)) return false;
  const common = ['action','target'];
  if (v.action === 'prepare') return fields(v, common);
  if (!key(v.key)) return false;
  if (v.action === 'get') return fields(v, [...common,'key']);
  if (v.action === 'claim') return fields(v, [...common,'key','payload','pin']) && (v.pin === null || digest(v.pin)) && validMaintenancePayload(v.target.operation, v.payload);
  if (v.action === 'effect') return fields(v, [...common,'key','write']) && typeof v.write === 'boolean';
  if (v.action === 'effectCheck') return fields(v, [...common,'key','write','digest']) && typeof v.write === 'boolean' && digest(v.digest);
  return v.action === 'observe' && fields(v, [...common,'key','upstream']) && validOwnerControlReceipt(v.upstream);
}
export function validHubMaintenanceResult(v: unknown): v is HubMaintenanceResult {
  if (v === null) return true;
  if (!object(v)) return false;
  if (fields(v, ['error'])) return [403,404,409,503].includes(v.error as number);
  if (!validHubMaintenanceTarget(v.target)) return false;
  const common = ['action','target'];
  if (v.action === 'prepare') return fields(v, [...common,'pin']) && (v.pin === null || digest(v.pin));
  if (!key(v.key)) return false;
  if (v.action === 'effect') return fields(v, [...common,'key','effect']) && validMaintenanceEffect(v.effect);
  if (v.action === 'effectCheck') return fields(v, [...common,'key','digest']) && digest(v.digest);
  if (v.action === 'get' && v.receipt === null) return fields(v, [...common,'key','receipt']);
  return (v.action === 'get' || v.action === 'observe' ? fields(v, [...common,'key','receipt'])
    : v.action === 'claim' && fields(v, [...common,'key','receipt','fresh']) && typeof v.fresh === 'boolean')
    && validOwnerControlReceipt(v.receipt) && v.receipt.key === v.key;
}
export function validHubMaintenanceReply(c: HubMaintenanceCommand, v: unknown): v is HubMaintenanceResult {
  return validHubMaintenanceResult(v) && (v === null || 'error' in v || v.action === c.action
    && v.target.connectionId === c.target.connectionId && v.target.operation === c.target.operation
    && (!('key' in v) || 'key' in c && v.key === c.key) && (!('digest' in v) || 'digest' in c && v.digest === c.digest));
}
export function executeHubMaintenanceCommand(owner: HubStore, actor: HubPrincipal,
  c: Exclude<HubMaintenanceCommand, { action: 'claim' }>): Exclude<HubMaintenanceResult, null> {
  const facts = owner.maintenanceCommands.facts, target = { ...c.target, userId: actor.userId, ownerUserId: actor.userId };
  try {
    if (c.action === 'prepare') return { action: c.action, target: c.target, pin: facts.prepare(target) };
    if (c.action === 'get') return { action: c.action, target: c.target, key: c.key, receipt: facts.get(target, c.key) ?? null };
    if (c.action === 'effect') return { action: c.action, target: c.target, key: c.key, effect: facts.effect(target, c.key, c.write) };
    if (c.action === 'effectCheck') {
      if (facts.effect(target, c.key, c.write).digest !== c.digest) return { error: 403 };
      return { action: c.action, target: c.target, key: c.key, digest: c.digest };
    }
    return { action: c.action, target: c.target, key: c.key, receipt: facts.observed(target, c.key, c.upstream) };
  } catch (error) {
    if (error instanceof MaintenanceAuthorityUnavailable) return { error: error.status };
    if (error instanceof CommandConflict) return { error: 409 };
    throw error;
  }
}
export async function claimHubMaintenanceCommand(owner: HubStore, request: Request, expectedScope: string,
  c: Extract<HubMaintenanceCommand, { action: 'claim' }>): Promise<HubMaintenanceResult> {
  let actor: HubPrincipal | undefined;
  const check = () => {
    const result = owner.identities.memberMaintenanceCommand(request, expectedScope, owner, { action: 'prepare', target: c.target });
    const current = owner.identities.commandPrincipal(request);
    if (!result || 'error' in result || !current || actor && actor.userId !== current.userId) throw new MaintenanceAuthorityUnavailable();
    actor = current;
  };
  try {
    check();
    const claimed = await owner.maintenanceCommands.facts.claim({ ...c.target, userId: actor!.userId, ownerUserId: actor!.userId }, c.key, c.payload, c.pin, check);
    return { action: c.action, target: c.target, key: c.key, ...claimed };
  } catch (error) {
    if (error instanceof MaintenanceAuthorityUnavailable) return { error: error.status };
    if (error instanceof CommandConflict) return { error: 409 };
    throw error;
  }
}
