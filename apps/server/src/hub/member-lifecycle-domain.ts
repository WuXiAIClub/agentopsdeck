import type { ConnectorLifecycleReceipt } from '@agentopsdeck/shared';
import { CommandConflict, type CommandReceipt } from '../commands/receipts.js';
import { isNodeId } from '../connector/node-identity.js';
import { validMaintenanceJob, type MaintenanceJob } from '../lifecycle/connector-maintenance.js';
import { lifecycleOrigin } from './lifecycle-client.js';
import { LifecycleAuthorityUnavailable, type LifecycleEffect, type LifecycleTarget } from './lifecycle-command-facts.js';
import { validOwnerControlReceipt } from './member-owner-control-domain.js';
import type { HubStore } from './hub-store.js';
import type { HubPrincipal } from './identity.js';

export const HUB_LIFECYCLE_BYTES = 128 * 1024;
export type HubLifecycleTarget = Pick<LifecycleTarget, 'connectionId' | 'operation'>;
export type HubLifecycleCommand = { target: HubLifecycleTarget } & (
  { action: 'prepare' } | { action: 'status' }
  | { action: 'statusCheck'; digest: string }
  | { action: 'claim'; key: string; pin: string | null }
  | { action: 'get'; key: string }
  | { action: 'effect'; key: string; write: boolean }
  | { action: 'effectCheck'; key: string; write: boolean; digest: string }
  | { action: 'observe'; key: string; job: MaintenanceJob }
);
type Reply = { target: HubLifecycleTarget } & (
  { action: 'prepare'; pin: string | null }
  | { action: 'status' | 'effect'; effect: LifecycleEffect | null; key?: string }
  | { action: 'statusCheck' | 'effectCheck'; digest: string }
  | { action: 'claim'; key: string; fresh: boolean; receipt: CommandReceipt }
  | { action: 'get'; key: string; receipt: CommandReceipt | null }
  | { action: 'observe'; key: string; observation: ConnectorLifecycleReceipt }
);
export type HubLifecycleResult = null | { error: 403 | 409 | 503 } | Reply;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const key = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const fields = (v: Record<string, unknown>, expected: string[]) => Object.keys(v).length === expected.length && Object.keys(v).every(k => expected.includes(k));
export function validHubLifecycleTarget(v: unknown): v is HubLifecycleTarget {
  return object(v) && fields(v, ['connectionId','operation']) && key(v.connectionId) && ['restart','upgrade'].includes(String(v.operation));
}
export function validLifecycleEffect(v: unknown): v is LifecycleEffect {
  if (!object(v) || !fields(v, ['nodeId','origin','credential','digest', ...(v.delivery === undefined ? [] : ['delivery'])])
    || !isNodeId(v.nodeId) || typeof v.origin !== 'string' || typeof v.credential !== 'string' || !v.credential
    || v.credential.length > 8192 || /[\r\n]/.test(v.credential) || !digest(v.digest) || v.delivery !== undefined && !key(v.delivery)) return false;
  try { return lifecycleOrigin(v.origin) === v.origin; } catch { return false; }
}
export function validHubLifecycleCommand(v: unknown): v is HubLifecycleCommand {
  if (!object(v) || !validHubLifecycleTarget(v.target)) return false;
  const common = ['action','target'];
  if (v.action === 'prepare' || v.action === 'status') return fields(v, common);
  if (v.action === 'statusCheck') return fields(v, [...common,'digest']) && digest(v.digest);
  if (!key(v.key)) return false;
  if (v.action === 'get') return fields(v, [...common,'key']);
  if (v.action === 'claim') return fields(v, [...common,'key','pin']) && (v.pin === null || digest(v.pin));
  if (v.action === 'effect') return fields(v, [...common,'key','write']) && typeof v.write === 'boolean';
  if (v.action === 'effectCheck') return fields(v, [...common,'key','write','digest']) && typeof v.write === 'boolean' && digest(v.digest);
  return v.action === 'observe' && fields(v, [...common,'key','job']) && validMaintenanceJob(v.job)
    && v.job.operation === v.target.operation && v.job.stage !== 'recover';
}
function validObservation(v: unknown): v is ConnectorLifecycleReceipt {
  if (!object(v) || !fields(v, ['command','job','observationUnavailable']) || v.observationUnavailable !== false
    || !validOwnerControlReceipt(v.command) || !object(v.job)) return false;
  const j = v.job;
  return fields(j, ['id','nodeId','operation','stage','createdAt','deadline','revision', ...(j.reason === undefined ? [] : ['reason'])])
    && isNodeId(j.nodeId) && j.operation !== 'recover' && j.stage !== 'recover'
    && validMaintenanceJob({ ...j, version: 1, actorId: 'public-projection' })
    && v.command.state === 'accepted' && v.command.result?.status === 202
    && JSON.stringify(v.command.result.body) === JSON.stringify({ lifecycle: j });
}
export function validHubLifecycleResult(v: unknown): v is HubLifecycleResult {
  if (v === null) return true;
  if (!object(v)) return false;
  if (fields(v, ['error'])) return [403,409,503].includes(v.error as number);
  if (!validHubLifecycleTarget(v.target)) return false;
  const common = ['action','target'];
  if (v.action === 'prepare') return fields(v, [...common,'pin']) && (v.pin === null || digest(v.pin));
  if (v.action === 'status' || v.action === 'effect') return fields(v, [...common,'effect', ...(v.action === 'effect' ? ['key'] : [])])
    && (v.action !== 'effect' || key(v.key)) && (v.effect === null ? v.action === 'status'
      : validLifecycleEffect(v.effect) && (v.action === 'effect' ? v.effect.delivery !== undefined : v.effect.delivery === undefined));
  if (v.action === 'statusCheck' || v.action === 'effectCheck') return fields(v, [...common,'digest']) && digest(v.digest);
  if (!key(v.key)) return false;
  if (v.action === 'get') return fields(v, [...common,'key','receipt']) && (v.receipt === null || validOwnerControlReceipt(v.receipt) && v.receipt.key === v.key);
  if (v.action === 'claim') return fields(v, [...common,'key','fresh','receipt']) && typeof v.fresh === 'boolean'
    && validOwnerControlReceipt(v.receipt) && v.receipt.key === v.key;
  return v.action === 'observe' && fields(v, [...common,'key','observation']) && validObservation(v.observation)
    && v.observation.command.key === v.key && v.observation.job?.operation === v.target.operation;
}
export function validHubLifecycleReply(c: HubLifecycleCommand, v: unknown): v is HubLifecycleResult {
  if (!validHubLifecycleResult(v)) return false;
  return v === null || 'error' in v || v.action === c.action && v.target.connectionId === c.target.connectionId
    && v.target.operation === c.target.operation && (!('key' in v) || 'key' in c && v.key === c.key)
    && (!('digest' in v) || 'digest' in c && v.digest === c.digest);
}
export function executeHubLifecycleCommand(owner: HubStore, actor: HubPrincipal,
  c: Exclude<HubLifecycleCommand, { action: 'claim' }>): Exclude<HubLifecycleResult, null> {
  const facts = owner.lifecycleCommands.facts, target = { ...c.target, userId: actor.userId };
  try {
    if (c.action === 'prepare') return { action: c.action, target: c.target, pin: facts.prepare(target) };
    if (c.action === 'status') return { action: c.action, target: c.target, effect: facts.status(actor.userId, target.connectionId) };
    if (c.action === 'statusCheck' || c.action === 'effectCheck') {
      const effect = c.action === 'statusCheck' ? facts.status(actor.userId, target.connectionId) : facts.effect(target, c.key, c.write);
      if (effect?.digest !== c.digest) return { error: 403 };
      return { action: c.action, target: c.target, digest: c.digest };
    }
    if (c.action === 'get') return { action: c.action, target: c.target, key: c.key, receipt: facts.get(target, c.key) ?? null };
    if (c.action === 'effect') return { action: c.action, target: c.target, key: c.key, effect: facts.effect(target, c.key, c.write) };
    return { action: c.action, target: c.target, key: c.key, observation: facts.observed(target, c.key, c.job) };
  } catch (error) {
    if (error instanceof LifecycleAuthorityUnavailable) return { error: 503 };
    if (error instanceof CommandConflict) return { error: 409 };
    throw error;
  }
}
export async function claimHubLifecycleCommand(owner: HubStore, request: Request, expectedScope: string,
  c: Extract<HubLifecycleCommand, { action: 'claim' }>): Promise<HubLifecycleResult> {
  let actor: HubPrincipal | undefined;
  const check = () => {
    const result = owner.identities.memberLifecycleCommand(request, expectedScope, owner, { action: 'prepare', target: c.target });
    if (!result) throw new LifecycleAuthorityUnavailable();
    if ('error' in result) throw new LifecycleAuthorityUnavailable();
    const current = owner.identities.commandPrincipal(request);
    if (!current) throw new LifecycleAuthorityUnavailable();
    if (actor && actor.userId !== current.userId) throw new LifecycleAuthorityUnavailable();
    actor = current;
  };
  try {
    check();
    const claimed = await owner.lifecycleCommands.facts.claim({ ...c.target, userId: actor!.userId }, c.key, c.pin, check);
    return { action: c.action, target: c.target, key: c.key, ...claimed };
  } catch (error) {
    if (error instanceof LifecycleAuthorityUnavailable) return { error: 503 };
    if (error instanceof CommandConflict) return { error: 409 };
    throw error;
  }
}
