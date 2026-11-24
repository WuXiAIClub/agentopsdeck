import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ExecutionProjectionChanged, executionProjectionInventory } from './execution-projection-inventory.js';
import { ConnectorOwnerUnavailable, encodeConnectorOwnerJson, validConnectorOwnerOutput } from './connector-owner-domain.js';
import { CONNECTOR_NATIVE_REPLY_COMMAND_BYTES } from './connector-native-reply-domain.js';
import type { OpenClawExecution } from '../openclaw/executions.js';
import type { DeckStore } from '../projection/deck-store.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

type Options = {
  owner: Pick<AsyncConnectorOwner, 'command'>;
  deck: DeckStore;
  connectionId(): string | undefined;
  // Trusted, same-owner AsyncOpenClawTurnQueue.observe, never an HTTP hook.
  observe(raw: unknown, connectionId: string | undefined): Promise<boolean>;
  diagnostics?: PerformanceDiagnostics;
  maxFacts?: number;
};
const MAX_BYTES = 16 * 1024 * 1024, MAX_EVENTS = 8 * 1024 * 1024, MAX_PENDING = 128;
const validKey = (key: unknown): key is string => typeof key === 'string' && key.trim().length > 0
  && Buffer.byteLength(key) <= 4096 && !/^(?:codex|hermes|claude-code|ghcp):/.test(key);

/** Bounded DISPLAY observations from the original worker, not a grant cache,
 * execution journal or idle proof. Bind before discovery; open under the root's
 * startup gate; start the original queue only after open. Close queue/transport
 * admission first, this consumer next, shared owner last. Never opens a DB. */
