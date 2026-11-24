import { AutomationStoreConflict } from '../commands/automation-store.js';
import type { createCodexAutomation } from './codex-automation.js';

type Service = ReturnType<typeof createCodexAutomation>;
/** One runtime-owner timer. Owners run sequentially; each scheduler admits at
 * most four jobs. No per-owner interval fanout and no catch-up after restart.
 * Creation never enables a rule; only durable explicitly confirmed config can.
 */
export class ConnectorAutomationHost {
  private readonly services = new Map<string, Service>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private closed = false;
  private inflight: Promise<void> | undefined;
  constructor(private readonly create: (owner: string) => Service,
    private readonly allowed: (owner: string) => boolean) {}
  service(owner: string) {
    if (this.closed) throw new AutomationStoreConflict('automation-closed');
    if (!this.allowed(owner)) throw new AutomationStoreConflict('forbidden');
    let service = this.services.get(owner);
    if (!service) {
      if (this.services.size >= 128) throw new AutomationStoreConflict('automation-owner-capacity');
      service = this.create(owner); this.services.set(owner, service);
      if (this.running) service.scheduler.start(false);
    }
    return service;
  }
  start(owners: readonly string[], timer = true) {
    if (this.closed) throw new AutomationStoreConflict('automation-closed');
    if (this.running) return;
    for (const owner of owners) if (this.allowed(owner)) this.service(owner);
    for (const service of this.services.values()) service.scheduler.start(false);
    this.running = true;
    if (timer) {
      this.timer = setInterval(() => { void this.tick(); }, 1000);
      this.timer.unref();
    }
  }
  tick(): Promise<void> {
    if (!this.running || this.closed) return Promise.resolve();
    if (this.inflight) return this.inflight;
    const pending = (async () => {
      for (const [owner, service] of this.services) {
        if (!this.running || this.closed) break;
        try {
          if (!this.allowed(owner)) { service.scheduler.stop(); continue; }
          // Idempotent; a restored scope starts strictly future slots only.
          service.scheduler.start(false);
          await service.pollCompleted();
          if (!this.running || this.closed || !this.allowed(owner)) { service.scheduler.stop(); continue; }
          await service.scheduler.tick();
        } catch { service.scheduler.stop(); } // One owner cannot abort others.
      }
    })();
    this.inflight = pending;
    void pending.finally(() => { if (this.inflight === pending) this.inflight = undefined; });
    return pending;
  }
  async close() {
    this.closed = true; this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const service of this.services.values()) service.scheduler.stop();
    await this.inflight; // Never close the owner's database under admitted work.
  }
}
