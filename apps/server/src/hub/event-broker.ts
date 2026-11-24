import { setTimeout as delay } from 'node:timers/promises';
import { setMaxListeners } from 'node:events';
import type { ConnectorEventFrame } from '../connector/sse.js';
import { ConnectorClientError, type ConnectorClientResolver } from './connector-client.js';
import type { HubConnection, HubDeliveryEvent, HubStore } from './hub-store.js';
import { encodeHubSessionId } from './session-id.js';
import { sessionRef } from './session-ref.js';
import { performanceDiagnostics } from '../diagnostics/performance.js';
import { addSqlFailure } from '../storage/sql-failure-diagnostics.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { isConnectionDirectoryChanged } from './connection-display-version.js';
import type { HubEventFeedPort, HubEventFeedTarget } from './async-event-feed.js';

function reportBrokerFailure(error: unknown, step: number) {
  try {
  const trace = performanceDiagnostics.start('hub-event-broker');
  trace.add('step', step); trace.add('unknown', 1); addSqlFailure(trace, error); trace.finish(true);
  } catch { /* Logging must never skip cleanup or replace the SQL outcome. */ }
}

type Upstream = { domain: string; controller: AbortController; denied: boolean; state?: string; liveSince?: number; target?: HubEventFeedTarget };

// One feed per node/credential domain, independent of browser count. Subscribers
// read the bounded durable journal; they cannot backpressure or queue the feed.
export class HubEventBroker {
  private readonly upstreams = new Map<string, Upstream>();
  private readonly pumps = new Map<Promise<void>, { id: string; upstream: Upstream }>();
  private readonly observedRotations = new WeakSet<Promise<void>>();
  private drainFlight: Promise<void> | undefined;
  private reconcileFlight: Promise<void> | undefined;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private subscribers = 0;
  private allNodes = 0;
  private readonly nodeSubscribers = new Map<string, number>();
  private closed = false;
  private gapWriteFailed = false;
  private readonly shutdown = new AbortController();
  private readonly ownerWork = new Set<Promise<unknown>>();
  private initialGap: Promise<void> | undefined;
  revision = 0;
  get isClosed() { return this.closed; }
  get closedSignal() { return this.shutdown.signal; }
  get pendingFeeds() { return this.pumps.size; }
  get pendingDirectoryReads() { return Number(this.reconcileFlight !== undefined); }
  get pendingWork() { return this.pendingFeeds + this.pendingDirectoryReads + this.ownerWork.size; }

  /** Join the original enumeration before capturing browser replay scope.
   * A browser may abandon this wait; drain still retains its real owner. */
  directoryReady(): Promise<void> { return this.reconcileFlight ?? Promise.resolve(); }

  private readonly legacy: { store: HubStore; client: ConnectorClientResolver } | undefined;
  private readonly feed: HubEventFeedPort | undefined;
  private get store() { if (!this.legacy) throw Error('Legacy event store unavailable'); return this.legacy.store; }
  private get client() { if (!this.legacy) throw Error('Legacy event resolver unavailable'); return this.legacy.client; }
  constructor(source: { mode: 'async'; feed: HubEventFeedPort }, client?: undefined, ownerUserId?: string,
    reconcileMs?: number, retryMs?: number, rotationWarningMs?: number);
  constructor(source: HubStore, client: ConnectorClientResolver, ownerUserId?: string,
    reconcileMs?: number, retryMs?: number, rotationWarningMs?: number, feed?: HubEventFeedPort);
  constructor(source: HubStore | { mode: 'async'; feed: HubEventFeedPort }, client?: ConnectorClientResolver,
    private readonly ownerUserId = 'default', private readonly reconcileMs = 2_000, private readonly retryMs = 500,
    private readonly rotationWarningMs = 30_000, feed?: HubEventFeedPort) {
    if ('mode' in source && source.mode === 'async') {
      if (!source.feed || !['directory', 'open', 'check', 'cursor', 'append', 'gap', 'close'].every(key =>
        typeof source.feed[key as keyof HubEventFeedPort] === 'function')) throw Error('Async event feed unavailable');
      this.feed = source.feed;
    } else if (feed) this.feed = feed;
    else {
      if (!client) throw Error('Legacy event resolver unavailable');
      this.legacy = { store: source as HubStore, client };
    }
    setMaxListeners(256, this.shutdown.signal); // Same bound as admitted browser subscriptions.
  }

