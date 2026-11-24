import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable, encodeConnectorOwnerJson, validConnectorOwnerOutput } from './connector-owner-domain.js';
import { validConnectorCodexNotificationInput } from './connector-codex-notification-domain.js';
import type { CodexExecution } from '../codex/executions.js';
import type { CodexNativeNotification } from '../codex/native-notification.js';
import type { DeckStore, CodexExecutionProjection } from '../projection/deck-store.js';
import type { CodexNativeJournal } from '../codex/app-server.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { ExecutionProjectionChanged, executionProjectionInventory } from './execution-projection-inventory.js';

type Options = {
  owner: Pick<AsyncConnectorOwner, 'command'>;
  deck: DeckStore;
  connectionId(): string | undefined;
  diagnostics?: PerformanceDiagnostics;
  maxFacts?: number;
  /** Let the original runtime bind its complete journal/view pair instead. */
  bind?: boolean;
};
const MAX_BYTES = 16 * 1024 * 1024, MAX_PENDING = 128;
const binary = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const validKey = (key: unknown): key is string => typeof key === 'string' && key.startsWith('codex:')
  && key.length > 6 && Buffer.byteLength(key) <= 4096 && !/[\u0000-\u001f\u007f]/.test(key);
const copy = (fact: CodexExecution) => JSON.parse(encodeConnectorOwnerJson(fact)) as CodexExecution;

/** Cached view is DISPLAY only, never authority or execution protection. The
 * journal port delegates authoritative reads and CAS to the same worker. Open while the original
 * startup gate holds native/queue admission; all later mutations must await their
 * refresh in this lane. The native observation owner still owns notification and
 * connection ordering. This consumer never constructs a store or native executor.
 * Close original producers first, this consumer next, the shared owner last. */
