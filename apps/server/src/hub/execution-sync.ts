import type { ExecutionAction, ExecutionGrantRef } from '../connector/execution-grants.js';
import { ConnectorClient, ConnectorClientError } from './connector-client.js';
import type { ExecutionLease, HubExecutionLeases } from './execution-leases.js';
import type { NodeGrantProof } from './node-grants.js';
import { reconcilePage } from './reconciliation-page.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

type Provenance = { nodeId: string; hubId: string; issuerTokenId: string };
type PersistenceMethod = 'reserve' | 'get' | 'prepareIssue' | 'acknowledgeIssue' | 'revoke' | 'acknowledgeRevoke' | 'revocations';
/** Fixed lease-domain methods only. This port does not start a worker, open a
 * second connection, transport callbacks or enable the application root. */
export type ExecutionLeasePersistence = {
  [K in PersistenceMethod]: (...args: Parameters<HubExecutionLeases[K]>) =>
    ReturnType<HubExecutionLeases[K]> | Promise<ReturnType<HubExecutionLeases[K]>>;
};

/** Explicitly operator-bound clients only; no credential promotion or fallback
 * to the connection owner's ordinary token. No Agent dispatch in this module.
 * Composition must invoke bounded reconciliation; this owns no polling timer.
 */
export class HubExecutionSync {
  private readonly flights = new Map<number, Promise<ExecutionLease>>();
  private readonly acquisitions = new Map<symbol, Promise<void>>();
  private readonly reconciliations = new Map<symbol, Promise<void>>();
  private readonly abort = new AbortController();
  private closing?: Promise<void>;
  private readonly retries = new Map<string, { after: number; failures: number }>();
  constructor(private readonly leases: ExecutionLeasePersistence, private readonly hubId: string,
    private readonly clientFor: (lease: ExecutionLease) => ConnectorClient | Promise<ConnectorClient>, private readonly maxFlights = 32,
    private readonly now = Date.now, private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics,
    private readonly revokeRetiredLocal?: (
      lease: ExecutionLease,
      binding: { principalId: string; grantKey: string; version: number; runtime: string | undefined; sessionKey: string | undefined },
    ) => Promise<(Provenance & { revokedThroughVersion: number }) | undefined>) {}

  acquire(proof: NodeGrantProof, nodeId: string, issuerId: string, actions: ExecutionAction[]) {
    this.abort.signal.throwIfAborted();
    if (this.acquisitions.size >= this.maxFlights) return Promise.reject(new Error('Execution acquisition capacity reached'));
    const key = Symbol(); let settled!: () => void;
    this.acquisitions.set(key, new Promise<void>(resolve => { settled = resolve; }));
    const release = () => { this.acquisitions.delete(key); settled(); };
    // Preserve synchronous refusals of the original compatibility owner.
    let reservation: ReturnType<ExecutionLeasePersistence['reserve']>;
    try { reservation = this.leases.reserve(proof, nodeId, issuerId, actions); }
    catch (error) { release(); throw error; }
    return Promise.resolve(reservation).then(lease => {
      this.abort.signal.throwIfAborted();
      const fresh = lease.state === 'active' && lease.ref && lease.expiresAt > this.now() + 15_000;
      this.abort.signal.throwIfAborted();
      if (fresh) return lease;
      return this.synchronize(lease.id);
    }).finally(release);
  }

  synchronize(id: number) {
    if (this.abort.signal.aborted) return Promise.reject(new Error('Execution synchronization closed'));
    const existing = this.flights.get(id);
    if (existing) return existing;
    if (this.flights.size >= this.maxFlights) return Promise.reject(new Error('Execution synchronization capacity reached'));
    // Set single-flight before running any caller-provided transport callback.
    const flight = Promise.resolve().then(() => this.sync(id)).finally(() => { this.flights.delete(id); });
    this.flights.set(id, flight);
    return flight;
  }