  // A scoped subscriber starts only its requested node. Owner-wide subscribers
  // may share that feed; leaving one interest never stops another's feed.
  acquire(connectionId?: string) {
    if (this.closed) throw new Error('Hub event broker is closed');
    if (this.subscribers >= 256) throw new Error('Hub event subscription capacity exceeded');
    const newInterest = connectionId === undefined ? this.allNodes === 0 : !this.allNodes && !this.nodeSubscribers.has(connectionId);
    if (connectionId === undefined) this.allNodes++;
    else this.nodeSubscribers.set(connectionId, (this.nodeSubscribers.get(connectionId) ?? 0) + 1);
    this.subscribers++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const lastInterest = connectionId === undefined ? this.allNodes === 1 : !this.allNodes && this.nodeSubscribers.get(connectionId) === 1;
      if (connectionId === undefined) this.allNodes--;
      else {
        const remaining = (this.nodeSubscribers.get(connectionId) ?? 1) - 1;
        if (remaining) this.nodeSubscribers.set(connectionId, remaining);
        else this.nodeSubscribers.delete(connectionId);
      }
      if (--this.subscribers === 0) this.stop();
      else if (!this.closed && lastInterest) this.reconcileSafely();
    };
    try {
      // Original constant-size owner/readiness fence, not a directory scan or
      // an authority cache. Admission still fails synchronously on an unsafe
      // owner; the original asynchronous enumeration is retained separately.
      if (!this.feed) this.store.connectionDirectoryVersion(this.ownerUserId);
      if (this.subscribers === 1) {
        if (this.feed) this.initialGap = this.gapAsync();
        else this.markGap();
      }
      if (newInterest) this.reconcileSafely();
      if (this.subscribers === 1) {
        this.timer = setInterval(() => this.reconcileSafely(), this.reconcileMs);
        this.timer.unref();
      }
    } catch (error) {
      reportBrokerFailure(error, 2);
      // Cleanup failures must not mask the original admission refusal.
      try { this.close(); } catch { /* stop reports its original failure. */ }
      try { release(); } catch { /* Counts still release exactly once. */ }
      throw error;
    }
    return release;
  }

  close() { if (this.closed) return; this.closed = true; this.shutdown.abort(); this.stop(); }

  /** Abort is only a stop request. The original pump (including transport
   * cancellation) must really settle before its dependent SQL owner closes. */
  drain(): Promise<void> {
    if (this.drainFlight) return this.drainFlight;
    let resolve!: () => void, reject!: (error: unknown) => void;
    this.drainFlight = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    let failed = false, original: unknown;
    try { this.close(); } catch (error) { failed = true; original = error; }
    // close() prevents a late directory reply from starting another pump.
    // Retain the ORIGINAL enumeration as well as all original transports.
    void Promise.allSettled([...this.pumps.keys(), ...this.ownerWork,
      ...(this.reconcileFlight ? [this.reconcileFlight] : [])]).then(async () => {
      await this.feed?.close();
      if (failed) reject(original); else resolve();
    }).catch(reject);
    return this.drainFlight;
  }

  private reconcileSafely() {
    if (this.closed || !this.subscribers || this.reconcileFlight) return;
    // Publish before invoking SQL/diagnostic hooks. Timer ticks and concurrent
    // interests join one original read, never create an unbounded read queue.
    const flight = Promise.resolve().then(async () => {
      await this.initialGap;
      while (!this.closed && this.subscribers) {
        const trace = guardedTrace(performanceDiagnostics, 'hub-event-broker');
        trace.add('step', 8);
        const warning = setTimeout(() => trace.reportPending({ step: 8, pending: 1 }), 1_000);
        warning.unref();
        let failed = true;
        try {
          const directory = this.feed ? await this.retain(() => this.feed!.directory()) : await this.store.listConnectionsAsync(this.ownerUserId);
          if (!this.closed && this.subscribers) await this.reconcile(directory);
          trace.add('settled', 1); failed = false;
          return;
        } catch (error) {
          if (!isConnectionDirectoryChanged(error)) throw error;
          // A configuration change invalidates enumeration, not its owner.
          // Retain this readiness flight across retries: an empty scope must
          // never advance the initial replay cursor. No write is replayed.
          trace.add('changed', 1); trace.add('settled', 1); trace.add('deferred', 1);
        } finally { clearTimeout(warning); trace.finish(failed); }
        if (this.closed || !this.subscribers) return;
        // One bounded read at a time, at the normal reconciliation cadence.
        // Shutdown cancels only this idle wait, never an original SQL read.
        try { await delay(this.reconcileMs, undefined, { signal: this.shutdown.signal }); }
        catch (error) { if (!this.closed) throw error; }
      }
    }).catch(error => {
      reportBrokerFailure(error, 2);
      try { this.close(); } catch { /* Timer callbacks cannot throw private SQL errors. */ }
    }).then(() => {
      if (this.reconcileFlight === flight) this.reconcileFlight = undefined;
    });
    this.reconcileFlight = flight;
  }

  private stop() {
    clearInterval(this.timer); this.timer = undefined;
    for (const upstream of this.upstreams.values()) upstream.controller.abort();
    for (const { upstream } of this.pumps.values()) upstream.controller.abort();
    try {
      if (this.upstreams.size && !this.gapWriteFailed) {
        if (this.feed) void this.gapAsync().catch(error => reportBrokerFailure(error, 1));
        else this.markGap();
      }
    } catch (error) { reportBrokerFailure(error, 1); throw error; }
    finally {
      // Subscription cleanup is not a successful gap COMMIT, writer unlock or
      // cancellation of original SQL. Wake every original waiter even on failure.
      this.upstreams.clear(); this.changed();
    }
  }

  private markGap() {
    try { this.store.completions.markGap(this.ownerUserId); this.gapWriteFailed = false; }
    catch (error) { this.gapWriteFailed = true; throw error; }
  }

  private retain<T>(work: () => Promise<T>): Promise<T> {
    // Publish before invoking the service/diagnostics, including sync reentry.
    const flight = Promise.resolve().then(work);
    this.ownerWork.add(flight);
    void flight.then(() => this.ownerWork.delete(flight), () => this.ownerWork.delete(flight));
    return flight;
  }

  private async gapAsync() {
    try { await this.retain(() => this.feed!.gap()); this.gapWriteFailed = false; }
    catch (error) { this.gapWriteFailed = true; throw error; }
  }

  // Re-resolve credentials on delivery too: a removed/rotated domain cannot
  // read yesterday's cached events during the reconciliation interval.
  visibleDomain(connectionId: string) {
    if (this.feed) throw Error('Awaited event authority is required');
    const upstream = this.currentUpstream(connectionId);
    return upstream && !upstream.denied ? upstream.domain : undefined;
  }

  private currentUpstream(connectionId: string) {
    const upstream = this.upstreams.get(connectionId);
    if (this.closed || !upstream || upstream.controller.signal.aborted) return;
    // A directory snapshot is ONLY enumeration. Credentials/status/capability
    // are re-read on the original owner for this exact node on every delivery.
    const connection = this.store.getConnection(connectionId, this.ownerUserId);
    if (!connection || connection.status === 'disabled' || !connection.capabilities.includes('events')) return;
    try { if (this.client(connectionId).eventDomain === upstream.domain) return upstream; } catch { /* fail closed */ }
  }

  visibleDomains() {
    const domains = new Map<string, string>();
    for (const id of this.upstreams.keys()) {
      const domain = this.visibleDomain(id);
      if (domain !== undefined) domains.set(id, domain);
    }
    return domains;
  }

  deniedConnections() {
    return [...this.upstreams.keys()].filter(id => this.currentUpstream(id)?.denied)
      .map(id => ({ envConnectionId: id, type: 'stream.status', ts: 0, payload: { connection: 'unauthorized' } }));
  }

  private async currentUpstreamAsync(connectionId: string) {
    if (!this.feed) return this.currentUpstream(connectionId);
    const upstream = this.upstreams.get(connectionId);
    if (this.closed || !upstream?.target || upstream.controller.signal.aborted) return;
    if (!await this.retain(() => this.feed!.check(upstream.target!))) return;
    if (!this.closed && !upstream.controller.signal.aborted && this.upstreams.get(connectionId) === upstream) return upstream;
  }

  async visibleDomainAsync(connectionId: string) {
    const upstream = await this.currentUpstreamAsync(connectionId);
    return upstream && !upstream.denied ? upstream.domain : undefined;
  }

  async visibleDomainsAsync() {
    const domains = new Map<string, string>();
    for (const id of this.upstreams.keys()) {
      const domain = await this.visibleDomainAsync(id);
      if (domain !== undefined) domains.set(id, domain);
    }
    return domains;
  }

  async deniedConnectionsAsync() {
    const denied: ReturnType<HubEventBroker['deniedConnections']> = [];
    for (const id of this.upstreams.keys()) if ((await this.currentUpstreamAsync(id))?.denied)
      denied.push({ envConnectionId: id, type: 'stream.status', ts: 0, payload: { connection: 'unauthorized' } });
    return denied;
  }

  wait(revision: number, signal: AbortSignal, timeoutMs = 10_000) {
    if (signal.aborted || revision !== this.revision || this.closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(timer); this.listeners.delete(finish); signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, timeoutMs);
      this.listeners.add(finish); signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted || revision !== this.revision) finish();
    });
  }

  private changed() { this.revision++; for (const listener of [...this.listeners]) listener(); }

  /** Rotation/removal is not a cancellation ACK. Observe the ORIGINAL pump,
   * including late headers/body cancellation, without changing its lifetime.
   * Settlement here means feed exit, never an event/gap SQL commit proof. */
  private observeRotation(upstream: Upstream) {
    for (const [flight, pump] of this.pumps) {
      if (pump.upstream !== upstream || this.observedRotations.has(flight)) continue;
      // Publish before diagnostic clocks/sinks can synchronously reenter.
      this.observedRotations.add(flight);
      let trace: ReturnType<typeof performanceDiagnostics.start> | undefined;
      try { trace = performanceDiagnostics.start('hub-event-broker'); trace.add('step', 7); }
      catch { /* Observation cannot prevent cancellation or authorize replacement. */ }
      const warning = setTimeout(() => {
        try { trace?.reportPending({ pending: 1, step: 7 }); } catch { /* Best effort. */ }
      }, this.rotationWarningMs);
      warning.unref();
      const finish = (failed: boolean) => {
        clearTimeout(warning);
        try { trace?.add(failed ? 'unknown' : 'settled', 1); trace?.finish(failed); }
        catch { /* Only the original pump controls admission. */ }
      };
      void flight.then(() => finish(false), () => finish(true));
    }
  }

  private async reconcile(directory: HubConnection[]) {
    const wanted = new Set<string>();
    for (const candidate of directory) {
      if (!this.allNodes && !this.nodeSubscribers.has(candidate.id)) continue;
      // Enumerated rows do not grant admission. Revalidate the original node
      // immediately before starting/rotating its original transport.
      const target = this.feed ? await this.retain(() => this.feed!.open(candidate.id)) : undefined;
      if (this.closed || !this.subscribers) return;
      const connection = this.feed ? target?.connection : this.store.getConnection(candidate.id, this.ownerUserId);
      if (!connection) continue;
      if (connection.status === 'disabled' || !connection.capabilities.includes('events')) continue;
      let domain: string;
      try { domain = target ? target.domain : this.client(connection.id).eventDomain; }
      catch { continue; /* Missing credentials are not a local-runtime fallback. */ }
      wanted.add(connection.id);
      const existing = this.upstreams.get(connection.id);
      if (existing?.domain === domain && !existing.controller.signal.aborted) continue;
      if (existing && !existing.controller.signal.aborted) {
        existing.controller.abort(); this.observeRotation(existing);
        if (this.feed) await this.gapAsync(); else this.markGap();
        if (this.closed || !this.subscribers) return;
      }
      // Removed or rotated feeds also retain their original flight. Neither
      // abort nor a credential change authorizes a replacement while it hangs.
      if ([...this.pumps.values()].some(pump => pump.id === connection.id)) continue;
      const upstream: Upstream = { domain, controller: new AbortController(), denied: false, ...(target ? { target } : {}) };
      this.upstreams.set(connection.id, upstream);
      // Publish before calling transport/SQL, including synchronous reentry.
      const flight = Promise.resolve().then(() => this.pump(connection, upstream)).catch(error => {
        // Storage failure must not advance the upstream cursor or appear live.
        try { reportBrokerFailure(error, 3); } catch { /* Observation is not settlement. */ }
        try { this.close(); } catch { /* Original gap failure already reported. */ }
      });
      this.pumps.set(flight, { id: connection.id, upstream });
      void flight.then(() => { this.pumps.delete(flight); this.changed(); });
    }
    for (const [id, upstream] of this.upstreams) {
      if (!wanted.has(id)) {
        upstream.controller.abort(); this.observeRotation(upstream);
        if (this.feed) await this.gapAsync(); else this.markGap();
        this.upstreams.delete(id); this.changed();
      }
    }
  }

  private async publish(connection: HubConnection, upstream: Upstream, event: Omit<HubDeliveryEvent, 'id'>, cursor?: string) {
    if (this.feed) {
      if (!upstream.controller.signal.aborted && await this.retain(() => this.feed!.append(upstream.target!, event, cursor, upstream.liveSince))) this.changed();
      return;
    }
    if (upstream.controller.signal.aborted || this.currentUpstream(connection.id)?.domain !== upstream.domain) return;
    if (this.store.appendDelivery(event, upstream.domain, cursor, this.ownerUserId, upstream.liveSince)) this.changed();
  }

  private async status(connection: HubConnection, upstream: Upstream, state: string) {
    if (upstream.state === state) return;
    upstream.state = state;
    await this.publish(connection, upstream, { envConnectionId: connection.id, envConnectionLabel: connection.label,
      type: state === 'connected' ? 'stream.reset' : 'stream.status', ts: Date.now(),
      payload: state === 'connected' ? { reason: 'connector_connected' } : { connection: state } });
  }

  private async pump(connection: HubConnection, upstream: Upstream) {
    const { signal } = upstream.controller;
    let failures = 0;
    while (!signal.aborted) {
      let localFailure: { error: unknown } | undefined;
      const local = async <T>(body: () => T | Promise<T>): Promise<T> => {
        try { return await body(); } catch (error) { localFailure = { error }; throw error; }
      };
      try {
        const client = upstream.target?.client ?? this.client(connection.id);
        if (client.eventDomain !== upstream.domain) return;
        upstream.liveSince = Date.now();
        const cursor = await local(() => this.feed ? this.retain(() => this.feed!.cursor(upstream.target!))
          : this.store.upstreamCursor(connection.id, upstream.domain, this.ownerUserId));
        for await (const frame of client.events(signal, cursor)) {
          if (signal.aborted) break;
          if (upstream.denied) { upstream.denied = false; this.changed(); }
          const event = frame.event === 'heartbeat' ? undefined : wrapEvent(connection, frame);
          await local(async () => {
            await this.status(connection, upstream, 'connected');
            if (event) await this.publish(connection, upstream, event, frame.id);
          });
          failures = 0;
        }
      } catch (error) {
        if (localFailure) throw localFailure.error;
        if (this.feed?.failed) throw error; // Unknown SQL ACK is not a network retry.
        if (error instanceof ConnectorClientError && [401, 403, 404].includes(error.status)) { upstream.denied = true; this.changed(); }
      }
      if (signal.aborted) return;
      if (this.feed) await this.gapAsync(); else this.markGap();
      await this.status(connection, upstream, upstream.denied ? 'unauthorized' : 'disconnected');
      await delay(Math.min(15_000, this.retryMs * 2 ** Math.min(failures++, 5)), undefined, { signal }).catch(() => undefined);
    }
  }
}

