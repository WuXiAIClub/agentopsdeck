import { randomUUID } from 'node:crypto';
import { MAX_MESSAGE_CHARS } from '@agentopsdeck/shared';
import { workerTurnContext, type SdkTurnContext } from './sdk-turn-context.js';
import { describeBatch, waitingBatch } from '../codex/queued-batch.js';
import type { TurnQueue } from '../commands/turn-queue.js';
import type { ExecutionGrantAuthority } from './execution-grants.js';
import type { SdkInputAttachment } from './sdk-attachment-input.js';
import type { WorkerInteractionContext } from '../commands/interaction-port.js';
import { runNativeOperation } from './native-operation.js';
import type { SdkExecution, SdkExecutionJournal, SdkExecutionRef, SdkTerminalOutcome } from './sdk-execution-journal.js';

// Bodies are stored separately; the bounded count also fences batching.
export type SdkTextInput = { text: string; images: []; attachmentCount?: number; actorId: string; executionGrant?: ExecutionGrantAuthority };
export type SdkSettlement = SdkExecutionRef & {
  nativeSessionId: string; historyPersisted: boolean; nativeQuiescent: boolean;
};
export interface SdkDispatchAdapter {
  /** Changes whenever the exclusive native worker is replaced. */
  readonly epoch: string | undefined;
  readonly ready: boolean;
  send(execution: SdkExecution, text: string, context?: SdkTurnContext, attachments?: SdkInputAttachment[],
    interaction?: WorkerInteractionContext): Promise<{ nativeRequestId: string }>;
  interrupt(execution: SdkExecution): Promise<void>;
  /** Must verify durable history and all descendant/background work, not just
   * the SDK's per-model-iteration terminal event or a projected idle label. */
  inspectSettlement(execution: SdkExecution): Promise<SdkSettlement>;
}
export type SdkDispatchResult = 'not_started' | 'blocked' | 'accepted' | 'unknown';

/** Durable queue -> one native invocation. The runtime supplies lifecycle and
 * event projection; this core owns batch/admission/stop/settlement ordering.
 * No polling, automatic retry, unknown reconciliation or process kill here. */
export class SdkDispatch {
  private paused = false;
  private readonly settling = new Map<string, { ref: SdkExecutionRef; task: Promise<boolean> }>();
  constructor(private readonly options: {
    journal: SdkExecutionJournal; turns: TurnQueue; adapter: SdkDispatchAdapter;
    authorize: (key: string, payload: SdkTextInput, action: 'messages:send' | 'runs:interrupt') => boolean;
    turnContext?: (key: string, payload: SdkTextInput) => SdkTurnContext;
    deadlineMs: number;
  }) {
    if (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs < 1 || options.deadlineMs > 2_147_483_647) {
      throw new Error('Invalid SDK operation deadline');
    }
  }

  pause() { this.paused = true; }
  resume() { this.paused = false; }

  async dispatch(key: string, signal?: AbortSignal): Promise<SdkDispatchResult> {
    const { journal, turns, adapter } = this.options;
    const epoch = adapter.epoch;
    if (this.paused || signal?.aborted || !adapter.ready || !epoch || !journal.canStart(key)) return 'not_started';
    const prefix = turns.dispatchPrefix<SdkTextInput>(journal.runtime, key);
    const head = prefix[0];
    if (!head || head.state !== 'queued') return 'not_started';
    const authorized = (payload: SdkTextInput) => this.validInput(payload)
      && journal.checkPermission(this.options.authorize, [key, payload, 'messages:send'], this.options);
    if (!authorized(head.payload)) { turns.block(journal.runtime, head.id); return 'blocked'; }
    const entries = waitingBatch(prefix, entry => authorized(entry.payload));
    // Media inputs retain one native turn per admission. Never combine eight
    // individually valid uploads into an oversized native IPC/model request.
    const mediaIndex = entries.findIndex(entry => !!entry.payload.attachmentCount);
    if (mediaIndex >= 0) entries.splice(mediaIndex === 0 ? 1 : mediaIndex);
    if (!entries.length) return 'not_started';
    let batch = describeBatch(entries);
    let text = entries.map(entry => entry.payload.text).join(batch?.separator ?? '');
    // A batch is one native user message. Respect the same display/input
    // bound, including separators, so its durable echo is never truncated
    // halfway through an admitted member. The remaining FIFO prefix waits.
    while (text.length > MAX_MESSAGE_CHARS && entries.length > 1) {
      entries.pop(); batch = describeBatch(entries);
      text = entries.map(entry => entry.payload.text).join(batch?.separator ?? '');
    }
    const context = this.options.turnContext?.(key, head.payload);
    workerTurnContext(context);
    // No await between fresh authorization, atomic claim/intent and invocation.
    // begin also applies the owning store's deletion/settings/maintenance fence.
    const execution = journal.begin({ key, id: randomUUID(), epoch }, entries.map(entry => entry.id), turns, batch,
      () => !this.paused && !signal?.aborted && adapter.ready && adapter.epoch === epoch
        && entries.every(entry => authorized(entry.payload)));
    if (!execution) return 'not_started';
    try {
      const ack = await runNativeOperation(() => adapter.send(execution, text, context), {
        timeoutMs: this.options.deadlineMs, ...(signal ? { signal } : {}),
      });
      if (!adapter.ready || adapter.epoch !== epoch) return this.unknown(execution);
      if (journal.acknowledge(execution, ack.nativeRequestId, turns)) return 'accepted';
      // A correlated terminal can precede ACK and proves admission too.
      if (this.admissionProven(execution)) return 'accepted';
      return this.unknown(execution);
    } catch {
      // Stop after an uncertain invocation; never put it back into queued.
      if (adapter.ready && adapter.epoch === epoch && this.admissionProven(execution)) return 'accepted';
      return this.unknown(execution);
    }
  }

