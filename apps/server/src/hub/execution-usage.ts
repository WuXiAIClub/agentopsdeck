import type { ConnectorClient } from './connector-client.js';
import type { ExecutionLease, HubExecutionLeases } from './execution-leases.js';
import type { HubExecutionSync } from './execution-sync.js';
import { reconcilePage } from './reconciliation-page.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

type UsageItem = { lease: ExecutionLease; version: number };
type UsageTask = { kind: 'probe'; batch: readonly UsageItem[] } | { kind: 'renew'; lease: ExecutionLease };
type UsageMethod = 'get' | 'authorized' | 'revoke' | 'usageQuiet';
/** Fixed domain port. Admission checks remain local; an owner adapter must
 * consume the callback locally, never serialize it to a worker. No writer is
 * opened or enabled here. Final write authority remains in the original owner. */
export type ExecutionUsagePersistence = Pick<HubExecutionLeases, 'usageDueAsync'> & {
  [K in UsageMethod]: (...args: Parameters<HubExecutionLeases[K]>) =>
    ReturnType<HubExecutionLeases[K]> | Promise<ReturnType<HubExecutionLeases[K]>>;
};

/** Hub-owned usage reconciliation, never a command executor. Groups a bounded
 * page by original issuer transport; only Connector-confirmed pending work
 * can renew a current lease. No browser input/GET or indefinite idle renewal.
 */
export class HubExecutionUsage {
  private readonly abort = new AbortController();
  private flight: Promise<{ examined: number }> | undefined;
  constructor(private readonly leases: ExecutionUsagePersistence, private readonly hubId: string,
    private readonly sync: Pick<HubExecutionSync, 'synchronize'>,
    private readonly clientFor: (lease: ExecutionLease) => ConnectorClient | Promise<ConnectorClient>, private readonly now = Date.now,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {}

  reconcile() {
    if (this.abort.signal.aborted) return Promise.reject(new Error('Execution usage closed'));
    return this.flight ??= Promise.resolve().then(() => this.poll()).finally(() => { this.flight = undefined; });
  }

  async close() { this.abort.abort(new Error('Execution usage closed')); await this.flight?.catch(() => {}); }

  private async poll() {
    this.abort.signal.throwIfAborted();
    let trace: ReturnType<PerformanceDiagnostics['start']> | undefined;
    const observe = (action: () => void) => { try { action(); } catch { /* Logs cannot replace owner settlement. */ } };
    observe(() => { trace = this.diagnostics.start('hub-usage-reconcile'); });
    let deferred = 0, active = 0, failed = true;
    const warning = setTimeout(() => observe(() => trace?.reportPending({ pending: active, deferred })), 30_000);
    warning.unref();
    try {
      const page = await this.leases.usageDueAsync(16, () => this.abort.signal.throwIfAborted()), groups = new Map<string, UsageItem[]>();
      this.abort.signal.throwIfAborted();
      observe(() => trace?.add('records', page.length));
      for (const item of page) {
        const lease = item.lease;
        if (!await this.current(lease)) {
          this.abort.signal.throwIfAborted();
          await this.leases.revoke(lease.id);
          this.abort.signal.throwIfAborted();
          continue;
        }
        const key = JSON.stringify([lease.proof.ownerUserId, lease.proof.connectionId, lease.proof.nodeVersion, lease.nodeId, lease.issuerId]);
        const group = groups.get(key) ?? []; group.push(item); groups.set(key, group);
      }
      const tasks: UsageTask[] = [...groups.values()].map(batch => ({ kind: 'probe', batch }));
      // Probes and their confirmed renewals share four rolling slots in this
      // original page. Held transport never grants another slot or a new page.
      await reconcilePage<UsageTask>(tasks, async task => {
        active++;
        try {
          if (task.kind === 'renew') {
            // Recheck durable currentness after waiting for a shared slot. No
            // renewal merely because an earlier usage probe said "needed".
            const lease = await this.leases.get(task.lease.id);
            this.abort.signal.throwIfAborted();
            if (lease && await this.current(lease) && (lease.expiresAt <= this.now() + 30_000 || lease.state === 'pending')) {
              this.abort.signal.throwIfAborted();
              await this.sync.synchronize(lease.id);
            }
            return;
          }
          const batch = task.batch, needed: UsageTask[] = [];
          const first = batch[0]!.lease, client = await this.clientFor(first);
          this.abort.signal.throwIfAborted();
          if (client.expectedNodeId !== first.nodeId) throw new Error('Pinned execution issuer required');
          const result = await client.json<{ nodeId: string; hubId: string; issuerTokenId: string;
            usage: Array<{ id: string; needed: boolean }> }>('/execution-grants/usage', {
            method: 'POST', signal: this.abort.signal, body: JSON.stringify({ ids: batch.map(item => item.lease.ref!.id) }),
          });
          this.abort.signal.throwIfAborted();
          if (result?.nodeId !== first.nodeId || result.hubId !== this.hubId || result.issuerTokenId !== first.issuerId
            || !Array.isArray(result.usage) || result.usage.length !== batch.length
            || result.usage.some((item, i) => item?.id !== batch[i]!.lease.ref!.id || typeof item.needed !== 'boolean')) {
            throw new Error('Execution usage acknowledgment mismatch');
          }
          for (let i = 0; i < batch.length; i++) {
            const item = batch[i]!, lease = await this.leases.get(item.lease.id);
            this.abort.signal.throwIfAborted();
            if (!lease || !await this.current(lease)) {
              this.abort.signal.throwIfAborted();
              if (lease) await this.leases.revoke(lease.id);
              this.abort.signal.throwIfAborted();
              continue;
            }
            if (!result.usage[i]!.needed) {
              this.abort.signal.throwIfAborted();
              await this.leases.usageQuiet(lease.id, item.version);
              this.abort.signal.throwIfAborted();
            }
            else if (lease.expiresAt <= this.now() + 30_000 || lease.state === 'pending') needed.push({ kind: 'renew', lease });
          }
          return needed;
        } catch {
          // Retry reservation/issue uncertainty stays durable. Logs contain no
          // transport exception, token, lease ID or inferred acknowledgment.
          deferred++; observe(() => trace?.add('deferred', 1));
          observe(() => trace?.reportPending({ pending: active, deferred }));
        } finally { active--; }
      }, () => !this.abort.signal.aborted, tasks.length + page.length);
      failed = deferred > 0;
      observe(() => trace?.add('settled', Number(!failed)));
      return { examined: page.length };
    } finally { clearTimeout(warning); observe(() => trace?.finish(failed)); }
  }

  private async current(lease: ExecutionLease) {
    this.abort.signal.throwIfAborted();
    if (!['active', 'pending'].includes(lease.state)) return false;
    const authorized = await this.leases.authorized(lease.proof, lease.actions);
    this.abort.signal.throwIfAborted();
    // Current time is checked after the original authorization read settles.
    const now = this.now(); this.abort.signal.throwIfAborted();
    return authorized && lease.expiresAt > now && lease.expiresAt <= now + 60_000;
  }
}
