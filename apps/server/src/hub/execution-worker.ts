import type { HubExecutionSync } from './execution-sync.js';
import type { HubExecutionUsage } from './execution-usage.js';
import { createShutdownCleanup, type ShutdownCleanup } from '../lifecycle/shutdown-cleanup.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

/** One Hub-owned lease worker, independent of browser reads/subscribers.
 * Polls indexed durable demand; zero HTTP when no demand exists.
 * Does not renew unused leases or retry execution commands.
 */
export class HubExecutionWorker {
  private timer?: ReturnType<typeof setTimeout>;
  private flight: Promise<void> | undefined;
  private usageFlight: Promise<unknown> | undefined;
  private readonly shutdown: ShutdownCleanup;
  private stopped = false;
  private cursor = 0;
  constructor(private readonly sync: Pick<HubExecutionSync, 'reconcileRevocations' | 'close'>, private readonly intervalMs = 3_000,
    private readonly usage?: Pick<HubExecutionUsage, 'reconcile' | 'close'>,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {
    this.shutdown = createShutdownCleanup(() => {
      // Fence new polls synchronously. Closing the two independent clients
      // signals their aborts; actual original lane settlement is also required.
      this.stopped = true; clearTimeout(this.timer); return Promise.resolve();
    }, [() => sync.close(), () => usage?.close(),
      async () => { await this.flight; }, async () => { await this.usageFlight; }],
    diagnostics, { independent: true });
    this.schedule(0); // recover durable demand on startup, without a GET
  }

  poll() {
    if (this.stopped) return Promise.resolve();
    if (this.flight) return this.flight;
    clearTimeout(this.timer);
    let nextDelay = this.intervalMs;
    this.flight = Promise.resolve().then(async () => {
      if (this.stopped) return;
      // A slow usage page must not delay subsequent revocation scans. Reuse
      // this timer, but give usage its own bounded single flight and drain it
      // on shutdown. No overlapping pages or additional scheduler.
      if (this.usage && !this.usageFlight) this.usageFlight = Promise.resolve()
        .then(() => { if (!this.stopped) return this.observeLane('hub-usage-pass', () => this.usage!.reconcile()); })
        .catch(() => {}).finally(() => { this.usageFlight = undefined; });
      const page = await this.observeLane('hub-revocation-pass', () =>
        this.sync.reconcileRevocations(this.cursor, 16, { retryBackoff: true }));
      this.cursor = page.nextCursor ?? 0;
      // Advance beyond failed old rows so they cannot permanently starve later
      // nodes. Yield between bounded pages; retry a complete scan after 3s.
      if (page.nextCursor !== null) nextDelay = 100;
    }).catch(() => { this.cursor = 0; }).finally(() => {
      this.flight = undefined;
      if (!this.stopped) this.schedule(nextDelay);
    });
    return this.flight;
  }

  close() {
    return this.shutdown();
  }

  shutdownSnapshot() { return this.shutdown.snapshot(); }

  private async observeLane<T>(operation: 'hub-revocation-pass' | 'hub-usage-pass', work: () => Promise<T>): Promise<T> {
    let trace: ReturnType<PerformanceDiagnostics['start']> | undefined;
    const observe = (action: () => void) => { try { action(); } catch { /* Logging never settles or releases the original lane. */ } };
    observe(() => { trace = this.diagnostics.start(operation); });
    // One observation of the original retained page. Not a deadline, drain
    // acknowledgement, replacement scan or permission to replay business work.
    const warning = setTimeout(() => observe(() => trace?.reportPending({ pending: 1 })), 30_000);
    warning.unref();
    let failed = true;
    try {
      const result = await work();
      failed = false; observe(() => trace?.add('settled', 1)); return result;
    } catch (error) {
      observe(() => trace?.add('deferred', 1)); throw error;
    } finally { clearTimeout(warning); observe(() => trace?.finish(failed)); }
  }

  private schedule(delay: number) {
    this.timer = setTimeout(() => { void this.poll(); }, delay);
    this.timer.unref();
  }
}
