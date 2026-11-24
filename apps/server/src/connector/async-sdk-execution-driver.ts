import { randomUUID } from 'node:crypto';
import type { ApplicationCommandScope } from '../auth/application-command-scope.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { AsyncSdkDispatch } from './async-sdk-dispatch.js';
import { AsyncSdkProjection } from './async-sdk-projection.js';
import { AsyncSdkInteractions, type SdkInteractionRuntime } from './async-sdk-interaction.js';
import { AsyncSdkCompactDriver, type AsyncSdkCompactOptions } from './async-sdk-compact-driver.js';
import type { WorkerInteractionContext } from '../commands/interaction-port.js';
import type { SdkDispatchAdapter, SdkTextInput } from './sdk-dispatch.js';
import type { SdkAgentId, SdkCompactRef, SdkExecution, SdkExecutionRef, SdkTerminalOutcome } from './sdk-execution-journal.js';
import type { SdkOwnedTurn } from './sdk-execution-driver.js';
import type { SdkInputAttachment } from './sdk-attachment-input.js';
import type { SdkTurnContext } from './sdk-turn-context.js';
import type { AdmissionPause } from '../lifecycle/request-drain.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import type { SdkMessageStopRequest } from './connector-sdk-stop-domain.js';

export type AsyncSdkDriverOptions<T extends SdkOwnedTurn> = {
  owner: Pick<AsyncConnectorOwner, 'command'>; runtime: SdkAgentId; deadlineMs: number;
  admissionReady: () => boolean;
  interactions?: SdkInteractionRuntime;
  compact?: AsyncSdkCompactOptions;
  turnContext?: (key: string, actor: SdkTextInput) => SdkTurnContext | Promise<SdkTurnContext>;
  changed?: (key: string) => void; diagnostics?: PerformanceDiagnostics;
  start: (execution: SdkExecution, text: string, projection: AsyncSdkProjection,
    context?: SdkTurnContext, attachments?: SdkInputAttachment[], interaction?: WorkerInteractionContext) => T;
  adapter: (callbacks: {
    epoch: string;
    start: (execution: SdkExecution, text: string, context?: SdkTurnContext, attachments?: SdkInputAttachment[], interaction?: WorkerInteractionContext) => T;
    terminal: (ref: SdkExecutionRef, outcome: SdkTerminalOutcome) => Promise<boolean>;
    unknown: (ref: SdkExecutionRef) => void; drained: (ref: SdkExecutionRef) => void;
  }) => SdkDispatchAdapter & { close(): void };
};
type Intent<T> = { ref: SdkCompactRef; turn?: T; cleanup?: Promise<void>; cleaned: boolean; settled: boolean };

/** Original vendor adapters + sole worker owner. No main-thread SQL/journal,
 * inferred permission, timer polling or unknown replay. HOME ownership and
 * HOME ownership belongs to the enclosing runtime. */
export class AsyncSdkExecutionDriver<T extends SdkOwnedTurn> {
  private readonly adapter: SdkDispatchAdapter & { close(): void };
  private readonly dispatch: AsyncSdkDispatch;
  private readonly projection: AsyncSdkProjection;
  private readonly interactions: AsyncSdkInteractions | undefined;
  private readonly compaction: AsyncSdkCompactDriver | undefined;
  private readonly intents = new Map<string, Intent<T>>();
  private readonly pumps = new Map<string, Promise<void>>();
  private readonly requested = new Set<string>();
  private readonly writes = new Set<Promise<unknown>>();
  private readonly scans = new Set<Promise<void>>();
  private scanEpoch = 0;
  private paused = false;
  private closed = false;
  private faulted = false;
  private cleanupUnconfirmed = false;
  private pauseLease: AdmissionPause | undefined;
  private closing: Promise<void> | undefined;

