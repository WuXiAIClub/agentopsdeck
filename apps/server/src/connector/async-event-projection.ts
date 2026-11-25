import { types } from 'node:util';
import type { DeckEvent } from '@agentopsdeck/shared';
import type { DeckProjectionEvents } from '../projection/deck-store.js';
import { ChangeSignal } from '../utils/change-signal.js';
import { ExecutionProjectionChanged } from './execution-projection-inventory.js';
import { performanceDiagnostics, type PerformanceDiagnostics, type PerformanceTrace } from '../diagnostics/performance.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { CONNECTOR_RESULT_BYTES, ConnectorOwnerUnavailable, encodeConnectorOwnerJson, encodeConnectorProjectionJson, validConnectorOwnerInput, validConnectorOwnerOutput,
  type ConnectorOwnerCommands } from './connector-owner-domain.js';
import { CONNECTOR_EVENT_BATCH_LIMIT, CONNECTOR_EVENT_COMMAND_BYTES, connectorEventReplayMatches, validConnectorEventOutput,
  type ConnectorEventReplay } from './connector-event-domain.js';

const MAX_PENDING = 64;
const MAX_STARTUP_PENDING = 256;
const MAX_COALESCED_BATCH_BYTES = 256 * 1024;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
type Owner = Pick<AsyncConnectorOwner, 'command'>;
/** Trusted assembly callback: refresh EVERY projection represented by capture,
 * from the same owner's committed facts. An SDK-only refresh is not a Deck-wide
 * proof. It must not wait for native/Goal quiescence or dispatch effects. */
export type ConnectorProjectionRefresh = () => Promise<void>;

/** Internal memory-projection caller, NOT execution-fact authority or a second
 * writer. Facts must append inside the original owner's fact/receipt transaction.
 * Call append synchronously with each memory mutation. Only capture a REST
 * snapshot through snapshot(), never capture memory before awaiting a cursor.
 * Construction does NOT reset/recover the original journal or replay commands.
 * This candidate does not activate the synchronous runtime root. */
export class AsyncConnectorEventProjection {
  readonly changes = new ChangeSignal();
  /** Feed the original Deck producer directly, never through a fake sync log.
   * append() records any failed/unknown write in this owner before rejecting;
   * consuming that rejection prevents an unhandled native callback error, not
   * a retry or a healthy cursor. close() still retains the physical operation. */
  readonly deckEvents: DeckProjectionEvents = Object.freeze({
    changes: this.changes,
    append: (events: readonly DeckEvent[]) => {
      const notifications: readonly DeckEvent[] = events.length > 256
        ? [{ id: '', type: 'stream.reset', ts: Date.now(), payload: { reason: 'history_batch' } }]
        : events.map(event => {
          if (event.type !== 'message.created' && event.type !== 'message.updated') return event;
          const descriptors = event.payload && typeof event.payload === 'object'
            ? Object.getOwnPropertyDescriptors(event.payload) : {};
          return { ...event, payload: {
            ...(typeof descriptors.id?.value === 'string' ? { id: descriptors.id.value.slice(0, 4096) } : {}),
            ...(descriptors.deleted?.value === true ? { deleted: true } : {}),
          } };
        });
      void this.appendDeckNotifications(notifications).catch(() => {});
    },
  });
  private tail: Promise<void> = Promise.resolve();
  private revision = 0;
  private count = 0;
  private bytes = 0;
  private coalescedTail: { events: DeckEvent[]; encodedBytes: number; reservedBytes: number; active: boolean } | undefined;
  private gap: 'read' | 'projection' | 'unknown' | undefined;
  private controlling = false;
  private closing = false;
  private closeWork: Promise<void> | undefined;
  private observing = false;
  private readonly snapshots = new Set<Promise<unknown>>();
  private checkpoint: { cursor: string; version: string; revision: number; refresh: ConnectorProjectionRefresh } | undefined;
  constructor(private readonly owner: Owner, private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics,
    private bootstrapping = false) {}

