import { CommandCapacity, CommandConflict, commandPayloadFingerprint, type CommandReceipts } from '../commands/receipts.js';
import type { ExecutionLease, HubExecutionLeases } from './execution-leases.js';
import type { HubExecutionIssuers } from './execution-issuers.js';
import { HubExecutionCommandFacts } from './execution-command-facts.js';
import type { Dispatch } from '../connector/transport.js';
import type { SharedQueuedCommandPage } from '@agentopsdeck/shared';
import { MAX_MESSAGE_CHARS, SHARED_MESSAGE_BODY_BYTES, SHARED_MESSAGE_FLIGHT_BYTES } from '@agentopsdeck/shared';
import { ConnectorNotDispatchedError } from './connector-connect.js';

export type ExecutionCommandTarget = { userId: string; ownerUserId: string; sessionId: string };
export type QueueCommandChange = { method: 'PATCH' | 'DELETE'; version: string; text: string };

/** No second command journal. Bind the existing receipt to an immutable lease
 * at claim time, before dispatch. Recovery can only query that historical
 * authority; neither a new grant nor an absent mapping permits redispatch.
 * The caller supplies an authenticated actor and a live read-access guard.
 */
export class HubExecutionCommands {
  private readonly abort = new AbortController();
  private readonly flights = new Set<Promise<unknown>>();
  private closing?: Promise<void>;
  private payloadBytes = 0;
  private readonly facts: HubExecutionCommandFacts;
  constructor(receipts: CommandReceipts, leases: HubExecutionLeases,
    private readonly issuers: HubExecutionIssuers, now = Date.now, private readonly maxFlights = 32) {
    this.facts = new HubExecutionCommandFacts(receipts, leases, now);
  }

  claim(target: ExecutionCommandTarget, key: string, payload: unknown, leaseId: number) {
    target = { ...target };
    try { payload = structuredClone(payload); }
    catch (error) { return Promise.reject(error); }
    return this.run(undefined, async signal => {
      return this.facts.claim(target, key, commandPayloadFingerprint(payload), leaseId,
        this.mirror(payload), () => signal.throwIfAborted());
    });
  }

  private mirror(payload: unknown) {
    return !!payload && typeof payload === 'object' && 'deliveryMode' in payload && payload.deliveryMode === 'mirror';
  }

  send(target: ExecutionCommandTarget, key: string, payload: Record<string, unknown>,
    acquire: () => Promise<ExecutionLease>, authorize: { read: () => void; send: () => void },
    local?: { connectionId: string; dispatch: Dispatch }, signal?: AbortSignal) {
    target = { ...target };
    // Snapshot before even the scheduling microtask: callers retain their own
    // object and must not change the content committed or sent by this call.
    let bytes: number;
    try {
      payload = structuredClone(payload);
      bytes = Buffer.byteLength(JSON.stringify(payload));
      if (bytes > SHARED_MESSAGE_BODY_BYTES) throw new CommandCapacity('Shared message too large');
    }
    catch (error) { return Promise.reject(error); }
    return this.run(signal, async activeSignal => {
      authorize.read();
      const digest = commandPayloadFingerprint(payload);
      const existing = this.facts.lookup(target, key, digest);
      if (existing) {
        // Check payload identity using the immutable old authority, before any
        // acquire. Legacy NULL and expired/retired leases never justify a new
        // claim, fresh authority, or redispatch, even for repeated POSTs.
        return (await this.readReceipt(target, key, authorize.read, local, activeSignal))!;
      }
      authorize.send(); activeSignal.throwIfAborted();
      const lease = await acquire();
      activeSignal.throwIfAborted(); authorize.send();
      const check = () => {
        activeSignal.throwIfAborted(); authorize.send();
        this.facts.currentLease(target, lease.id, this.mirror(payload));
      };
      const claimed = await this.facts.claim(target, key, digest, lease.id, this.mirror(payload), check);
      activeSignal.throwIfAborted();
      if (!claimed.fresh) return (await this.readReceipt(target, key, authorize.read, local, activeSignal))!;
      check();
      try {
        const binding = this.facts.historical(target, key);
        const upstream = await this.issuers.messageFor(binding.lease, binding.deliveryKey, payload,
          () => { activeSignal.throwIfAborted(); authorize.send(); this.facts.currentLease(target, lease.id); }, local, activeSignal);
        activeSignal.throwIfAborted();
        this.facts.settle(target, key, upstream);
      } catch (error) {
        // This request never connected. All ambiguous failures still require
        // the historical receipt; they never authorize a second POST.
        if (error instanceof ConnectorNotDispatchedError) this.facts.settle(target, key, undefined, true);
      }
      return (await this.readReceipt(target, key, authorize.read, local, activeSignal))!;
    }, bytes);
  }

