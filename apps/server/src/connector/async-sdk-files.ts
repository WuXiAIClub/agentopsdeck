import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { validConnectorSdkFilesOutput, connectorSdkFilesSteps, type ConnectorSdkFilesKind, type ConnectorSdkFilesCommands } from './connector-sdk-files-domain.js';
import { validConnectorSdkHistoryOutput } from './connector-sdk-history-domain.js';
import { ReadRequestOwner } from '../lifecycle/read-request-owner.js';
import type { PerformanceDiagnostics } from '../diagnostics/performance.js';

/** Ending the HTTP wait never releases or replays physical scan/commit work. */
export class AsyncSdkFiles {
  private readonly reads: ReadRequestOwner;
  constructor(private readonly owner: Pick<AsyncConnectorOwner, 'command'>, options: { timeoutMs?: number; diagnostics?: PerformanceDiagnostics } = {}) {
    this.reads = new ReadRequestOwner('connector-event-projection', { waitMs: options.timeoutMs, diagnostics: options.diagnostics, limit: 4 });
  }
  page(input: ConnectorSdkFilesCommands['sdkFilesPage']['input'], request: Request) { return this.run('sdkFilesPage', input, request); }
  start(input: ConnectorSdkFilesCommands['sdkFilesStart']['input'], request: Request) { return this.run('sdkFilesStart', input, request); }
  step(input: ConnectorSdkFilesCommands['sdkFilesStep']['input'], request: Request) { return this.run('sdkFilesStep', input, request); }
  cancel(input: ConnectorSdkFilesCommands['sdkFilesCancel']['input'], request: Request) { return this.run('sdkFilesCancel', input, request); }
  private async run<K extends ConnectorSdkFilesKind>(kind: K, input: ConnectorSdkFilesCommands[K]['input'], request: Request): Promise<ConnectorSdkFilesCommands[K]['output']> {
    const original = { ...input };
    return (await this.reads.run(request, async context => {
      const { value: result } = await context.stage(connectorSdkFilesSteps[kind] - 64, () => this.owner.command(kind, original));
      if (!validConnectorSdkFilesOutput(kind, result)) throw new ConnectorOwnerUnavailable();
      if ('error' in result) return result;
      if (result.runtime !== original.runtime || result.key !== original.key
        || 'jobId' in original && (!('id' in result.body) || result.body.id !== original.jobId)) throw new ConnectorOwnerUnavailable();
      const { value: delivery } = await context.stage(73, () => this.owner.command('sdkHistoryDeliver', {
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
