import type { DatabaseSync } from 'node:sqlite';
import type { ConnectorLifecycleReceipt, ConnectorLifecycleStatus } from '@agentopsdeck/shared';
import { CommandCapacity, CommandConflict, type CommandReceipts } from '../commands/receipts.js';
import { LifecycleClient, type LifecycleEndpoint } from './lifecycle-client.js';
import { HubLifecycleCommandFacts, lifecyclePublicStatus, lifecycleUnavailable as unavailable,
  type LifecycleTarget as Target } from './lifecycle-command-facts.js';

type Vault = { current: (connection: string, owner: string) => string | undefined;
  read: (receipt: string) => string | undefined; write: (receipt: string, credential: string) => void };

/** Uses the existing bounded receipt/vault transaction, not a second queue.
 * Historical credentials can GET their exact command only, never new work.
 * Node authority continues to govern already-admitted maintenance even when
 * a Hub connection changes; the Hub cannot revoke a node token by hiding it.
 */
export class HubLifecycleCommands {
  readonly facts: HubLifecycleCommandFacts;
  private readonly abort = new AbortController();
  private readonly flights = new Set<Promise<unknown>>();
  private closing?: Promise<void>;
  constructor(db: DatabaseSync, receipts: CommandReceipts, vault: Vault, endpoints: readonly LifecycleEndpoint[] = []) {
    this.facts = new HubLifecycleCommandFacts(db, receipts, vault, endpoints);
  }
  status(userId: string, connectionId: string, authorize: () => void, signal?: AbortSignal): Promise<ConnectorLifecycleStatus> {
    return this.run(signal, async active => {
      authorize();
      const effect = this.facts.status(userId, connectionId);
      if (!effect) return { configured: false };
      const guard = () => {
        active.throwIfAborted(); authorize();
        if (this.facts.status(userId, connectionId)?.digest !== effect.digest) throw unavailable();
      };
      const status = await new LifecycleClient(effect.nodeId, effect.origin, effect.credential, guard).status(active);
      guard();
      return lifecyclePublicStatus(status);
    });
  }
  private client(target: Target, key: string, authorize: () => void, write: boolean) {
    const effect = this.facts.effect(target, key, write);
    const guard = () => {
      authorize();
      if (this.facts.effect(target, key, write).digest !== effect.digest) throw unavailable();
    };
    // The client never escapes this class. Recovery only calls command(GET).
    return { client: new LifecycleClient(effect.nodeId, effect.origin, effect.credential, guard), delivery: effect.delivery! };
  }
  send(target: Target, key: string, authorize: () => void, signal?: AbortSignal): Promise<ConnectorLifecycleReceipt> {
    const original = { ...target };
    return this.run(signal, async active => {
      const guard = () => { active.throwIfAborted(); authorize(); };
      guard();
      const claimed = await this.facts.claim(original, key, this.facts.prepare(original), guard);
      if (claimed.fresh) {
        try {
          const { client, delivery } = this.client(original, key, guard, true);
          const job = await client.command(delivery, original.operation, active, true);
          guard();
          return this.facts.observed(original, key, job);
        } catch { /* Persisted unknown, then GET original key only. */ }
      }
      return (await this.read(original, key, guard, active))!;
    });
  }
  recover(target: Target, key: string, authorize: () => void, signal?: AbortSignal) {
    const original = { ...target };
    return this.run(signal, active => this.read(original, key, () => { active.throwIfAborted(); authorize(); }, active));
  }
  private async read(target: Target, key: string, authorize: () => void, signal: AbortSignal): Promise<ConnectorLifecycleReceipt | undefined> {
    authorize();
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) throw new CommandConflict('Invalid lifecycle key');
    const command = this.facts.get(target, key);
    if (!command) return undefined;
    try {
      const { client, delivery } = this.client(target, key, authorize, false);
      const job = await client.command(delivery, target.operation, signal);
      authorize();
      return this.facts.observed(target, key, job);
    } catch { /* Lost/revoked original authority does not authorize another POST. */ }
    authorize();
    return { command, observationUnavailable: true };
  }
  stopAndDrain(): void | Promise<void> {
    this.abort.abort();
    if (!this.flights.size) return;
    return this.closing ??= Promise.allSettled([...this.flights]).then(() => {});
  }
  close(): Promise<void> { return this.closing ??= this.stopAndDrain() ?? Promise.resolve(); }
  private run<T>(signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.abort.signal.aborted) return Promise.reject(new Error('Lifecycle commands closed'));
    if (this.flights.size >= 32) return Promise.reject(new CommandCapacity('Lifecycle request capacity reached'));
    const active = signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal;
    const flight = Promise.resolve().then(() => { active.throwIfAborted(); return work(active); }).finally(() => this.flights.delete(flight));
    this.flights.add(flight); return flight;
  }
}
