import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { connectorHermesDispatchReplyMatches, validConnectorHermesDispatchOutput,
  type ConnectorHermesDispatchCommands, type ConnectorHermesDispatchKind } from './connector-hermes-dispatch-domain.js';
import { AsyncHermesExecution } from './async-hermes-execution.js';
import { dispatchHermes, type HermesDispatchNative, type HermesDispatchPort } from '../hermes/dispatch.js';
import { runNativeOperation } from './native-operation.js';
import type { HermesExecution } from '../hermes/journal.js';
import type { HermesHistoryRow } from '../hermes/history.js';
import type { PerformanceDiagnostics } from '../diagnostics/performance.js';

/** Complete queue-to-native consumer, not a production second writer. The
 * original runtime assembly supplies ONE owner and its original native port. */
export class AsyncHermesDispatch {
  private paused = false;
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly dispatching = new Set<string>();
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly physical = new Set<Promise<unknown>>();
  private readonly persistence: AsyncHermesExecution;
  constructor(private readonly options: { owner: Pick<AsyncConnectorOwner, 'command'>; native: HermesDispatchNative;
    deadlineMs: number; blockPreparationFailures?: boolean; claimed?: (execution: HermesExecution) => void;
    admitted?: (execution: HermesExecution, rows: HermesHistoryRow[]) => Promise<void>; diagnostics?: PerformanceDiagnostics }) {
    if (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs < 1 || options.deadlineMs > 2_147_483_647) throw Error('Invalid Hermes operation deadline');
    this.persistence = new AsyncHermesExecution(options.owner);
  }
  private async drain() {
    // A callback can synchronously pause/close before its returned physical
    // promise is registered. Published tasks must settle first (including any
    // caller deadline), then collect the original still-running operations.
    await Promise.allSettled([...this.tasks]);
    await Promise.allSettled([...this.physical]);
  }
  pause() { this.paused = true; return { drained: this.drain(), resume: () => this.resume() }; }
  resume() { if (this.closed) return false; this.paused = false; return true; }
  close() { this.closed = true; this.paused = true; return this.closing ??= this.drain(); }
  private async call<K extends ConnectorHermesDispatchKind>(kind: K, input: ConnectorHermesDispatchCommands[K]['input']) {
    const value = await this.options.owner.command(kind, input);
    if (!validConnectorHermesDispatchOutput(kind, value) || !connectorHermesDispatchReplyMatches(kind, input, value)) throw new ConnectorOwnerUnavailable();
    return value;
  }
  dispatch(key: string, signal?: AbortSignal) {
    if (this.closed || this.paused || signal?.aborted || this.dispatching.has(key)
      || this.tasks.size >= 128 || this.dispatching.size >= 128) return Promise.resolve('not_started');
    // Publish before invoking owner/native/observer callbacks: any synchronous
    // reentry into close/pause must retain this original task. This deferral is
    // only at dispatch entry, never between nativeReady and native submission.
    const task = Promise.resolve().then(() => this.dispatchOnce(key, signal));
    this.tasks.add(task);
    void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task));
    return task;
  }
  private async dispatchOnce(key: string, signal?: AbortSignal) {
    if (this.closed || this.paused || signal?.aborted || this.dispatching.has(key) || this.dispatching.size >= 128) return 'not_started';
    this.dispatching.add(key);
    const { native, deadlineMs } = this.options;
    const physical = new Set<Promise<unknown>>();
    const operation = <T>(invoke: () => Promise<T>) => runNativeOperation(() => {
      const pending = Promise.resolve(invoke());
      physical.add(pending);
      this.physical.add(pending);
      // Caller timeout/abort is not physical completion. Keep the same-key and
      // global capacity gates until the original operation actually settles.
      const settled = () => { physical.delete(pending); this.physical.delete(pending); };
      void pending.then(settled, settled);
      return pending;
    }, { timeoutMs: deadlineMs, ...(signal ? { signal } : {}) });
    const port: HermesDispatchPort = {
      plan: target => this.call('hermesDispatchPlan', { key: target }),
      claim: async (plan, live, epoch, id) => {
        const e = await this.call('hermesDispatchClaim', { key: plan.key, digest: plan.digest, live, epoch, id,
          ...(plan.batch ? { separator: plan.batch.separator } : {}) });
        if (e && (JSON.stringify(e.members) !== JSON.stringify(plan.members) || JSON.stringify(e.batch) !== JSON.stringify(plan.batch))) throw new ConnectorOwnerUnavailable();
        return e;
      },
      nativeReady: execution => this.call('hermesDispatchNativeReady', { execution }),
      admitted: execution => this.persistence.admitted(execution), unknown: execution => this.persistence.unknown(execution),
      ...(this.options.blockPreparationFailures ? { preparationFailed: (key: string, head: string) => this.call('hermesDispatchPreparationFailed', { key, head }) } : {}),
    };
    try {
      return await dispatchHermes(key, port, {
        available: () => !this.paused && !signal?.aborted && native.available() === true, epoch: () => native.epoch(),
        attach: target => operation(() => native.attach(target)), history: live => operation(() => native.history(live)),
        submit: (live, text) => operation(() => native.submit(live, text)),
      }, { claimed: e => this.options.claimed?.(e), admitted: async (e, rows) => { await this.options.admitted?.(e, rows); } }, this.options.diagnostics);
    } finally {
      if (physical.size) void Promise.allSettled([...physical]).then(() => { this.dispatching.delete(key); });
      else this.dispatching.delete(key);
    }
  }
}
