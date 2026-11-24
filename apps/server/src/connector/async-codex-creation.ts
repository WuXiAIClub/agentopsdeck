import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import type { ApplicationCommandScope } from '../auth/application-command-scope.js';
import { validConnectorCodexCreationOutput, type ConnectorCodexCreationCommands, type ConnectorCodexCreationKind,
  type CodexCreationIntent, type CodexCreationResult } from './connector-codex-creation-domain.js';
import { runNativeOperation } from './native-operation.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

export type CodexCreationPort = { ready(): Promise<void>; identify(threadId: string): Promise<void>;
  nameReady(): Promise<void>; accept(): Promise<void>; local(): void };
type Options = { owner: Pick<AsyncConnectorOwner, 'command'>; deadlineMs: number;
  native: { available(): boolean; createSessionOwned(intent: CodexCreationIntent, port: CodexCreationPort): Promise<{ key: string }> };
  diagnostics?: PerformanceDiagnostics };

/** Physical creation is not owned by the HTTP waiter's deadline. Owner close
 * freezes new admission then drains this set before runtime/storage shutdown. */
export class AsyncCodexCreation {
  private readonly tasks = new Set<Promise<unknown>>();
  private stopped = false;
  private closing: Promise<void> | undefined;
  constructor(private readonly options: Options) {
    if (!Number.isSafeInteger(options.deadlineMs) || options.deadlineMs < 1 || options.deadlineMs > 2_147_483_647) throw Error('Finite Codex creation deadline required');
  }
  private async call<K extends ConnectorCodexCreationKind>(kind: K, input: ConnectorCodexCreationCommands[K]['input']) {
    const value = await this.options.owner.command(kind, input);
    if (!validConnectorCodexCreationOutput(kind, value)) throw new ConnectorOwnerUnavailable();
    if (value && typeof value === 'object' && !('error' in value)
      && ('commandKey' in input ? value.commandKey !== input.commandKey : value.receipt?.id !== input.intent.receiptId)) throw new ConnectorOwnerUnavailable();
    return value;
  }
  receipt(authorization: string, commandKey: string) { return this.receiptPhysical(authorization, commandKey); }
  receiptPhysical(authorization: string, commandKey: string) { return this.call('codexCreationReceiptRead', { authorization, commandKey }); }
  create(input: ConnectorCodexCreationCommands['codexCreationClaim']['input']) {
    return runNativeOperation(() => this.createPhysical(input), { timeoutMs: this.options.deadlineMs });
  }
  createPhysical(input: ConnectorCodexCreationCommands['codexCreationClaim']['input'], authority?: ApplicationCommandScope) {
    if (this.stopped || this.tasks.size >= 128) return Promise.resolve({ error: 409 as const });
    const pinned = structuredClone(input);
    const task = Promise.resolve().then(() => this.createOnce(pinned, authority));
    this.tasks.add(task);
    const done = () => { this.tasks.delete(task); }; void task.then(done, done);
    return task;
  }
  private async createOnce(input: ConnectorCodexCreationCommands['codexCreationClaim']['input'], authority?: ApplicationCommandScope) {
    const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'codex-session-creation');
    let original: ConnectorCodexCreationCommands['codexCreationClaim']['output'] | undefined;
    let accepted: CodexCreationResult | undefined;
    const local = () => { authority?.local(); if (this.stopped || this.options.native.available() !== true) throw new ConnectorOwnerUnavailable(); };
    try {
      trace.add('step', 1);
      await authority?.authorize('prepare'); authority?.local();
      original = await this.call('codexCreationClaim', { ...input,
        ...(this.stopped || this.options.native.available() !== true ? { rejectFresh: 'runtime_unavailable' as const } : {}) });
      if ('error' in original || !original.admitted) return original;
      const intent = original.intent!;
      const gate = async (kind: 'codexCreationReady' | 'codexCreationNameReady') => {
        await authority?.authorize('effect');
        local(); if (await this.call(kind, { intent, authorization: input.authorization }) !== true) throw new ConnectorOwnerUnavailable(); local();
      };
      local();
      await this.options.native.createSessionOwned(intent, {
        local, ready: () => gate('codexCreationReady'), nameReady: () => gate('codexCreationNameReady'),
        identify: async threadId => {
          // No local/revocation fence before saving an irreversible native ID.
          trace.add('step', 2);
          if (await this.call('codexCreationIdentify', { intent, threadId }) !== true) throw new ConnectorOwnerUnavailable();
        },
        accept: async () => {
          const settled = await this.call('codexCreationAccept', { intent });
          if (!settled || settled.receipt.state !== 'accepted') throw new ConnectorOwnerUnavailable();
          accepted = settled; trace.add('settled', 1);
          // Settlement records the irreversible ACK without reauthorization.
          // Subsequent caller-side projection still requires current authority.
          await authority?.authorize('prepare'); local();
        },
      });
      if (!accepted) throw new ConnectorOwnerUnavailable();
      return accepted;
    } catch {
      if (accepted) return accepted;
      trace.add('unknown', 1);
      if (original && !('error' in original) && original.intent) {
        try {
          const current = await this.call('codexCreationAbandon', { intent: original.intent });
          if (current) return current;
          // Accept may have committed and retired its private binding before
          // its ACK was lost. Read the original scoped receipt; never reclaim
          // the command or call native again to discover its result.
          const stored = await this.receipt(input.authorization, input.commandKey);
          if (!('error' in stored) && stored.receipt?.id === original.receipt.id) {
            const recovered: CodexCreationResult = { commandKey: stored.commandKey, receipt: stored.receipt, intent: null, admitted: false };
            if (stored.receipt.state === 'accepted') { accepted = recovered; trace.add('settled', 1); }
            return recovered;
          }
        }
        catch { /* Original pending receipt/identity remains authoritative. No replay. */ }
      }
      throw new ConnectorOwnerUnavailable();
    } finally { trace.finish(!accepted); }
  }
  /** Physical effects already entered before a maintenance pause. Does not
   * freeze receipt reads or dispose this owner; local() vetoes new effects. */
  drain() { return Promise.allSettled([...this.tasks]).then(() => {}); }
  close() {
    if (this.closing) return this.closing;
    this.stopped = true;
    return this.closing = Promise.resolve().then(async () => { while (this.tasks.size) await Promise.allSettled([...this.tasks]); });
  }
}
