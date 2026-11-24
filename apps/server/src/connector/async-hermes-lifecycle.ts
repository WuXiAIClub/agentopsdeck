import type { ChatMessage } from '@agentopsdeck/shared';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { AsyncHermesExecution } from './async-hermes-execution.js';
import { connectorHermesLifecycleReplyMatches, validConnectorHermesLifecycleOutput,
  type ConnectorHermesLifecycleCommands, type ConnectorHermesLifecycleKind } from './connector-hermes-lifecycle-domain.js';
import { validHermesHistoryMessage } from './connector-hermes-history-domain.js';
import type { HermesLifecycleSnapshot } from '../hermes/journal.js';
import { hermesSessionView } from '../hermes/session-view.js';
import type { DeckStore } from '../projection/deck-store.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

type Options = { owner: Pick<AsyncConnectorOwner, 'command'>;
  projection: Pick<DeckStore, 'upsertSession' | 'replaceMessages' | 'removeSession' | 'getMessages'>;
  connected(): boolean; diagnostics?: PerformanceDiagnostics };
type Flight = { generation: number; work: Promise<void> };

/** Startup recovery and persisted projection, not a native executor or proof of
 * final native history. Startup owns activation AFTER restore completes and
 * must close this consumer BEFORE retiring its one shared database owner. */