  recover(target: ExecutionCommandTarget, key: string, authorize: () => void,
    local?: { connectionId: string; dispatch: Dispatch }, signal?: AbortSignal) {
    return this.run(signal, activeSignal => this.readReceipt(target, key, authorize, local, activeSignal));
  }

  queue(target: ExecutionCommandTarget, key: string, nodeId: string, authorize: () => void,
    local?: { connectionId: string; dispatch: Dispatch }, signal?: AbortSignal) {
    return this.run(signal, async activeSignal => {
      authorize();
      if (!this.facts.lookup(target, key)) return undefined;
      const { lease, deliveryKey } = this.facts.historical(target, key, nodeId);
      const queue = await this.issuers.queueFor(lease, deliveryKey, authorize, local, activeSignal);
      activeSignal.throwIfAborted(); authorize();
      return queue;
    });
  }

  private async readReceipt(target: ExecutionCommandTarget, key: string, authorize: () => void,
    local?: { connectionId: string; dispatch: Dispatch }, signal?: AbortSignal) {
    signal?.throwIfAborted();
    authorize();
    const { receipt, authorityId } = this.facts.observation(target, key);
    if (!receipt || receipt.state !== 'outcome_unknown') return receipt;
    if (authorityId === undefined) return receipt;
    try {
      const { lease, deliveryKey } = this.facts.historical(target, key);
      const upstream = await this.issuers.receiptFor(lease, deliveryKey, authorize, local, signal);
      signal?.throwIfAborted();
      authorize();
      return this.facts.settle(target, key, upstream);
    } catch { /* Missing/revoked issuer, pin mismatch or lost ACK stays unknown. */ }
    signal?.throwIfAborted(); authorize();
    return receipt;
  }