  constructor(private readonly options: AsyncSdkDriverOptions<T>) {
    this.interactions = options.interactions ? new AsyncSdkInteractions({ owner: options.owner,
      runtime: options.runtime, interactions: options.interactions }) : undefined;
    this.projection = new AsyncSdkProjection({ owner: options.owner, runtime: options.runtime,
      ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}), changed: key => this.notify(key),
      faulted: ref => { this.fence(1); this.markUnknown(ref); } });
    this.adapter = options.adapter({ epoch: randomUUID(),
      start: (execution, text, context, attachments, interaction) => {
        if (!this.available() || this.compaction?.has(execution.key) || this.intents.has(execution.key) || this.intents.size >= 128) {
          throw Error('connector_storage_unavailable');
        }
        const intent: Intent<T> = { ref: this.ref(execution), cleaned: false, settled: false };
        this.intents.set(execution.key, intent);
        let turn: T;
        try { turn = options.start(execution, text, this.projection, context, attachments, interaction); }
        catch (error) { this.cleanupUnconfirmed = true; this.fence(2); this.markUnknown(intent.ref); throw error; }
        intent.turn = turn;
        intent.cleanup = Promise.resolve(turn.finished).then(async () => {
          try {
            if (await turn.inspectQuiescence() === true) {
              await this.interactions?.release(intent.ref);
              intent.cleaned = true;
            } else { this.cleanupUnconfirmed = true; this.fence(3); this.markUnknown(intent.ref); }
          } catch { this.cleanupUnconfirmed = true; this.fence(3); this.markUnknown(intent.ref); }
        }, () => { this.cleanupUnconfirmed = true; this.fence(3); this.markUnknown(intent.ref); })
          .finally(() => { this.notify(execution.key); void this.wake(execution.key); });
        return turn;
      },
      terminal: (ref, outcome) => {
        const current = this.owned(ref);
        if (!current) return Promise.resolve(false);
        const task = this.dispatch.terminal(current.ref, outcome).then(value => { this.notify(ref.key); return value; });
        return this.track(task);
      },
      unknown: ref => { const intent = this.owned(ref); if (intent) this.markUnknown(intent.ref); },
      drained: ref => { if (this.owned(ref)) void this.wake(ref.key); },
    });
    this.dispatch = new AsyncSdkDispatch({ owner: options.owner, runtime: options.runtime, adapter: this.adapter,
      deadlineMs: options.deadlineMs, persistence: this.projection,
      ...(this.interactions ? { interactions: this.interactions } : {}),
      ...(options.turnContext ? { turnContext: options.turnContext } : {}),
      ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}) });
    this.compaction = options.compact ? new AsyncSdkCompactDriver({ ...options.compact,
      owner: options.owner, runtime: options.runtime, epoch: this.adapter.epoch!, deadlineMs: options.compact.timeoutMs ?? options.deadlineMs,
      ready: () => !this.closed && !this.faulted && !this.cleanupUnconfirmed
        && options.admissionReady() === true && this.adapter.ready === true,
      controlReady: () => !this.closed && !this.faulted && !this.cleanupUnconfirmed && this.adapter.ready === true,
      occupied: key => this.intents.has(key), drained: key => { this.notify(key); void this.wake(key); },
      faulted: () => { this.cleanupUnconfirmed = true; this.fence(12); },
      ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}) }) : undefined;
  }

  inspect() {
    return { nativeWorkers: [...this.intents.values()].filter(intent => intent.turn && !intent.cleaned).length
        + (this.compaction?.inspect().nativeWorkers ?? 0),
      retainedIntents: this.intents.size, admissionInFlight: this.pumps.size + this.scans.size,
      admissionPaused: this.paused, cleanupUnconfirmed: this.cleanupUnconfirmed,
      faulted: this.faulted, closed: this.closed, persistence: this.projection.snapshot() };
  }
  private ref(ref: SdkCompactRef): SdkCompactRef {
    return { key: ref.key, id: ref.id, epoch: ref.epoch, nativeSessionId: ref.nativeSessionId };
  }
  private owned(ref: SdkExecutionRef): Intent<T> | undefined {
    const intent = this.intents.get(ref.key);
    return intent && intent.ref.id === ref.id && intent.ref.epoch === ref.epoch
      && (!('nativeSessionId' in ref) || intent.ref.nativeSessionId === ref.nativeSessionId) ? intent : undefined;
  }
  private available(): boolean {
    if (this.closed || this.paused || this.faulted || this.cleanupUnconfirmed) return false;
    try { return this.options.admissionReady() === true; }
    catch { this.fence(4); return false; }
  }
  private notify(key: string) { try { this.options.changed?.(key); } catch { /* Observer cannot undo an ACK. */ } }
  private fence(step: number) {
    this.faulted = true; this.paused = true; this.scanEpoch++; this.dispatch?.pause();
    const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'sdk-async-driver');
    trace.add('step', step); trace.add('unknown', 1); trace.finish(true);
  }
  private track<P>(task: Promise<P>): Promise<P> {
    this.writes.add(task);
    void task.then(() => this.writes.delete(task), () => this.writes.delete(task));
    return task;
  }
  private markUnknown(ref: SdkCompactRef) {
    // Scheduling also catches a synchronously throwing/failing port. Retain
    // the ORIGINAL command promise; no timeout is permission to close its DB.
    this.track(Promise.resolve().then(() => this.options.owner.command('sdkExecutionUnknown', {
      runtime: this.options.runtime, ref: this.ref(ref),
    })).then(() => { this.notify(ref.key); }, () => { this.fence(5); }));
  }

  wake(key: string): Promise<void> {
    if (this.closed || !key.startsWith(`${this.options.runtime}:`) || key.length > 512) return Promise.resolve();
    const existing = this.pumps.get(key);
    if (!existing && this.pumps.size >= 128) { this.fence(6); return Promise.resolve(); }
    this.requested.add(key);
    if (existing) return existing;
    const task = Promise.resolve().then(async () => {
      while (!this.closed && this.requested.delete(key)) {
        const intent = this.intents.get(key);
        if (intent) {
          const { execution } = await this.options.owner.command('sdkSnapshotRead', { runtime: this.options.runtime, key });
          // Only this driver's original invocation may be settled here. A
          // recovered unknown or foreign epoch is never an invitation to send.
          if (execution?.phase === 'settling' && this.owned(execution) === intent) {
            intent.settled = await this.dispatch.settle(intent.ref);
          }
          if (intent.settled && intent.cleaned) {
            if (!await this.projection.release(intent.ref)) { this.fence(7); continue; }
            this.intents.delete(key);
          }
        }
        if (!this.intents.has(key) && !this.compaction?.has(key) && this.available()) await this.dispatch.dispatch(key);
        this.notify(key);
      }
    }).catch(() => { this.fence(8); const intent = this.intents.get(key); if (intent) this.markUnknown(intent.ref); })
      .finally(() => {
        this.pumps.delete(key);
        if (!this.closed && this.requested.has(key)) void this.wake(key);
      });
    this.pumps.set(key, task); return task;
  }

  async interrupt(key: string, expectedRunId: string, actor: SdkTextInput) {
    const intent = this.intents.get(key);
    // A maintenance admission pause does not suppress an authorized stop.
    if (this.closed || !intent || intent.ref.id !== expectedRunId) return 'not_started' as const;
    const task = this.dispatch.interrupt(intent.ref, actor);
    const result = await this.track(task); this.notify(key); return result;
  }
  async interruptMessage(input: SdkMessageStopRequest, authority?: ApplicationCommandScope) {
    // Capture before the owning worker/admission awaits. A successor intent
    // cannot silently replace the physical target of this HTTP request.
    const request = { ...input }, intent = this.intents.get(request.key);
    const ref = !this.closed && intent ? this.ref(intent.ref) : null;
    const task = !intent && this.compaction?.has(request.key)
      ? this.compaction.interruptMessage(request, authority) : this.dispatch.interruptMessage(request, ref, authority);
    try { return await this.track(task); }
    finally { this.notify(request.key); }
  }
  compact(key: string, commandKey: string, authorization: string, signal?: AbortSignal,
    application?: import('../auth/application-transaction-gate.js').ApplicationTransactionEvidence, authority?: ApplicationCommandScope) {
    // An already in-flight message claim has priority. Once reserved below,
    // subsequent message pumps see the same physical barrier before claiming.
    if (!this.available() || !this.compaction || this.pumps.has(key)) return Promise.resolve('not_started' as const);
    return this.compaction.compact(key, commandKey, authorization, signal, application, authority);
  }
  interruptCompact(key: string, expectedRunId: string, authorization: string) {
    return this.compaction?.interrupt(key, expectedRunId, authorization) ?? Promise.resolve('not_started' as const);
  }
  pauseQueueWorker(): AdmissionPause {
    if (this.closed) throw Error('SDK driver is closed');
    if (this.pauseLease) return this.pauseLease;
    this.paused = true; this.scanEpoch++; this.dispatch.pause();
    this.compaction?.pause();
    let drained = false;
    const lease: AdmissionPause = {
      drained: Promise.all([...this.pumps.values(), ...this.scans]).then(() => { drained = true; }),
      resume: () => {
        if (!drained || this.closed || this.faulted || this.cleanupUnconfirmed || this.pauseLease !== lease) return false;
        this.pauseLease = undefined; this.paused = false; this.dispatch.resume();
        this.compaction?.resume();
        this.scanSessions(); return true;
      },
    };
    this.pauseLease = lease; return lease;
  }
  private scanSessions() {
    const epoch = ++this.scanEpoch;
    const scan = Promise.resolve().then(async () => {
      let after = '';
      while (!this.closed && !this.paused && epoch === this.scanEpoch) {
        const keys = await this.options.owner.command('sdkSessionPage', { runtime: this.options.runtime, after, limit: 64 });
        if (this.closed || this.paused || epoch !== this.scanEpoch) break;
        if (!keys.length) break;
        // Real owner validates page shape; also fail closed for substituted
        // internal ports rather than loop forever on a repeated cursor.
        if (keys.length > 64 || keys.some((key, i) => !key.startsWith(`${this.options.runtime}:`)
          || key <= (i ? keys[i - 1]! : after))) throw Error('connector_storage_unavailable');
        for (const key of keys) {
          if (this.closed || this.paused || epoch !== this.scanEpoch) break;
          await this.wake(key);
        }
        after = keys[keys.length - 1]!;
      }
    }).catch(() => { this.fence(9); }).finally(() => { this.scans.delete(scan); });
    this.scans.add(scan);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.paused = true; this.scanEpoch++; this.requested.clear(); this.dispatch.pause();
    this.interactions?.freeze();
    const compactClosing = this.compaction?.close();
    void compactClosing?.catch(() => {});
    try { this.adapter.close(); } catch { this.cleanupUnconfirmed = true; this.fence(10); }
    this.closing = (async () => {
      await Promise.all([...this.pumps.values(), ...this.scans]);
      await Promise.all([...this.intents.values()].map(intent => intent.cleanup));
      while (this.writes.size) await Promise.allSettled([...this.writes]);
      const cleanup = await Promise.allSettled([this.projection.close(), this.interactions?.close(), compactClosing]);
      while (this.writes.size) await Promise.allSettled([...this.writes]);
      if (cleanup.some(result => result.status === 'rejected') || cleanup[0]?.status !== 'fulfilled'
        || cleanup[0].value !== true || this.cleanupUnconfirmed || this.faulted) throw Error('SDK driver cleanup could not be confirmed');
    })();
    return this.closing;
  }
}
