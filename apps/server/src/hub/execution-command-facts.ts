import type { QueuedCommandPage, SharedQueuedCommandPage } from '@agentopsdeck/shared';
import { sessionRuntimeId } from '@agentopsdeck/shared';
import { CommandConflict, type CommandReceipt, type CommandReceipts } from '../commands/receipts.js';
import type { ExecutionCommandTarget } from './execution-commands.js';
import type { HubExecutionLeases } from './execution-leases.js';
import { decodeHubSessionId } from './session-id.js';

/** Original owner's transaction facts only. No network, caller principal,
 * second connection, credential or new journal. Both compatibility flow and
 * worker commands use these same historical binding rules. Checks are local
 * synchronous transaction participants, NEVER serialized callbacks. */
export class HubExecutionCommandFacts {
  constructor(private readonly receipts: CommandReceipts, private readonly leases: HubExecutionLeases,
    private readonly now = Date.now) {}

  private scope(t: ExecutionCommandTarget) { return JSON.stringify(['execution-v1', t.ownerUserId, t.userId, t.sessionId]); }
  private queueScope(t: ExecutionCommandTarget, key: string) {
    return JSON.stringify(['execution-queue-mutation-v1', t.ownerUserId, t.userId, t.sessionId, key]);
  }
  lookup(t: ExecutionCommandTarget, key: string, digest?: string) {
    if (digest !== undefined && (!/^[A-Za-z0-9._:-]{1,200}$/.test(key) || Buffer.byteLength(this.scope(t)) > 4096)) throw new CommandConflict('Invalid command identity');
    return digest === undefined ? this.receipts.get(this.scope(t), key) : this.receipts.matchDigest(this.scope(t), key, digest);
  }
  boundLease(t: ExecutionCommandTarget, id: number) {
    const decoded = decodeHubSessionId(t.sessionId), lease = this.leases.get(id);
    if (!decoded || !lease || lease.proof.userId !== t.userId || lease.proof.ownerUserId !== t.ownerUserId
      || lease.proof.connectionId !== decoded.connectionId || lease.proof.resource.sessionKey !== decoded.remoteSessionKey
      || lease.proof.resource.runtime !== sessionRuntimeId(decoded.remoteSessionKey)) {
      throw new Error('Command authority target mismatch');
    }
    return lease;
  }
  currentLease(t: ExecutionCommandTarget, id: number, mirror = false) {
    const lease = this.boundLease(t, id);
    if (lease.state !== 'active' || !lease.ref || lease.expiresAt <= this.now() || lease.expiresAt > this.now() + 60_000
      || !lease.actions.includes('messages:send') || !this.leases.authorized(lease.proof, lease.actions)) throw new Error('Command execution authority is not current');
    if (mirror && !lease.actions.includes('messages:mirror')) throw new Error('Command mirror authority is not current');
    return lease;
  }
  claim(t: ExecutionCommandTarget, key: string, digest: string, id: number, mirror: boolean, authorize: () => void) {
    const check = () => { authorize(); this.currentLease(t, id, mirror); };
    return this.receipts.claimDigestAsync(this.scope(t), key, digest, check, check, id);
  }
  observation(t: ExecutionCommandTarget, key: string) {
    const scope = this.scope(t), receipt = this.receipts.get(scope, key);
    return { receipt, authorityId: receipt ? this.receipts.authorityId(scope, key) : undefined };
  }
  historical(t: ExecutionCommandTarget, key: string, nodeId?: string) {
    const scope = this.scope(t), receipt = this.receipts.get(scope, key), id = this.receipts.authorityId(scope, key);
    if (!receipt || id === undefined) throw new CommandConflict('Historical command authority unavailable');
    const lease = this.boundLease(t, id);
    if (nodeId !== undefined && lease.nodeId !== nodeId) throw new CommandConflict('Historical command node changed');
    return { lease, deliveryKey: this.receipts.deliveryKey(scope, key) };
  }
  settle(t: ExecutionCommandTarget, key: string, upstream: CommandReceipt | undefined, notDispatched = false) {
    const scope = this.scope(t);
    return notDispatched ? this.receipts.settle(scope, key, { status: 409, body: {} })
      : this.receipts.settleFromReceipt(scope, key, upstream);
  }
  queueBinding(t: ExecutionCommandTarget, key: string, nodeId: string) {
    if (this.lookup(t, key)?.state !== 'accepted') throw new CommandConflict('Original queue command is not confirmed');
    return this.historical(t, key, nodeId);
  }
  queueObservation(t: ExecutionCommandTarget, commandKey: string, key: string, nodeId: string) {
    const scope = this.queueScope(t, commandKey), receipt = this.receipts.get(scope, key);
    if (!receipt) return undefined;
    const binding = this.queueBinding(t, commandKey, nodeId);
    if (this.receipts.authorityId(scope, key) !== binding.lease.id) throw new CommandConflict('Queue mutation authority changed');
    return { ...binding, receipt, mutationDeliveryKey: this.receipts.deliveryKey(scope, key) };
  }
  claimQueue(t: ExecutionCommandTarget, commandKey: string, key: string, nodeId: string, digest: string,
    patch: boolean, authorize: { read: () => void; write: () => void }) {
    const binding = this.queueBinding(t, commandKey, nodeId), scope = this.queueScope(t, commandKey);
    const check = () => {
      authorize.read();
      if (!this.receipts.get(scope, key)) {
        authorize.write();
        if (patch) this.currentLease(t, binding.lease.id);
      }
      const current = this.queueBinding(t, commandKey, nodeId);
      if (current.lease.id !== binding.lease.id || current.deliveryKey !== binding.deliveryKey) throw new CommandConflict('Queue mutation authority changed');
    };
    return this.receipts.claimDigestAsync(scope, key, digest, check, check, binding.lease.id);
  }
  settleQueue(t: ExecutionCommandTarget, commandKey: string, key: string, upstream: CommandReceipt | undefined) {
    const scope = this.queueScope(t, commandKey), result = upstream?.result;
    const safe = result && upstream?.state === 'accepted' && result.status === 200 && result.body?.ok === true
      ? { status: 200, body: { ok: true } } : result && upstream?.state === 'rejected' && result.status >= 400 && result.status < 500
        ? { status: result.status, body: { error: 'Queue mutation rejected' } } : undefined;
    return safe ? this.receipts.settleFromReceipt(scope, key, { ...upstream!, result: safe }) : this.receipts.get(scope, key)!;
  }
  selectPage(t: ExecutionCommandTarget, nodeId: string, cursor?: string) {
    const decoded = decodeHubSessionId(t.sessionId);
    if (!decoded) throw new CommandConflict('Invalid queue session');
    const selection = { ...t, connectionId: decoded.connectionId, sessionKey: decoded.remoteSessionKey, nodeId };
    let lease, after = '0';
    if (cursor !== undefined) {
      if (!/^[1-9]\d{0,15}:(0|[1-9]\d{0,15})$/.test(cursor)) throw new CommandConflict('Invalid queue cursor');
      const [id, sequence] = cursor.split(':').map(Number);
      if (!Number.isSafeInteger(id) || !Number.isSafeInteger(sequence)) throw new CommandConflict('Invalid queue cursor');
      lease = this.boundLease(t, id!); after = String(sequence);
      if (lease.nodeId !== nodeId || !lease.ref) throw new CommandConflict('Queue cursor authority changed');
    } else lease = this.leases.nextQueueActor(selection);
    const next = lease && this.leases.nextQueueActor(selection, lease.issuerId);
    return { lease, after, nextActorCursor: next ? `${next.id}:0` : null };
  }
  projectPage(t: ExecutionCommandTarget, nodeId: string, id: number, page: QueuedCommandPage): SharedQueuedCommandPage['items'] {
    const lease = this.boundLease(t, id);
    if (lease.nodeId !== nodeId || !lease.ref) throw new CommandConflict('Queue page authority changed');
    const keys = page.items.flatMap(item => item.commandKey === null ? [] : [item.commandKey]);
    const originals = this.receipts.deliveryCommands(this.scope(t), keys), byDelivery = new Map(keys.map((key, index) => [key, originals[index]]));
    return page.items.map(item => {
      const original = item.commandKey === null ? null : byDelivery.get(item.commandKey);
      let commandKey: string | null = null, commandState: CommandReceipt['state'] | null = null;
      if (original?.authorityId) {
        const authority = this.boundLease(t, original.authorityId);
        if (authority.nodeId === nodeId && authority.issuerId === lease.issuerId && authority.ref?.actorId === lease.ref!.actorId) {
          commandKey = original.key; commandState = original.state;
        }
      }
      return { ...item, commandKey, commandState };
    });
  }
}