  terminal(ref: SdkExecutionRef, outcome: SdkTerminalOutcome): boolean {
    const { adapter, journal, turns } = this.options;
    if (adapter.epoch !== ref.epoch || !adapter.ready) return false;
    return journal.observeTerminal(ref, outcome, turns);
  }

  async interrupt(ref: SdkExecutionRef, actor: SdkTextInput): Promise<SdkDispatchResult> {
    const { journal, adapter } = this.options;
    const execution = journal.current(ref.key);
    if (!execution || execution.kind === 'compact' || !this.matches(execution, ref) || adapter.epoch !== ref.epoch || !adapter.ready) return 'not_started';
    if (!journal.checkPermission(this.options.authorize, [ref.key, actor, 'runs:interrupt'], this.options)) return 'blocked';
    if (!journal.requestStop(ref)) return 'not_started';
    try {
      await runNativeOperation(() => adapter.interrupt({ ...execution, stopRequested: true }), { timeoutMs: this.options.deadlineMs });
      if (adapter.epoch !== ref.epoch || !adapter.ready) return this.unknown(ref);
      // An interrupt ACK is NOT proof the run stopped. Keep running/settling.
      return 'accepted';
    } catch { return this.unknown(ref); }
  }

  settle(ref: SdkExecutionRef): Promise<boolean> {
    const existing = this.settling.get(ref.key);
    if (existing) return this.matches(existing.ref, ref) ? existing.task : Promise.resolve(false);
    const task = this.inspectAndSettle(ref).finally(() => { this.settling.delete(ref.key); });
    this.settling.set(ref.key, { ref: { ...ref }, task });
    return task;
  }

  disconnected() {
    this.pause();
    this.options.journal.recover(this.options.turns);
  }

  private async inspectAndSettle(ref: SdkExecutionRef): Promise<boolean> {
    const { journal, adapter } = this.options;
    const execution = journal.current(ref.key);
    if (!execution || execution.kind === 'compact' || !this.matches(execution, ref) || execution.phase !== 'settling'
      || !adapter.ready || adapter.epoch !== ref.epoch) return false;
    try {
      const proof = await runNativeOperation(() => adapter.inspectSettlement(execution), { timeoutMs: this.options.deadlineMs });
      if (!adapter.ready || adapter.epoch !== ref.epoch || !this.matches(proof, ref)
        || proof.nativeSessionId !== execution.nativeSessionId) { this.unknown(ref); return false; }
      if (proof.historyPersisted !== true || proof.nativeQuiescent !== true) return false;
      return journal.confirmSettled(ref);
    } catch { this.unknown(ref); return false; }
  }
  private matches(actual: SdkExecutionRef, expected: SdkExecutionRef) {
    return actual?.key === expected.key && actual.id === expected.id && actual.epoch === expected.epoch;
  }
  private admissionProven(ref: SdkExecutionRef) {
    const current = this.options.journal.current(ref.key);
    return !!current && this.matches(current, ref) && ['settling', 'completed', 'failed', 'interrupted'].includes(current.phase);
  }
  private unknown(ref: SdkExecutionRef): 'unknown' {
    this.options.journal.markUnknown(ref, this.options.turns);
    return 'unknown';
  }
  private validInput(payload: SdkTextInput) {
    return !!payload && typeof payload.text === 'string' && !!payload.text.trim() && payload.text.length <= MAX_MESSAGE_CHARS
      && (payload.attachmentCount === undefined || Number.isSafeInteger(payload.attachmentCount) && payload.attachmentCount >= 1 && payload.attachmentCount <= 8)
      && typeof payload.actorId === 'string' && !!payload.actorId && Array.isArray(payload.images) && payload.images.length === 0;
  }
}
