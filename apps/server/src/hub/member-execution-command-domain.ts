import type { QueuedCommandPage, SharedQueuedCommandPage } from '@agentopsdeck/shared';
import { sessionRuntimeId } from '@agentopsdeck/shared';
import { CommandConflict, type CommandReceipt } from '../commands/receipts.js';
import { HubExecutionCommandFacts } from './execution-command-facts.js';
import type { ExecutionCommandTarget } from './execution-commands.js';
import type { ExecutionLease } from './execution-leases.js';
import type { HubStore } from './hub-store.js';
import type { HubPrincipal } from './identity.js';
import type { NodeAction, NodeGrantProof } from './node-grants.js';
import { validHubNodeGrantProof } from './member-connector-access-domain.js';
import { validHubExecutionLeaseResult } from './member-execution-lease-domain.js';
import { validOwnerControlReceipt } from './member-owner-control-domain.js';
import { decodeHubSessionId, encodeHubSessionId } from './session-id.js';
import { sessionRef } from './session-ref.js';
import { isNodeId } from '../connector/node-identity.js';
import { executeHubExecutionEffect, executionEffectBinding, validHubExecutionEffectCommand, validHubExecutionEffectResult,
  type HubExecutionEffectCommand, type HubExecutionEffectResult } from './member-execution-effect-domain.js';

type Target = Pick<ExecutionCommandTarget, 'ownerUserId' | 'sessionId'>;
type WriteAction = 'messages:send' | 'messages:mirror' | 'queue:manage';
type Read = { target: Target; read: NodeGrantProof };
type Write = { send: NodeGrantProof; mirror?: NodeGrantProof };
export type HubExecutionCommand = { action: 'open'; target: Target }
  | Read & (HubExecutionEffectCommand | { action: 'check' }
    | { action: 'permission'; permission: WriteAction; proof?: NodeGrantProof }
    | { action: 'lookup'; key: string; digest?: string }
    | { action: 'claim'; key: string; digest: string; leaseId: number; write: Write }
    | { action: 'historical'; key: string; nodeId?: string }
    | { action: 'settle'; key: string; receipt: CommandReceipt | null; notDispatched: boolean }
    | { action: 'queueObserve'; commandKey: string; key: string; nodeId: string }
    | { action: 'queueClaim'; commandKey: string; key: string; nodeId: string; digest: string; patch: boolean; write?: NodeGrantProof; send?: NodeGrantProof }
    | { action: 'queueSettle'; commandKey: string; key: string; nodeId: string; receipt: CommandReceipt | null }
    | { action: 'pageSelect'; nodeId: string; cursor?: string }
    | { action: 'pageProject'; nodeId: string; leaseId: number; page: QueuedCommandPage }
    | { action: 'issuer'; write: Write });
type Binding = { lease: ExecutionLease; deliveryKey: string };
export type HubExecutionCommandResult = null | { error: 401 | 403 | 404 | 409 } | HubExecutionEffectResult
  | { action: 'open'; target: ExecutionCommandTarget; read: NodeGrantProof; nodeId: string }
  | { action: 'check'; ok: true }
  | { action: 'permission'; proof: NodeGrantProof }
  | { action: 'lookup'; receipt: CommandReceipt | null; authorityId: number | null }
  | { action: 'claim' | 'queueClaim'; fresh: boolean; receipt: CommandReceipt }
  | { action: 'historical'; binding: Binding }
  | { action: 'settle' | 'queueSettle'; receipt: CommandReceipt }
  | { action: 'queueObserve'; observation: null | Binding & { receipt: CommandReceipt; mutationDeliveryKey: string } }
  | { action: 'pageSelect'; lease: ExecutionLease | null; after: string; nextActorCursor: string | null }
  | { action: 'pageProject'; items: SharedQueuedCommandPage['items'] }
  | { action: 'issuer'; nodeId: string; issuerId: string };
export const HUB_EXECUTION_COMMAND_BYTES = 128 * 1024;
export const HUB_EXECUTION_COMMAND_RESULT_BYTES = 128 * 1024;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= 4096 && !/[\x00-\x1f\x7f]/.test(v);
const key = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const cursor = (v: unknown): v is string => typeof v === 'string' && /^[1-9]\d{0,15}:(0|[1-9]\d{0,15})$/.test(v)
  && v.split(':').every(x => Number.isSafeInteger(Number(x)));
