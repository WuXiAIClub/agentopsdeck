import type { AsyncConnectorOwner } from './async-connector-owner.js';
import type { ApplicationCommandScope } from '../auth/application-command-scope.js';
import type { ApplicationTransactionEvidence } from '../auth/application-transaction-gate.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { validConnectorHermesDeletionOutput, type ConnectorHermesDeletionCommands, type ConnectorHermesDeletionKind,
  type HermesDeletionResult } from './connector-hermes-deletion-domain.js';
import { inspectHermesDeletion, deleteHermesNative, type HermesDeletionNative } from '../hermes/session-deletion.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

type Native = HermesDeletionNative & { available(): boolean; epoch(): string; live(key: string): string | undefined };
type Options = { owner: Pick<AsyncConnectorOwner, 'command'>; native: Native; diagnostics?: PerformanceDiagnostics;
  /** Fence original dispatch/attach and drain already entered reads. Never opens storage. */
  fence(key: string): void | Promise<void>; closed(key: string, live: string): void; removed(key: string): void };

/** Tracks ORIGINAL physical work, not HTTP waiters. No timeout can free the key
 * or turn a pending deletion into another native attempt. No sync store. */
export class AsyncHermesDeletion {
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly keys = new Set<string>();
  private stopped = false;
  private closing: Promise<void> | undefined;
  constructor(private readonly options: Options) {}
  private async call<K extends ConnectorHermesDeletionKind>(kind: K, input: ConnectorHermesDeletionCommands[K]['input']) {
    const output = await this.options.owner.command(kind, input);
    if (!validConnectorHermesDeletionOutput(kind, output)) throw new ConnectorOwnerUnavailable();
    if (output && typeof output === 'object' && !('error' in output)) {
      const key = 'key' in input ? input.key : input.intent.key;
      if (output.key !== key || 'commandKey' in input && output.commandKey !== input.commandKey
        || 'intent' in input && output.receipt?.id !== input.intent.receiptId) throw new ConnectorOwnerUnavailable();
    }
    return output;
  }
  receipt(key: string, commandKey: string, authorization: string) {
    return this.call('hermesDeletionReceiptRead', { key, commandKey, authorization });
  }
  remove(key: string, commandKey: string, authorization: string, application?: ApplicationTransactionEvidence,
    authority?: ApplicationCommandScope): Promise<ConnectorHermesDeletionCommands['hermesDeletionClaim']['output']> {
    if (this.stopped || this.keys.has(key) || this.tasks.size >= 128) return Promise.resolve({ error: 409 });
    this.keys.add(key);
    const evidence = application === undefined ? undefined : structuredClone(application);
    const task = Promise.resolve().then(() => this.removeOnce(key, commandKey, authorization, evidence, authority));
    this.tasks.add(task);
    const settled = () => { this.tasks.delete(task); this.keys.delete(key); };
    void task.then(settled, settled);
    return task;
  }
  private async removeOnce(key: string, commandKey: string, authorization: string, application?: ApplicationTransactionEvidence,
    authority?: ApplicationCommandScope) {
    const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'hermes-session-deletion');
    let accepted = false, original: HermesDeletionResult | undefined;
    try {
      trace.add('step', 1); await authority?.authorize('prepare'); authority?.local();
      if (this.stopped || this.options.native.available() !== true) return { error: 409 as const };
      const result = await this.call('hermesDeletionClaim', { key, commandKey, authorization, ...(application === undefined ? {} : { application }) });
      if ('error' in result || !result.admitted) return result;
      original = result;
      const intent = result.intent!;
      const epoch = this.options.native.epoch();
      await this.options.fence(key);
      const live = this.options.native.live(key);
      let liveClosed = false;
      const current = () => {
        try { authority?.local(); } catch { return false; }
        return !this.stopped && this.options.native.available() === true && this.options.native.epoch() === epoch
          && (liveClosed ? this.options.native.live(key) === undefined : this.options.native.live(key) === live);
      };
      if (!current()) throw new ConnectorOwnerUnavailable();
      trace.add('step', 2);
      await inspectHermesDeletion(intent.stored, live, this.options.native);
      if (!current()) throw new ConnectorOwnerUnavailable();
      await deleteHermesNative(intent.stored, live, this.options.native, async stage => {
        await authority?.authorize('effect');
        if (!current() || await this.call('hermesDeletionReady', { intent, authorization, stage }) !== true || !current()) throw new ConnectorOwnerUnavailable();
        trace.add('step', stage === 'close' ? 3 : 4);
      }, () => {
        liveClosed = true;
        if (live) this.options.closed(key, live);
      }, current);
      const settled = await this.call('hermesDeletionSettle', { intent, accepted: true });
      if (!settled || settled.receipt.state !== 'accepted') throw new ConnectorOwnerUnavailable();
      accepted = true;
      // Projection cannot undo or disguise the original durable acceptance.
      try { await authority?.authorize('prepare'); if (current()) this.options.removed(key); } catch { /* recover from original event/history */ }
      trace.add('settled', 1);
      return settled;
    } catch {
      trace.add('unknown', 1);
      if (original?.intent) {
        try {
          const unknown = await this.call('hermesDeletionSettle', { intent: original.intent, accepted: false });
          if (unknown) return unknown;
        } catch { /* Keep original pending/unknown and physical ownership. */ }
      }
      throw new ConnectorOwnerUnavailable();
    } finally { trace.finish(!accepted); }
  }
  close() {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.closing = Promise.resolve().then(async () => {
      while (this.tasks.size) await Promise.allSettled([...this.tasks]);
    });
    return this.closing;
  }
}
