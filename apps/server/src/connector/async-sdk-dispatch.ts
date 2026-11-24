import { randomUUID } from 'node:crypto';
import type { ApplicationCommandScope } from '../auth/application-command-scope.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { workerTurnContext, type SdkTurnContext } from './sdk-turn-context.js';
import { runNativeOperation } from './native-operation.js';
import type { SdkDispatchAdapter, SdkDispatchResult, SdkTextInput } from './sdk-dispatch.js';
import type { SdkAgentId, SdkCompactRef, SdkExecution, SdkTerminalOutcome } from './sdk-execution-journal.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { readSdkExecutionAttachments, reserveSdkAttachmentAssembly } from './async-sdk-attachments.js';
import type { AsyncSdkInteractions } from './async-sdk-interaction.js';
import type { SdkMessageStopRequest } from './connector-sdk-stop-domain.js';
import { dispatchSdkMessageStop } from './async-sdk-message-stop.js';
import { BOARD_CONTEXT_MAX_CHARS } from './workspace-board-file-format.js';
import { sdkContextReplyMatches, validConnectorSdkContextOutput } from './connector-sdk-context-domain.js';

/** Async caller for the sole Connector owner. Not enabled by runtime.ts yet:
 * command receipts, settings, attachments and runtime projection must migrate
 * together before replacing the legacy connection. Never runs a second owner.
 * Native side effects are deliberately outside the worker, once per intent. */
