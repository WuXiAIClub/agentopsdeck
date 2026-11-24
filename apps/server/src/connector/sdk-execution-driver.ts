import { randomUUID } from 'node:crypto';
import type { SdkTurnContext } from './sdk-turn-context.js';
import type { TurnQueue } from '../commands/turn-queue.js';
import { SdkDispatch, type SdkTextInput, type SdkDispatchAdapter } from './sdk-dispatch.js';
import type { SdkExecution, SdkExecutionRef, SdkExecutionJournal, SdkTerminalOutcome } from './sdk-execution-journal.js';
import type { AdmissionPause } from '../lifecycle/request-drain.js';
import type { DatabaseSync } from 'node:sqlite';
import { SdkCompactDispatch, type SdkCompactExecution } from './sdk-compact-dispatch.js';
import type { SdkOwnedCompactWorker } from './sdk-compact-worker.js';

export type SdkOwnedTurn = { finished: Promise<void>; inspectQuiescence(): Promise<boolean> };
export type SdkDriverOptions<T extends SdkOwnedTurn> = {
  journal: SdkExecutionJournal; turns: TurnQueue; deadlineMs: number;
  admissionReady?: () => boolean;
  authorize: (key: string, actor: SdkTextInput, action: 'messages:send' | 'runs:interrupt' | 'runs:compact') => boolean;
  turnContext?: (key: string, actor: SdkTextInput) => SdkTurnContext;
  startCompact?: (execution: SdkCompactExecution) => SdkOwnedCompactWorker;
  compactTimeoutMs?: number;
  start: (execution: SdkExecution, text: string, changed: () => void, context?: SdkTurnContext) => T;
  endStreams: (ref: SdkExecutionRef) => void;
  changed?: (key: string) => void;
  adapter: (callbacks: {
    epoch: string; start: (execution: SdkExecution, text: string, context?: SdkTurnContext) => T;
    terminal: (ref: SdkExecutionRef, outcome: SdkTerminalOutcome) => boolean | Promise<boolean>;
    unknown: (ref: SdkExecutionRef) => void; drained: (ref: SdkExecutionRef) => void;
  }) => SdkDispatchAdapter & { close(): void };
};

/** Internal execution composition behind the owner-authorized runtime routes.
 * The caller must exclusively own the Connector store AND private Agent
 * HOME before providing start; this class does not acquire a HOME lease.
 * Receipt admission owns enqueue/edit/cancel; wake never creates a command.
 * Native completion wakes the next FIFO batch without polling or re-sending
 * unknown work. A browser history request is not needed to advance the queue. */
export class SdkExecutionDriver<T extends SdkOwnedTurn> {
  private readonly adapter: SdkDispatchAdapter & { close(): void };
  private readonly dispatch: SdkDispatch;
  private readonly compactDispatch: SdkCompactDispatch;
  private readonly compactWorkers = new Map<string, SdkOwnedCompactWorker>();
  private readonly compactJobs = new Set<Promise<void>>();
  private readonly pumps = new Map<string, Promise<void>>();
  private readonly requested = new Set<string>();
  private readonly workers = new Set<T>();
  private paused = false;
  private pauseLease: AdmissionPause | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;
  private faulted = false;
  private cleanupUnconfirmed = false;

  /** In-memory native ownership complements journal/queue inspection. An
   * empty queue alone never proves that native descendants have exited. */
  inspect() {
    return { nativeWorkers: this.workers.size + this.compactWorkers.size, admissionInFlight: this.pumps.size + this.compactJobs.size,
      admissionPaused: this.paused, cleanupUnconfirmed: this.cleanupUnconfirmed,
      faulted: this.faulted, closed: this.closed };
  }

