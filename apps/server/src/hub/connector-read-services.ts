import type { AsyncHubMemberOwner } from './async-member-owner.js';
import { createAsyncConnectorClientResolver } from './async-connector-client.js';
import { AsyncHubSharedDirectory } from './async-shared-directory.js';
import { AsyncHubOwnerControls } from './async-owner-control.js';
import { createIndependentDrain } from '../lifecycle/independent-drain.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { HubMemberOwnerUnavailable } from './member-owner-domain.js';
import { AsyncHubSharedCommands } from './async-shared-commands.js';
import { AsyncHubLifecycleCommands } from './async-lifecycle-commands.js';
import { AsyncHubMaintenanceCommands } from './async-maintenance-commands.js';
import { AsyncHubEventReplay } from './async-event-replay.js';
import { AsyncHubSharedReads } from './async-shared-reads.js';
import { AsyncHubSharedCreation } from './async-shared-creation.js';
import { AsyncHubCreationDiscovery } from './async-creation-discovery.js';
import type { HubExecutionSync } from './execution-sync.js';
import { AsyncHubIssuerManagement, type LocalIssuerOperator } from './async-issuer-management.js';

/** Request-bound Connector authority and directory discovery share one original
 * command owner. No background/internal principal is converted to HTTP proof,
 * no second writer is opened and no original command is retried on failure. */
export function createHubConnectorReadServices(originalOwner: Pick<AsyncHubMemberOwner, 'command'>,
  local?: Parameters<typeof createAsyncConnectorClientResolver>[1],
  diagnostics: PerformanceDiagnostics = performanceDiagnostics, sync?: Pick<HubExecutionSync, 'acquire'>,
  operator?: LocalIssuerOperator) {
  let closed = false;
  // Fence every lane before diagnostics can reenter a later lane. Do not
  // close the shared SQL owner or release an admitted original command.
  const owner: Pick<AsyncHubMemberOwner, 'command'> = { command(kind, input) {
    if (closed) return Promise.reject(new HubMemberOwnerUnavailable());
    return originalOwner.command(kind, input);
  } };
  const connector = createAsyncConnectorClientResolver(owner, local, diagnostics);
  const directory = new AsyncHubSharedDirectory(owner, connector, diagnostics);
  const ownerControl = new AsyncHubOwnerControls(owner, connector, diagnostics);
  const sharedCommands = new AsyncHubSharedCommands(owner, sync, local, diagnostics);
  const lifecycleCommands = new AsyncHubLifecycleCommands(owner, diagnostics);
  const eventReplay = new AsyncHubEventReplay(owner, diagnostics);
  const sharedReads = new AsyncHubSharedReads(owner, diagnostics);
  const sharedCreation = new AsyncHubSharedCreation(owner, local, diagnostics);
  const creationDiscovery = new AsyncHubCreationDiscovery(owner, diagnostics);
  const issuerManagement = new AsyncHubIssuerManagement(owner, local, operator, diagnostics);
  const maintenanceCommands = new AsyncHubMaintenanceCommands(owner, local?.maintenanceToken ? {
    connectionId: local.connectionId, maintenanceToken: local.maintenanceToken, dispatch: local.dispatch,
  } : undefined, diagnostics);
  const drain = createIndependentDrain([() => sharedCreation.close(), () => creationDiscovery.close(), () => sharedReads.close(), () => eventReplay.close(), () => maintenanceCommands.close(), () => lifecycleCommands.close(), () => sharedCommands.close(), () => directory.close(), () => ownerControl.close(),
    () => connector.close()], 'hub-route-drain', diagnostics);
  const allDrains = createIndependentDrain([() => issuerManagement.close(), () => drain()], 'hub-route-drain', diagnostics);
  const close = () => { closed = true; return allDrains(); };
  return { connector, directory, ownerControl, sharedCommands, lifecycleCommands, maintenanceCommands, eventReplay, sharedReads, sharedCreation, creationDiscovery, issuerManagement, close };
}