const sequence = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9]\d{0,15})$/.test(v) && Number.isSafeInteger(Number(v));
const lease = (v: unknown): v is ExecutionLease => v !== null && validHubExecutionLeaseResult({ action: 'get', lease: v });
const writes = (v: unknown): v is Write => object(v) && fields(v, ['send'], ['mirror']) && validHubNodeGrantProof(v.send)
  && v.send.action === 'messages:send' && (v.mirror === undefined || validHubNodeGrantProof(v.mirror) && v.mirror.action === 'messages:mirror');
function target(v: unknown): v is Target {
  if (!object(v) || !fields(v, ['ownerUserId','sessionId']) || !text(v.ownerUserId) || !text(v.sessionId)) return false;
  const decoded = decodeHubSessionId(v.sessionId);
  return !!decoded && encodeHubSessionId(decoded.connectionId, decoded.remoteSessionKey) === v.sessionId;
}
function queueItems(v: unknown, projected = false): boolean {
  if (!Array.isArray(v) || v.length > 64) return false;
  let previous = 0;
  const seen = new Set<string>();
  return v.every(item => {
    if (!object(item) || !fields(item, ['commandKey','state','createdAt','version', ...(projected ? ['commandState'] : [])])
      || !(item.commandKey === null || key(item.commandKey)) || !['queued','dispatching','outcome_unknown','blocked'].includes(String(item.state))
      || !Number.isSafeInteger(item.createdAt) || Number(item.createdAt) < 0 || !cursor(item.version) || item.version.endsWith(':0')
      || projected && (!(item.commandState === null || ['outcome_unknown','accepted','rejected'].includes(String(item.commandState)))
        || (item.commandKey === null) !== (item.commandState === null))) return false;
    const n = Number(item.version.split(':')[0]);
    if (n <= previous || item.commandKey !== null && seen.has(item.commandKey)) return false;
    previous = n;
    if (item.commandKey !== null) seen.add(item.commandKey);
    return true;
  });
}
export function validHubExecutionCommand(v: unknown): v is HubExecutionCommand {
  if (!object(v) || !target(v.target)) return false;
  if (v.action === 'open') return fields(v, ['action','target']);
  if (!validHubNodeGrantProof(v.read) || v.read.action !== 'messages:read') return false;
  const base = ['action','target','read'];
  if (v.action === 'effectOpen' || v.action === 'effectCheck') return fields(v, [...base,'effect', ...(v.action === 'effectCheck' ? ['fingerprint'] : [])])
    && validHubExecutionEffectCommand(v);
  if (v.action === 'check') return fields(v, base);
  if (v.action === 'permission') return fields(v, [...base,'permission'], ['proof']) && ['messages:send','messages:mirror','queue:manage'].includes(String(v.permission))
    && (v.proof === undefined || validHubNodeGrantProof(v.proof) && v.proof.action === v.permission);
  if (v.action === 'lookup') return fields(v, [...base,'key'], ['digest']) && key(v.key) && (v.digest === undefined || hash(v.digest));
  if (v.action === 'claim') return fields(v, [...base,'key','digest','leaseId','write']) && key(v.key) && hash(v.digest) && positive(v.leaseId) && writes(v.write);
  if (v.action === 'historical') return fields(v, [...base,'key'], ['nodeId']) && key(v.key) && (v.nodeId === undefined || isNodeId(v.nodeId));
  if (v.action === 'settle') return fields(v, [...base,'key','receipt','notDispatched']) && key(v.key)
    && (v.receipt === null || validOwnerControlReceipt(v.receipt)) && typeof v.notDispatched === 'boolean' && (!v.notDispatched || v.receipt === null);
  if (v.action === 'issuer') return fields(v, [...base,'write']) && writes(v.write);
  if (!isNodeId(v.nodeId)) return false;
  if (v.action === 'queueObserve') return fields(v, [...base,'commandKey','key','nodeId']) && key(v.key) && key(v.commandKey);
  if (v.action === 'queueClaim') return fields(v, [...base,'commandKey','key','nodeId','digest','patch'], ['write','send']) && key(v.key) && key(v.commandKey)
    && hash(v.digest) && typeof v.patch === 'boolean' && (v.write === undefined || validHubNodeGrantProof(v.write) && v.write.action === 'queue:manage')
    && (v.send === undefined || v.patch === true && validHubNodeGrantProof(v.send) && v.send.action === 'messages:send');
  if (v.action === 'queueSettle') return fields(v, [...base,'commandKey','key','nodeId','receipt']) && key(v.key) && key(v.commandKey)
    && (v.receipt === null || validOwnerControlReceipt(v.receipt));
  if (v.action === 'pageSelect') return fields(v, [...base,'nodeId'], ['cursor']) && (v.cursor === undefined || cursor(v.cursor));
  return v.action === 'pageProject' && fields(v, [...base,'nodeId','leaseId','page']) && positive(v.leaseId) && object(v.page)
    && fields(v.page, ['items','nextCursor']) && queueItems(v.page.items)
    && (v.page.nextCursor === null || v.page.items instanceof Array && v.page.items.length === 64 && sequence(v.page.nextCursor)
      && v.page.nextCursor === String((v.page.items.at(-1) as { version: string }).version.split(':')[0]));
}
const binding = (v: unknown): v is Binding => object(v) && fields(v, ['lease','deliveryKey']) && lease(v.lease) && key(v.deliveryKey);
export function validHubExecutionCommandResult(v: unknown): v is HubExecutionCommandResult {
  if (v === null) return true;
  if (!object(v)) return false;
  if (fields(v, ['error'])) return typeof v.error === 'number' && [401,403,404,409].includes(v.error);
  if (v.action === 'effectOpen' || v.action === 'effectCheck') return validHubExecutionEffectResult(v);
  if (v.action === 'open') return fields(v, ['action','target','read','nodeId']) && object(v.target) && text(v.target.userId)
    && fields(v.target, ['userId','ownerUserId','sessionId']) && target({ ownerUserId: v.target.ownerUserId, sessionId: v.target.sessionId })
    && validHubNodeGrantProof(v.read) && v.read.action === 'messages:read' && isNodeId(v.nodeId);
  if (v.action === 'check') return fields(v, ['action','ok']) && v.ok === true;
  if (v.action === 'permission') return fields(v, ['action','proof']) && validHubNodeGrantProof(v.proof);
  if (v.action === 'lookup') return fields(v, ['action','receipt','authorityId']) && (v.receipt === null || validOwnerControlReceipt(v.receipt))
    && (v.authorityId === null || v.receipt !== null && positive(v.authorityId));
  if (v.action === 'claim' || v.action === 'queueClaim') return fields(v, ['action','fresh','receipt']) && typeof v.fresh === 'boolean' && validOwnerControlReceipt(v.receipt);
  if (v.action === 'historical') return fields(v, ['action','binding']) && binding(v.binding);
  if (v.action === 'settle' || v.action === 'queueSettle') return fields(v, ['action','receipt']) && validOwnerControlReceipt(v.receipt);
  if (v.action === 'queueObserve') return fields(v, ['action','observation']) && (v.observation === null || object(v.observation)
    && fields(v.observation, ['lease','deliveryKey','receipt','mutationDeliveryKey']) && lease(v.observation.lease)
    && key(v.observation.deliveryKey) && key(v.observation.mutationDeliveryKey) && validOwnerControlReceipt(v.observation.receipt));
  if (v.action === 'pageSelect') return fields(v, ['action','lease','after','nextActorCursor']) && (v.lease === null || lease(v.lease))
    && sequence(v.after) && (v.nextActorCursor === null || cursor(v.nextActorCursor));
  if (v.action === 'pageProject') return fields(v, ['action','items']) && queueItems(v.items, true);
  return v.action === 'issuer' && fields(v, ['action','nodeId','issuerId']) && isNodeId(v.nodeId)
    && typeof v.issuerId === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(v.issuerId);
}
function sameTarget(p: NodeGrantProof, t: ExecutionCommandTarget): boolean {
  const d = decodeHubSessionId(t.sessionId)!;
  return p.userId === t.userId && p.ownerUserId === t.ownerUserId && p.connectionId === d.connectionId
    && p.resource.sessionKey === d.remoteSessionKey && p.resource.runtime === sessionRuntimeId(d.remoteSessionKey);
}
export function validHubExecutionCommandReply(c: HubExecutionCommand, v: unknown): v is HubExecutionCommandResult {
  if (!validHubExecutionCommandResult(v)) return false;
  if (v === null || 'error' in v) return true;
  if (v.action !== c.action) return false;
  if (c.action === 'open') return v.action === 'open' && v.target.ownerUserId === c.target.ownerUserId && v.target.sessionId === c.target.sessionId && sameTarget(v.read, v.target);
  const t = { ...c.target, userId: c.read.userId };
  if (v.action === 'effectOpen' || v.action === 'effectCheck') return (c.action === 'effectOpen' || c.action === 'effectCheck')
    && v.binding === executionEffectBinding(c.target, c.read, c.effect) && sameTarget(v.lease.proof, t)
    && (c.action !== 'effectCheck' || v.fingerprint === c.fingerprint);
  if ('receipt' in v && v.receipt !== null && 'key' in c && v.receipt.key !== c.key) return false;
  if (v.action === 'permission') return c.action === 'permission' && v.proof.action === c.permission && sameTarget(v.proof, t)
    && (c.proof === undefined || JSON.stringify(v.proof) === JSON.stringify(c.proof));
  const selected = v.action === 'historical' ? v.binding.lease : v.action === 'queueObserve' ? v.observation?.lease : v.action === 'pageSelect' ? v.lease : undefined;
  if (selected && (!sameTarget(selected.proof, t) || 'nodeId' in c && selected.nodeId !== c.nodeId)) return false;
  if (v.action === 'queueObserve' && v.observation && c.action === 'queueObserve' && v.observation.receipt.key !== c.key) return false;
  if (v.action === 'pageProject') return c.action === 'pageProject' && v.items.length === c.page.items.length
    && v.items.every((item, i) => item.state === c.page.items[i]!.state && item.createdAt === c.page.items[i]!.createdAt && item.version === c.page.items[i]!.version
      && (c.page.items[i]!.commandKey !== null || item.commandKey === null));
  return true;
}
class ExecutionCommandDenied extends Error { constructor(readonly status: 403 | 404 | 409) { super('Shared execution unavailable'); } }