export class AsyncOpenClawProjection {
  private facts = new Map<string, OpenClawExecution>();
  private factBytes = 0;
  private ready = false;
  private failed = false;
  private closing = false;
  private readonly maxFacts: number;
  private tail: Promise<void> = Promise.resolve();
  private readonly tasks = new Set<Promise<unknown>>();
  private count = 0;
  private eventBytes = 0;
  private opening: Promise<void> | undefined;
  private closeWork: Promise<void> | undefined;
  private refreshWork: Promise<void> | undefined;
  private refreshGeneration = 0;
  constructor(private readonly options: Options) {
    this.maxFacts = options.maxFacts ?? 4096;
    if (!Number.isSafeInteger(this.maxFacts) || this.maxFacts < 1 || this.maxFacts > 100_000) throw new ConnectorOwnerUnavailable();
    options.deck.bindOpenClawExecutionProjection({
      get: key => { this.readable(); return this.facts.get(key); },
      sessionPage: (after = '', limit = 16) => {
        this.readable();
        // Bytewise ordering matches SQLite's original BINARY primary key.
        return [...this.facts.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
          .filter(key => Buffer.compare(Buffer.from(key), Buffer.from(after)) > 0).slice(0, Math.max(1, Math.min(limit, 64)));
      },
    }, options.connectionId);
  }
  status() { return Object.freeze({ ready: this.ready, unavailable: this.failed, closing: this.closing,
    facts: this.facts.size, factBytes: this.factBytes, pending: this.count, eventBytes: this.eventBytes }); }
  private readable() { if (!this.ready || this.failed) throw new ConnectorOwnerUnavailable(); }
  private fail(step: number) {
    this.failed = true;
    try { this.options.deck.invalidateOpenClawExecutionFacts(); } catch { /* Availability remains latched locally. */ }
    const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'openclaw-projection');
    trace.add('step', step); trace.add('pending', this.count); trace.finish(true);
  }
  private retain<T>(work: Promise<T>): Promise<T> {
    this.tasks.add(work);
    void work.then(() => this.tasks.delete(work), () => this.tasks.delete(work));
    return work;
  }
  private enqueue<T>(step: number, work: () => Promise<T>, accepted = false): Promise<T> {
    if ((!accepted && (this.closing || this.tasks.size >= MAX_PENDING)) || this.failed || this.count >= MAX_PENDING) {
      this.fail(step); return Promise.reject(new ConnectorOwnerUnavailable());
    }
    this.count++;
    const result = this.tail.then(async () => {
      if (this.failed) throw new ConnectorOwnerUnavailable();
      const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'openclaw-projection');
      trace.add('step', step); trace.add('pending', this.count);
      try { const value = await work(); trace.add('settled', 1); trace.finish(); return value; } catch (error) {
        trace.finish(true);
        if (error instanceof ExecutionProjectionChanged) throw error;
        this.fail(step);
        throw new ConnectorOwnerUnavailable();
      }
    }).finally(() => { this.count--; });
    this.tail = result.then(() => {}, () => {});
    return this.retain(result);
  }
  private async read(key: string) {
    if (!validKey(key)) throw new ConnectorOwnerUnavailable();
    const result = await this.options.owner.command('openClawExecutionRead', { sessionKey: key });
    if (!validConnectorOwnerOutput('openClawExecutionRead', result) || result && result.sessionKey !== key)
      throw new ConnectorOwnerUnavailable();
    // Do not retain owner/caller references in the display snapshot.
    return result ? JSON.parse(encodeConnectorOwnerJson(result)) as OpenClawExecution : null;
  }
  private decodeInventoryFact(fact: unknown, key: string) {
    if (!validConnectorOwnerOutput('openClawExecutionRead', fact)) throw new ConnectorOwnerUnavailable();
    const checked = fact as OpenClawExecution | null;
    if (checked && checked.sessionKey !== key) throw new ConnectorOwnerUnavailable();
    return checked;
  }
  private bytes(fact: OpenClawExecution | null | undefined) { return fact ? Buffer.byteLength(JSON.stringify(fact)) : 0; }
  open(): Promise<void> {
    if (this.opening) return this.opening;
    return this.opening = this.enqueue(1, async () => {
      // Other original runtimes may commit while their preflights start. Use
      // the same bounded causal inventory as refresh: retry reads, never an
      // execution or partial publication. Corrupt/stable missing facts fail.
      const next = await executionProjectionInventory({ owner: this.options.owner, runtime: 'openclaw', validKey,
        decode: (fact, key) => this.decodeInventoryFact(fact, key), maxFacts: this.maxFacts, maxBytes: MAX_BYTES });
      if (this.closing) throw new ExecutionProjectionChanged();
      this.facts = next.facts; this.factBytes = next.bytes; this.ready = true;
      this.options.deck.projectOpenClawConnection();
    });
  }
  private refresh(key: string, accepted = false): Promise<void> {
    return this.enqueue(2, async () => {
      this.readable();
      const fact = await this.read(key);
      const bytes = this.factBytes - this.bytes(this.facts.get(key)) + this.bytes(fact);
      if (bytes > MAX_BYTES || fact && !this.facts.has(key) && this.facts.size >= this.maxFacts) throw new ConnectorOwnerUnavailable();
      if (fact) this.facts.set(key, fact); else this.facts.delete(key);
      this.factBytes = bytes;
      this.options.deck.projectOpenClawExecution(key);
    }, accepted);
  }
  // Ignore a potentially late caller snapshot: reread in the SAME serialized
  // read/publish lane. Dispatch/observe/settlement must await this callback.
  project(key: string, _committed?: OpenClawExecution | null): Promise<void> { return this.refresh(key); }
  /** Same-worker execution-facts refresh, without connection timestamps,
   * display events, native effects or inferred unlocks. */
  readonly refreshProjection = (): Promise<void> => {
    if (this.closing || this.failed || !this.ready) return Promise.reject(new ConnectorOwnerUnavailable());
    ++this.refreshGeneration;
    if (this.refreshWork) return this.refreshWork;
    const work = this.enqueue(6, async () => {
      this.readable();
      for (let attempt = 0; attempt < 4; attempt++) {
        const generation = this.refreshGeneration;
        const next = await executionProjectionInventory({ owner: this.options.owner, runtime: 'openclaw', validKey,
          decode: (fact, key) => this.decodeInventoryFact(fact, key), maxFacts: this.maxFacts, maxBytes: MAX_BYTES });
        if (this.closing) throw new ExecutionProjectionChanged();
        if (generation !== this.refreshGeneration) continue;
        this.facts = next.facts; this.factBytes = next.bytes; return;
      }
      throw new ExecutionProjectionChanged();
    });
    this.refreshWork = work;
    const clear = () => { if (this.refreshWork === work) this.refreshWork = undefined; };
    void work.then(clear, clear);
    return work;
  };
  connectionChanged(): Promise<void> {
    return this.enqueue(3, async () => { this.readable(); this.options.deck.projectOpenClawConnection(); });
  }
  observe(raw: unknown, connectionId: string | undefined): Promise<boolean> {
    if (this.closing || this.failed || !this.ready) return Promise.reject(new ConnectorOwnerUnavailable());
    let copied: any, bytes: number;
    try {
      const json = encodeConnectorOwnerJson(raw, CONNECTOR_NATIVE_REPLY_COMMAND_BYTES);
      bytes = Buffer.byteLength(json); copied = JSON.parse(json);
      if (this.count >= MAX_PENDING || this.tasks.size >= MAX_PENDING || this.eventBytes + bytes > MAX_EVENTS) throw new ConnectorOwnerUnavailable();
    } catch { this.fail(4); return Promise.reject(new ConnectorOwnerUnavailable()); }
    const payload = copied?.payload ?? copied?.data ?? copied;
    const key = payload?.sessionKey ?? payload?.session?.key ?? payload?.session?.sessionKey ?? copied?.sessionKey;
    // Foreign runtimes must not enter OpenClaw's display or journal.
    if (key !== undefined && !validKey(key)) return Promise.resolve(false);
    this.eventBytes += bytes;
    const result = (async () => {
      try {
        const observed = await this.options.observe(copied, connectionId);
        // Queue.observe may itself call project(). Never hold this lane while
        // waiting for the original queue's persistence/project callback.
        if (key) await this.refresh(key, true);
        await this.enqueue(5, async () => {
          this.readable(); this.options.deck.presentCommittedGatewayEvent(copied, observed);
        }, true);
        return observed;
      } catch { this.fail(4); throw new ConnectorOwnerUnavailable(); }
      finally { this.eventBytes -= bytes; }
    })();
    return this.retain(result);
  }
  close(): Promise<void> {
    this.closing = true;
    return this.closeWork ??= (async () => {
      while (this.tasks.size) await Promise.allSettled([...this.tasks]);
    })();
  }
}