  constructor(private readonly options: SdkDriverOptions<T>) {
    const { journal, turns } = options;
    this.adapter = options.adapter({ epoch: randomUUID(),
      start: (execution, text, context) => {
        const turn = options.start(execution, text, () => this.notify(execution.key), context);
        this.workers.add(turn);
        // Cleanup is still verified by the turn/adapter before settlement.
        // finished can reject; never create an unhandled rejection here.
        void turn.finished.then(async () => {
          try { if (!await turn.inspectQuiescence()) this.cleanupUnconfirmed = true; }
          catch { this.cleanupUnconfirmed = true; }
          finally {
            this.finishWorker(turn, execution);
          }
        }, () => {
          this.cleanupUnconfirmed = true; this.finishWorker(turn, execution);
        });
        return turn;
      },
      terminal: (ref, outcome) => {
        const accepted = this.dispatch.terminal(ref, outcome);
        this.notify(ref.key); return accepted;
      },
      unknown: ref => { journal.markUnknown(ref, turns); this.notify(ref.key); },
      drained: ref => { void this.wake(ref.key); },
    });
    this.dispatch = new SdkDispatch({ adapter: this.adapter, journal: journal,
      turns: turns, authorize: (key, actor, action) => journal.checkPermission(options.authorize,
        [key, actor, action], options), deadlineMs: options.deadlineMs,
      ...(options.turnContext ? { turnContext: options.turnContext } : {}) });
    const driver = this;
    this.compactDispatch = new SdkCompactDispatch({ journal, turns,
      deadlineMs: options.compactTimeoutMs ?? 600_000,
      authorize: (key, actorId, action) => journal.checkPermission(options.authorize,
        [key, { actorId, text: '', images: [] }, action], options),
      adapter: {
        runtime: journal.runtime, get epoch() { return driver.adapter.epoch; },
        get ready() { return !!options.startCompact && driver.adapter.ready && !driver.closed && !driver.cleanupUnconfirmed; },
        compact: async execution => {
          if (!options.startCompact || this.compactWorkers.has(execution.key)) throw new Error('Compact worker unavailable');
          const worker = options.startCompact(execution); this.compactWorkers.set(execution.key, worker);
          this.notify(execution.key);
          return worker.result;
        },
        inspectSettlement: execution => {
          const worker = this.compactWorkers.get(execution.key);
          if (!worker) throw new Error('Compact worker not owned');
          return worker.inspectSettlement();
        },
        interruptCompact: execution => {
          const worker = this.compactWorkers.get(execution.key);
          if (!worker) throw new Error('Compact worker not owned');
          return worker.interrupt();
        },
      },
    });
  }

  /** Admission/receipt is synchronous; native completion runs independently of
   * HTTP lifetime. A disconnected client must inspect its receipt, not replay. */
  compact(key: string, id: string, actorId: string, commit: (db: DatabaseSync) => void, signal?: AbortSignal): boolean {
    if (this.closed || this.paused || this.faulted || this.cleanupUnconfirmed || this.options.admissionReady?.() === false
      || !this.adapter.epoch || !this.options.startCompact) return false;
    let admitted = false, commitError: unknown;
    const ref = { key, id, epoch: this.adapter.epoch };
    const dispatched = this.compactDispatch.dispatch(ref, actorId, db => {
      try {
        // Preserve the original callback identity and SQL owner. An escaped
        // continuation must roll back, not set admission or start native work.
        this.options.journal.checkAuthority(commit, undefined, [db]);
        admitted = true;
      } catch (error) { commitError = error; throw error; }
    }, signal);
    const job = dispatched.then(async result => {
      const current = this.options.journal.current(key);
      if (result === 'accepted' && current?.kind === 'compact' && current.id === id) {
        await this.compactDispatch.settle(current);
      }
    }).catch(() => { if (admitted) this.options.journal.markUnknown(ref, this.options.turns); }).finally(async () => {
      const worker = admitted ? this.compactWorkers.get(key) : undefined;
      try { if (worker) {
        // Even a timeout keeps ownership until the exact worker group is gone.
        worker.close(); await worker.finished;
        if (!await worker.inspectQuiescence()) this.cleanupUnconfirmed = true;
      } } catch { this.cleanupUnconfirmed = true; }
      finally {
        if (worker && this.compactWorkers.get(key) === worker) this.compactWorkers.delete(key);
        this.compactJobs.delete(job); this.notify(key); void this.wake(key);
      }
    });
    this.compactJobs.add(job);
    if (commitError) throw commitError;
    return admitted;
  }

