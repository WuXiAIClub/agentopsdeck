import { createHash } from 'node:crypto';
import { MAX_MESSAGE_CHARS } from '@agentopsdeck/shared';
import { CommandConflict, commandPayloadFingerprint } from '../commands/receipts.js';
import { isNodeId } from '../connector/node-identity.js';
import type { ExecutionCommandTarget, QueueCommandChange } from './execution-commands.js';
import { HubExecutionCommandFacts } from './execution-command-facts.js';
import type { ExecutionLease } from './execution-leases.js';
import type { ExecutionIssuerSnapshot } from './execution-issuers.js';
import type { HubStore } from './hub-store.js';
import type { NodeAction, NodeGrantProof } from './node-grants.js';
import { validHubNodeGrantProof } from './member-connector-access-domain.js';
import { executionIssuerBinding, validExecutionIssuerSnapshot } from './member-execution-issuer-domain.js';
import { validHubExecutionLeaseResult } from './member-execution-lease-domain.js';

type Write = { send: NodeGrantProof; mirror?: NodeGrantProof };
/** Browser command keys, never caller-supplied credential/path/delivery IDs. */
export type HubExecutionEffect = { kind: 'receipt'; key: string }
  | { kind: 'queue'; key: string; nodeId: string }
  | { kind: 'message'; key: string; digest: string; write: Write }
  | { kind: 'queueMutation'; commandKey: string; key: string; nodeId: string;
      change?: QueueCommandChange; write?: NodeGrantProof; send?: NodeGrantProof }
  | { kind: 'page'; nodeId: string; cursor?: string };
export type HubExecutionEffectCommand = { action: 'effectOpen'; effect: HubExecutionEffect }
  | { action: 'effectCheck'; effect: HubExecutionEffect; fingerprint: string };