/** Runs in the ORIGINAL identity savepoint, never across an await. */
export function executionCommandAccess(owner: HubStore, actor: HubPrincipal, c: HubExecutionCommand) {
  const t = { ...c.target, userId: actor.userId }, decoded = decodeHubSessionId(t.sessionId)!;
  owner.roles.syncAdministrator(actor);
  const connection = owner.getConnection(decoded.connectionId, t.ownerUserId);
  let ref;
  try { ref = sessionRef(connection?.nodeId, decoded.remoteSessionKey); } catch { /* Not a verified node. */ }
  if (!connection || connection.status === 'disabled' || !ref) throw new ExecutionCommandDenied(404);
  const policy = { userId: actor.userId, ownerUserId: t.ownerUserId, connectionId: connection.id, administrator: actor.admin };
  const resource = { runtime: ref.runtimeId, sessionKey: decoded.remoteSessionKey };
  const validate = (p: NodeGrantProof | undefined, action: NodeAction) => {
    if (!p || p.action !== action || !sameTarget(p, t) || !!p.administrator && !actor.admin
      || p.resource.runtime !== resource.runtime || !owner.grants.revalidate(p)) throw new ExecutionCommandDenied(403);
    return p;
  };
  const read = c.action === 'open' ? owner.grants.authorize(policy, 'messages:read', resource) : validate(c.read, 'messages:read');
  if (!read) throw new ExecutionCommandDenied(404);
  return { t, nodeId: ref.nodeId, read, validate, permission: (action: WriteAction, proof?: NodeGrantProof) =>
    validate(proof ?? owner.grants.authorize(policy, action, resource), action) };
}
export function executeHubExecutionCommand(owner: HubStore, actor: HubPrincipal,
  c: Exclude<HubExecutionCommand, { action: 'claim' | 'queueClaim' }>): Exclude<HubExecutionCommandResult, null> {
  try {
    const access = executionCommandAccess(owner, actor, c), { t, nodeId } = access;
    const facts = new HubExecutionCommandFacts(owner.commands, owner.executionLeases);
    if (c.action === 'open') return { action: c.action, target: t, nodeId, read: access.read };
    if (c.action === 'check') return { action: c.action, ok: true };
    if (c.action === 'effectOpen' || c.action === 'effectCheck') return executeHubExecutionEffect(owner, access, c.read, c);
    if (c.action === 'permission') return { action: c.action, proof: access.permission(c.permission, c.proof) };
    if ('nodeId' in c && c.nodeId !== nodeId) throw new ExecutionCommandDenied(409);
    if (c.action === 'lookup') {
      facts.lookup(t, c.key, c.digest);
      const o = facts.observation(t, c.key);
      return { action: c.action, receipt: o.receipt ?? null, authorityId: o.authorityId ?? null };
    }
    if (c.action === 'historical') return { action: c.action, binding: facts.historical(t, c.key, c.nodeId) };
    if (c.action === 'settle') {
      if (!facts.lookup(t, c.key)) throw new ExecutionCommandDenied(404);
      return { action: c.action, receipt: facts.settle(t, c.key, c.receipt ?? undefined, c.notDispatched) };
    }
    if (c.action === 'queueObserve') return { action: c.action, observation: facts.queueObservation(t, c.commandKey, c.key, c.nodeId) ?? null };
    if (c.action === 'queueSettle') {
      if (!facts.queueObservation(t, c.commandKey, c.key, c.nodeId)) throw new ExecutionCommandDenied(404);
      return { action: c.action, receipt: facts.settleQueue(t, c.commandKey, c.key, c.receipt ?? undefined) };
    }
    if (c.action === 'pageSelect') { const page = facts.selectPage(t, c.nodeId, c.cursor); return { action: c.action, ...page, lease: page.lease ?? null }; }
    if (c.action === 'pageProject') return { action: c.action, items: facts.projectPage(t, c.nodeId, c.leaseId, c.page) };
    access.validate(c.write.send, 'messages:send');
    if (c.write.mirror) access.validate(c.write.mirror, 'messages:mirror');
    const issuer = owner.executionIssuers.current(t.ownerUserId, decodeHubSessionId(t.sessionId)!.connectionId);
    if (!issuer || issuer.nodeId !== nodeId) throw new ExecutionCommandDenied(409);
    return { action: c.action, nodeId, issuerId: issuer.issuerId };
  } catch (error) {
    if (error instanceof ExecutionCommandDenied) return { error: error.status };
    if (error instanceof CommandConflict) return { error: 409 };
    throw error;
  }
}
export async function claimHubExecutionCommand(owner: HubStore, request: Request, expectedScope: string,
  c: Extract<HubExecutionCommand, { action: 'claim' | 'queueClaim' }>): Promise<HubExecutionCommandResult> {
  const facts = new HubExecutionCommandFacts(owner.commands, owner.executionLeases);
  let target: ExecutionCommandTarget | undefined;
  const read = () => {
    const access = owner.identities.memberExecutionCommandAccess(request, expectedScope, owner, c);
    if (!access) throw new ExecutionCommandDenied(403);
    if ('nodeId' in c && c.nodeId !== access.nodeId) throw new ExecutionCommandDenied(409);
    target = access.t;
    return access;
  };
  try {
    read();
    const write = () => {
      const access = read();
      if (c.action === 'claim') {
        access.validate(c.write.send, 'messages:send');
        if (c.write.mirror) access.validate(c.write.mirror, 'messages:mirror');
      } else {
        access.validate(c.write, 'queue:manage');
        if (c.patch) access.validate(c.send, 'messages:send');
      }
    };
    const result = c.action === 'claim' ? await facts.claim(target!, c.key, c.digest, c.leaseId, !!c.write.mirror, write)
      : await facts.claimQueue(target!, c.commandKey, c.key, c.nodeId, c.digest, c.patch, { read, write });
    return { action: c.action, ...result };
  } catch (error) {
    if (error instanceof ExecutionCommandDenied) return { error: error.status };
    if (error instanceof CommandConflict) return { error: 409 };
    throw error;
  }
}