  wake(key: string): Promise<void> {
    if (this.closed || !key.startsWith(`${this.options.journal.runtime}:`)) return Promise.resolve();
    this.requested.add(key);
    const existing = this.pumps.get(key);
    if (existing) return existing;
    const task = Promise.resolve().then(async () => {
      while (!this.closed && this.requested.delete(key)) {
        const current = this.options.journal.current(key);
        // Settlement remains allowed during an admission pause. A pause
        // alone neither interrupts native work nor declares it complete.
        if (current?.phase === 'settling') {
          if (current.kind === 'compact') await this.compactDispatch.settle(current);
          else await this.dispatch.settle(current);
        }
        if (!this.paused && !this.closed && !this.cleanupUnconfirmed
          && this.options.admissionReady?.() !== false) await this.dispatch.dispatch(key);
        this.notify(key);
      }
    }).catch(() => {
      // A journal/observer failure must not turn into automatic retry. Keep
      // the entire driver's admission fence closed until explicit recovery.
      this.faulted = true; this.paused = true; this.dispatch.pause();
      try {
        const current = this.options.journal.current(key);
        if (current) this.options.journal.markUnknown(current, this.options.turns);
      } catch { /* keep fenced */ }
      this.notify(key);
    }).finally(() => {
      this.pumps.delete(key);
      // A drain notification can arrive after the loop exits but before this
      // promise's finally runs. Do not lose that wakeup behind the old task.
      if (!this.closed && this.requested.has(key)) void this.wake(key);
    });
    this.pumps.set(key, task);
    return task;
  }

  async interrupt(key: string, expectedRunId: string, actor: SdkTextInput) {
    if (this.closed || this.options.admissionReady?.() === false) return 'not_started' as const;
    const current = this.options.journal.current(key);
    if (!current || current.id !== expectedRunId) return 'not_started' as const;
    const result = current.kind === 'compact'
      ? await this.compactDispatch.interrupt(current, actor.actorId)
      : await this.dispatch.interrupt(current, actor);
    this.notify(key); return result;
  }

  /** Drains queue admission calls, NOT native runs. Maintenance must also
   * inspect SDK journal + native quiescence before stopping/backing up. */
  pauseQueueWorker(): AdmissionPause {
    if (this.closed) throw new Error('SDK driver is closed');
    if (this.pauseLease) return this.pauseLease;
    this.paused = true; this.dispatch.pause(); this.compactDispatch.pause();
    let drained = false;
    const lease: AdmissionPause = {
      drained: Promise.all([...this.pumps.values()]).then(() => { drained = true; }),
      resume: () => {
        if (this.closed || this.faulted || this.cleanupUnconfirmed || !drained || this.pauseLease !== lease) return false;
        this.pauseLease = undefined; this.paused = false; this.dispatch.resume(); this.compactDispatch.resume();
        for (const key of this.options.turns.sessions(this.options.journal.runtime)) void this.wake(key);
        return true;
      },
    };
    this.pauseLease = lease;
    return lease;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.paused = true; this.dispatch.pause(); this.requested.clear();
    this.compactDispatch.pause();
    for (const worker of this.compactWorkers.values()) worker.close();
    this.adapter.close();
    this.closing = (async () => {
      const results = await Promise.allSettled([...this.compactJobs, ...this.pumps.values(), ...[...this.workers].map(async turn => {
        await turn.finished;
        if (!await turn.inspectQuiescence()) throw new Error('SDK worker cleanup is unconfirmed');
      })]);
      if (this.cleanupUnconfirmed || results.some(result => result.status === 'rejected')) throw new Error('SDK worker cleanup is unconfirmed');
    })();
    return this.closing;
  }

  private notify(key: string) {
    // Notification is best-effort. Durable transcript/journal remains the
    // source of truth and can be read again after a disconnected UI returns.
    try { this.options.changed?.(key); } catch { /* never expose subscriber errors/native content */ }
  }

  private finishWorker(turn: T, execution: SdkExecutionRef) {
    // Projection failures must not leak a rejected promise or leave a dead
    // worker in maintenance counts. Fence admission without inventing a new
    // terminal outcome for an already durable execution.
    try { this.options.endStreams(execution); }
    catch { this.faulted = true; this.paused = true; this.dispatch.pause(); }
    finally { this.workers.delete(turn); this.notify(execution.key); }
  }
}
