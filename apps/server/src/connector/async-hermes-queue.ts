import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { validConnectorHermesQueueOutput, type ConnectorHermesQueueKind, type ConnectorHermesQueueCommands } from './connector-hermes-queue-domain.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { guardedTrace } from '../diagnostics/guarded-trace.js';

type Options = { owner: Pick<AsyncConnectorOwner, 'command'>;
  diagnostics?: PerformanceDiagnostics;
  /** Original projection/wake only, never a replacement store/native effect. */
  changed(key: string, targetId: string, edit: boolean): void | Promise<void> };

/** Physical owner work and publication are drained independently of HTTP
 * waiters. A lost ACK is only recovered with readReceipt, never replayed. */
export class AsyncHermesQueue {
  private stopped = false;
  private closing: Promise<void> | undefined;
  private readonly tasks = new Set<Promise<unknown>>();
  constructor(private readonly options: Options) {}
  private call<K extends ConnectorHermesQueueKind>(kind: K, input: ConnectorHermesQueueCommands[K]['input'], signal?: AbortSignal): Promise<ConnectorHermesQueueCommands[K]['output']> {
    signal?.throwIfAborted();
    if (this.stopped || this.tasks.size >= 128) return Promise.reject(new ConnectorOwnerUnavailable());
    const original = structuredClone(input);
    const task = Promise.resolve().then(async () => {
      if (this.stopped) throw new ConnectorOwnerUnavailable();
      const value = await this.options.owner.command(kind, original);
      if (!validConnectorHermesQueueOutput(kind, value)) throw new ConnectorOwnerUnavailable();
      if (!('error' in value)) {
        if (value.key !== original.key || 'mutationKey' in original && 'receipt' in value
          && (value.receipt && value.receipt.key !== original.mutationKey
            || 'messageId' in original.target && value.targetId !== original.target.messageId)
          || 'after' in original && 'page' in value && value.page.items.some(item => Number(item.version.split(':')[0]) <= original.after)) throw new ConnectorOwnerUnavailable();
        if ('changed' in value && value.changed) {
          // Persistence remains authoritative if the original in-memory view
          // fails; do not turn accepted work into a retry opportunity.
          const trace = guardedTrace(this.options.diagnostics ?? performanceDiagnostics, 'hermes-queue-projection');
          let failed = true;
          try { await this.options.changed(original.key, value.targetId, kind === 'hermesQueuedEdit'); failed = false; }
          catch { /* original event/history restores projection */ }
          finally { trace.finish(failed); }
        }
      }
      return value;
    });
    this.tasks.add(task);
    const settled = () => { this.tasks.delete(task); }; void task.then(settled, settled);
    return task;
  }
  page(input: ConnectorHermesQueueCommands['hermesQueuePage']['input'], signal?: AbortSignal) { return this.call('hermesQueuePage', input, signal); }
  commandPage(input: ConnectorHermesQueueCommands['hermesQueueCommandPage']['input'], signal?: AbortSignal) { return this.call('hermesQueueCommandPage', input, signal); }
  edit(input: ConnectorHermesQueueCommands['hermesQueuedEdit']['input'], signal?: AbortSignal) { return this.call('hermesQueuedEdit', input, signal); }
  cancel(input: ConnectorHermesQueueCommands['hermesQueuedCancel']['input'], signal?: AbortSignal) { return this.call('hermesQueuedCancel', input, signal); }
  readReceipt(input: ConnectorHermesQueueCommands['hermesQueueReceiptRead']['input'], signal?: AbortSignal) { return this.call('hermesQueueReceiptRead', input, signal); }
  close() {
    if (this.closing) return this.closing;
    this.stopped = true;
    return this.closing = Promise.resolve().then(async () => { while (this.tasks.size) await Promise.allSettled([...this.tasks]); });
  }
}