export class AsyncSdkDispatch {
  private paused = false;
  private readonly dispatching = new Set<string>();
  private readonly settling = new Map<string, { ref: SdkCompactRef; task: Promise<boolean> }>();
  constructor(private readonly options: {
    owner: Pick<AsyncConnectorOwner, 'command'>; runtime: SdkAgentId; adapter: SdkDispatchAdapter;
    turnContext?: (key: string, actor: SdkTextInput) => SdkTurnContext | Promise<SdkTurnContext>;
    persistence?: { flush(ref: SdkCompactRef): Promise<boolean> };
    interactions?: Pick<AsyncSdkInteractions, 'prepare' | 'release'>;
    deadlineMs: number; diagnostics?: PerformanceDiagnostics;
  }) {
    if (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs < 1 || options.deadlineMs > 2_147_483_647) {
      throw Error('Invalid SDK operation deadline');
    }
  }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  private available(epoch: string, signal?: AbortSignal) {
    return !this.paused && !signal?.aborted && this.options.adapter.ready === true && this.options.adapter.epoch === epoch;
  }
  async dispatch(key: string, signal?: AbortSignal): Promise<SdkDispatchResult> {
    const { owner, runtime, adapter } = this.options, epoch = adapter.epoch;
    if (!epoch || !this.available(epoch, signal) || this.dispatching.has(key) || this.dispatching.size >= 128) return 'not_started';
    this.dispatching.add(key);
    const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'sdk-async-dispatch');
    let execution: SdkExecution | undefined, failed = true, invoked = false, releaseAttachments: (() => void) | undefined;
    try {
      trace.add('step', 1);
      const plan = await owner.command('sdkDispatchPlan', { runtime, key });
      if (!this.available(epoch, signal) || !plan) return 'not_started';
      if (plan === 'blocked') return 'blocked';
      const actor = { ...plan.actor, text: plan.batch ? plan.text.split(plan.batch.separator)[0]! : plan.text };
      const context = this.options.turnContext ? await runNativeOperation(
        () => Promise.resolve(this.options.turnContext!(key, actor)),
        { timeoutMs: this.options.deadlineMs, ...(signal ? { signal } : {}) }) : undefined;
      workerTurnContext(context);
      // Optional trusted prompt text is not a file authorization port. File
      // grants below come only from the original worker-owned queue records.
      if (context && typeof context !== 'string' && context.files.length) throw Error('connector_storage_unavailable');
      if (!this.available(epoch, signal)) return 'not_started';
      trace.add('step', 2);
      execution = await owner.command('sdkDispatchClaim', { runtime, key, epoch, id: randomUUID(), digest: plan.digest,
        ...(plan.batch ? { separator: plan.batch.separator } : {}) }) ?? undefined;
      if (!execution) return 'not_started';
      // Cancellation/epoch replacement after durable claim cannot release or
      // requeue it: no native send, but outcome remains protected/unknown.
      if (!this.available(epoch, signal)) return await this.unknown(execution);
      trace.add('step', 3);
      let reading = true;
      const attachmentTrace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'sdk-async-attachments');
      let attachments;
      try {
        attachments = await runNativeOperation(() => readSdkExecutionAttachments(owner, runtime, this.ref(execution!),
          () => reading && this.available(epoch, signal), bytes => { releaseAttachments = reserveSdkAttachmentAssembly(bytes); }),
        { timeoutMs: this.options.deadlineMs, ...(signal ? { signal } : {}) });
        attachmentTrace.finish(false);
      } catch (error) { attachmentTrace.finish(true); throw error; }
      finally { reading = false; }
      if (!this.available(epoch, signal)) return await this.unknown(execution);
      const interaction = await this.options.interactions?.prepare(this.ref(execution));
      // Check native admission before obtaining the final file grants. The
      // context command itself rechecks every original member on the worker;
      // no await may follow its receipt before invoking the original adapter.
      if (!this.available(epoch, signal) || await owner.command('sdkNativeReady', { runtime, ref: this.ref(execution) }) !== true
        || !this.available(epoch, signal)) return await this.unknown(execution);
      const scope = { runtime, ref: this.ref(execution) }, expected = structuredClone(scope);
      const originalContext = await owner.command('sdkExecutionContext', scope);
      if (!this.available(epoch, signal) || !validConnectorSdkContextOutput(originalContext)
        || !originalContext || !sdkContextReplyMatches(expected, originalContext)) {
        return await this.unknown(execution);
      }
      const textContext = typeof context === 'string' ? context : context?.text;
      const nativeContext = { text: [textContext, originalContext.context.text].filter(Boolean).join('\n\n'),
        files: [...originalContext.context.files] };
      if (nativeContext.text.length > BOARD_CONTEXT_MAX_CHARS) return await this.unknown(execution);
      workerTurnContext(nativeContext);
      try {
        const ack = await runNativeOperation(() => {
          // A deadline stops our wait, not the adapter's original promise.
          // Retain its body reservation until that original invocation settles.
          const release = releaseAttachments;
          releaseAttachments = undefined;
          try {
            invoked = true;
            const work = adapter.send(execution!, plan.text, nativeContext, attachments, interaction);
            Promise.resolve(work).then(() => release?.(), () => release?.());
            return work;
          } catch (error) { release?.(); throw error; }
        }, {
          timeoutMs: this.options.deadlineMs, ...(signal ? { signal } : {}),
        });
        if (!this.available(epoch)) return await this.unknown(execution);
        const acknowledged = await owner.command('sdkExecutionAcknowledge', { runtime, ref: this.ref(execution), nativeRequestId: ack.nativeRequestId });
        if (!this.available(epoch)) return await this.unknown(execution);
        if (acknowledged) {
          failed = false; return 'accepted';
        }
      } catch { /* Correlated terminal may prove admission despite lost ACK. */ }
      if (this.available(epoch) && await this.admissionProven(execution)) { failed = false; return 'accepted'; }
      return await this.unknown(execution);
    } catch (error) {
      if (execution) return await this.unknown(execution);
      // A lost CLAIM reply is not retryable. The original owner already retires
      // failed IPC, while its durable dispatching fact is recovered as unknown.
      throw error;
    } finally {
      try { if (execution && !invoked) await this.options.interactions?.release(this.ref(execution)); }
      finally { releaseAttachments?.(); this.dispatching.delete(key); trace.finish(failed); }
    }
  }
  async terminal(ref: SdkCompactRef, outcome: SdkTerminalOutcome): Promise<boolean> {
    if (this.options.adapter.ready !== true || this.options.adapter.epoch !== ref.epoch) return false;
    if (!await this.persisted(ref)) { await this.unknown(ref); return false; }
    if (this.options.adapter.ready !== true || this.options.adapter.epoch !== ref.epoch) return false;
    return this.options.owner.command('sdkExecutionTerminal', { runtime: this.options.runtime, ref: this.ref(ref), outcome });
  }
  async interrupt(ref: SdkCompactRef, actor: SdkTextInput): Promise<SdkDispatchResult> {
    const { adapter, owner, runtime } = this.options;
    if (adapter.ready !== true || adapter.epoch !== ref.epoch) return 'not_started';
    const execution = await owner.command('sdkInterruptClaim', { runtime, ref: this.ref(ref), actorId: actor.actorId,
      ...(actor.executionGrant ? { executionGrant: actor.executionGrant } : {}) });
    if (!execution) return 'not_started';
    if (execution === 'blocked') return 'blocked';
    if (adapter.ready !== true || adapter.epoch !== ref.epoch) return this.unknown(execution);
    try {
      await runNativeOperation(() => adapter.interrupt(execution), { timeoutMs: this.options.deadlineMs });
      return adapter.ready === true && adapter.epoch === ref.epoch ? 'accepted' : this.unknown(execution);
    } catch { return this.unknown(execution); }
  }
  /** HTTP control uses original evidence, never a main-thread actorId. Keep the
   * ORIGINAL interrupt Promise alive through HTTP deadlines and shutdown drain.
   * Its ACK settles only the command, not execution/history/native ownership. */
  async interruptMessage(input: SdkMessageStopRequest, ref: SdkCompactRef | null, authority?: ApplicationCommandScope) {
    const { adapter, owner, runtime } = this.options;
    return dispatchSdkMessageStop(input, { owner, runtime, kind: 'message', ref, authority,
      available: original => adapter.ready === true && adapter.epoch === original.epoch,
      interrupt: execution => adapter.interrupt(execution),
      ...(this.options.diagnostics ? { diagnostics: this.options.diagnostics } : {}) });
  }
  settle(ref: SdkCompactRef): Promise<boolean> {
    const existing = this.settling.get(ref.key);
    if (existing) return this.matches(existing.ref, ref) ? existing.task : Promise.resolve(false);
    if (this.settling.size >= 128) return Promise.resolve(false);
    const task = this.inspectAndSettle(ref).finally(() => this.settling.delete(ref.key));
    this.settling.set(ref.key, { ref: { ...ref }, task }); return task;
  }
  private async inspectAndSettle(ref: SdkCompactRef): Promise<boolean> {
    const { owner, runtime, adapter } = this.options;
    const { execution } = await owner.command('sdkSnapshotRead', { runtime, key: ref.key });
    if (!execution || execution.kind === 'compact' || !this.matches(execution, ref) || execution.phase !== 'settling'
      || adapter.ready !== true || adapter.epoch !== ref.epoch) return false;
    try {
      if (!await this.persisted(ref)) { await this.unknown(ref); return false; }
      if (adapter.ready !== true || adapter.epoch !== ref.epoch) return false;
      const proof = await runNativeOperation(() => adapter.inspectSettlement(execution), { timeoutMs: this.options.deadlineMs });
      if (adapter.ready !== true || adapter.epoch !== ref.epoch || !this.matches(proof, ref)) { await this.unknown(ref); return false; }
      if (proof.historyPersisted !== true || proof.nativeQuiescent !== true) return false;
      if (!await this.persisted(ref)) { await this.unknown(ref); return false; }
      if (adapter.ready !== true || adapter.epoch !== ref.epoch) return false;
      return await owner.command('sdkExecutionSettle', { runtime, ref: this.ref(ref), historyPersisted: true, nativeQuiescent: true });
    } catch { await this.unknown(ref); return false; }
  }
  /** Runtime supplies its correlated current refs; startup recovery still
   * belongs to the original store, not this caller or a history observer. */
  async disconnected(refs: readonly SdkCompactRef[]): Promise<void> {
    this.pause();
    if (refs.length > 128) throw Error('connector_storage_unavailable');
    for (const ref of refs) await this.unknown(ref);
  }
  private matches(actual: SdkCompactRef, expected: SdkCompactRef) {
    return actual.key === expected.key && actual.id === expected.id && actual.epoch === expected.epoch
      && actual.nativeSessionId === expected.nativeSessionId;
  }
  private ref(value: SdkCompactRef): SdkCompactRef {
    return { id: value.id, key: value.key, epoch: value.epoch, nativeSessionId: value.nativeSessionId };
  }
  private async persisted(ref: SdkCompactRef): Promise<boolean> {
    if (!this.options.persistence) return true;
    try {
      return await runNativeOperation(() => this.options.persistence!.flush(this.ref(ref)),
        { timeoutMs: this.options.deadlineMs }) === true;
    } catch { return false; }
  }
  private async admissionProven(ref: SdkCompactRef): Promise<boolean> {
    const { execution } = await this.options.owner.command('sdkSnapshotRead', { runtime: this.options.runtime, key: ref.key });
    return !!execution && this.matches(execution, ref) && ['settling', 'completed', 'failed', 'interrupted'].includes(execution.phase);
  }
  private async unknown(ref: SdkCompactRef): Promise<'unknown'> {
    try { await this.options.owner.command('sdkExecutionUnknown', { runtime: this.options.runtime, ref: this.ref(ref) }); }
    catch { /* Durable claim stays protected; failed owner never replays. */ }
    return 'unknown';
  }
}
