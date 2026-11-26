import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { ConnectorOwnerUnavailable } from './connector-owner-domain.js';
import { validConnectorSdkMetadataOutput, type ConnectorSdkMetadataCommands } from './connector-sdk-metadata-domain.js';
import { validConnectorSdkHistoryOutput } from './connector-sdk-history-domain.js';
import type { SdkAgentId } from './sdk-execution-journal.js';
import { validSdkModel } from './sdk-models.js';
import { ReadRequestOwner } from '../lifecycle/read-request-owner.js';
import type { PerformanceDiagnostics } from '../diagnostics/performance.js';

export type SdkModelDiscoverers = Partial<Record<SdkAgentId, () => Promise<Array<{ id: string; label: string }>>>>;
const validDiscoveredModel = (value: unknown): value is { id: string; label: string } => !!value
  && typeof value === 'object' && !Array.isArray(value)
  && validSdkModel((value as Record<string, unknown>).id)
  && typeof (value as Record<string, unknown>).label === 'string'
  && ((value as Record<string, unknown>).label as string).trim().length > 0
  && ((value as Record<string, unknown>).label as string).length <= 120
  && !/[\p{Cc}\p{Cf}]/u.test((value as Record<string, unknown>).label as string);

export class AsyncSdkMetadata {
  private readonly reads: ReadRequestOwner;
  private readonly discoverModels: SdkModelDiscoverers | undefined;
  constructor(
    private readonly owner: Pick<AsyncConnectorOwner, 'command'>,
    options: { timeoutMs?: number; diagnostics?: PerformanceDiagnostics; discoverModels?: SdkModelDiscoverers } = {},
  ) {
    this.reads = new ReadRequestOwner('connector-event-projection', { waitMs: options.timeoutMs, diagnostics: options.diagnostics, limit: 8 });
    this.discoverModels = options.discoverModels;
  }
  async state(input: ConnectorSdkMetadataCommands['sdkStateRead']['input'], request: Request): Promise<ConnectorSdkMetadataCommands['sdkStateRead']['output']> {
    const original = { ...input };
    return (await this.reads.run(request, async context => {
      const { value } = await context.stage(74, () => this.owner.command('sdkStateRead', original));
      if (!validConnectorSdkMetadataOutput('sdkStateRead', value)) throw new ConnectorOwnerUnavailable();
      if ('error' in value) return value;
      if (value.runtime !== original.runtime || value.key !== original.key) throw new ConnectorOwnerUnavailable();
      const { value: delivery } = await context.stage(75, () => this.owner.command('sdkHistoryDeliver', {
        runtime: original.runtime, key: original.key, authorization: original.authorization, readerId: value.readerId, nativeSessionId: value.nativeSessionId,
      }));
      if (!validConnectorSdkHistoryOutput('sdkHistoryDeliver', delivery)) throw new ConnectorOwnerUnavailable();
      if ('error' in delivery) return delivery;
      if (delivery.runtime !== value.runtime || delivery.key !== value.key || delivery.readerId !== value.readerId || delivery.nativeSessionId !== value.nativeSessionId) throw new ConnectorOwnerUnavailable();
      context.check(); return value;
    })).value;
  }
  async models(input: ConnectorSdkMetadataCommands['sdkModelsRead']['input'], request: Request): Promise<ConnectorSdkMetadataCommands['sdkModelsRead']['output']> {
    const original = { ...input };
    return (await this.reads.run(request, async context => {
      const { value } = await context.stage(76, () => this.owner.command('sdkModelsRead', original));
      if (!validConnectorSdkMetadataOutput('sdkModelsRead', value)) throw new ConnectorOwnerUnavailable();
      if ('error' in value) return value;
      if (value.runtime !== original.runtime) throw new ConnectorOwnerUnavailable();
      let body = value.body;
      const discover = this.discoverModels?.[original.runtime];
      if (discover) {
        try {
          const discovered = await discover();
          if (Array.isArray(discovered) && discovered.length > 0 && discovered.length <= 100
            && discovered.every(validDiscoveredModel)
            && new Set(discovered.map(model => model.id)).size === discovered.length) {
            body = { models: discovered.map(model => ({ id: model.id, label: model.label })) };
          }
        } catch {
          // Retain the owner's fallback catalog when dynamic CLI discovery is unavailable.
        }
      }
      const { value: delivery } = await context.stage(77, () => this.owner.command('sdkModelsDeliver', { ...original, readerId: value.readerId }));
      if (!validConnectorSdkMetadataOutput('sdkModelsDeliver', delivery)) throw new ConnectorOwnerUnavailable();
      if ('error' in delivery) return delivery;
      if (delivery.runtime !== value.runtime || delivery.readerId !== value.readerId) throw new ConnectorOwnerUnavailable();
      context.check(); return { ...value, body };
    })).value;
  }
  close() { return this.reads.close(); }
}
