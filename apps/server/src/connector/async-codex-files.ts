import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { connectorCodexFilesSteps, validConnectorCodexFilesOutput,
  type ConnectorCodexFilesCommands, type ConnectorCodexFilesKind } from './connector-codex-files-domain.js';
import { ReadRequestOwner } from '../lifecycle/read-request-owner.js';
import type { PerformanceDiagnostics } from '../diagnostics/performance.js';

type Kind = Exclude<ConnectorCodexFilesKind, 'codexFilesDeliver'>;
/** Waiter termination is not physical cancellation, release or step replay. */
export class AsyncCodexFiles {
  private readonly reads: ReadRequestOwner;
  constructor(private readonly options: { owner: Pick<AsyncConnectorOwner, 'command'>; local(): void;
    sessionExists(key: string): boolean; timeoutMs?: number; diagnostics?: PerformanceDiagnostics }) {
    this.reads = new ReadRequestOwner('codex-files', { waitMs: options.timeoutMs, diagnostics: options.diagnostics, limit: 4 });
  }
  page(input: ConnectorCodexFilesCommands['codexFilesPage']['input'], request: Request) { return this.run('codexFilesPage', input, request); }
  start(input: ConnectorCodexFilesCommands['codexFilesStart']['input'], request: Request) { return this.run('codexFilesStart', input, request); }
  step(input: ConnectorCodexFilesCommands['codexFilesStep']['input'], request: Request) { return this.run('codexFilesStep', input, request); }
  cancel(input: ConnectorCodexFilesCommands['codexFilesCancel']['input'], request: Request) { return this.run('codexFilesCancel', input, request); }
  private async run<K extends Kind>(kind: K, input: ConnectorCodexFilesCommands[K]['input'], request: Request): Promise<ConnectorCodexFilesCommands[K]['output']> {
    const original = { ...input };
    return (await this.reads.run(request, async context => {
      this.options.local();
      if (!this.options.sessionExists(original.key)) return { error: 404 as const };
      const { value: result } = await context.stage(connectorCodexFilesSteps[kind], () => this.options.owner.command(kind, original));
      if (!validConnectorCodexFilesOutput(kind, result)) throw new ConnectorOwnerUnavailable();
      if ('error' in result) return result;
      if (result.runtime !== original.runtime || result.key !== original.key
        || 'jobId' in original && (!('id' in result.body) || result.body.id !== original.jobId)) throw new ConnectorOwnerUnavailable();
      const { value: delivery } = await context.stage(connectorCodexFilesSteps.codexFilesDeliver,
        () => this.options.owner.command('codexFilesDeliver', { runtime: 'codex', key: original.key,
          authorization: original.authorization, readerId: result.readerId, generation: result.generation }));
      if (!validConnectorCodexFilesOutput('codexFilesDeliver', delivery)) throw new ConnectorOwnerUnavailable();
      if ('error' in delivery) return delivery;
      if (delivery.runtime !== result.runtime || delivery.key !== result.key || delivery.readerId !== result.readerId
        || delivery.generation !== result.generation) throw new ConnectorOwnerUnavailable();
      this.options.local(); context.check();
      return this.options.sessionExists(original.key) ? result : { error: 404 as const };
    })).value;
  }
  close() { return this.reads.close(); }
}
