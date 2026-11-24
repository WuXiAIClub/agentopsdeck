import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { validConnectorSdkHistoryOutput, type ConnectorSdkHistoryCommands } from './connector-sdk-history-domain.js';
import { ReadRequestError, ReadRequestOwner } from '../lifecycle/read-request-owner.js';
import type { PerformanceDiagnostics } from '../diagnostics/performance.js';

type Kind = 'sdkHistoryPage' | 'sdkHistoryMessage';
/** Own the complete read, including final delivery authority. Ending an HTTP
 * waiter never releases the original worker work or starts a second read. */
export class AsyncSdkHistory {
  private readonly reads: ReadRequestOwner;
  constructor(private readonly owner: Pick<AsyncConnectorOwner, 'command'>, options: { timeoutMs?: number; diagnostics?: PerformanceDiagnostics } = {}) {
    this.reads = new ReadRequestOwner('connector-event-projection', { waitMs: options.timeoutMs, diagnostics: options.diagnostics, limit: 8 });
  }
  page(input: ConnectorSdkHistoryCommands['sdkHistoryPage']['input'], request: Request) { return this.read('sdkHistoryPage', input, request); }
  message(input: ConnectorSdkHistoryCommands['sdkHistoryMessage']['input'], request: Request) { return this.read('sdkHistoryMessage', input, request); }
  private async read<K extends Kind>(kind: K, input: ConnectorSdkHistoryCommands[K]['input'], request: Request): Promise<ConnectorSdkHistoryCommands[K]['output']> {
    const original = { ...input };
    return (await this.reads.run(request, async context => {
      const { value: result } = await context.stage(kind === 'sdkHistoryPage' ? 61 : 62, () => this.owner.command(kind, original));
      if (!validConnectorSdkHistoryOutput(kind, result)) throw new ConnectorOwnerUnavailable();
      if ('error' in result) return result;
      if (result.runtime !== original.runtime || result.key !== original.key
        || kind === 'sdkHistoryMessage' && 'messageId' in original && (!('messageId' in result) || result.messageId !== original.messageId)) throw new ConnectorOwnerUnavailable();
      const { value: delivery } = await context.stage(63, () => this.owner.command('sdkHistoryDeliver', {
        runtime: original.runtime, key: original.key, authorization: original.authorization,
        readerId: result.readerId, nativeSessionId: result.nativeSessionId,
      }));
      if (!validConnectorSdkHistoryOutput('sdkHistoryDeliver', delivery)) throw new ConnectorOwnerUnavailable();
      if ('error' in delivery) return delivery;
      if (delivery.runtime !== result.runtime || delivery.key !== result.key || delivery.readerId !== result.readerId
        || delivery.nativeSessionId !== result.nativeSessionId) throw new ConnectorOwnerUnavailable();
      context.check(); return result;
    })).value;
  }
  close() { return this.reads.close(); }
}
export { ReadRequestError };