  status() {
    return Object.freeze({ pending: this.count, inputBytes: this.bytes, revision: this.revision,
      unavailable: this.gap !== undefined, unknown: this.gap === 'unknown', closing: this.closing,
      recovering: this.controlling, snapshots: this.snapshots.size });
  }
  private unavailable(): never { throw new ConnectorOwnerUnavailable(); }
  private invalidate(reason: 'read' | 'projection' | 'unknown') {
    if (this.gap !== 'unknown' && (this.gap !== 'projection' || reason !== 'read')) this.gap = reason;
    this.changes.notify();
  }
  private observeDiagnostic(work: () => void) {
    // Suppress only nested diagnostics, never nested original operations. A
    // broken/reentrant sink is not a queue owner or an availability decision.
    if (this.observing) return;
    this.observing = true;
    try { work(); } catch { /* Original work retains its result and ownership. */ }
    finally { this.observing = false; }
  }
  private trace(): PerformanceTrace {
    let trace: PerformanceTrace | undefined;
    this.observeDiagnostic(() => { trace = this.diagnostics.start('connector-event-projection'); });
    return {
      add: (metric, value) => this.observeDiagnostic(() => trace?.add(metric, value)),
      reportPending: metrics => this.observeDiagnostic(() => trace?.reportPending(metrics)),
      finish: failed => this.observeDiagnostic(() => trace?.finish(failed)),
    };
  }
  private failure(step: number, stage?: number, attempts?: number) {
    const trace = this.trace();
    trace.add('step', step); trace.add('pending', this.count);
    trace.add('unknown', this.gap === 'unknown' ? 1 : 0);
    if (stage !== undefined) trace.add('startupStage', stage);
    if (attempts !== undefined) trace.add('records', attempts);
    trace.finish(true);
  }
  private copyReply(value: unknown): unknown {
    try { return JSON.parse(encodeConnectorOwnerJson(value, CONNECTOR_RESULT_BYTES)); }
    catch { this.invalidate('unknown'); this.unavailable(); }
  }
  private readable() {
    if (this.closing || this.gap || this.controlling) this.unavailable();
  }
  private queue<T>(step: number, work: () => Promise<T>, inputBytes = 0): Promise<T> {
    this.coalescedTail = undefined;
    const pendingLimit = this.bootstrapping ? MAX_STARTUP_PENDING : MAX_PENDING;
    if (this.closing || this.count >= pendingLimit || this.bytes + inputBytes > MAX_INPUT_BYTES) this.unavailable();
    this.count++; this.bytes += inputBytes;
    let trace: PerformanceTrace | undefined, warning: ReturnType<typeof setTimeout> | undefined;
    let failed = true;
    const original = this.tail.then(work).then(value => { failed = this.gap !== undefined; return value; });
    // Attach both continuations immediately. A rejected caller does not make
    // the original operation unhandled, cancelled, replayable, or settled early.
    this.tail = original.then(() => {}, () => {}).finally(() => {
      this.count--; this.bytes -= inputBytes;
      clearTimeout(warning); trace?.add('settled', 1);
      if (this.gap === 'unknown') trace?.add('unknown', 1);
      trace?.finish(failed);
    });
    // Publish the complete original queue before any injected diagnostic can
    // reenter append/replay/close. A nested call must follow this exact flight.
    trace = this.trace();
    trace.add('step', step); trace.add('pending', this.count); trace.add('sourceBytes', inputBytes);
    warning = setTimeout(() => trace?.reportPending({ pending: this.count }), 30_000); warning.unref();
    return original;
  }
  append(events: readonly DeckEvent[]): Promise<string> {
    this.coalescedTail = undefined;
    // Invalid admission still represents a memory mutation with no log proof.
    // Fence snapshots immediately, without an unbounded reset/retry queue.
    if (!this.closing) this.revision++;
    try {
      this.readable();
      const encoded = encodeConnectorProjectionJson({ events }, CONNECTOR_EVENT_COMMAND_BYTES);
      const input: unknown = JSON.parse(encoded);
      if (!validConnectorOwnerInput('eventProjectionAppend', input)) this.unavailable();
      return this.queue(1, async () => {
        if (this.gap) this.unavailable();
        let reply: unknown;
        try { reply = await this.owner.command('eventProjectionAppend', input as { events: DeckEvent[] }); }
        catch { this.invalidate('unknown'); this.unavailable(); }
        reply = this.copyReply(reply);
        if (!validConnectorEventOutput('eventProjectionAppend', reply)) {
          this.invalidate('unknown'); this.unavailable();
        }
        const cursor = (reply as { cursor: string | null }).cursor;
        if (cursor === null) { this.invalidate('projection'); this.unavailable(); }
        this.changes.notify(); return cursor;
      }, Buffer.byteLength(encoded));
    } catch {
      this.invalidate('projection'); this.failure(1); return Promise.reject(new ConnectorOwnerUnavailable());
    }
  }
  private appendDeckNotifications(events: readonly DeckEvent[]): Promise<string> {
    if (!this.closing) this.revision++;
    try {
      this.readable();
      const encoded = encodeConnectorProjectionJson({ events }, CONNECTOR_EVENT_COMMAND_BYTES);
      const input = JSON.parse(encoded) as { events: DeckEvent[] };
      if (!validConnectorOwnerInput('eventProjectionAppend', input)) this.unavailable();
      const encodedBytes = Buffer.byteLength(encoded);
      const tail = this.coalescedTail;
      // When the queue is near capacity, coalesce waiting Deck notifications
      // into the unstarted tail command instead of overflowing MAX_PENDING.
      if (tail?.active && this.count >= MAX_PENDING - 8
        && tail.events.length + input.events.length <= CONNECTOR_EVENT_BATCH_LIMIT
        && tail.encodedBytes + encodedBytes <= MAX_COALESCED_BATCH_BYTES
        && this.bytes + encodedBytes <= MAX_INPUT_BYTES) {
        tail.events.push(...input.events);
        tail.encodedBytes += encodedBytes;
        tail.reservedBytes += encodedBytes;
        this.bytes += encodedBytes;
        return Promise.resolve('');
      }
      const bucket = { events: [...input.events], encodedBytes, reservedBytes: 0, active: true };
      const queued = this.queue(1, async () => {
        bucket.active = false;
        if (this.coalescedTail === bucket) this.coalescedTail = undefined;
        try {
          if (this.gap) this.unavailable();
          let reply: unknown;
          try { reply = await this.owner.command('eventProjectionAppend', { events: bucket.events }); }
          catch { this.invalidate('unknown'); this.unavailable(); }
          reply = this.copyReply(reply);
          if (!validConnectorEventOutput('eventProjectionAppend', reply)) {
            this.invalidate('unknown'); this.unavailable();
          }
          const cursor = (reply as { cursor: string | null }).cursor;
          if (cursor === null) { this.invalidate('projection'); this.unavailable(); }
          this.changes.notify(); return cursor;
        } finally {
          this.bytes -= bucket.reservedBytes;
          bucket.reservedBytes = 0;
        }
      }, encodedBytes);
      this.coalescedTail = bucket;
      return queued;
    } catch {
      this.coalescedTail = undefined;
      this.invalidate('projection'); this.failure(1); return Promise.reject(new ConnectorOwnerUnavailable());
    }
  }
  private async observe(after: string | null): Promise<ConnectorEventReplay> {
    let reply: unknown;
    try { reply = await this.owner.command('eventReplay', { after }); }
    // A failed read cannot have dispatched a business write. Keep it fenced
    // until explicit recovery proves this same original journal readable, but
    // do not classify it as an unknown write or reset a healthy event epoch.
    catch { this.invalidate('read'); this.unavailable(); }
    reply = this.copyReply(reply);
    if (!connectorEventReplayMatches(after, reply as ConnectorEventReplay)) {
      this.invalidate('unknown'); this.unavailable();
    }
    return reply as ConnectorEventReplay;
  }
  replay(after: string | null): Promise<ConnectorEventReplay> {
    try {
      this.readable();
      if (!validConnectorOwnerInput('eventReplay', { after })) this.unavailable();
    return this.queue(2, async () => { this.readable(); const reply = await this.observe(after); this.readable(); return reply; });
    } catch { this.failure(2); return Promise.reject(new ConnectorOwnerUnavailable()); }
  }
  snapshot<T>(capture: (cursor: string) => T, refresh: ConnectorProjectionRefresh): Promise<T> {
    return this.reserveSnapshot(capture, refresh, 0);
  }
  startupSnapshot(refresh: ConnectorProjectionRefresh): Promise<void> {
    return this.reserveSnapshot(() => undefined, refresh, 30_000).then(() => {
      this.bootstrapping = false;
    });
  }
  private reserveSnapshot<T>(capture: (cursor: string) => T, refresh: ConnectorProjectionRefresh, stabilizationMs: number): Promise<T> {
    if (typeof capture !== 'function' || typeof refresh !== 'function' || types.isAsyncFunction(capture)
      || this.snapshots.size >= MAX_PENDING || this.closing || this.gap || this.controlling) {
      this.failure(3); return Promise.reject(new ConnectorOwnerUnavailable());
    }
    // Publish accepted work before invoking any injected refresh/capture code.
    const work = Promise.resolve().then(() => this.capture(capture, refresh, stabilizationMs))
      .finally(() => { this.snapshots.delete(work); });
    this.snapshots.add(work);
    return work;
  }
  private head(): Promise<ConnectorOwnerCommands['eventProjectionHead']['output']> {
    return this.queue(3, async () => {
      this.readable();
      let value: unknown;
      try { value = await this.owner.command('eventProjectionHead', {}); }
      catch { this.invalidate('read'); this.unavailable(); }
      value = this.copyReply(value);
      if (!validConnectorOwnerOutput('eventProjectionHead', value)) { this.invalidate('unknown'); this.unavailable(); }
      this.readable();
      return value as ConnectorOwnerCommands['eventProjectionHead']['output'];
    });
  }
  private async capture<T>(capture: (cursor: string) => T, refresh: ConnectorProjectionRefresh, stabilizationMs = 0): Promise<T> {
    // Numeric-only failure stages distinguish a busy causal barrier from a
    // failed refresh/capture without logging session identifiers or payloads.
    let stage = 1, attempts = 0;
    try {
      // A main-side revision alone cannot see a committed worker fact whose
      // notifier is delayed. Bracket the complete authoritative refresh with
      // two observations of the SAME worker facts + event head, not idle checks.
      const deadline = performance.now() + stabilizationMs;
      for (let attempt = 0; stabilizationMs > 0 ? attempt === 0 || performance.now() < deadline : attempt < 4; attempt++) {
        if (stabilizationMs === 0 && attempt > 0) {
          await new Promise(resolve => setTimeout(resolve, 100 * 2 ** (attempt - 1)));
          this.readable();
        }
        if (stabilizationMs > 0 && attempt > 0) {
          await new Promise(resolve => setTimeout(resolve, Math.min(250, 25 * 2 ** Math.min(attempt - 1, 4), Math.max(1, deadline - performance.now()))));
          this.readable();
          if (performance.now() >= deadline) break;
        }
        attempts = attempt + 1; stage = 1;
        this.readable();
        const version = this.revision;
        stage = 2;
        const page = await this.head();
        this.readable();
        if (version !== this.revision) continue;
        const checkpoint = this.checkpoint;
        if (checkpoint?.cursor !== page.cursor || checkpoint.version !== page.version || checkpoint.revision !== version || checkpoint.refresh !== refresh) {
          stage = 3;
          try { await refresh(); }
          catch (error) {
            if (error instanceof ExecutionProjectionChanged) continue;
            throw error;
          }
          this.readable();
          const refreshed = this.revision;
          stage = 4;
          const confirmed = await this.head();
          this.readable();
          if (confirmed.cursor !== page.cursor || confirmed.version !== page.version || refreshed !== this.revision) continue;
        }
        const represented = this.revision;
        stage = 5;
        // No await between the final check and capture. This represents the
        // confirmed head, not future commits (which may have no display event).
        // Such commits invalidate the next snapshot through the facts version.
        const value = capture(page.cursor);
        if (types.isPromise(value)) {
          // Internal callbacks must be synchronous. Observe accidental native
          // rejections, but never accept their results as snapshot bodies.
          void Promise.prototype.then.call(value, undefined, () => {});
          this.unavailable();
        }
        if (value && (typeof value === 'object' || typeof value === 'function') && 'then' in value) this.unavailable();
        this.readable();
        if (represented !== this.revision) this.unavailable();
        this.checkpoint = { cursor: page.cursor, version: page.version, revision: represented, refresh };
        return value;
      }
      stage = 6;
      this.unavailable();
    } catch { this.failure(3, stage, attempts); throw new ConnectorOwnerUnavailable(); }
  }
  recover(): Promise<boolean> {
    if (this.closing || this.controlling || this.gap === 'unknown') {
      this.failure(4); return Promise.reject(new ConnectorOwnerUnavailable());
    }
    const version = ++this.revision;
    this.checkpoint = undefined;
    this.controlling = true;
    let work: Promise<boolean>;
    try {
      work = this.queue(4, async () => {
        try {
          if (this.gap === 'unknown') this.unavailable();
          const gap = this.gap;
          const result = this.copyReply(await this.owner.command('eventProjectionRecover', {})) as { recovered: boolean; cursor: string | null };
          if (!validConnectorEventOutput('eventProjectionRecover', result)) {
            this.invalidate('unknown'); this.unavailable();
          }
          if (result.cursor === null) { this.invalidate('projection'); return false; }
          // A rejected-before-dispatch append left a gap only in memory. Reset
          // explicitly AFTER original queued work, and ONLY after the original
          // log proves itself readable. Transaction failures cannot heal here.
          if (gap === 'projection' && !result.recovered) {
            const cursor = this.copyReply(await this.owner.command('eventProjectionReset', {}));
            if (!validConnectorEventOutput('eventProjectionReset', cursor)) { this.invalidate('unknown'); this.unavailable(); }
          }
          if (version !== this.revision) { this.invalidate('projection'); return false; }
          this.gap = undefined; this.changes.notify(); return true;
        } catch { this.invalidate('unknown'); this.unavailable(); }
      });
    } catch {
      this.controlling = false; this.failure(4); return Promise.reject(new ConnectorOwnerUnavailable());
    }
    return work.finally(() => { this.controlling = false; });
  }
  close(): Promise<void> {
    if (this.closeWork) return this.closeWork;
    this.closing = true; this.checkpoint = undefined;
    let trace: PerformanceTrace | undefined, warning: ReturnType<typeof setTimeout> | undefined;
    // This facade does not own/terminate/replace the database worker. Keep all
    // accepted original operations alive until their real completion.
    this.closeWork = Promise.allSettled([this.tail, ...this.snapshots]).then(() => {
      clearTimeout(warning); trace?.add('pending', this.count); trace?.add('settled', 1); trace?.finish(this.gap !== undefined);
    });
    this.changes.notify();
    trace = this.trace(); trace.add('step', 5);
    warning = setTimeout(() => trace?.reportPending({ pending: this.count }), 30_000); warning.unref();
    return this.closeWork;
  }
}
