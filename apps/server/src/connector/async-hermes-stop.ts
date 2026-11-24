import type { AsyncConnectorOwner } from './async-connector-owner.js';
import type { ApplicationCommandScope } from '../auth/application-command-scope.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import type { HermesExecution } from '../hermes/journal.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { runNativeOperation } from './native-operation.js';
import { sameHermesStopExecution, validConnectorHermesStopOutput, type ConnectorHermesStopCommands, type ConnectorHermesStopKind } from './connector-hermes-stop-domain.js';

type Options = { owner: Pick<AsyncConnectorOwner, 'command'>; deadlineMs: number; diagnostics?: PerformanceDiagnostics;
  native: { available(): boolean; current(key: string): HermesExecution | undefined; epoch(): string;
    interrupt(execution: HermesExecution): Promise<unknown> };
  settled(key: string): void };
type Request = Omit<ConnectorHermesStopCommands['hermesStopClaim']['input'], 'execution'>;
/** Logical waits never cancel or replay the original physical control. Only a
 * committed original ACK releases the persistent successor fence. */
export class AsyncHermesStop {
  private readonly tasks = new Set<Promise<unknown>>();
  private stopped = false;
  private closing: Promise<void> | undefined;
  constructor(private readonly options: Options) {
    if (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs < 1 || options.deadlineMs > 2_147_483_647) throw Error('Finite Hermes stop deadline required');
  }
  private async call<K extends ConnectorHermesStopKind>(kind: K, input: ConnectorHermesStopCommands[K]['input']) {
    const result = await this.options.owner.command(kind, input);
    if (!validConnectorHermesStopOutput(kind, result) || result && typeof result === 'object' && 'key' in result
      && (result.key !== input.key || result.commandKey !== input.commandKey)) throw new ConnectorOwnerUnavailable();
    return result;
  }
  receipt(input: ConnectorHermesStopCommands['hermesStopReceiptRead']['input'], wait: { timeoutMs: number; signal?: AbortSignal }) {
    return runNativeOperation(() => this.call('hermesStopReceiptRead', { ...input }), wait);
  }
  stop(input: Request) {
    return runNativeOperation(() => this.stopPhysical(input), { timeoutMs: this.options.deadlineMs });
  }
  stopPhysical(input: Request, authority?: ApplicationCommandScope) {
    if (this.stopped || this.tasks.size >= 128) return Promise.resolve({ error: 409 as const });
    const pinned = structuredClone(input), task = Promise.resolve().then(() => this.stopOnce(pinned, authority));
    this.tasks.add(task);
    const done = () => { this.tasks.delete(task); }; void task.then(done, done);
    return task;
  }
  private async stopOnce(input: Request, authority?: ApplicationCommandScope) {
    const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'hermes-message-stop');
    let original: ConnectorHermesStopCommands['hermesStopClaim']['output'] | undefined, sent = false, accepted = false;
    try {
      trace.add('step', 1);
      await authority?.authorize('prepare'); authority?.local();
      const local = this.options.native.current(input.key);
      original = await this.call('hermesStopClaim', { ...input,
        execution: !this.stopped && this.options.native.available() === true && local?.phase === 'running' ? structuredClone(local) : null });
      if ('error' in original || !original.execution || !original.receipt) return original;
      const execution = original.execution, ref = { key: input.key, commandKey: input.commandKey, receiptId: original.receipt.id, execution };
      const current = () => { authority?.local(); return !this.stopped && this.options.native.available() === true && this.options.native.epoch() === execution.epoch
        && this.options.native.current(input.key) === local && local?.phase === 'running' && sameHermesStopExecution(local, execution);
      };
      await authority?.authorize('effect');
      if (!current() || await this.call('hermesStopReady', { ...ref, authorization: input.authorization }) !== true || !current()) {
        const rejected = await this.call('hermesStopSettle', { ...ref, outcome: 'not_dispatched' });
        if (!rejected) throw new ConnectorOwnerUnavailable();
        try { this.options.settled(input.key); } catch { /* durable outcome wins */ }
        return rejected;
      }
      trace.add('step', 2); sent = true;
      // No await between final original-run check and invocation. The transport
      // promise, unlike the bounded caller wait, owns the physical outcome.
      await this.options.native.interrupt(execution);
      trace.add('step', 3);
      const result = await this.call('hermesStopSettle', { ...ref, outcome: 'acknowledged' });
      if (!result || result.receipt?.state !== 'accepted') throw new ConnectorOwnerUnavailable();
      accepted = true; trace.add('settled', 1);
      try { this.options.settled(input.key); } catch { /* original receipt wins */ }
      return result;
    } catch {
      trace.add('unknown', 1);
      if (original && !('error' in original) && original.execution && original.receipt) {
        try {
          const result = await this.call('hermesStopSettle', { key: input.key, commandKey: input.commandKey,
            receiptId: original.receipt.id, execution: original.execution, outcome: sent ? 'unknown' : 'not_dispatched' });
          if (result) return result;
        } catch { /* Keep original receipt AND persistent successor fence. */ }
      }
      throw new ConnectorOwnerUnavailable();
    } finally { trace.finish(!accepted); }
  }
  close() {
    if (this.closing) return this.closing;
    this.stopped = true;
    return this.closing = Promise.resolve().then(async () => { while (this.tasks.size) await Promise.allSettled([...this.tasks]); });
  }
}
