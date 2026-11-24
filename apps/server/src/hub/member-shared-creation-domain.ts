import { createHash } from 'node:crypto';
import { CommandConflict, type CommandReceipt } from '../commands/receipts.js';
import type { HubStore } from './hub-store.js';
import type { HubPrincipal } from './identity.js';
import { isNodeId } from '../connector/node-identity.js';
import { validOwnerControlReceipt } from './member-owner-control-domain.js';
import { encodeHubSessionId } from './session-id.js';
import { sessionRef } from './session-ref.js';

export const HUB_SHARED_CREATION_BYTES = 128 * 1024;
export type HubSharedCreationTarget = { ownerUserId: string; connectionId: string };
export type HubSharedCreationEffect = { kind: 'local' | 'remote'; origin: string; credential: string;
  nodeId: string; delivery: string; digest: string };
export type HubSharedCreationCommand = { target: HubSharedCreationTarget } & (
  { action: 'prepare' } | { action: 'check'; pin: string }
  | { action: 'get'; pin: string; key: string }
  | { action: 'claim'; pin: string; key: string; payload: { label: string } }
  | { action: 'effect'; pin: string; key: string; write: boolean }
  | { action: 'effectCheck'; pin: string; key: string; write: boolean; digest: string }
  | { action: 'observe'; pin: string; key: string; upstream: CommandReceipt }
);
type Data = { action: 'prepare'; pin: string } | { action: 'check' | 'effectCheck' }
  | { action: 'get' | 'observe'; receipt: CommandReceipt | null }
  | { action: 'claim'; receipt: CommandReceipt; fresh: boolean }
  | { action: 'effect'; effect: HubSharedCreationEffect };