// One lifecycle owner for all HTTP views of the same owner/node feed. A scoped
// handle is internal only: routes must verify resource grants before acquiring.
export class HubEventBrokers {
  private readonly brokers = new Map<string, { events: HubEventBroker; subscribers: number }>();
  private readonly retiring = new Map<string, HubEventBroker>();
  private readonly observedRetirements = new WeakSet<HubEventBroker>();
  private drainFlight: Promise<void> | undefined;
  private closeFailed = false;
  private closeFailure: unknown;
  private subscribers = 0;
  private closed = false;

  private readonly legacy: { store: HubStore; client: ConnectorClientResolver } | undefined;
  private readonly feed: ((ownerUserId: string) => HubEventFeedPort) | undefined;
  constructor(source: { mode: 'async'; feed: (ownerUserId: string) => HubEventFeedPort }, client?: undefined, drainWarningMs?: number);
  constructor(source: HubStore, client: ConnectorClientResolver, drainWarningMs?: number, feed?: (ownerUserId: string) => HubEventFeedPort);
  constructor(source: HubStore | { mode: 'async'; feed: (ownerUserId: string) => HubEventFeedPort }, client?: ConnectorClientResolver,
    private readonly drainWarningMs = 30_000, feed?: (ownerUserId: string) => HubEventFeedPort) {
    if ('mode' in source && source.mode === 'async') {
      if (typeof source.feed !== 'function') throw Error('Async event feed unavailable');
      this.feed = source.feed;
    } else if (feed) this.feed = feed;
    else {
      if (!client) throw Error('Legacy event resolver unavailable');
      this.legacy = { store: source as HubStore, client };
    }
  }

