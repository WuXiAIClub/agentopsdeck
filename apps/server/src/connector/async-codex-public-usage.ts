import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { connectorCodexPublicUsageSteps, validConnectorCodexPublicUsageOutput,
  type ConnectorCodexPublicUsageCommands, type ConnectorCodexPublicUsageKind } from './connector-codex-public-usage-domain.js';
import { ReadRequestOwner } from '../lifecycle/read-request-owner.js';
import type { PerformanceDiagnostics } from '../diagnostics/performance.js';

type Kind = Exclude<ConnectorCodexPublicUsageKind, 'codexPublicUsageDeliver'>;
export class AsyncCodexPublicUsage {
  private readonly reads: ReadRequestOwner;
  constructor(private readonly options: { owner: Pick<AsyncConnectorOwner, 'command'>; local(): void;
    sessionExists(key: string): boolean; timeoutMs?: number; diagnostics?: PerformanceDiagnostics }) {
    this.reads = new ReadRequestOwner('codex-public-usage', { waitMs: options.timeoutMs, diagnostics: options.diagnostics, limit: 4 });
  }
  range(input: ConnectorCodexPublicUsageCommands['codexPublicUsageRange']['input'], request: Request) { return this.run('codexPublicUsageRange', input, request); }
  export(input: ConnectorCodexPublicUsageCommands['codexPublicUsageExport']['input'], request: Request) { return this.run('codexPublicUsageExport', input, request); }
  createSnapshot(input: ConnectorCodexPublicUsageCommands['codexPublicUsageSnapshotCreate']['input'], request: Request) { return this.run('codexPublicUsageSnapshotCreate', input, request); }
  readSnapshot(input: ConnectorCodexPublicUsageCommands['codexPublicUsageSnapshotRead']['input'], request: Request) { return this.run('codexPublicUsageSnapshotRead', input, request); }
  private async run<K extends Kind>(kind: K, input: ConnectorCodexPublicUsageCommands[K]['input'], request: Request): Promise<ConnectorCodexPublicUsageCommands[K]['output']> {
    const original = { ...input };
    return (await this.reads.run(request, async context => {
      this.options.local();
      if (!this.options.sessionExists(original.key)) return { error: 404 as const };
      const { value: result } = await context.stage(connectorCodexPublicUsageSteps[kind], () => this.options.owner.command(kind, original));
      if (!validConnectorCodexPublicUsageOutput(kind, result)) throw new ConnectorOwnerUnavailable();
      if ('error' in result) return result;
      const body = result.body, usage = 'data' in body ? body.data.usage : 'usage' in body ? body.usage : body;
      if (result.runtime !== original.runtime || result.key !== original.key
        || 'requestId' in original && (!('requestId' in body) || body.requestId !== original.requestId)
        || 'from' in original && (usage.from !== original.from || usage.to !== original.to || usage.bucketMs !== original.bucketMs)) throw new ConnectorOwnerUnavailable();
      const { value: delivery } = await context.stage(connectorCodexPublicUsageSteps.codexPublicUsageDeliver,
        () => this.options.owner.command('codexPublicUsageDeliver', { runtime: 'codex', key: original.key,
          authorization: original.authorization, readerId: result.readerId }));
      if (!validConnectorCodexPublicUsageOutput('codexPublicUsageDeliver', delivery)) throw new ConnectorOwnerUnavailable();
      if ('error' in delivery) return delivery;
      if (delivery.runtime !== result.runtime || delivery.key !== result.key || delivery.readerId !== result.readerId) throw new ConnectorOwnerUnavailable();
      this.options.local(); context.check();
      return this.options.sessionExists(original.key) ? result : { error: 404 as const };
    })).value;
  }
  close() { return this.reads.close(); }
}
