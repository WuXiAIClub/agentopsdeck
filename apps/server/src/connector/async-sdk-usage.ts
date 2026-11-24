import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { validConnectorSdkUsageOutput, connectorSdkUsageSteps, type ConnectorSdkUsageKind, type ConnectorSdkUsageCommands } from './connector-sdk-usage-domain.js';
import { validConnectorSdkHistoryOutput } from './connector-sdk-history-domain.js';
import { ReadRequestOwner } from '../lifecycle/read-request-owner.js';
import type { PerformanceDiagnostics } from '../diagnostics/performance.js';

/** Holds original physical work through final delivery. Snapshot creation uses
 * its immutable caller-supplied requestId; ending a waiter cannot undo a commit
 * and never generates or submits a replacement request. */
export class AsyncSdkUsage {
  private readonly reads: ReadRequestOwner;
  constructor(private readonly owner: Pick<AsyncConnectorOwner, 'command'>, options: { timeoutMs?: number; diagnostics?: PerformanceDiagnostics } = {}) {
    this.reads = new ReadRequestOwner('connector-event-projection', { waitMs: options.timeoutMs, diagnostics: options.diagnostics, limit: 4 });
  }
  range(input: ConnectorSdkUsageCommands['sdkUsageRange']['input'], request: Request) { return this.run('sdkUsageRange', input, request); }
  export(input: ConnectorSdkUsageCommands['sdkUsageExport']['input'], request: Request) { return this.run('sdkUsageExport', input, request); }
  createSnapshot(input: ConnectorSdkUsageCommands['sdkUsageSnapshotCreate']['input'], request: Request) { return this.run('sdkUsageSnapshotCreate', input, request); }
  readSnapshot(input: ConnectorSdkUsageCommands['sdkUsageSnapshotRead']['input'], request: Request) { return this.run('sdkUsageSnapshotRead', input, request); }
  private async run<K extends ConnectorSdkUsageKind>(kind: K, input: ConnectorSdkUsageCommands[K]['input'], request: Request): Promise<ConnectorSdkUsageCommands[K]['output']> {
    const original = { ...input };
    return (await this.reads.run(request, async context => {
      const { value: result } = await context.stage(connectorSdkUsageSteps[kind] - 65, () => this.owner.command(kind, original));
      if (!validConnectorSdkUsageOutput(kind, result)) throw new ConnectorOwnerUnavailable();
      if ('error' in result) return result;
      const body = result.body;
      const usage = 'data' in body ? body.data.usage : 'usage' in body ? body.usage : body;
      if (result.runtime !== original.runtime || result.key !== original.key
        || 'requestId' in original && (!('requestId' in body) || body.requestId !== original.requestId)
        || 'from' in original && (usage.from !== original.from || usage.to !== original.to || usage.bucketMs !== original.bucketMs)) throw new ConnectorOwnerUnavailable();
      const { value: delivery } = await context.stage(68, () => this.owner.command('sdkHistoryDeliver', {
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