  acquire(ownerUserId: string, connectionId?: string) {
    if (this.closed) this.refuse('Hub event brokers are closed',1);
    if (this.subscribers >= 256) this.refuse('Hub event subscription capacity exceeded',2);
    const retiring = this.retiring.get(ownerUserId);
    if (retiring) this.refuse('Hub event feed is draining',3,retiring.pendingWork);
    let entry = this.brokers.get(ownerUserId);
    if (!entry) {
      // Releasing browsers does not release still-pending transport ownership.
      if (this.brokers.size + this.retiring.size >= 256) this.refuse('Hub event feed capacity exceeded',4);
      const events = this.feed ? new HubEventBroker({ mode: 'async', feed: this.feed(ownerUserId) }, undefined, ownerUserId)
        : new HubEventBroker(this.legacy!.store, (id, maintenance) => this.legacy!.client(id, maintenance, ownerUserId), ownerUserId);
      entry = { events, subscribers: 0 };
      this.brokers.set(ownerUserId, entry);
    }
    let stop: () => void;
    try { stop = entry.events.acquire(connectionId); }
    catch (error) {
      if (entry.subscribers === 0) {
        try { this.retire(ownerUserId, entry.events); } catch { /* Preserve original refusal. */ }
      }
      throw error;
    }
    entry.subscribers++;
    this.subscribers++;
    let released = false;
    return { events: entry.events, release: () => {
      if (released) return;
      released = true;
      let failed = false, original: unknown;
      this.subscribers--;
      const last = --entry.subscribers === 0;
      // Retire BEFORE stop() can invoke gap SQL, cancellation or observers.
      if (last) {
        if (this.brokers.get(ownerUserId) === entry) this.brokers.delete(ownerUserId);
        this.retiring.set(ownerUserId, entry.events);
      }
      try { stop(); } catch (error) { failed = true; original = error; }
      if (last) try { this.retire(ownerUserId, entry.events); }
      catch (error) { if (!failed) { failed = true; original = error; } }
      if (failed) throw original;
    } };
  }

