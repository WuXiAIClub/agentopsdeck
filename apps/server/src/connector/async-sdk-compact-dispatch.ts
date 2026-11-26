import { randomUUID } from 'node:crypto';
import type { ApplicationCommandScope } from '../auth/application-command-scope.js';
import type { ApplicationTransactionEvidence } from '../auth/application-transaction-gate.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import type { SdkCompactAdapter, SdkCompactExecution } from './sdk-compact-dispatch.js';
import type { SdkCompactRef } from './sdk-execution-journal.js';
import type { SdkDispatchResult } from './sdk-dispatch.js';
import { sameSdkCompactRef, validConnectorSdkCompactOutput } from './connector-sdk-compact-domain.js';
import { sdkModelAllowed, sdkModelChoices } from './sdk-models.js';
import { runNativeOperation } from './native-operation.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

/** Candidate caller for the ONE Connector owner. The original receipt and
 * compact intent are committed together; only a fresh correlated admission
 * invokes native. Never wire beside the legacy writer/runtime. */
export class AsyncSdkCompactDispatch {
  private paused = false;
  private readonly dispatching = new Set<string>();
  private readonly settling = new Map<string, { ref: SdkCompactRef; task: Promise<boolean> }>();
  private readonly models: { model: string; modelChoices?: string[]; dynamicModels?: boolean };
  constructor(private readonly options: {
    owner: Pick<AsyncConnectorOwner, 'command'>; adapter: SdkCompactAdapter; deadlineMs: number;
    admissionReady?: () => boolean;
    models: { model: string; modelChoices?: readonly string[]; dynamicModels?: boolean }; diagnostics?: PerformanceDiagnostics;
  }) {
    if (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs < 1 || options.deadlineMs > 2_147_483_647
      || !['claude-code', 'ghcp', 'antigravity'].includes(options.adapter.runtime)) throw Error('Invalid async SDK compact dispatcher');
    this.models = options.models.dynamicModels
      ? { model: options.models.model, dynamicModels: true }
      : { model: options.models.model, modelChoices: sdkModelChoices(options.models.model, options.models.modelChoices) };
  }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  private available(epoch: string, signal?: AbortSignal, admission = false) {
    return (!admission || !this.paused && (this.options.admissionReady?.() ?? true) === true)
      && !signal?.aborted && this.options.adapter.ready === true && this.options.adapter.epoch === epoch;
  }
  async dispatch(key: string, commandKey: string, authorization: string, signal?: AbortSignal,
    application?: ApplicationTransactionEvidence, authority?: ApplicationCommandScope): Promise<SdkDispatchResult> {
    const { owner, adapter, deadlineMs } = this.options, epoch = adapter.epoch, runtime = adapter.runtime;
    const operate = <T>(work: () => Promise<T>, cancellable = false) => authority ? Promise.resolve().then(work)
      : runNativeOperation(work, { timeoutMs: deadlineMs, ...(cancellable && signal ? { signal } : {}) });
    const unknown = (ref: SdkCompactRef) => this.unknown(ref, !!authority);
    if (!epoch || !this.available(epoch, signal, true) || this.dispatching.has(key) || this.dispatching.size >= 128) return 'not_started';
    this.dispatching.add(key);
    const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'sdk-async-compact');
    let execution: SdkCompactExecution | undefined, failed = true, reading = true;
    try {
      if (authority) { await authority.authorize('prepare'); authority.local(); }
      const claimed = await operate(async () => {
        const snapshot = await owner.command('sdkSnapshotRead', { runtime, key });
        if (!reading || !this.available(epoch, signal, true) || snapshot.canStart !== true || snapshot.session?.nativeState !== 'ready'
          || !sdkModelAllowed(this.models, snapshot.session.model)) return null;
        const request = { runtime, key, id: randomUUID(), epoch, authorization, commandKey,
          nativeSessionId: snapshot.session.nativeSessionId, model: snapshot.session.model ?? null,
          ...(application ? { application } : {}) };
        const value = await owner.command('sdkCompactClaim', request);
        if (!validConnectorSdkCompactOutput('sdkCompactClaim', value)) throw Error('connector_storage_unavailable');
        if (!('error' in value) && (value.key !== key || value.receipt.key !== commandKey
          || value.execution && !sameSdkCompactRef(value.execution, request))) throw Error('connector_storage_unavailable');
        if (!('error' in value) && value.execution) execution = value.execution;
        if (!reading || !this.available(epoch, signal, true)) {
          if (!('error' in value) && value.execution) await unknown(value.execution);
          return null;
        }
        return value;
      }, true);
      reading = false;
      if (!claimed) return execution ? await unknown(execution) : 'not_started';
      if ('error' in claimed) return claimed.error === 401 || claimed.error === 403 ? 'blocked' : 'not_started';
      if (!claimed.admitted) {
        failed = claimed.receipt.state !== 'accepted';
        return claimed.receipt.state === 'accepted' ? 'accepted' : claimed.receipt.state === 'rejected' ? 'not_started' : 'unknown';
      }
      execution = claimed.execution!;
      const ref = this.ref(execution);
      if (!this.available(epoch, signal, true)) return await unknown(ref);
      if (authority) { await authority.authorize('effect'); authority.local(); }
      const ready = await operate(() => owner.command('sdkCompactReady', { runtime, ref, authorization, action: 'dispatch' }), true);
      if (ready !== true || !this.available(epoch, signal, true)) return await unknown(ref);
      // No await between final readiness and invoking native. A disconnected
      // HTTP caller after invocation does not cancel or replay admitted work.
      authority?.local();
      const result = await operate(() => { authority?.local(); return adapter.compact(structuredClone(execution!)); });
      if (!this.available(epoch) || !sameSdkCompactRef(result, ref)) return await unknown(ref);
      const accepted = await operate(() => owner.command('sdkCompactTerminal', { runtime, ref,
        result: { nativeRequestId: result.nativeRequestId, completionEventId: result.completionEventId, outcome: result.outcome } }));
      if (accepted !== true) return await unknown(ref);
      failed = false; return 'accepted';
    } catch (error) {
      if (execution) return await unknown(execution);
      // A lost claim result is not a definitive rejection or permission to
      // retry. The original durable intent remains protected on reopen.
      throw error;
    } finally { reading = false; this.dispatching.delete(key); trace.finish(failed); }
  }
  async interrupt(original: SdkCompactRef, authorization: string): Promise<SdkDispatchResult> {
    const ref = this.ref(original), { owner, adapter, deadlineMs } = this.options, runtime = adapter.runtime;
    if (!this.available(ref.epoch) || !adapter.interruptCompact) return 'not_started';
    let claimed = false;
    try {
      const e = await runNativeOperation(() => owner.command('sdkCompactInterruptClaim', { runtime, ref, authorization }), { timeoutMs: deadlineMs });
      if (!e) return 'not_started';
      if (e === 'blocked') return 'blocked';
      if (!validConnectorSdkCompactOutput('sdkCompactInterruptClaim', e) || !sameSdkCompactRef(e, ref)) throw Error('connector_storage_unavailable');
      claimed = true;
      if (!this.available(ref.epoch)) return await this.unknown(ref);
      const ready = await runNativeOperation(() => owner.command('sdkCompactReady', { runtime, ref, authorization, action: 'interrupt' }), { timeoutMs: deadlineMs });
      if (ready !== true || !this.available(ref.epoch)) return await this.unknown(ref);
      await runNativeOperation(() => adapter.interruptCompact!(structuredClone(e)), { timeoutMs: deadlineMs });
      return this.available(ref.epoch) ? 'accepted' : this.unknown(ref);
    } catch (error) { if (claimed) return this.unknown(ref); throw error; }
  }
  settle(original: SdkCompactRef, physical = false): Promise<boolean> {
    const ref = this.ref(original), previous = this.settling.get(ref.key);
    if (previous) return sameSdkCompactRef(previous.ref, ref) ? previous.task : Promise.resolve(false);
    if (this.settling.size >= 128) return Promise.resolve(false);
    const task = this.inspectAndSettle(ref, physical).finally(() => this.settling.delete(ref.key));
    this.settling.set(ref.key, { ref, task }); return task;
  }
  private async inspectAndSettle(ref: SdkCompactRef, physical: boolean): Promise<boolean> {
    const { owner, adapter, deadlineMs } = this.options, runtime = adapter.runtime;
    const operate = <T>(work: () => Promise<T>) => physical ? Promise.resolve().then(work) : runNativeOperation(work, { timeoutMs: deadlineMs });
    if (!this.available(ref.epoch)) return false;
    try {
      const snapshot = await operate(() => owner.command('sdkSnapshotRead', { runtime, key: ref.key }));
      const e = snapshot.execution;
      if (!e || e.kind !== 'compact' || !sameSdkCompactRef(e, ref) || e.phase !== 'settling' || !e.control.completionEventId
        || !this.available(ref.epoch)) return false;
      const proof = await operate(() => adapter.inspectSettlement(structuredClone(e)));
      if (!this.available(ref.epoch) || !sameSdkCompactRef(proof, ref) || proof.completionEventId !== e.control.completionEventId) {
        await this.unknown(ref, physical); return false;
      }
      if (proof.historyPersisted !== true || proof.nativeQuiescent !== true) return false;
      return await operate(() => owner.command('sdkCompactSettle', { runtime, ref, completionEventId: proof.completionEventId,
        historyPersisted: true, nativeQuiescent: true })) === true;
    } catch { await this.unknown(ref, physical); return false; }
  }
  private ref(value: SdkCompactRef): SdkCompactRef { return { key: value.key, id: value.id, epoch: value.epoch, nativeSessionId: value.nativeSessionId }; }
  private async unknown(ref: SdkCompactRef, physical = false): Promise<'unknown'> {
    try { const work = () => this.options.owner.command('sdkExecutionUnknown', { runtime: this.options.adapter.runtime, ref: this.ref(ref) });
      await (physical ? work() : runNativeOperation(work, { timeoutMs: this.options.deadlineMs })); }
    catch { /* Original sole owner/intent remains protected; no replacement. */ }
    return 'unknown';
  }
}