  async reconcileRevocations(after = 0, limit = 32, options: { retryBackoff?: boolean } = {}) {
    this.abort.signal.throwIfAborted();
    if (this.reconciliations.size >= this.maxFlights) throw new Error('Execution reconciliation capacity reached');
    const key = Symbol(); let settled!: () => void;
    this.reconciliations.set(key, new Promise<void>(resolve => { settled = resolve; }));
    let trace: ReturnType<PerformanceDiagnostics['start']> | undefined;
    const observe = (action: () => void) => { try { action(); } catch { /* Observation cannot replace the original result. */ } };
    observe(() => { trace = this.diagnostics.start('hub-revocation-reconcile'); });
    let active = 0, deferred = 0, failed = true, transportFailed = false;
    const warning = setTimeout(() => observe(() => trace?.reportPending({ pending: active, deferred })), 30_000);
    warning.unref();
    try {
      this.abort.signal.throwIfAborted();
      const read = this.leases.revocations(after, limit);
      // Preserve original synchronous page admission. Closing after its read
      // fences unstarted work and still returns that examined page. A pending
      // async read must settle first and cannot start a page after shutdown.
      const page = Array.isArray(read) ? read : await read;
      if (!Array.isArray(read)) this.abort.signal.throwIfAborted();
      observe(() => trace?.add('records', page.length));
      let acknowledged = 0;
      // At most four transports per reconciliation page; a slow node does not
      // serialize every healthy node. The shared flight cap also covers acquire.
      await reconcilePage(page, async lease => {
        active++;
        try {
          const key = JSON.stringify([lease.proof.ownerUserId, lease.proof.connectionId,
            lease.proof.nodeVersion, lease.nodeId, lease.issuerId]);
          const retry = options.retryBackoff ? this.retries.get(key) : undefined;
          const wait = retry ? retry.after - this.now() : 0;
          if (wait > 0 && wait <= 900_000) { observe(() => trace?.add('deferred', 1)); deferred++; return; }
          try {
            if ((await this.synchronize(lease.id)).state === 'revoked') {
              acknowledged++;
              if (options.retryBackoff) this.retries.delete(key);
            }
          } catch (error) {
            transportFailed = true; deferred++; observe(() => trace?.add('deferred', 1));
            observe(() => trace?.reportPending({ pending: active, deferred }));
            // Bound failing issuer domains as well as per-page transports. One
            // offline node with many grants must not create a retry storm.
            if (options.retryBackoff && !this.abort.signal.aborted) {
              const previous = this.retries.get(key), now = this.now();
              const isAuthRefusal = error instanceof ConnectorClientError && (error.status === 401 || error.status === 403);
              const maxDelayMs = isAuthRefusal ? 900_000 : 30_000;
              const maxFailures = isAuthRefusal ? 10 : 6;
              const baseDelayMs = isAuthRefusal ? 5_000 : 1_000;
              if (previous && previous.after > now && previous.after <= now + maxDelayMs) return;
              const failures = Math.min((previous?.failures ?? 0) + 1, maxFailures);
              if (this.retries.size >= 128 && !this.retries.has(key)) this.retries.delete(this.retries.keys().next().value!);
              this.retries.set(key, { after: now + Math.min(maxDelayMs, baseDelayMs * 2 ** (failures - 1)), failures });
            }
            // Durable revoking; never ACK on timeout, backoff, or shutdown.
          }
        } finally { active--; }
      }, () => !this.abort.signal.aborted);
      observe(() => trace?.add('settled', acknowledged)); failed = transportFailed;
      return { examined: page.length, acknowledged, nextCursor: page.at(-1)?.id ?? null };
    } finally {
      clearTimeout(warning); this.reconciliations.delete(key); settled();
      observe(() => trace?.finish(failed));
    }
  }

  close() {
    return this.closing ??= (async () => {
      this.abort.abort(new Error('Execution synchronization closed'));
      await Promise.allSettled([...this.acquisitions.values(), ...this.reconciliations.values(), ...this.flights.values()]);
    })();
  }