export class AsyncHermesLifecycle {
  private stopped = false;
  private restored = false;
  private restoring: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly flights = new Map<string, Flight>();
  private readonly known = new Set<string>();
  private generation = 0;
  private directoryGeneration = 0;
  private directoryFlight: Promise<void> | undefined;
  constructor(private readonly options: Options) {}
  get recovered() { return this.restored && !this.stopped; }
  private check() { if (this.stopped) throw new ConnectorOwnerUnavailable(); }
  private async call<K extends ConnectorHermesLifecycleKind>(kind: K, input: ConnectorHermesLifecycleCommands[K]['input']) {
    this.check();
    const original = structuredClone(input);
    const result = await this.options.owner.command(kind, original);
    this.check();
    if (!validConnectorHermesLifecycleOutput(kind, result) || !connectorHermesLifecycleReplyMatches(kind, original, result)) throw new ConnectorOwnerUnavailable();
    return result;
  }
  private track(work: Promise<void>) {
    this.tasks.add(work); void work.then(() => this.tasks.delete(work), () => this.tasks.delete(work)); return work;
  }
  private async observed(step: number, run: () => Promise<void>) {
    const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'hermes-lifecycle');
    trace.add('step', step); let failed = true;
    try { await run(); trace.add('settled', 1); failed = false; }
    finally { trace.finish(failed); }
  }
  restore(): Promise<void> {
    if (this.stopped) return Promise.reject(new ConnectorOwnerUnavailable());
    // Publish the flight before invoking any owner or projection callback.
    return this.restoring ??= this.track(Promise.resolve().then(() => this.observed(1, async () => {
      this.check(); const execution = new AsyncHermesExecution(this.options.owner);
      let after = '';
      while (true) {
        this.check(); const keys = await execution.recoverPage(after, 64); this.check();
        for (const key of keys) {
          let cursor = 0;
          while (true) {
            const page = await this.call('hermesLifecycleRepairTools', { key, after: cursor, limit: 64 });
            if (page.next === null) break;
            cursor = page.next;
          }
        }
        if (keys.length < 64) break;
        after = keys.at(-1)!;
      }
      await this.scan(); this.check(); this.restored = true;
    })));
  }
  refresh(key: string): Promise<void> {
    if (!this.recovered) return Promise.reject(new ConnectorOwnerUnavailable());
    return this.read(key);
  }
  /** Merged successor guarantees a scan begun after the last caller. This
   * fragment covers persisted Hermes sessions/history, not queue/native state. */
  refreshProjection(): Promise<void> {
    if (!this.recovered) return Promise.reject(new ConnectorOwnerUnavailable());
    ++this.directoryGeneration;
    if (this.directoryFlight) return this.directoryFlight;
    const work = this.track(Promise.resolve().then(() => this.observed(2, async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const generation = this.directoryGeneration; await this.scan();
        if (generation === this.directoryGeneration) return;
      }
      throw new ConnectorOwnerUnavailable();
    })).finally(() => { if (this.directoryFlight === work) this.directoryFlight = undefined; }));
    this.directoryFlight = work; return work;
  }
  private async scan() {
    let after = ''; const missing = new Set(this.known);
    while (true) {
      const page = await this.call('hermesLifecyclePage', { after, limit: 64 });
      for (const key of page) { missing.delete(key); await this.read(key); }
      if (page.length < 64) break;
      after = page.at(-1)!;
    }
    for (const key of missing) await this.read(key);
  }
  private read(key: string): Promise<void> {
    if (this.stopped || this.flights.size >= 128 && !this.flights.has(key)) return Promise.reject(new ConnectorOwnerUnavailable());
    const current = this.flights.get(key);
    if (current) { current.generation = ++this.generation; return current.work; }
    const flight: Flight = { generation: ++this.generation, work: Promise.resolve() };
    const work = this.track(Promise.resolve().then(() => this.observed(3, async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const generation = flight.generation;
        const snapshot = await this.call('hermesLifecycleRead', { key });
        const messages = snapshot.title === null ? [] : await this.history(snapshot);
        const final = await this.call('hermesLifecycleRead', { key });
        // ABA advances the original revision. Discard all partial pages.
        if (messages === null || snapshot.digest !== final.digest || generation !== flight.generation) continue;
        this.check(); const target = this.options.projection;
        if (final.title === null) {
          target.removeSession(key); this.check();
          if (generation !== flight.generation) continue;
          this.known.delete(key); return;
        }
        const connected = this.options.connected() === true;
        this.check(); if (generation !== flight.generation) continue;
        // Original transient assistant output is not replaced by older
        // persisted history while the current execution is still streaming.
        const streaming = final.execution && ['starting', 'running'].includes(final.execution.phase)
          ? target.getMessages(key).filter(m => m.id === `hermes-stream:${final.execution!.id}`) : [];
        target.replaceMessages(key, [...messages, ...streaming], { authoritative: true });
        this.check(); if (generation !== flight.generation) continue;
        target.upsertSession(hermesSessionView(key, final.title, final.execution ?? undefined, connected, final.deletion !== null));
        this.check(); if (generation !== flight.generation) continue;
        this.known.add(key); return;
      }
      throw new ConnectorOwnerUnavailable();
    })).finally(() => { if (this.flights.get(key) === flight) this.flights.delete(key); }));
    flight.work = work; this.flights.set(key, flight); return work;
  }
  private async history(snapshot: HermesLifecycleSnapshot): Promise<ChatMessage[] | null> {
    const messages: ChatMessage[] = []; let offset = 0, bytes = 0;
    for (let pages = 0; pages < 50_001; pages++) {
      const page = await this.call('hermesLifecycleHistoryPage', { key: snapshot.key, digest: snapshot.digest, offset, limit: 64 });
      if (!page) return null;
      bytes += Buffer.byteLength(JSON.stringify(page.messages));
      if (bytes > 64 * 1024 * 1024) throw new ConnectorOwnerUnavailable();
      messages.push(...page.messages);
      if (page.large) {
        bytes += page.large.bytes;
        if (bytes > 64 * 1024 * 1024) throw new ConnectorOwnerUnavailable();
        const chunks: Buffer[] = []; let partOffset = 0;
        while (partOffset < page.large.bytes) {
          const part = await this.call('hermesLifecycleHistoryPart', { key: snapshot.key, digest: snapshot.digest, index: page.large.index, offset: partOffset });
          if (!part) return null;
          if (part.total !== page.large.bytes) throw new ConnectorOwnerUnavailable();
          chunks.push(Buffer.from(part.data, 'base64')); partOffset += chunks.at(-1)!.length;
        }
        const message: unknown = JSON.parse(Buffer.concat(chunks, partOffset).toString('utf8'));
        if (!validHermesHistoryMessage(message, snapshot.key)) throw new ConnectorOwnerUnavailable();
        messages.push(message);
      }
      if (page.next === null) return messages;
      offset = page.next;
    }
    throw new ConnectorOwnerUnavailable();
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true; this.restored = false;
    return this.closing = Promise.resolve().then(() => this.observed(4, async () => {
      while (this.tasks.size) await Promise.allSettled([...this.tasks]);
    }));
  }
}
