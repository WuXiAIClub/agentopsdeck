import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { validConnectorHermesCreationOutput, type ConnectorHermesCreationCommands, type ConnectorHermesCreationKind } from './connector-hermes-creation-domain.js';
import { hermesNativeIdentity } from '../hermes/native-session.js';
import { runNativeOperation } from './native-operation.js';
import type { ApplicationCommandScope } from '../auth/application-command-scope.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

type Options = { owner: Pick<AsyncConnectorOwner, 'command'>; deadlineMs: number; workspace: string;
  native: { available(): boolean; epoch(): string; create(key: string, title: string, workspace: string): Promise<unknown> };
  created(key: string, live: string, epoch: string): void | Promise<void>; diagnostics?: PerformanceDiagnostics };

/** One original effect pipeline, independently of bounded HTTP waiters. A late
 * valid identity is still settled; no timeout can authorize a second create. */
export class AsyncHermesCreation {
  private readonly tasks = new Set<Promise<unknown>>();
  private stopped = false;
  private closing: Promise<void> | undefined;
  constructor(private readonly options: Options) {
    if (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs < 1 || options.deadlineMs > 2_147_483_647) throw Error('Finite Hermes creation deadline required');
  }
  private async call<K extends ConnectorHermesCreationKind>(kind: K, input: ConnectorHermesCreationCommands[K]['input']) {
    const output = await this.options.owner.command(kind, input);
    if (!validConnectorHermesCreationOutput(kind, output)) throw new ConnectorOwnerUnavailable();
    if (output && typeof output === 'object' && !('error' in output)
      && ('commandKey' in input ? output.commandKey !== input.commandKey : output.receipt?.id !== input.intent.receiptId)) throw new ConnectorOwnerUnavailable();
    return output;
  }
  receipt(authorization: string, commandKey: string) { return this.receiptPhysical(authorization, commandKey); }
  receiptPhysical(authorization: string, commandKey: string) { return this.call('hermesCreationReceiptRead', { authorization, commandKey }); }
  create(input: ConnectorHermesCreationCommands['hermesCreationClaim']['input']) {
    return runNativeOperation(() => this.createPhysical(input), { timeoutMs: this.options.deadlineMs });
  }
  createPhysical(input: ConnectorHermesCreationCommands['hermesCreationClaim']['input'], authority?: ApplicationCommandScope) {
    if (this.stopped || this.tasks.size >= 128) return Promise.resolve({ error: 409 as const });
    const pinned = structuredClone(input);
    const task = Promise.resolve().then(() => this.createOnce(pinned, authority));
    this.tasks.add(task);
    const done = () => { this.tasks.delete(task); };
    void task.then(done, done);
    return task;
  }
  private async createOnce(input: ConnectorHermesCreationCommands['hermesCreationClaim']['input'], authority?: ApplicationCommandScope) {
    const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'hermes-session-creation');
    let accepted = false;
    let original: ConnectorHermesCreationCommands['hermesCreationClaim']['output'] | undefined;
    try {
      trace.add('step', 1);
      await authority?.authorize('prepare'); authority?.local();
      original = await this.call('hermesCreationClaim', { ...input,
        ...(this.stopped || this.options.native.available() !== true ? { rejectFresh: 'runtime_unavailable' as const } : {}) });
      if ('error' in original || !original.admitted) return original;
      const intent = original.intent!, epoch = this.options.native.epoch();
      const current = () => { authority?.local(); return !this.stopped && this.options.native.available() === true && !!epoch && this.options.native.epoch() === epoch; };
      await authority?.authorize('effect');
      if (!current() || await this.call('hermesCreationReady', { intent, authorization: input.authorization }) !== true || !current()) throw new ConnectorOwnerUnavailable();
      trace.add('step', 2);
      // Physical promise: intentionally NOT the bounded caller wait. Neither
      // late success nor caller cancellation may lose the original identity.
      const identity = hermesNativeIdentity(await this.options.native.create(intent.key, intent.title, this.options.workspace));
      trace.add('step', 3);
      const settled = await this.call('hermesCreationSettle', { intent, stored: identity.stored });
      if (!settled || settled.receipt.state !== 'accepted') throw new ConnectorOwnerUnavailable();
      accepted = true;
      try { await authority?.authorize('prepare'); if (current()) await this.options.created(intent.key, identity.live, epoch); }
      catch { /* original durable ACK is authoritative, including caller close */ }
      trace.add('settled', 1);
      return settled;
    } catch {
      trace.add('unknown', 1);
      if (original && !('error' in original) && original.intent) {
        try {
          const settled = await this.call('hermesCreationSettle', { intent: original.intent, stored: null });
          if (settled) return settled;
        } catch { /* Original pending receipt survives; never re-create. */ }
      }
      throw new ConnectorOwnerUnavailable();
    } finally { trace.finish(!accepted); }
  }
  close() {
    if (this.closing) return this.closing;
    this.stopped = true;
    return this.closing = Promise.resolve().then(async () => {
      while (this.tasks.size) await Promise.allSettled([...this.tasks]);
    });
  }
}