  private async sync(id: number): Promise<ExecutionLease> {
    let trace: ReturnType<PerformanceDiagnostics['start']> | undefined;
    const observe = (action: () => void) => { try { action(); } catch { /* Logs do not settle original persistence or release its flight. */ } };
    observe(() => { trace = this.diagnostics.start('hub-execution-sync'); });
    observe(() => { trace?.add('pending', this.flights.size); });
    const warning = setTimeout(() => observe(() => trace?.reportPending({ step: 1, pending: 1 })), 30_000);
    warning.unref();
    let failed = true;
    try {
      const result = await this.syncLease(id);
      failed = false; observe(() => { trace?.add('step', 2); trace?.add('settled', 1); });
      return result;
    } catch (error) {
      observe(() => { trace?.add('step', 3); trace?.add('unknown', 1); });
      throw error;
    } finally { clearTimeout(warning); observe(() => trace?.finish(failed)); }
  }

  private async syncLease(id: number): Promise<ExecutionLease> {
    this.abort.signal.throwIfAborted();
    let lease = await this.leases.get(id);
    this.abort.signal.throwIfAborted();
    if (!lease) throw new Error('Execution lease not found');
    if (lease.state === 'revoked') return lease;
    const client = await this.clientFor(lease);
    this.abort.signal.throwIfAborted();
    if (!client.expectedNodeId || client.expectedNodeId !== lease.nodeId) throw new Error('Pinned issuer client required');
    if (lease.state !== 'revoking') lease = await this.leases.prepareIssue(id);
    this.abort.signal.throwIfAborted();
    const binding = { principalId: lease.proof.userId, grantKey: lease.grantKey, version: lease.version,
      runtime: lease.proof.resource.runtime, sessionKey: lease.proof.resource.sessionKey };
    if (lease.state === 'revoking') {
      let result: Provenance & { revokedThroughVersion: number };
      try {
        result = await client.json<Provenance & { revokedThroughVersion: number }>('/execution-grants/revoke', {
          method: 'POST', body: JSON.stringify(binding), signal: this.abort.signal });
      } catch (error) {
        if (
          this.revokeRetiredLocal
          && error instanceof ConnectorClientError
          && (error.status === 401 || error.status === 403)
        ) {
          this.abort.signal.throwIfAborted();
          const retired = await this.revokeRetiredLocal(lease, binding);
          if (!retired) throw error;
          result = retired;
        } else {
          throw error;
        }
      }
      this.abort.signal.throwIfAborted();
      await this.validate(result, lease);
      this.abort.signal.throwIfAborted();
      if (!await this.leases.acknowledgeRevoke(id, result.revokedThroughVersion)) throw new Error('Execution revocation acknowledgment mismatch');
    } else {
      let result: Provenance & { grant: ExecutionGrantRef; leaseMs: number };
      try {
        result = await client.json('/execution-grants', { method: 'POST',
          body: JSON.stringify({ ...binding, actions: lease.actions, leaseMs: 60_000 }), signal: this.abort.signal });
      } catch (error) {
        // Conflict means this version cannot be safely renewed. Retire it via
        // the same barrier, never silently allocate a fresh execution command.
        if (error instanceof ConnectorClientError && error.status === 409) await this.leases.revoke(id);
        throw error;
      }
      this.abort.signal.throwIfAborted();
      await this.validate(result, lease);
      this.abort.signal.throwIfAborted();
      if (result.leaseMs !== 60_000) { await this.leases.revoke(id); throw new Error('Execution lease acknowledgment mismatch'); }
      if (!await this.leases.acknowledgeIssue(id, result.grant, lease.expiresAt)) throw new Error('Execution policy changed during acknowledgment');
    }
    this.abort.signal.throwIfAborted();
    const current = await this.leases.get(id);
    this.abort.signal.throwIfAborted();
    if (!current) throw new Error('Execution lease not found');
    return current;
  }

  private async validate(value: Provenance, lease: ExecutionLease) {
    if (!value || value.nodeId !== lease.nodeId || value.hubId !== this.hubId || value.issuerTokenId !== lease.issuerId) {
      await this.leases.revoke(lease.id);
      throw new Error('Execution issuer acknowledgment mismatch');
    }
  }
}
