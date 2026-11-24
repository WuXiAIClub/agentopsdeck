import { isDeepStrictEqual } from 'node:util';
import type { AsyncContentBackgroundAccess } from './async-content-background-access.js';
import type { ContentBackgroundWork } from './content-background-domain.js';
import { synchronizeContentReplica, validateContentReplicaView } from './async-content-synchronize.js';
import { ContentProposalConflict } from './content-proposal-store.js';
import type { ContentReplicaTransport } from './workspace-content-coordinator.js';
import { observeContentReplica } from '../diagnostics/content-replica.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

/** No SQL or HTTP identity on the effect side. One page and one flight, four
 * native effects maximum. Disabling/closing stops new effects, not original ACKs. */
export class AsyncContentBackground {
  private stopping = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flight: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private cursor = 0;
  private readonly retained = new Set<string>();
  constructor(private readonly access: AsyncContentBackgroundAccess,
    private readonly transport: (reference: string) => Promise<ContentReplicaTransport>,
    private readonly enabled: () => boolean,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {}
  start(intervalMs = 10_000) {
    if (this.stopping || this.timer || this.flight) return;
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error('invalid_background_interval');
    const tick = () => {
      this.timer = undefined;
      void this.syncTick().catch(() => {}).finally(() => {
        if (!this.stopping) { this.timer = setTimeout(tick,intervalMs); this.timer.unref(); }
      });
    };
    this.timer = setTimeout(tick,intervalMs); this.timer.unref();
  }
  syncTick(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.flight) return this.flight;
    const flight = this.phase(0,() => this.scan());
    this.flight = flight;
    void flight.then(() => { if (this.flight === flight) this.flight = undefined; },() => { if (this.flight === flight) this.flight = undefined; });
    return flight;
  }
  private phase<T>(step: number,run: () => Promise<T>) {
    return observeContentReplica('hub-content-background',step,run,this.diagnostics);
  }
  private check = () => {
    if (this.stopping || !this.enabled()) throw new ContentProposalConflict('background-paused');
  };
  private async release(reference: string) {
    await this.phase(3,() => this.access.command({ action: 'release',reference }));
    this.retained.delete(reference);
  }
  private async scan() {
    // An unavailable release does not strand the page forever: retry only this
    // idempotent private reference release, never the native mutation.
    for (const reference of this.retained) await this.release(reference);
    if (this.stopping || !this.enabled()) return;
    const page = await this.access.command({ action: 'scan',after: this.cursor });
    if (page.action !== 'scan') throw new ContentProposalConflict('background-page');
    this.cursor = page.cursor;
    for (const work of page.work) this.retained.add(work.reference);
    await Promise.all(page.work.map(async work => {
      try { await this.phase(1,() => this.synchronize(work)); }
      catch { /* Original unknown intents remain durable; diagnostics retain only numeric phases. */ }
      finally { try { await this.release(work.reference); } catch { /* Retained for the next scan/close. */ } }
    }));
  }
  private async synchronize(work: ContentBackgroundWork) {
    const { id,resource,generation,reference } = work;
    this.check();
    const current = async () => {
      const result = await this.access.command({ action: 'current',reference });
      if (result.action !== 'current' || result.binding.id !== id || result.binding.generation !== generation)
        throw new ContentProposalConflict('background-binding');
      return result.binding;
    };
    const call = async <T>(effect: (transport: ContentReplicaTransport) => Promise<T>): Promise<T> => {
      await current();
      const transport = await this.transport(reference);
      await current();
      const value = await effect(transport);
      await current();
      return value;
    };
    const inspect = async () => {
      const before = await current();
      const view = await call(t => t.view(id));
      validateContentReplicaView(before,resource,view);
      if (!isDeepStrictEqual(view.initial,before.initial)) throw new ContentProposalConflict('background-initial');
      if (before.acknowledgedRevision < 0) {
        const { epoch,revision,hash } = view.initial;
        await this.phase(2,() => this.access.command({ action: 'ack',reference,proof: { epoch,revision,hash } }));
      }
      return current();
    };
    await synchronizeContentReplica({ id,resource,current,inspect,call,check: this.check,diagnostics: this.diagnostics,
      command: async command => {
        const result = await this.access.command({ action: 'sync',reference,command });
        if (result.action !== 'sync' || result.resource !== resource) throw new ContentProposalConflict('background-receipt');
        return result.result;
      } });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.closing = this.phase(4,async () => {
      try {
        await this.flight?.catch(() => {});
        for (const reference of this.retained) await this.release(reference);
      } finally { await this.access.close(); }
    });
    return this.closing;
  }
}