  /** Fixed reasons: 1 closed, 2 subscriber capacity, 3 original feed draining,
   * 4 owner capacity. No private identity or error text enters diagnostics. */
  private refuse(message: string, code: 1 | 2 | 3 | 4, pending = 0): never {
    // Observation is not recovery authority and never includes owner/node IDs.
    try {
      const trace = performanceDiagnostics.start('hub-event-broker');
      trace.add('step', 6); trace.add('ownerFailureCode', code);
      trace.add('pending',pending); trace.add('deferred', 1); trace.finish(true);
    } catch { /* Preserve the original admission refusal. */ }
    throw new Error(message);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    let failed = false, original: unknown;
    for (const [owner, { events }] of [...this.brokers]) {
      try { this.retire(owner, events); } catch (error) { if (!failed) { failed = true; original = error; } }
    }
    this.brokers.clear();
    if (failed) { this.closeFailed = true; this.closeFailure = original; throw original; }
  }

  private retire(owner: string, events: HubEventBroker) {
    if (this.observedRetirements.has(events)) return;
    // Publish before close/gap SQL or diagnostics can reenter retirement.
    this.observedRetirements.add(events);
    if (this.brokers.get(owner)?.events === events) this.brokers.delete(owner);
    this.retiring.set(owner, events);
    let failed = false, original: unknown;
    try { events.close(); } catch (error) { failed = true; original = error; }
    // Publish retirement before close can reenter, but a synchronously settled
    // legacy broker has no remaining owner work to fence until a microtask.
    if (!events.pendingWork && this.retiring.get(owner) === events) this.retiring.delete(owner);
    const originalDrain = events.drain();
    let trace: ReturnType<typeof performanceDiagnostics.start> | undefined;
    let warning: ReturnType<typeof setTimeout> | undefined;
    try { trace = performanceDiagnostics.start('hub-event-broker'); trace.add('step', 5); }
    catch { /* The original drain must still be awaited. */ }
    warning = setTimeout(() => {
      try { trace?.reportPending({ pending: events.pendingWork }); } catch { /* Best effort. */ }
    }, this.drainWarningMs);
    warning.unref();
    const release = (rejected: boolean) => {
      if (warning) clearTimeout(warning);
      if (this.retiring.get(owner) === events) this.retiring.delete(owner);
      try { trace?.add(rejected ? 'unknown' : 'settled', 1); trace?.finish(rejected); }
      catch { /* Original settlement, not a diagnostic, releases the slot. */ }
    };
    // All original pumps settle even when a known SQL attempt failed. Fresh
    // admission still executes the original independent gap/owner guards.
    void originalDrain.then(() => release(false), () => release(true));
    if (failed) throw original;
  }

