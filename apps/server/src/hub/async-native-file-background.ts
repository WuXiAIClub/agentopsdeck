import type {ConnectorClient} from './connector-client.js';
import {AsyncNativeFileBackgroundAccess} from './async-native-file-background-access.js';
import type {NativeFileBackgroundWork} from './native-file-background-domain.js';
import {validNativeFileSnapshot} from './member-native-file-domain.js';
import {ChangeSignal} from '../utils/change-signal.js';
import {performanceDiagnostics, type PerformanceDiagnostics} from '../diagnostics/performance.js';
import {guardedTrace} from '../diagnostics/guarded-trace.js';

type Group = {ids: string; controller: AbortController; task: Promise<void>};
/** Original file SSE effects with private, bounded owner capabilities. No SQL,
 * request identity, install/write replay or caller-selected remote resource. */
export class AsyncNativeFileBackground {
  private stopping = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flight: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private readonly retained = new Map<string, NativeFileBackgroundWork>();
  private readonly groups = new Map<string, Group>();
  constructor(private readonly access: AsyncNativeFileBackgroundAccess,
    private readonly resolve: (reference: string) => Promise<Pick<ConnectorClient, 'fileBoardEvents' | 'fileCardEvents'>>,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {}
  start(intervalMs = 10_000) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw Error('invalid_background_interval');
    if (this.stopping || this.flight || this.timer) return;
    const tick = () => {
      this.timer = undefined;
      void this.syncTick().catch(() => {}).finally(() => {
        if (!this.stopping) {this.timer = setTimeout(tick, intervalMs); this.timer.unref();}
      });
    };
    tick();
  }
  private async phase<T>(step: number, run: () => Promise<T>): Promise<T> {
    const trace = guardedTrace(this.diagnostics, 'hub-native-file-background');
    trace.add('step', step); const warning = setTimeout(() => trace.reportPending({pending: 1}), 30_000); warning.unref(); let failed = true;
    try {const result = await run(); trace.add('settled', 1); failed = false; return result;}
    finally {clearTimeout(warning); if (failed) trace.add('unknown', 1); trace.finish(failed);}
  }
  syncTick(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.flight) return this.flight;
    const flight = this.phase(0, () => this.scan()); this.flight = flight;
    void flight.then(() => {if (this.flight === flight) this.flight = undefined;}, () => {if (this.flight === flight) this.flight = undefined;});
    return flight;
  }
  private async release(reference: string) {
    await this.phase(3, () => this.access.command({action: 'release', reference}));
    this.retained.delete(reference);
  }
  private async scan() {
    for (const reference of this.retained.keys()) {
      if (this.stopping) return;
      const result = await this.access.command({action: 'current', reference});
      if (result.action !== 'current') throw Error('native_file_background_reply');
      if (!result.current) await this.release(reference);
    }
    let cursor = '';
    // Original global quotas bound this to 128 bindings plus the terminal page.
    for (let page = 0; page < 33 && !this.stopping; page++) {
      const result = await this.access.command({action: 'scan', after: cursor});
      if (result.action !== 'scan') throw Error('native_file_background_reply');
      for (const work of result.work) this.retained.set(work.reference, work);
      if (!result.cursor) break;
      if (result.cursor <= cursor) throw Error('native_file_background_cursor');
      cursor = result.cursor;
    }
    const desired = new Map<string, NativeFileBackgroundWork[]>();
    for (const work of this.retained.values()) {
      const list = desired.get(work.group) ?? []; list.push(work); desired.set(work.group, list);
    }
    const ids = (list: NativeFileBackgroundWork[]) => list.map(w => w.reference).sort().join(',');
    for (const [key, group] of this.groups) {
      if (ids(desired.get(key) ?? []) !== group.ids || this.stopping) {
        group.controller.abort(); await group.task; this.groups.delete(key);
      }
    }
    for (const [key, works] of desired) {
      if (this.stopping || this.groups.has(key)) continue;
      const controller = new AbortController();
      this.groups.set(key, {ids: ids(works), controller, task: this.follow(works, controller.signal).catch(() => {})});
    }
  }
  private async follow(works: NativeFileBackgroundWork[], signal: AbortSignal) {
    const wait = new ChangeSignal(); let backoff = 1000;
    while (!signal.aborted) {
      try { await this.phase(1, async () => {
        const allowed: NativeFileBackgroundWork[] = [];
        for (const work of works) {
          const current = await this.access.command({action: 'current', reference: work.reference});
          signal.throwIfAborted();
          if (current.action === 'current' && current.current) allowed.push(work);
        }
        const first = allowed[0]; if (!first) throw Error('native_file_background_empty');
        const client = await this.resolve(first.reference); signal.throwIfAborted();
        const stream = first.domain === 'board' ? client.fileBoardEvents(allowed.map(w => w.bindingId), signal)
          : client.fileCardEvents(allowed.map(w => w.bindingId), signal);
        const index = new Map(allowed.map(work => [work.bindingId, work]));
          for await (const frame of stream) {
            signal.throwIfAborted();
            if (frame.event === 'heartbeat') {backoff = 1000; continue;}
            const prefix = first.domain === 'board' ? 'board-file' : 'card-file';
            if (frame.event !== prefix + '.snapshot' && frame.event !== prefix + '.closed') continue;
            const data: unknown = JSON.parse(frame.data);
            if (!data || typeof data !== 'object' || !('id' in data) || typeof data.id !== 'string') throw Error('native_file_background_frame');
            const work = index.get(data.id); if (!work) throw Error('native_file_background_unrequested');
            if (frame.event === prefix + '.closed') {
              await this.access.command({action: 'closed', reference: work.reference}); index.delete(data.id);
            } else {
              if (!('snapshot' in data) || !validNativeFileSnapshot(work, data.snapshot)) throw Error('native_file_background_snapshot');
              const snapshot = data.snapshot;
              // Admission is owned until the original ACK even if close/abort
              // happens during the command; never race it against the signal.
              await this.phase(2, () => this.access.command({action: 'apply', reference: work.reference,
                scope: {domain: work.domain, resourceId: work.resourceId}, snapshot}));
            }
            backoff = 1000;
          }
      }); } catch { /* Fixed diagnostics above; no content, identity or credentials. */ }
      if (signal.aborted) break;
      for (const work of works) {
        if (signal.aborted) break;
        try {await this.phase(2, () => this.access.command({action: 'apply', reference: work.reference,
          scope: {domain: work.domain, resourceId: work.resourceId}, snapshot: {state: 'unavailable'}}));}
        catch { /* Revoked references cannot update even availability. */ }
      }
      await wait.wait(wait.revision, signal, backoff); backoff = Math.min(30_000, backoff * 2);
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    for (const group of this.groups.values()) group.controller.abort();
    this.closing = (async () => {
      await this.flight?.catch(() => {});
      for (const group of this.groups.values()) group.controller.abort();
      await Promise.all([...this.groups.values()].map(group => group.task)); this.groups.clear();
      const failures: unknown[] = [];
      try {
        for (const reference of this.retained.keys()) {
          try {await this.release(reference);} catch (error) {failures.push(error);}
        }
        if (failures.length) throw new AggregateError(failures, 'native_file_background_release');
      }
      finally {await this.access.close();}
    })();
    return this.closing;
  }
}
