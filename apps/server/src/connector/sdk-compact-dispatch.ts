import type { DatabaseSync } from 'node:sqlite';
import type { TurnQueue } from '../commands/turn-queue.js';
import { runNativeOperation } from './native-operation.js';
import type { SdkAgentId, SdkCompactRef, SdkCompactResult, SdkCompactSettlement,
  SdkExecution, SdkExecutionJournal, SdkExecutionRef } from './sdk-execution-journal.js';
import type { SdkDispatchResult } from './sdk-dispatch.js';

export type SdkCompactExecution = Extract<SdkExecution, { kind: 'compact' }>;
export interface SdkCompactAdapter {
  readonly runtime: SdkAgentId;
  readonly epoch: string | undefined;
  readonly ready: boolean;
  /** Must correlate the native manual boundary and result to this invocation.
   * Do not return raw summaryContent, tool bodies or provider errors. */
  compact(execution: SdkCompactExecution): Promise<SdkCompactRef & SdkCompactResult>;
  inspectSettlement(execution: SdkCompactExecution): Promise<SdkCompactSettlement>;
  /** Absent until the runtime's dedicated compact cancellation is verified.
   * This is NOT ordinary message interrupt/abort. */
  interruptCompact?(execution: SdkCompactExecution): Promise<void>;
}

/** Dedicated native control path. Receipt claim/dedup is
 * owned by the command layer. One fresh intent permits one native invocation;
 * timeout/disconnect never retries it. Completion has its own evidence path,
 * since GHCP compact emits neither a user message nor ordinary session idle. */
export class SdkCompactDispatch {
  private paused = false;
  private readonly settling = new Map<string, { ref: SdkCompactRef; task: Promise<boolean> }>();
  constructor(private readonly options: {
    journal: SdkExecutionJournal; turns: TurnQueue; adapter: SdkCompactAdapter; deadlineMs: number;
    authorize: (key: string, actorId: string, action: 'runs:compact' | 'runs:interrupt') => boolean;
  }) {
    if (options.adapter.runtime !== options.journal.runtime || !Number.isSafeInteger(options.deadlineMs)
      || options.deadlineMs < 1 || options.deadlineMs > 2_147_483_647) throw new Error('Invalid SDK compact dispatcher');
  }

  pause() { this.paused = true; }
  resume() { this.paused = false; }

  async dispatch(ref: SdkExecutionRef, actorId: string, commit: (db: DatabaseSync) => void,
    signal?: AbortSignal): Promise<SdkDispatchResult> {
    ref = { id: ref.id, key: ref.key, epoch: ref.epoch };
    const { adapter, journal, turns } = this.options;
    if (this.paused || signal?.aborted || !this.available(ref)) return 'not_started';
    if (!journal.checkPermission(this.options.authorize, [ref.key, actorId, 'runs:compact'], this.options)) return 'blocked';
    // No await between fresh authorization, durable intent/receipt and native
    // invocation. The journal also enforces store ownership and queue fences.
    const execution = journal.beginCompact(ref, actorId, turns, db => {
      if (this.paused || signal?.aborted || !this.available(ref)
        || !journal.checkPermission(this.options.authorize, [ref.key, actorId, 'runs:compact'], this.options)) throw new Error('SDK compact admission changed');
      journal.checkAuthority(commit, undefined, [db]);
    });
    if (!execution || execution.kind !== 'compact') return 'not_started';
    try {
      const result = await runNativeOperation(() => adapter.compact(structuredClone(execution)), {
        // Admission is durable. Losing the HTTP connection afterwards must
        // neither cancel native work nor trigger an implicit retry.
        timeoutMs: this.options.deadlineMs,
      });
      if (!this.available(ref) || !this.matches(result, execution)
        || result.nativeSessionId !== execution.nativeSessionId) return this.unknown(ref);
      return journal.observeCompactTerminal(execution, result) ? 'accepted' : this.unknown(ref);
    } catch { return this.unknown(ref); }
  }

  async interrupt(ref: SdkCompactRef, actorId: string): Promise<SdkDispatchResult> {
    ref = { id: ref.id, key: ref.key, epoch: ref.epoch, nativeSessionId: ref.nativeSessionId };
    const { journal, adapter } = this.options;
    const execution = journal.current(ref.key);
    if (!execution || execution.kind !== 'compact' || !this.matches(execution, ref)
      || execution.nativeSessionId !== ref.nativeSessionId || !this.available(ref)
      || !adapter.interruptCompact) return 'not_started';
    if (!journal.checkPermission(this.options.authorize, [ref.key, actorId, 'runs:interrupt'], this.options)) return 'blocked';
    if (!journal.requestCompactStop(ref)) return 'not_started';
    try {
      await runNativeOperation(() => adapter.interruptCompact!(structuredClone({ ...execution, stopRequested: true })),
        { timeoutMs: this.options.deadlineMs });
      // Stop ACK is not terminal evidence. Original compact must still settle.
      return this.available(ref) ? 'accepted' : this.unknown(ref);
    } catch { return this.unknown(ref); }
  }

  settle(ref: SdkCompactRef): Promise<boolean> {
    ref = { id: ref.id, key: ref.key, epoch: ref.epoch, nativeSessionId: ref.nativeSessionId };
    const existing = this.settling.get(ref.key);
    if (existing) return this.matches(existing.ref, ref) && existing.ref.nativeSessionId === ref.nativeSessionId ? existing.task : Promise.resolve(false);
    const task = this.inspectAndSettle(ref).finally(() => { this.settling.delete(ref.key); });
    this.settling.set(ref.key, { ref: { ...ref }, task });
    return task;
  }

  private async inspectAndSettle(ref: SdkCompactRef): Promise<boolean> {
    const { journal, adapter } = this.options;
    const execution = journal.current(ref.key);
    if (!execution || execution.kind !== 'compact' || execution.phase !== 'settling'
      || !this.matches(execution, ref) || execution.nativeSessionId !== ref.nativeSessionId || !this.available(ref)) return false;
    try {
      const proof = await runNativeOperation(() => adapter.inspectSettlement(structuredClone(execution)), { timeoutMs: this.options.deadlineMs });
      if (!this.available(ref) || !this.matches(proof, execution) || proof.nativeSessionId !== execution.nativeSessionId
        || proof.completionEventId !== execution.control.completionEventId) { this.unknown(ref); return false; }
      return journal.confirmCompactSettled(proof);
    } catch { this.unknown(ref); return false; }
  }

  private available(ref: SdkExecutionRef) { return this.options.adapter.ready && !!ref.epoch && this.options.adapter.epoch === ref.epoch; }
  private matches(actual: SdkExecutionRef, expected: SdkExecutionRef) {
    return actual?.key === expected.key && actual.id === expected.id && actual.epoch === expected.epoch;
  }
  private unknown(ref: SdkExecutionRef): 'unknown' {
    this.options.journal.markUnknown(ref, this.options.turns);
    return 'unknown';
  }
}