  /** Used by route/application shutdown, not by browser unsubscribe. No
   * deadline, abort signal or log event is accepted as a drain ACK. */
  drain(): Promise<void> {
    if (this.drainFlight) return this.drainFlight;
    let resolve!: () => void, reject!: (error: unknown) => void;
    this.drainFlight = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    try { this.close(); } catch { /* Preserve the original close failure below. */ }
    let trace: ReturnType<typeof performanceDiagnostics.start> | undefined;
    try { trace = performanceDiagnostics.start('hub-event-broker'); trace.add('step', 4); }
    catch { /* Observation cannot prevent original drains. */ }
    const warning = setTimeout(() => {
      try { trace?.reportPending({ pending: this.retiring.size }); } catch { /* Best effort. */ }
    }, 30_000);
    warning.unref();
    void Promise.allSettled([...this.retiring.values()].map(events => events.drain())).then(outcomes => {
      clearTimeout(warning);
      const failure = outcomes.find(outcome => outcome.status === 'rejected');
      const failed = this.closeFailed || failure !== undefined;
      try { trace?.add(failed ? 'unknown' : 'settled', 1); trace?.finish(failed); } catch { /* Best effort. */ }
      if (this.closeFailed) reject(this.closeFailure);
      else if (failure?.status === 'rejected') reject(failure.reason);
      else resolve();
    });
    return this.drainFlight;
  }
}

function wrapEvent(connection: HubConnection, frame: ConnectorEventFrame): Omit<HubDeliveryEvent, 'id'> {
  const data = JSON.parse(frame.data) as Record<string, unknown>;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid Connector event');
  const type = typeof data.type === 'string' ? data.type : frame.event;
  if (!type || !/^[\w.:-]{1,100}$/.test(type)) throw new Error('Invalid Connector event type');
  const remoteSessionKey = typeof data.sessionKey === 'string' ? data.sessionKey : undefined;
  const hubSessionId = remoteSessionKey ? encodeHubSessionId(connection.id, remoteSessionKey) : undefined;
  return { envConnectionId: connection.id, envConnectionLabel: connection.label, hubSessionId,
    sessionRef: remoteSessionKey ? sessionRef(connection.nodeId, remoteSessionKey) : undefined,
    sessionKey: hubSessionId, remoteSessionKey, remoteEventId: frame.id, type,
    ts: typeof data.ts === 'number' ? data.ts : Date.now(), payload: data.payload,
    agentId: typeof data.agentId === 'string' ? data.agentId : undefined };
}