  mutateQueue(target: ExecutionCommandTarget, commandKey: string, key: string, nodeId: string, change: QueueCommandChange,
    authorize: { read: () => void; write: () => void }, local?: { connectionId: string; dispatch: Dispatch }, signal?: AbortSignal) {
    target = { ...target }; change = { ...change };
    return this.run(signal, async activeSignal => {
      authorize.read();
      const binding = this.facts.queueBinding(target, commandKey, nodeId);
      const scope = JSON.stringify(['execution-queue-mutation-v1', target.ownerUserId, target.userId, target.sessionId, commandKey]);
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key) || Buffer.byteLength(scope) > 4096
        || !['PATCH', 'DELETE'].includes(change.method) || !/^[1-9]\d{0,15}:[1-9]\d{0,15}$/.test(change.version)
        || typeof change.text !== 'string' || change.text.length > MAX_MESSAGE_CHARS || (change.method === 'PATCH' ? !change.text.trim() : change.text !== '')) {
        throw new CommandConflict('Invalid queue mutation');
      }
      const write = () => {
        activeSignal.throwIfAborted(); authorize.write();
        // Edits need the original current execution authority. Cancellation
        // can remove one's unstarted work after send permission/lease expiry.
        if (change.method === 'PATCH') this.facts.currentLease(target, binding.lease.id);
      };
      const claimed = await this.facts.claimQueue(target, commandKey, key, nodeId, commandPayloadFingerprint(change), change.method === 'PATCH',
        { read: () => { activeSignal.throwIfAborted(); authorize.read(); }, write });
      activeSignal.throwIfAborted(); authorize.read();
      if (claimed.fresh) {
        try {
          write();
          const observed = this.facts.queueObservation(target, commandKey, key, nodeId)!;
          const upstream = await this.issuers.queueMutationFor(binding.lease, binding.deliveryKey, observed.mutationDeliveryKey, change, write, local, activeSignal);
          activeSignal.throwIfAborted(); authorize.read();
          this.facts.settleQueue(target, commandKey, key, upstream);
        } catch { /* Only a durable receipt establishes an outcome, never a transport 4xx. */ }
      }
      return (await this.readQueueMutation(target, commandKey, key, nodeId, authorize.read, local, activeSignal))!;
    });
  }

  recoverQueueMutation(target: ExecutionCommandTarget, commandKey: string, key: string, nodeId: string, authorize: () => void,
    local?: { connectionId: string; dispatch: Dispatch }, signal?: AbortSignal) {
    return this.run(signal, activeSignal => this.readQueueMutation(target, commandKey, key, nodeId, authorize, local, activeSignal));
  }

  queuePage(target: ExecutionCommandTarget, nodeId: string, cursor: string | undefined, authorize: () => void,
    local?: { connectionId: string; dispatch: Dispatch }, signal?: AbortSignal): Promise<SharedQueuedCommandPage> {
    return this.run(signal, async activeSignal => {
      authorize();
      const { lease, after, nextActorCursor } = this.facts.selectPage(target, nodeId, cursor);
      if (!lease) return { availability: 'available', items: [], nextCursor: null };
      try {
        const page = await this.issuers.queuePageFor(lease, after, authorize, local, activeSignal);
        activeSignal.throwIfAborted(); authorize();
        const items = this.facts.projectPage(target, nodeId, lease.id, page);
        return { availability: 'available', items, nextCursor: page.nextCursor === null ? nextActorCursor : `${lease.id}:${page.nextCursor}` };
      } catch { /* Historical actor unavailable is not an empty queue or permission to renew. */ }
      activeSignal.throwIfAborted(); authorize();
      return { availability: 'unavailable', items: [], nextCursor: nextActorCursor };
    });
  }

  private async readQueueMutation(target: ExecutionCommandTarget, commandKey: string, key: string, nodeId: string, authorize: () => void,
    local?: { connectionId: string; dispatch: Dispatch }, signal?: AbortSignal) {
    signal?.throwIfAborted(); authorize();
    const observed = this.facts.queueObservation(target, commandKey, key, nodeId);
    if (!observed) return undefined;
    const { receipt, ...binding } = observed;
    if (receipt.state !== 'outcome_unknown') return receipt;
    try {
      const upstream = await this.issuers.queueMutationFor(binding.lease, binding.deliveryKey, binding.mutationDeliveryKey, undefined, authorize, local, signal);
      signal?.throwIfAborted(); authorize();
      return this.facts.settleQueue(target, commandKey, key, upstream);
    } catch { /* Never acquire a new lease, infer absence or redispatch. */ }
    signal?.throwIfAborted(); authorize();
    return receipt;
  }

  stopAndDrain(): void | Promise<void> {
    this.abort.abort(new Error('Execution commands closed'));
    if (!this.flights.size) return;
    return this.closing ??= Promise.allSettled([...this.flights]).then(() => {});
  }

  close(): Promise<void> { return this.closing ??= this.stopAndDrain() ?? Promise.resolve(); }

  private run<T>(signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>, bytes = 0): Promise<T> {
    if (this.abort.signal.aborted) return Promise.reject(new Error('Execution commands closed'));
    if (this.flights.size >= this.maxFlights || bytes > SHARED_MESSAGE_FLIGHT_BYTES - this.payloadBytes) return Promise.reject(new CommandCapacity('Execution command capacity reached'));
    this.payloadBytes += bytes;
    const activeSignal = signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal;
    const flight = Promise.resolve().then(() => { activeSignal.throwIfAborted(); return work(activeSignal); })
      .finally(() => { this.flights.delete(flight); this.payloadBytes -= bytes; });
    this.flights.add(flight);
    return flight;
  }

}
