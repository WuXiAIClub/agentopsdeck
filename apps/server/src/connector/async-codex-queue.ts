import type { AsyncConnectorOwner } from './async-connector-owner.js';
import type { AsyncCodexDispatch, CodexDispatchOutcome, PreparedCodexDispatch } from './async-codex-dispatch.js';
import type { AsyncCodexPreparation } from './async-codex-preparation.js';
import { connectorCodexDispatchReplyMatches, validConnectorCodexDispatchOutput,
  validConnectorCodexDispatchInput } from './connector-codex-dispatch-domain.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { connectorCodexQueuePlanReplyMatches, decodeCodexQueuePlan, validConnectorCodexQueuePlanOutput,
  CODEX_QUEUE_PLAN_CHUNK_BYTES, type CodexQueueEntry, type CodexQueuePlan } from './connector-codex-queue-plan-domain.js';
import { requiredSynchronousEffectAuthority } from '../auth/synchronous-effect-authority.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { appendTurnContext } from '../codex/turn-context.js';
import { codexContextReplyMatches, validConnectorCodexContextOutput } from './connector-codex-context-domain.js';

export type CodexQueuePreparation = Pick<PreparedCodexDispatch, 'input' | 'interactive'> & {
  connectionId: string; blockedGoalInput: boolean; context?: PreparedCodexDispatch['claim']['context'];
  /** Original preparation transfers resource protection before claim IPC. */
  dispatching?(): void;
  /** Original preparation owner settles resources; unknown is never safe-to-delete. */
  finish(outcome: CodexDispatchOutcome): Promise<void>;
};
export type CodexQueueRecovery = {
  connectionId: string; blockedGoalInput: boolean; previousRunId?: string;
  /** False keeps ordinary sends out of the compaction permission domain. */
  needed?: boolean;
  /** Exact worker predecessor (null proves absence), not native authority. */
  predecessor?: Exclude<PreparedCodexDispatch['claim']['predecessor'], undefined>;
  /** Original executor lease, never serialized or supplied to the DB worker. */
  local?(): void;
  beforeClaim?(): void;
  /** Immutable native/history evidence checked before our own effect starts.
   * Only ordinary dispatch may retain it; recovery replaces this evidence. */
  beforeEffect?(): void;
  release?(): void;
};
/** Live FIFO consumer, not a startup-inventory reader. No DB, automatic timer,
 * process startup or default preparation. Production supplies the full original
 * history/resources/interaction/tools lifecycle before enabling this consumer. */