type Common = { binding: string; fingerprint: string; lease: ExecutionLease; path: string; method: 'GET' | 'POST' | 'PATCH' | 'DELETE' };
export type HubExecutionEffectResult = Common & ({ action: 'effectOpen'; snapshot: ExecutionIssuerSnapshot }
  | { action: 'effectCheck'; allowed: true });
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const fields = (v: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(k => Object.hasOwn(v, k))
  && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const key = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function validHubExecutionEffect(v: unknown): v is HubExecutionEffect {
  if (!object(v)) return false;
  if (v.kind === 'receipt') return fields(v, ['kind','key']) && key(v.key);
  if (v.kind === 'queue') return fields(v, ['kind','key','nodeId']) && key(v.key) && isNodeId(v.nodeId);
  if (v.kind === 'message') return fields(v, ['kind','key','digest','write']) && key(v.key) && hash(v.digest)
    && object(v.write) && fields(v.write, ['send'], ['mirror']) && validHubNodeGrantProof(v.write.send) && v.write.send.action === 'messages:send'
    && (v.write.mirror === undefined || validHubNodeGrantProof(v.write.mirror) && v.write.mirror.action === 'messages:mirror');
  if (v.kind === 'page') return fields(v, ['kind','nodeId'], ['cursor']) && isNodeId(v.nodeId)
    && (v.cursor === undefined || typeof v.cursor === 'string' && /^[1-9]\d{0,15}:(0|[1-9]\d{0,15})$/.test(v.cursor)
      && v.cursor.split(':').every(n => Number.isSafeInteger(Number(n))));
  if (v.kind !== 'queueMutation' || !fields(v, ['kind','commandKey','key','nodeId'], ['change','write','send'])
    || !key(v.key) || !key(v.commandKey) || !isNodeId(v.nodeId)) return false;
  if (v.change === undefined) return v.write === undefined && v.send === undefined;
  return object(v.change) && fields(v.change, ['method','version','text']) && ['PATCH','DELETE'].includes(String(v.change.method))
    && typeof v.change.version === 'string' && /^[1-9]\d{0,15}:[1-9]\d{0,15}$/.test(v.change.version)
    && typeof v.change.text === 'string' && v.change.text.length <= MAX_MESSAGE_CHARS
    && (v.change.method === 'PATCH' ? !!v.change.text.trim() : v.change.text === '')
    && validHubNodeGrantProof(v.write) && v.write.action === 'queue:manage'
    && (v.change.method === 'PATCH' ? validHubNodeGrantProof(v.send) && v.send.action === 'messages:send' : v.send === undefined);
}
export function validHubExecutionEffectCommand(v: Record<string, unknown>): boolean {
  return validHubExecutionEffect(v.effect) && (v.action === 'effectOpen' || v.action === 'effectCheck' && hash(v.fingerprint));
}
export function executionEffectBinding(target: Pick<ExecutionCommandTarget, 'ownerUserId' | 'sessionId'>,
  read: NodeGrantProof, effect: HubExecutionEffect) { return digest([target.ownerUserId, target.sessionId, read, effect]); }
export function validHubExecutionEffectResult(v: unknown): v is HubExecutionEffectResult {
  if (!object(v) || !hash(v.binding) || !hash(v.fingerprint) || !validHubExecutionLeaseResult({ action: 'get', lease: v.lease }) || v.lease === null
    || typeof v.path !== 'string' || Buffer.byteLength(v.path) > 16384 || !v.path.startsWith('/sessions/')
    || !['GET','POST','PATCH','DELETE'].includes(String(v.method))) return false;
  const common = ['action','binding','fingerprint','lease','path','method'];
  if (v.action === 'effectCheck') return fields(v, [...common,'allowed']) && v.allowed === true;
  if (v.action !== 'effectOpen' || !fields(v, [...common,'snapshot']) || !validExecutionIssuerSnapshot(v.snapshot)) return false;
  const l = v.lease as ExecutionLease, s = v.snapshot;
  return s.connectionId === l.proof.connectionId && s.version === l.proof.nodeVersion && s.nodeId === l.nodeId && s.issuerId === l.issuerId
    && v.fingerprint === digest([v.binding, executionIssuerBinding(l), l.ref, v.path, v.method, s]);
}
/** Called only inside the original identity savepoint. Reconstruct one exact
 * operation from persisted command/lease facts on EVERY transport check. */
export function executeHubExecutionEffect(owner: HubStore,
  access: { t: ExecutionCommandTarget; nodeId: string; validate: (p: NodeGrantProof | undefined, action: NodeAction) => NodeGrantProof },
  read: NodeGrantProof, c: HubExecutionEffectCommand): HubExecutionEffectResult {
  const facts = new HubExecutionCommandFacts(owner.commands, owner.executionLeases), e = c.effect, t = access.t;
  if ('nodeId' in e && e.nodeId !== access.nodeId) throw new CommandConflict('Command node changed');
  let lease: ExecutionLease, deliveryKey: string | undefined, mutationKey: string | undefined, after: string | undefined;
  if (e.kind === 'page') {
    const page = facts.selectPage(t, e.nodeId, e.cursor);
    if (!page.lease) throw new CommandConflict('Historical queue authority unavailable');
    lease = page.lease; after = page.after;
  } else if (e.kind === 'queueMutation') {
    const observation = facts.queueObservation(t, e.commandKey, e.key, e.nodeId);
    if (!observation) throw new CommandConflict('Historical queue mutation unavailable');
    ({ lease, deliveryKey, mutationDeliveryKey: mutationKey } = observation);
    if (e.change) {
      // The method, version and text must be the ORIGINAL admitted mutation.
      owner.commands.matchDigest(JSON.stringify(['execution-queue-mutation-v1', t.ownerUserId, t.userId, t.sessionId, e.commandKey]),
        e.key, commandPayloadFingerprint(e.change));
      if (observation.receipt.state !== 'outcome_unknown') throw new CommandConflict('Queue mutation already settled');
      access.validate(e.write, 'queue:manage');
      if (e.change.method === 'PATCH') { access.validate(e.send, 'messages:send'); facts.currentLease(t, lease.id); }
    }
  } else {
    const binding = facts.historical(t, e.key, e.kind === 'queue' ? e.nodeId : undefined);
    ({ lease, deliveryKey } = binding);
    if (e.kind === 'message') {
      if (facts.lookup(t, e.key, e.digest)?.state !== 'outcome_unknown') throw new CommandConflict('Command already settled');
      access.validate(e.write.send, 'messages:send');
      if (e.write.mirror) access.validate(e.write.mirror, 'messages:mirror');
      facts.currentLease(t, lease.id, !!e.write.mirror);
    }
  }
  if (!lease.ref || lease.nodeId !== access.nodeId) throw new CommandConflict('Historical command authority unavailable');
  const session = encodeURIComponent(lease.proof.resource.sessionKey!), base = `/sessions/${session}`;
  const method = e.kind === 'message' ? 'POST' : e.kind === 'queueMutation' && e.change ? e.change.method : 'GET';
  const path = e.kind === 'message' ? `${base}/messages` : e.kind === 'page' ? `${base}/queue/commands?cursor=${after}`
    : e.kind === 'queueMutation' ? `${base}/commands/${encodeURIComponent(deliveryKey!)}/queue${e.change ? '' : `/commands/${encodeURIComponent(mutationKey!)}`}`
      : `${base}/commands/${encodeURIComponent(deliveryKey!)}${e.kind === 'queue' ? '/queue' : ''}`;
  const s = owner.executionIssuers.snapshotFor(lease);
  if (!validExecutionIssuerSnapshot(s)) throw new Error('Execution issuer snapshot unavailable');
  if (method !== 'GET' && owner.executionIssuers.current(t.ownerUserId, lease.proof.connectionId)?.version !== s.version) {
    throw new CommandConflict('Execution issuer retired');
  }
  const binding = executionEffectBinding(t, read, e), fingerprint = digest([binding, executionIssuerBinding(lease), lease.ref, path, method, s]);
  if (c.action === 'effectCheck') {
    if (fingerprint !== c.fingerprint) throw new CommandConflict('Execution effect binding changed');
    return { action: c.action, binding, fingerprint, lease, path, method, allowed: true };
  }
  return { action: c.action, binding, fingerprint, lease, path, method, snapshot: s };
}