export class AsyncCodexProjection {
  private facts = new Map<string, CodexExecution>();
  private factBytes = 0;
  private ready = false;
  private failed = false;
  private closing = false;
  private generation = 0;
  private readonly maxFacts: number;
  private tail: Promise<void> = Promise.resolve();
  private readonly tasks = new Set<Promise<unknown>>();
  private opening?: Promise<void>;
  private closeWork?: Promise<void>;
  private refreshWork: Promise<void> | undefined;
  private refreshGeneration = 0;
  private readonly view: CodexExecutionProjection;
  constructor(private readonly options: Options) {
    this.maxFacts = options.maxFacts ?? 2048;
    if (!Number.isSafeInteger(this.maxFacts) || this.maxFacts < 1 || this.maxFacts > 2048) throw new ConnectorOwnerUnavailable();
    this.view = {
      get: key => { this.viewReadable(); const fact = this.facts.get(key); return fact ? copy(fact) : undefined; },
      sessionPage: (after = '', limit = 16) => {
        this.viewReadable();
        if (typeof after !== 'string' || !Number.isSafeInteger(limit) || limit < 1) throw new ConnectorOwnerUnavailable();
        return [...this.facts.keys()].sort(binary).filter(key => binary(key, after) > 0).slice(0, Math.min(limit, 64));
      },
    };
    if (options.bind !== false) options.deck.bindCodexExecutionProjection(this.view, options.connectionId);
  }
  /** The original receiver owns generation checks and publication. Refresh
   * facts here, but never publish ahead of its post-await connection fence. */
  nativeJournal(): CodexNativeJournal {
    return {
      projection: this.view,
      fileIndexProjection: input => {
        const accepted = structuredClone(input);
        return this.enqueue(19, async () => {
          this.readable();
          const result = await this.options.owner.command('codexFileIndexProjection', accepted);
          if (typeof result !== 'boolean') throw new ConnectorOwnerUnavailable();
          return result;
        });
      },
      cumulativeUsage: input => {
        const accepted = structuredClone(input);
        return this.enqueue(18, async () => {
          this.readable();
          const result = await this.options.owner.command('codexCumulativeUsage', accepted);
          if (typeof result !== 'boolean') throw new ConnectorOwnerUnavailable();
          return result;
        });
      },
      prepareResume: input => {
        const accepted = structuredClone(input);
        return this.enqueue(15, async () => {
          this.readable();
          const result = await this.options.owner.command('codexResumePrepare', accepted);
          if (!validConnectorOwnerOutput('codexResumePrepare', result)) throw new ConnectorOwnerUnavailable();
          return result;
        });
      },
      beginResume: receipt => {
        const accepted = structuredClone(receipt);
        return this.enqueue(16, async () => {
          this.readable();
          const result = await this.options.owner.command('codexResumeBegin', accepted);
          if (typeof result !== 'boolean') throw new ConnectorOwnerUnavailable();
          return result;
        });
      },
      finishResume: (receipt, outcome) => {
        const accepted = structuredClone(receipt);
        return this.enqueue(17, async () => {
          this.readable();
          const result = await this.options.owner.command('codexResumeFinish', { receipt: accepted, outcome });
          if (typeof result !== 'boolean') throw new ConnectorOwnerUnavailable();
          if (result && outcome === 'acknowledged') await this.refresh(accepted.sessionKey);
          return result;
        });
      },
      readMaintenance: () => this.enqueue(14, async () => {
        this.readable();
        const result = await this.options.owner.command('codexMaintenanceObservation', {});
        if (!validConnectorOwnerOutput('codexMaintenanceObservation', result)) throw new ConnectorOwnerUnavailable();
        return result;
      }),
      readExecution: key => this.enqueue(7, async () => { this.readable(); return (await this.read(key)) ?? undefined; }),
      readHistory: sessionKey => this.enqueue(11, async () => {
        this.readable();
        const result = await this.options.owner.command('codexHistoryObservation', { sessionKey });
        if (!validConnectorOwnerOutput('codexHistoryObservation', result)
          || result.execution && result.execution.sessionKey !== sessionKey) throw new ConnectorOwnerUnavailable();
        return result;
      }),
      recoverTerminal: (expected, runId, phase) => {
        const accepted = copy(expected);
        return this.enqueue(12, async () => {
          this.readable();
          const result = await this.options.owner.command('codexExecutionRecoverTerminal', { expected: accepted, runId, phase });
          if (typeof result !== 'boolean') throw new ConnectorOwnerUnavailable();
          await this.refresh(accepted.sessionKey); return result;
        });
      },
      observeTerminal: (expected, connectionId, runId, phase) => {
        const accepted = copy(expected);
        return this.enqueue(13, async () => {
          this.readable();
          const result = await this.options.owner.command('codexExecutionObserve', { sessionKey: accepted.sessionKey,
            connectionId, runId, phase, expected: { commandId: accepted.commandId, revision: accepted.revision } });
          if (typeof result !== 'boolean') throw new ConnectorOwnerUnavailable();
          await this.refresh(accepted.sessionKey); return result;
        });
      },
      cleanupRecovered: (sessionKey, runId) => this.enqueue(8, async () => {
        this.readable();
        const result = await this.options.owner.command('codexCleanupRecovered', { sessionKey, runId });
        if (typeof result !== 'boolean') throw new ConnectorOwnerUnavailable();
        return result;
      }),
      settleHistory: (expected, sync, checkpoint) => {
        // Snapshot before this lane can wait behind a notification. A caller
        // cannot retarget a reserved CAS by mutating its original fact.
        const accepted = copy(expected), proof = checkpoint ? { ...checkpoint } : undefined;
        return this.enqueue(9, async () => {
          this.readable();
          const result = proof
            ? await this.options.owner.command('codexNativeHistorySettle', { expected: accepted, checkpoint: proof })
            : await this.options.owner.command('codexHistoryCompareSettle', { expected: accepted, sync });
          if (typeof result !== 'boolean') throw new ConnectorOwnerUnavailable();
          await this.refresh(accepted.sessionKey);
          return result;
        });
      },
      invalidateHistory: sessionKey => this.enqueue(10, async () => {
        this.readable();
        const result = await this.options.owner.command('codexNativeHistoryInvalidate', {
          sessionKey, reason: 'changed', readableSuccessorTurnId: null,
        });
        if (typeof result !== 'boolean') throw new ConnectorOwnerUnavailable();
        await this.refresh(sessionKey);
      }),
      settle: event => this.settle(event, false),
      settleConnectionPage: (after, previous, next) => this.invalidateConnectionPage(after, 64, previous, next),
    };
  }
  status() { return Object.freeze({ ready: this.ready, unavailable: this.failed, closing: this.closing,
    facts: this.facts.size, factBytes: this.factBytes, pending: this.tasks.size }); }
  private readable() { if (!this.ready || this.failed) throw new ConnectorOwnerUnavailable(); }
  // Close invalidates observations immediately, but already admitted journal
  // work must still drain without turning committed work into a failed reply.
  private viewReadable() { this.readable(); if (this.closing) throw new ConnectorOwnerUnavailable(); }
  private fail(step: number) {
    this.failed = true;
    try { this.options.deck.invalidateCodexExecutionFacts(); } catch { /* Keep local failure latched. */ }
    const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'codex-projection');
    trace.add('step', step); trace.add('pending', this.tasks.size); trace.finish(true);
  }
  private enqueue<T>(step: number, work: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new ConnectorOwnerUnavailable());
    if (this.failed || this.tasks.size >= MAX_PENDING) {
      this.fail(step); return Promise.reject(new ConnectorOwnerUnavailable());
    }
    const result = this.tail.then(async () => {
      if (this.failed) throw new ConnectorOwnerUnavailable();
      const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'codex-projection');
      trace.add('step', step); trace.add('pending', this.tasks.size);
      try { const value = await work(); trace.add('settled', 1); trace.finish(); return value; }
      catch (error) {
        trace.finish(true);
        if (error instanceof ExecutionProjectionChanged) throw error;
        this.fail(step);
        throw new ConnectorOwnerUnavailable();
      }
    });
    this.tasks.add(result);
    this.tail = result.then(() => { this.tasks.delete(result); }, () => { this.tasks.delete(result); });
    return result;
  }
  private async read(key: string) {
    if (!validKey(key)) throw new ConnectorOwnerUnavailable();
    const fact = await this.options.owner.command('codexExecutionRead', { sessionKey: key });
    if (!validConnectorOwnerOutput('codexExecutionRead', fact) || fact && fact.sessionKey !== key) throw new ConnectorOwnerUnavailable();
    return fact ? copy(fact) : null;
  }
  private bytes(fact: CodexExecution | undefined | null) { return fact ? Buffer.byteLength(JSON.stringify(fact)) : 0; }
  private async refresh(key: string) {
    const fact = await this.read(key);
    const bytes = this.factBytes - this.bytes(this.facts.get(key)) + this.bytes(fact);
    if (bytes > MAX_BYTES || fact && !this.facts.has(key) && this.facts.size >= this.maxFacts) throw new ConnectorOwnerUnavailable();
    if (fact) this.facts.set(key, fact); else this.facts.delete(key);
    this.factBytes = bytes;
  }
  private page(value: unknown, after: string): string[] {
    if (!Array.isArray(value) || value.length > 64) throw new ConnectorOwnerUnavailable();
    let cursor = after;
    for (const key of value) {
      if (!validKey(key) || binary(key, cursor) <= 0) throw new ConnectorOwnerUnavailable();
      cursor = key;
    }
    return value;
  }
  private current(generation: number, connection: string | undefined) {
    return !this.closing && generation === this.generation && connection === this.options.connectionId();
  }
  open(): Promise<void> {
    if (this.opening) return this.opening;
    const generation = this.generation, connection = this.options.connectionId();
    return this.opening = this.enqueue(1, async () => {
      const next = new Map<string, CodexExecution>();
      let after = '', bytes = 0;
      for (;;) {
        const page = this.page(await this.options.owner.command('executionSessionPage', { runtime: 'codex', after, limit: 64 }), after);
        if (!page.length) break;
        for (const key of page) {
          const fact = await this.read(key);
          if (!fact || next.size >= this.maxFacts || (bytes += this.bytes(fact)) > MAX_BYTES) throw new ConnectorOwnerUnavailable();
          next.set(key, fact);
        }
        after = page.at(-1)!;
      }
      this.facts = next; this.factBytes = bytes; this.ready = true;
      if (this.current(generation, connection)) this.options.deck.projectCodexConnection();
    });
  }
  // Ignore caller snapshots, including late terminal/verified snapshots. Reread
  // from the SAME owner before allowing the original DeckStore to publish.
  project(key: string, _committed?: CodexExecution | null): Promise<void> {
    const generation = this.generation, connection = this.options.connectionId();
    return this.enqueue(2, async () => {
      this.readable(); await this.refresh(key);
      if (this.current(generation, connection)) this.options.deck.projectCodexExecution(key);
    });
  }
  /** Execution-facts fragment of a global barrier. Silent cache replacement:
   * a read is not a connection transition or a new display event. */
  readonly refreshProjection = (): Promise<void> => {
    if (this.closing || this.failed || !this.ready) return Promise.reject(new ConnectorOwnerUnavailable());
    ++this.refreshGeneration;
    if (this.refreshWork) return this.refreshWork;
    const work = this.enqueue(6, async () => {
      this.readable();
      for (let attempt = 0; attempt < 4; attempt++) {
        const generation = this.refreshGeneration;
        const next = await executionProjectionInventory({ owner: this.options.owner, runtime: 'codex', validKey,
          decode: (fact, key) => {
            if (!validConnectorOwnerOutput('codexExecutionRead', fact)) throw new ConnectorOwnerUnavailable();
            const checked = fact as CodexExecution | null;
            if (checked && checked.sessionKey !== key) throw new ConnectorOwnerUnavailable();
            return checked;
          }, maxFacts: this.maxFacts, maxBytes: MAX_BYTES });
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
    const generation = ++this.generation, connection = this.options.connectionId();
    return this.enqueue(3, async () => {
      this.readable();
      if (this.current(generation, connection)) this.options.deck.projectCodexConnection();
    });
  }
  settle(event: CodexNativeNotification, publish = true) {
    // Snapshot before admission: caller mutation cannot change the accepted
    // worker command while an older publication holds this serialized lane.
    let accepted: CodexNativeNotification;
    try {
      accepted = JSON.parse(encodeConnectorOwnerJson(event, 32 * 1024));
      if (!validConnectorCodexNotificationInput('codexNativeNotification', accepted)) throw new ConnectorOwnerUnavailable();
    }
    catch { this.fail(4); return Promise.reject(new ConnectorOwnerUnavailable()); }
    const generation = this.generation, connection = this.options.connectionId();
    return this.enqueue(4, async () => {
      this.readable();
      const result = await this.options.owner.command('codexNativeNotification', accepted);
      if (!validConnectorOwnerOutput('codexNativeNotification', result)) throw new ConnectorOwnerUnavailable();
      await this.refresh(accepted.sessionKey);
      if (publish && this.current(generation, connection)) this.options.deck.projectCodexExecution(accepted.sessionKey);
      return result;
    });
  }
  invalidateConnectionPage(after: string, limit: number, previous: string | undefined, next: string | undefined) {
    return this.enqueue(5, async () => {
      this.readable();
      const page = this.page(await this.options.owner.command('codexConnectionRecoveryPage', {
        after, limit, previousConnectionId: previous ?? null, nextConnectionId: next ?? null,
      }), after);
      if (page.length > limit) throw new ConnectorOwnerUnavailable();
      for (const key of page) await this.refresh(key);
      // Original observation owner publishes connection state after ALL pages.
      return page;
    });
  }
  close(): Promise<void> {
    this.closing = true;
    // The private tail was attached before exposing any result Promise. A caller
    // replacing public .then cannot counterfeit physical completion during drain.
    return this.closeWork ??= Promise.resolve().then(async () => {
      const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'codex-projection');
      trace.add('step', 6);
      if (this.tasks.size) trace.reportPending({ pending: this.tasks.size });
      await this.tail;
      trace.add('settled', 1); trace.finish(this.failed);
    });
  }
}