export class AsyncCodexQueue {
  private frozen = false;
  private closing?: Promise<void>;
  private readonly keys = new Set<string>();
  private readonly tasks = new Set<Promise<unknown>>();
  private retained = 0;
  constructor(private readonly options: {
    owner: Pick<AsyncConnectorOwner, 'command'>;
    dispatch: Pick<AsyncCodexDispatch, 'dispatch'>;
    local(sessionKey: string): void;
    prepare(plan: CodexQueuePlan, entries: CodexQueueEntry[], recoveryContext?: string): Promise<CodexQueuePreparation | null>;
    recovery?: {
      /** Original scheduler's idle/history/Goal observation and predecessor
       * cleanup. No new credentials or mutation claim before this completes. */
      observe(plan: CodexQueuePlan, entries: CodexQueueEntry[]): Promise<CodexQueueRecovery | null>;
      consumer: Pick<AsyncCodexPreparation, 'recover'>;
    };
    diagnostics?: PerformanceDiagnostics;
  }) {}
  run(sessionKey: string): Promise<CodexDispatchOutcome> {
    if (this.frozen || this.keys.has(sessionKey) || this.tasks.size >= 128) return Promise.resolve('not_started');
    this.keys.add(sessionKey);
    const task = Promise.resolve().then(() => this.once(sessionKey));
    // Never drain the public Promise: callers can replace its then method.
    // Capture the physical continuation before exposing any user callbacks.
    const release = () => { this.keys.delete(sessionKey); this.tasks.delete(drain); };
    const drain = task.then(release, release);
    this.tasks.add(drain);
    return task;
  }
  drain(): Promise<void> { return Promise.allSettled([...this.tasks]).then(() => {}); }
  close(): Promise<void> {
    this.frozen = true;
    return this.closing ??= this.drain();
  }
  private async once(sessionKey: string): Promise<CodexDispatchOutcome> {
    const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'codex-dispatch');
    let plan: CodexQueuePlan | undefined, body: Buffer | undefined, reserved = 0, preparation: CodexQueuePreparation | null = null;
    let outcome: CodexDispatchOutcome = 'not_started', failed = true, dispatchEntered = false, preparationClaimed = false;
    let observationLocal: (() => void) | undefined;
    let observationBeforeClaim: (() => void) | undefined;
    let observationBeforeEffect: (() => void) | undefined;
    let observationRelease: (() => void) | undefined;
    let finishPreparation: CodexQueuePreparation['finish'] | undefined;
    const local = () => {
      if (this.frozen) throw new ConnectorOwnerUnavailable();
      requiredSynchronousEffectAuthority(() => this.options.local(sessionKey));
      if (observationLocal) requiredSynchronousEffectAuthority(observationLocal);
    };
    try {
      local();
      const warning = setTimeout(() => trace.reportPending({ step: 6, pending: 1 }), 30_000); warning.unref();
      const request = { sessionKey };
      const result = await this.options.owner.command('codexQueuePlan', request).finally(() => clearTimeout(warning));
      if (!validConnectorCodexQueuePlanOutput('codexQueuePlan', result) || !connectorCodexQueuePlanReplyMatches('codexQueuePlan', request, result)) throw new ConnectorOwnerUnavailable();
      if (!result || result.state === 'blocked') { failed = false; return outcome; }
      trace.reportPending({ step: 6, pending: 1 });
      plan = structuredClone(result); local();
      if (this.retained + plan.bytes > 64 * 1024 * 1024) throw new ConnectorOwnerUnavailable();
      reserved = plan.bytes; this.retained += reserved;
      body = Buffer.alloc(plan.bytes);
      for (let offset = 0; offset < plan.bytes; offset += CODEX_QUEUE_PLAN_CHUNK_BYTES) {
        local();
        const ref = { sessionKey, planId: plan.planId, offset }, part = await this.options.owner.command('codexQueuePlanChunk', ref);
        if (!validConnectorCodexQueuePlanOutput('codexQueuePlanChunk', part) || !part || !connectorCodexQueuePlanReplyMatches('codexQueuePlanChunk', ref, part)) throw new ConnectorOwnerUnavailable();
        const bytes = Buffer.from(part.chunk, 'base64');
        try {
          if (bytes.length !== Math.min(CODEX_QUEUE_PLAN_CHUNK_BYTES, plan.bytes - offset)) throw new ConnectorOwnerUnavailable();
          bytes.copy(body, offset);
        } finally { bytes.fill(0); }
        local();
      }
      const entries = decodeCodexQueuePlan(plan, body); body.fill(0); body = undefined;
      local(); trace.add('step', 7);
      let proof = plan.proof, recovery: CodexQueueRecovery | null = null, recoveryContext: string | undefined;
      if (this.options.recovery) {
        recovery = await this.options.recovery.observe(structuredClone(plan), structuredClone(entries));
        if (recovery) {
          if (recovery.release !== undefined && typeof recovery.release !== 'function') throw new ConnectorOwnerUnavailable();
          observationRelease = recovery.release;
          if (recovery.local !== undefined && typeof recovery.local !== 'function'
            || recovery.beforeClaim !== undefined && typeof recovery.beforeClaim !== 'function'
            || recovery.beforeEffect !== undefined && typeof recovery.beforeEffect !== 'function'
            || recovery.needed !== undefined && typeof recovery.needed !== 'boolean') throw new ConnectorOwnerUnavailable();
          observationLocal = recovery.local;
          const beforeClaim = recovery.beforeClaim;
          observationBeforeClaim = beforeClaim;
          observationBeforeEffect = recovery.beforeEffect;
          recovery = { connectionId: recovery.connectionId, blockedGoalInput: recovery.blockedGoalInput,
            ...(recovery.previousRunId === undefined ? {} : { previousRunId: recovery.previousRunId }),
            ...(recovery.needed === undefined ? {} : { needed: recovery.needed }),
            ...(recovery.predecessor === undefined ? {} : { predecessor: structuredClone(recovery.predecessor) }) };
          local();
          if (beforeClaim) requiredSynchronousEffectAuthority(beforeClaim);
        }
        if (recovery && recovery.needed !== false) {
          const claim = { sessionKey, commandId: plan.commandId, connectionId: recovery.connectionId,
            proof, preparing: true, blockedGoalInput: recovery.blockedGoalInput, ...(plan.batch ? { batch: plan.batch } : {}),
            ...(recovery.predecessor === undefined ? {} : { predecessor: recovery.predecessor }) };
          if (!validConnectorCodexDispatchInput('codexDispatchClaim', claim)
            || recovery.previousRunId !== undefined && (typeof recovery.previousRunId !== 'string' || !recovery.previousRunId
              || Buffer.byteLength(recovery.previousRunId) > 512 || /[\x00-\x1f\x7f]/.test(recovery.previousRunId)))
            throw new ConnectorOwnerUnavailable();
          // IPC may commit even when its reply is lost. From here no callback,
          // close or later failure can convert the original claim to unstarted.
          outcome = 'unknown';
          const receipt = await this.options.owner.command('codexDispatchClaim', claim);
          if (!validConnectorCodexDispatchOutput('codexDispatchClaim', receipt)
            || !connectorCodexDispatchReplyMatches(claim, receipt)) throw new ConnectorOwnerUnavailable();
          if (!receipt) {
            // Only an explicit pre-claim refusal permits denial settlement.
            // A lost reply may own preparation and must remain unknown. The
            // worker rechecks the original FIFO, predecessor and permission;
            // this fixed action carries no caller authorization conclusion.
            if (recovery.predecessor !== undefined) {
              const settled = await this.options.owner.command('codexDispatchFailure', {
                sessionKey, commandId: plan.commandId, proof: structuredClone(proof),
                expected: recovery.predecessor, failure: 'compaction_authorization',
              });
              if (!validConnectorCodexDispatchOutput('codexDispatchFailure', settled)) throw new ConnectorOwnerUnavailable();
            }
            outcome = 'not_started'; failed = false; return outcome;
          }
          preparationClaimed = true;
          proof = structuredClone(receipt.proof);
          local(); trace.add('step', 8);
          const result = await this.options.recovery.consumer.recover({ expected: { sessionKey, commandId: plan.commandId,
            connectionId: recovery.connectionId, proof: structuredClone(proof), revision: receipt.execution.revision },
            ...(recovery.previousRunId === undefined ? {} : { previousRunId: recovery.previousRunId }) }, local);
          local();
          if (!result || result.state !== 'ready' || result.context !== undefined
            && (typeof result.context !== 'string' || result.context.length > 2000)) throw new ConnectorOwnerUnavailable();
          recoveryContext = result.context;
        }
      }
      local();
      // Original proof remains private even if a preparation callback mutates
      // its copy. Only the worker's bound preparing receipt can advance proof.
      preparation = await this.options.prepare(structuredClone(plan), entries, recoveryContext);
      if (!preparation) { failed = outcome === 'unknown'; return outcome; }
      if (typeof preparation.finish !== 'function' || !Array.isArray(preparation.input)
        || preparation.dispatching !== undefined && typeof preparation.dispatching !== 'function'
        || typeof preparation.interactive !== 'boolean' || typeof preparation.blockedGoalInput !== 'boolean'
        || typeof preparation.connectionId !== 'string' || !preparation.connectionId.trim()) throw new ConnectorOwnerUnavailable();
      // Resource hooks are capabilities of the original preparation owner,
      // not mutable fields to look up again after an IPC await.
      finishPreparation = preparation.finish.bind(preparation);
      const dispatching = preparation.dispatching?.bind(preparation);
      if (recovery && (preparation.connectionId !== recovery.connectionId
        || preparation.blockedGoalInput !== recovery.blockedGoalInput)) throw new ConnectorOwnerUnavailable();
      local();
      // Read the original worker-owned bindings only after the original file/
      // credential preparation has completed. A callback's actor/proof copy
      // cannot replace this private FIFO proof. This read grants no effect.
      const envelope = structuredClone(preparation.input);
      const suppliedContext = preparation.context && structuredClone(preparation.context);
      const { connectionId, interactive, blockedGoalInput } = preparation;
      const ref = { sessionKey, commandId: plan.commandId, connectionId, proof: structuredClone(proof) };
      const context = await this.options.owner.command('codexQueueContext', structuredClone(ref));
      if (!validConnectorCodexContextOutput(context) || !context || !codexContextReplyMatches(ref, context))
        throw new ConnectorOwnerUnavailable();
      local();
      // Never double-inject a callback-provided context. A single durable hash
      // must describe the actual native input; no transcript regex stripping.
      if (suppliedContext && context.context) throw new ConnectorOwnerUnavailable();
      const contextual = appendTurnContext(envelope, context.context);
      const contextProof = contextual.proof ?? suppliedContext;
      if (!preparationClaimed && observationBeforeClaim) requiredSynchronousEffectAuthority(observationBeforeClaim);
      const prepared: PreparedCodexDispatch = { claim: { sessionKey, commandId: plan.commandId, connectionId,
        proof, preparing: false, blockedGoalInput,
        ...(!preparationClaimed && recovery?.predecessor !== undefined ? { predecessor: recovery.predecessor } : {}),
        ...(plan.batch ? { batch: plan.batch } : {}), ...(contextProof ? { context: contextProof } : {}) },
        input: contextual.input, interactive };
      // A throwing dispatcher may have already committed claim. Never convert
      // that ambiguity into a known pre-effect outcome for resource cleanup.
      if (dispatching) requiredSynchronousEffectAuthority(dispatching);
      dispatchEntered = true;
      outcome = await this.options.dispatch.dispatch(prepared, local, preparationClaimed ? undefined : observationBeforeEffect);
      if (!['not_started', 'admitted', 'unknown'].includes(outcome)) { outcome = 'unknown'; throw new ConnectorOwnerUnavailable(); }
      // A refused continuation is not evidence that the preparing claim never
      // happened. Keep both its protection and any handed-off private resources.
      if (preparationClaimed && outcome === 'not_started') outcome = 'unknown';
      failed = outcome === 'unknown'; return outcome;
    } catch {
      if (dispatchEntered) outcome = 'unknown';
      trace.add('deferred', 1); return outcome;
    } finally {
      body?.fill(0);
      // Explicit original resource owner; callbacks after ACK cannot revoke it.
      try { if (finishPreparation) await finishPreparation(outcome); } catch { trace.add('unknown', 1); }
      if (plan) try { await this.options.owner.command('codexQueuePlanRelease', { sessionKey, planId: plan.planId }); }
      catch { trace.add('deferred', 1); }
      if (observationRelease) {
        try { requiredSynchronousEffectAuthority(observationRelease); }
        catch { trace.add('deferred', 1); }
      }
      this.retained -= reserved; trace.finish(failed);
    }
  }
}
