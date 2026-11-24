import type { DatabaseSync } from 'node:sqlite';
import { CommandCapacity, CommandConflict, type CommandReceipts, type CommandReceipt } from '../commands/receipts.js';
import type { Dispatch } from '../connector/transport.js';
import { ConnectorClient } from './connector-client.js';
import { HubMaintenanceCommandFacts, maintenanceBoundary, validMaintenancePayload, type MaintenanceVault } from './maintenance-command-facts.js';

export type MaintenanceTarget = { userId: string; ownerUserId: string; connectionId: string; operation: 'apply' | 'rollback' | 'pause' | 'resume' };
export type LocalMaintenance = { connectionId: string; maintenanceToken: string; dispatch: Dispatch };

// The existing receipt owns immutable provenance; the existing vault owns the
// encrypted historical secret. No second queue, command table or renewal loop.
export class HubMaintenanceCommands {
  readonly facts: HubMaintenanceCommandFacts;
  private readonly abort = new AbortController();
  private readonly flights = new Set<Promise<unknown>>();
  private closing?: Promise<void>;
  constructor(db: DatabaseSync, private readonly receipts: CommandReceipts,
    vault: MaintenanceVault, private readonly maxFlights = 32, localConnectionId?: string) {
    this.facts = new HubMaintenanceCommandFacts(db, receipts, vault, localConnectionId);
  }

  private client(target: MaintenanceTarget, key: string, authorize: () => void, local: LocalMaintenance | undefined, write = false) {
    const localId = local?.maintenanceToken ? local.connectionId : null;
    const snapshot = this.facts.effect(target, key, write, localId);
    const path = `/${maintenanceBoundary(target)}/commands/${target.operation}`, readPath = `${path}/${encodeURIComponent(snapshot.delivery)}`;
    const guard = () => {
      authorize();
      if (this.facts.effect(target, key, write, localId).digest !== snapshot.digest) throw new Error('Maintenance authority changed');
    };
    // A historical client may query one original receipt only. It cannot use a
    // retained token for new writes, broad status reads or another operation.
    const access = { nodeId: snapshot.nodeId, authorize: guard, request: (requested: string, method: string) => {
      if (requested !== (write ? path : readPath) || method !== (write ? 'POST' : 'GET')) throw new Error('Original maintenance request only');
    } };
    let token = snapshot.credential, origin = snapshot.origin, dispatch: Dispatch | undefined;
    if (snapshot.kind === 'local') {
      if (local?.connectionId !== target.connectionId) throw new Error('Original local Connector unavailable');
      // Stable local:maintenance actor, new process secret. Never persist the
      // transient secret or route a former local command through remote fetch.
      token = local.maintenanceToken; origin = 'http://connector.example.invalid'; dispatch = local.dispatch;
    }
    if (!token) throw new Error('Original maintenance credential unavailable');
    return { client: new ConnectorClient(origin, token, dispatch, 10_000, 128 * 1024, access), path: write ? path : readPath };
  }

  send(target: MaintenanceTarget, key: string, payload: Record<string, unknown>, authorize: { read: () => void; send: () => void },
    local?: LocalMaintenance, signal?: AbortSignal) {
    // Own the request data before the first await; callers cannot mutate a
    // claimed fingerprint into a different downstream operation.
    const original = { ...target }, body = structuredClone(payload);
    return this.run(signal, async active => {
      authorize.read();
      if (!validMaintenancePayload(original.operation, body)) {
        throw new CommandConflict('Invalid maintenance payload');
      }
      const scope = this.facts.scope(original);
      if (!this.receipts.get(scope, key)) authorize.send();
      const pin = this.facts.prepare(original);
      const check = () => {
        active.throwIfAborted(); authorize.read();
        if (!this.receipts.get(scope, key)) {
          authorize.send();
        }
      };
      const claimed = await this.facts.claim(original, key, body, pin, check, local?.maintenanceToken ? local.connectionId : null);
      if (claimed.fresh) {
        try {
          const { client, path } = this.client(original, key, () => { active.throwIfAborted(); authorize.send(); }, local, true);
          const response = await client.jsonResponseOriginal<Record<string, unknown> & { command?: CommandReceipt }>(path,
            { method: 'POST', signal: active, headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...body, idempotencyKey: this.receipts.deliveryKey(scope, key) }) });
          active.throwIfAborted(); authorize.read();
          // A valid terminal POST receipt avoids an extra network round trip.
          // Missing/malformed metadata or a lost reply falls back only to GET.
          if (response.body?.command) {
            const { command, ...result } = response.body;
            this.receipts.settleFromReceipt(scope, key, { ...command, result: { status: response.status, body: result } });
          }
        } catch { /* A late 403/timeout can follow a real switch; retain unknown. */ }
      }
      return (await this.read(original, key, authorize.read, local, active))!;
    });
  }

  recover(target: MaintenanceTarget, key: string, authorize: () => void, local?: LocalMaintenance, signal?: AbortSignal) {
    const original = { ...target };
    return this.run(signal, active => {
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) throw new CommandConflict('Invalid maintenance key');
      return this.read(original, key, authorize, local, active);
    });
  }

  private async read(target: MaintenanceTarget, key: string, authorize: () => void, local: LocalMaintenance | undefined, signal: AbortSignal) {
    signal.throwIfAborted(); authorize();
    const scope = this.facts.scope(target), receipt = this.receipts.get(scope, key);
    if (!receipt || receipt.state !== 'outcome_unknown') return receipt;
    try {
      const { client, path } = this.client(target, key, authorize, local);
      const { command } = await client.jsonOriginal<{ command?: CommandReceipt }>(path, { signal });
      signal.throwIfAborted(); authorize();
      return this.receipts.settleFromReceipt(scope, key, command);
    } catch { /* Missing/revoked original authority never permits a new POST. */ }
    signal.throwIfAborted(); authorize();
    return this.receipts.get(scope, key)!;
  }

  stopAndDrain(): void | Promise<void> {
    this.abort.abort(new Error('Maintenance commands closed'));
    if (!this.flights.size) return;
    return this.closing ??= Promise.allSettled([...this.flights]).then(() => {});
  }

  close(): Promise<void> { return this.closing ??= this.stopAndDrain() ?? Promise.resolve(); }

  private run<T>(signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.abort.signal.aborted) return Promise.reject(new Error('Maintenance commands closed'));
    if (this.flights.size >= this.maxFlights) return Promise.reject(new CommandCapacity('Maintenance command capacity reached'));
    const active = signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal;
    const flight = Promise.resolve().then(() => { active.throwIfAborted(); return work(active); }).finally(() => { this.flights.delete(flight); });
    this.flights.add(flight); return flight;
  }
}
