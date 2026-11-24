import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { validConnectorOpenClawDispatchOutput, type OpenClawDispatchClaim, type OpenClawDispatchRef } from './connector-openclaw-dispatch-domain.js';
import type { GatewayWsClient } from '../gateway/ws-client.js';
import { agentIdFromSessionKey, localOpenClawCliSessionKey, shouldUseOpenClawCliFallback, startOpenClawAgentFallback } from '../openclaw/cli.js';
import { readOpenClawQueuedAttachments } from '../openclaw/turn-queue.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import type { AdmissionPause } from '../lifecycle/request-drain.js';

type CliResult = Parameters<NonNullable<Parameters<typeof startOpenClawAgentFallback>[5]>>[0];
export type OpenClawDispatchOutcome = 'not_started' | 'blocked' | 'admitted' | 'unknown';
type Stage = 'plan' | 'prepare' | 'claim' | 'ready' | 'gateway' | 'cli' | 'settle' | 'projection';

/** Sole-owner candidate: shares the original worker and native transports.
 * No synchronous store, native retry, replacement owner or SQL fallback.
 * The composition root must drain this port before closing the shared owner. */
export class AsyncOpenClawDispatch {
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly physical = new Set<Promise<unknown>>();
  private readonly keys = new Set<string>();
  private closed = false;
  private paused = false;
  private generation = 0;
  private closing?: Promise<void>;
  private pauseLease: AdmissionPause | undefined;
  constructor(private readonly options: {
    owner: Pick<AsyncConnectorOwner, 'command'>;
    gateway: Pick<GatewayWsClient, 'prepareWriteConnection' | 'connectionId' | 'requestBound'>;
    native: { available(): boolean; epoch(): string };
    /** Additional synchronous native safety veto, never worker authority. */
    canDispatch?(key: string): boolean;
    allowCliFallback: boolean;
    message(text: string): string;
    startCli?: typeof startOpenClawAgentFallback;
    settled?(claim: OpenClawDispatchClaim, result?: CliResult): void | Promise<void>;
    // Fixed codes only; never hand a sink an Error, payload or identity.
    diagnostic?(stage: Stage, outcome: 'failed' | 'unknown'): void;
    diagnostics?: PerformanceDiagnostics;
  }) {}
  private note(stage: Stage, outcome: 'failed' | 'unknown' = 'failed') {
    const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'openclaw-dispatch');
    trace.add('step', ['plan', 'prepare', 'claim', 'ready', 'gateway', 'cli', 'settle', 'projection'].indexOf(stage) + 1);
    trace.add('unknown', Number(outcome === 'unknown')); trace.finish(true);
    try { this.options.diagnostic?.(stage, outcome); } catch { /* diagnostic is not authority */ }
  }
  private async drain() {
    await Promise.allSettled([...this.tasks]);
    await Promise.allSettled([...this.physical]);
  }
  pause(): AdmissionPause {
    if (this.pauseLease) return this.pauseLease;
    this.paused = true; this.generation++;
    let settled = false;
    const lease: AdmissionPause = {
      drained: this.drain().then(() => { settled = true; }),
      resume: () => {
        if (this.closed || this.pauseLease !== lease || !settled) return false;
        this.pauseLease = undefined; this.paused = false; return true;
      },
    };
    return this.pauseLease = lease;
  }
  close() { this.closed = true; this.paused = true; this.generation++; return this.closing ??= this.drain(); }
  dispatch(key: string, signal?: AbortSignal): Promise<OpenClawDispatchOutcome> {
    if (this.closed || this.paused || signal?.aborted || this.keys.has(key) || this.keys.size >= 128) return Promise.resolve('not_started');
    this.keys.add(key);
    // Publish before any injectable callback can reenter close().
    const task = Promise.resolve().then(() => this.run(key, signal));
    this.tasks.add(task);
    void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task));
    return task;
  }
  private async project(claim: OpenClawDispatchClaim, result?: CliResult) {
    try { await this.options.settled?.(claim, result); } catch { this.note('projection'); }
  }
  private async run(key: string, signal?: AbortSignal): Promise<OpenClawDispatchOutcome> {
    const generation = this.generation;
    let epoch: string | undefined, claim: OpenClawDispatchClaim | undefined, entered = false;
    let stage: Stage = 'plan';
    const lifetimes = new Set<Promise<unknown>>();
    const retain = (work: Promise<unknown>) => {
      lifetimes.add(work); this.physical.add(work);
      const release = () => { lifetimes.delete(work); this.physical.delete(work); };
      void work.then(release, release);
    };
    const local = () => {
      const available = this.options.native.available(), currentEpoch = this.options.native.epoch();
      if (this.closed || this.paused || signal?.aborted || generation !== this.generation
        || available !== true || this.options.canDispatch?.(key) === false || epoch !== undefined && currentEpoch !== epoch)
        throw new ConnectorOwnerUnavailable();
    };
    const ref = (): OpenClawDispatchRef => ({ key, id: claim!.turn.id, digest: claim!.digest, revision: claim!.execution.revision! });
    const abandon = async () => {
      if (!claim) return;
      try { if (await this.options.owner.command('openClawDispatchAbandon', ref()) !== true) this.note('settle', 'unknown'); }
      catch { this.note('settle', 'unknown'); }
    };
    try {
      local(); epoch = this.options.native.epoch();
      const plan = await this.options.owner.command('openClawDispatchPlan', { key });
      if (!validConnectorOpenClawDispatchOutput('openClawDispatchPlan', plan)) throw new ConnectorOwnerUnavailable();
      if (!plan) return 'not_started';
      if (plan === 'blocked') return 'blocked';
      if (plan.turn.sessionKey !== key) throw new ConnectorOwnerUnavailable();
      local(); stage = 'prepare';
      const attachments = await readOpenClawQueuedAttachments(plan.turn.payload);
      local();
      const message = this.options.message(plan.turn.payload.message);
      // Connection establishment happens BEFORE current worker authorization.
      const connectionId = await this.options.gateway.prepareWriteConnection();
      local(); stage = 'claim';
      const selected = await this.options.owner.command('openClawDispatchClaim', { key, id: plan.turn.id, digest: plan.digest, connectionId });
      if (!validConnectorOpenClawDispatchOutput('openClawDispatchClaim', selected)) throw new ConnectorOwnerUnavailable();
      if (!selected) return 'not_started';
      if (selected.turn.sessionKey !== key || selected.turn.id !== plan.turn.id
        || JSON.stringify(selected.turn.payload) !== JSON.stringify(plan.turn.payload)
        || selected.execution.gatewayConnectionId !== connectionId) throw new ConnectorOwnerUnavailable();
      claim = selected; local(); stage = 'ready';
      if (await this.options.owner.command('openClawDispatchReady', ref()) !== true) { await abandon(); return 'blocked'; }
      local();
      if (this.options.gateway.connectionId() !== connectionId) { await abandon(); return 'blocked'; }
      stage = 'gateway';
      let reply: { payload: unknown; connectionId: string };
      try {
        reply = await this.options.gateway.requestBound('agent', { sessionKey: key, message, deliver: false,
          idempotencyKey: claim.turn.id, attachments }, connectionId, () => {
          local();
          // This guard is synchronous. No SQL/Promise authority crosses send.
          if (this.options.gateway.connectionId() !== connectionId) throw new ConnectorOwnerUnavailable();
          entered = true;
        });
      } catch (error) {
        if (!entered) throw error;
        if (!this.options.allowCliFallback || attachments.length || !shouldUseOpenClawCliFallback(error, 'agent')) throw error;
        // Only this exact native rejection proves no Gateway effect started.
        entered = false; local(); stage = 'cli';
        const switched = await this.options.owner.command('openClawDispatchCli', ref());
        if (!validConnectorOpenClawDispatchOutput('openClawDispatchCli', switched) || !switched
          || switched.turn.id !== claim.turn.id || switched.turn.sessionKey !== key || switched.digest !== claim.digest
          || JSON.stringify(switched.turn.payload) !== JSON.stringify(claim.turn.payload)) throw new ConnectorOwnerUnavailable();
        claim = switched;
        const original = claim;
        const agentId = agentIdFromSessionKey(key) ?? 'main';
        local(); entered = true;
        const started = await (this.options.startCli ?? startOpenClawAgentFallback)(localOpenClawCliSessionKey(key, agentId), agentId,
          key, claim.turn.payload.message, claim.turn.id, result => {
            const settlement = (async () => {
              try {
                const persisted = await this.options.owner.command('openClawCliFinalReply', { sessionKey: key, commandId: original.turn.id,
                  phase: result.ok ? 'completed' : 'failed', deliveryMode: original.turn.payload.deliveryMode,
                  replyText: result.ok && original.turn.payload.deliveryMode === 'mirror' ? result.replyText ?? null : null });
                if (persisted !== true) throw new ConnectorOwnerUnavailable();
                await this.project(original, result);
              } catch { this.note('settle', 'unknown'); }
            })();
            retain(settlement); return settlement;
          }, retain);
        if (!started.ok) throw new ConnectorOwnerUnavailable();
        stage = 'settle';
        if (await this.options.owner.command('openClawExecutionAcknowledge', { sessionKey: key, commandId: claim.turn.id, transport: 'cli' }) !== true)
          throw new ConnectorOwnerUnavailable();
        await this.project(claim);
        const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'openclaw-dispatch');
        trace.add('step', 6); trace.add('admitted', 1); trace.finish();
        return 'admitted';
      }
      // An ACK received on another connection is not settlement evidence.
      stage = 'settle';
      if (reply.connectionId !== connectionId) throw new ConnectorOwnerUnavailable();
      const payload = reply.payload as { runId?: unknown } | null;
      const runId = payload && typeof payload.runId === 'string' && payload.runId ? payload.runId : null;
      if (await this.options.owner.command('openClawExecutionAcknowledge', { sessionKey: key, commandId: claim.turn.id,
        transport: 'gateway', connectionId, runId }) !== true) throw new ConnectorOwnerUnavailable();
      await this.project(claim);
      const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'openclaw-dispatch');
      trace.add('step', 5); trace.add('admitted', 1); trace.finish();
      return 'admitted';
    } catch {
      this.note(stage, entered ? 'unknown' : 'failed');
      if (claim && entered) {
        try { await this.options.owner.command('openClawDispatchUnknown', { key, id: claim.turn.id }); } catch { this.note('settle', 'unknown'); }
      } else await abandon();
      return entered ? 'unknown' : 'not_started';
    } finally {
      // A returned CLI startup/ACK is not physical completion. Retain same-key
      // and global capacity until original child AND callback persistence drain.
      if (lifetimes.size) void Promise.allSettled([...lifetimes]).then(() => this.keys.delete(key));
      else this.keys.delete(key);
    }
  }
}