export type HubSharedCreationResult = null | { binding: string; data: Data | { error: 403 | 409 | 503 } };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && Object.keys(v).every(k => names.includes(k));
const id = (v: unknown): v is string => typeof v === 'string' && !!v && !v.includes('\0') && Buffer.byteLength(v) <= 512;
const key = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const sharedCreationBinding = (c: HubSharedCreationCommand) => hash(c);
export function validHubSharedCreationTarget(v: unknown): v is HubSharedCreationTarget {
  return object(v) && fields(v, ['ownerUserId', 'connectionId']) && id(v.ownerUserId) && id(v.connectionId);
}
export function validSharedCreationPayload(v: unknown): v is { label: string } {
  return object(v) && fields(v, ['label']) && typeof v.label === 'string' && !!v.label.trim() && v.label.length <= 256;
}
export function validHubSharedCreationCommand(v: unknown): v is HubSharedCreationCommand {
  if (!object(v) || !validHubSharedCreationTarget(v.target)) return false;
  const common = ['action', 'target'];
  if (v.action === 'prepare') return fields(v, common);
  if (!digest(v.pin)) return false;
  common.push('pin');
  if (v.action === 'check') return fields(v, common);
  if (!key(v.key)) return false;
  common.push('key');
  if (v.action === 'get') return fields(v, common);
  if (v.action === 'claim') return fields(v, [...common, 'payload']) && validSharedCreationPayload(v.payload);
  if (v.action === 'effect') return fields(v, [...common, 'write']) && typeof v.write === 'boolean';
  if (v.action === 'effectCheck') return fields(v, [...common, 'write', 'digest']) && typeof v.write === 'boolean' && digest(v.digest);
  return v.action === 'observe' && fields(v, [...common, 'upstream']) && validOwnerControlReceipt(v.upstream);
}
export function validSharedCreationEffect(v: unknown): v is HubSharedCreationEffect {
  if (!object(v) || !fields(v, ['kind','origin','credential','nodeId','delivery','digest'])
    || !['local','remote'].includes(v.kind as string) || !isNodeId(v.nodeId) || !key(v.delivery) || !digest(v.digest)
    || typeof v.credential !== 'string' || !v.credential || Buffer.byteLength(v.credential) > 8192 || /\s/.test(v.credential)
    || typeof v.origin !== 'string' || Buffer.byteLength(v.origin) > 8192 || /[\x00-\x20\x7f]/.test(v.origin)) return false;
  if (v.kind === 'local') return true;
  try { const u = new URL(v.origin); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; } catch { return false; }
}
export function validHubSharedCreationResult(v: unknown): v is HubSharedCreationResult {
  if (v === null) return true;
  if (!object(v) || !fields(v, ['binding','data']) || !digest(v.binding) || !object(v.data)) return false;
  const d = v.data;
  if (fields(d, ['error'])) return [403,409,503].includes(d.error as number);
  if (d.action === 'prepare') return fields(d, ['action','pin']) && digest(d.pin);
  if (d.action === 'check' || d.action === 'effectCheck') return fields(d, ['action']);
  if (d.action === 'effect') return fields(d, ['action','effect']) && validSharedCreationEffect(d.effect);
  if (d.action === 'claim') return fields(d, ['action','receipt','fresh']) && typeof d.fresh === 'boolean' && validOwnerControlReceipt(d.receipt);
  return (d.action === 'get' || d.action === 'observe') && fields(d, ['action','receipt']) && (d.receipt === null || validOwnerControlReceipt(d.receipt));
}
export function validHubSharedCreationReply(c: HubSharedCreationCommand, v: unknown): v is HubSharedCreationResult {
  return validHubSharedCreationResult(v) && (v === null || v.binding === sharedCreationBinding(c)
    && ('error' in v.data || v.data.action === c.action));
}
class CreationRefused extends Error { constructor(readonly status: 403 | 409 | 503) { super('Shared creation unavailable'); } }
function access(store: HubStore, actor: HubPrincipal, target: HubSharedCreationTarget) {
  const connection = store.getConnection(target.connectionId, target.ownerUserId);
  const proof = store.grants.authorize({ ...target, userId: actor.userId }, 'sessions:create', { runtime: 'codex' });
  if (!connection?.nodeId || !proof) throw new CreationRefused(403);
  const issuer = store.executionIssuers.current(target.ownerUserId, target.connectionId);
  if (!issuer?.creationAllowed || issuer.nodeId !== connection.nodeId) throw new CreationRefused(409);
  const pin = hash([proof, issuer]);
  const scope = JSON.stringify(['shared-session-create-v1', actor.userId, target.ownerUserId, target.connectionId, 'codex']);
  return { connection, proof, issuer, pin, scope };
}
/** Runs inside the original identity savepoint; external effects never run here. */
export function executeHubSharedCreation(store: HubStore, actor: HubPrincipal,
  c: Exclude<HubSharedCreationCommand, { action: 'claim' }>): Exclude<HubSharedCreationResult, null> {
  const reply = (data: NonNullable<HubSharedCreationResult>['data']) => ({ binding: sharedCreationBinding(c), data });
  try {
    const a = access(store, actor, c.target), receipts = store.commands;
    if (c.action === 'prepare') return reply({ action: c.action, pin: a.pin });
    if (c.pin !== a.pin) throw new CreationRefused(403);
    if (c.action === 'check') return reply({ action: c.action });
    const receipt = receipts.get(a.scope, c.key);
    if (c.action === 'get' && !receipt) return reply({ action: c.action, receipt: null });
    if (!receipt || receipts.authorityId(a.scope, c.key) !== a.issuer.version) throw new CreationRefused(409);
    if (c.action === 'get') return reply({ action: c.action, receipt });
    if (c.action === 'effect' || c.action === 'effectCheck') {
      if (c.write && receipt.state !== 'outcome_unknown') throw new CreationRefused(409);
      const snapshot = store.executionIssuers.creationSnapshot(c.target.ownerUserId, c.target.connectionId, a.issuer.version);
      const delivery = receipts.deliveryKey(a.scope, c.key);
      const effect = { kind: snapshot.kind, origin: snapshot.origin, credential: snapshot.token, nodeId: snapshot.nodeId,
        delivery, digest: hash([snapshot, delivery, c.pin]) };
      if (!validSharedCreationEffect(effect)) throw new CreationRefused(503);
      if (c.action === 'effectCheck') {
        if (c.digest !== effect.digest) throw new CreationRefused(403);
        return reply({ action: c.action });
      }
      return reply({ action: c.action, effect });
    }
    if (c.upstream.key !== receipts.deliveryKey(a.scope, c.key)) return reply({ action: c.action, receipt });
    if (c.upstream.state === 'accepted' && c.upstream.result?.status === 201) {
      const nativeKey = c.upstream.result.body?.key;
      if (typeof nativeKey !== 'string' || sessionRef(a.connection.nodeId!, nativeKey)?.runtimeId !== 'codex') return reply({ action: c.action, receipt });
      store.grants.acceptCreatedSession(a.proof, nativeKey, a.scope, c.key, () => {
        const settled = receipts.settleFromReceipt(a.scope, c.key, { ...c.upstream, result: { status: 201, body: {
          key: encodeHubSessionId(c.target.connectionId, nativeKey), ownerUserId: c.target.ownerUserId,
        } } });
        if (settled.state !== 'accepted') throw Error('Creation ownership requires original receipt settlement');
      });
    } else if (c.upstream.state === 'rejected' && c.upstream.result && c.upstream.result.status >= 400 && c.upstream.result.status < 500) {
      receipts.settleFromReceipt(a.scope, c.key, { ...c.upstream, result: { status: c.upstream.result.status, body: { error: 'Shared creation rejected' } } });
    }
    return reply({ action: c.action, receipt: receipts.get(a.scope, c.key)! });
  } catch (error) {
    if (error instanceof CreationRefused) return reply({ error: error.status });
    if (error instanceof CommandConflict) return reply({ error: 409 });
    throw error; // Unknown SQL/commit ACK cannot authorize a replacement effect.
  }
}
export async function claimHubSharedCreation(store: HubStore, request: Request, expectedScope: string,
  c: Extract<HubSharedCreationCommand, { action: 'claim' }>): Promise<HubSharedCreationResult> {
  const reply = (data: NonNullable<HubSharedCreationResult>['data']) => ({ binding: sharedCreationBinding(c), data });
  let pinned: ReturnType<typeof access> | undefined;
  const check = () => {
    const current = store.identities.memberSharedCreationCommand(request, expectedScope, store, { action: 'check', target: c.target, pin: c.pin });
    if (!current) throw new CreationRefused(403);
    if ('error' in current.data) throw new CreationRefused(current.data.error);
    const actor = store.identities.commandPrincipal(request);
    if (!actor) throw new CreationRefused(403);
    pinned = access(store, actor, c.target);
    if (pinned.pin !== c.pin) throw new CreationRefused(403);
  };
  try {
    check();
    const claimed = await store.commands.claimAsync(pinned!.scope, c.key, c.payload, true, pinned!.issuer.version,
      undefined, undefined, false, check, check);
    return reply({ action: c.action, ...claimed });
  } catch (error) {
    if (error instanceof CreationRefused) return reply({ error: error.status });
    if (error instanceof CommandConflict) return reply({ error: 409 });
    throw error;
  }
}
