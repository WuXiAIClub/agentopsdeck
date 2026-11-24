import type { CodexAppServer } from '../codex/app-server.js';
import type { ApplicationCommandScope } from '../auth/application-command-scope.js';
import type { ApplicationTransactionEvidence } from '../auth/application-transaction-gate.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { validConnectorCodexDeletionOutput, type ConnectorCodexDeletionCommands, type ConnectorCodexDeletionKind } from './connector-codex-deletion-domain.js';

/** One original archive and its physical settlement. HTTP timeout cannot free
 * an intent or turn an unknown receipt into permission for another effect. */
export class AsyncCodexDeletion {
  private readonly pending = new Set<Promise<void>>();
  private frozen = false;
  private closing: Promise<void> | undefined;
  constructor(private readonly deps: { owner: Pick<AsyncConnectorOwner, 'command'>;
    runtime: Pick<CodexAppServer, 'removeOwned'>; writable(): boolean; local(key: string): void;
    diagnostics?: PerformanceDiagnostics }) {}
  private track<T>(work: () => Promise<T>): Promise<T> {
    if (this.frozen || this.pending.size >= 128) return Promise.reject(new ConnectorOwnerUnavailable());
    const task = Promise.resolve().then(work);
    const done = () => { this.pending.delete(drain); };
    const drain = task.then(done, done); this.pending.add(drain);
    return task;
  }
  private async command<K extends ConnectorCodexDeletionKind>(kind: K, input: ConnectorCodexDeletionCommands[K]['input']) {
    const result = await this.deps.owner.command(kind, input);
    if (!validConnectorCodexDeletionOutput(kind, result)) throw new ConnectorOwnerUnavailable();
    if (result && typeof result === 'object' && !('error' in result)) {
      const request: ConnectorCodexDeletionCommands[ConnectorCodexDeletionKind]['input'] = input;
      const ref = 'intent' in request ? request.intent : request;
      if (result.key !== ref.key || result.commandKey !== ref.commandKey
        || 'receiptId' in ref && result.receipt?.id !== ref.receiptId) throw new ConnectorOwnerUnavailable();
    }
    return result;
  }
  receipt(key: string, commandKey: string, authorization: string) {
    const input = { key, commandKey, authorization };
    return this.track(() => this.command('codexDeletionReceipt', input));
  }
  remove(key: string, commandKey: string, authorization: string, application?: ApplicationTransactionEvidence,
    authority?: ApplicationCommandScope): Promise<ConnectorCodexDeletionCommands['codexDeletionClaim']['output']> {
    const evidence = application === undefined ? undefined : structuredClone(application);
    return this.track(async () => {
      const trace = guardedTrace(this.deps.diagnostics ?? performanceDiagnostics, 'codex-session-deletion');
      let failed = true;
      try {
        trace.add('step', 1); await authority?.authorize('prepare'); authority?.local();
        const result = await this.command('codexDeletionClaim', { key, commandKey, authorization,
          ...(evidence === undefined ? {} : { application: evidence }),
          ...(!this.deps.writable() || this.frozen ? { rejectFresh: 'runtime_unavailable' as const } : {}) });
        if ('error' in result || !result.intent) return result;
        const intent = result.intent;
        const local = () => { authority?.local(); if (this.frozen || !this.deps.writable()) throw new ConnectorOwnerUnavailable(); this.deps.local(key); };
        try {
          local();
          await this.deps.runtime.removeOwned(key, local, async () => {
            await authority?.authorize('effect'); local();
            if (!await this.command('codexDeletionBegin', { intent, authorization })) throw new ConnectorOwnerUnavailable();
            local(); trace.add('step', 2);
          }, async () => {
            // Original ACK is an execution fact even after reader revocation.
            const accepted = await this.command('codexDeletionAccept', { intent });
            if (!accepted || accepted.receipt.state !== 'accepted') throw new ConnectorOwnerUnavailable();
            trace.add('settled', 1); await authority?.authorize('prepare'); local();
          });
        } catch {
          trace.add('unknown', 1);
          await this.command('codexDeletionAbandon', { intent }).catch(() => false);
        }
        const current = await this.command('codexDeletionReceipt', { key, commandKey, authorization });
        if ('error' in current) return current;
        if (!current.receipt || current.receipt.id !== intent.receiptId) throw new ConnectorOwnerUnavailable();
        failed = current.receipt.state !== 'accepted';
        return { key, commandKey, receipt: current.receipt, intent: null };
      } finally { trace.finish(failed); }
    });
  }
  freeze() { this.frozen = true; }
  drain(): Promise<void> { return Promise.all([...this.pending]).then(() => {}); }
  close(): Promise<void> { this.freeze(); return this.closing ??= this.drain(); }
}
