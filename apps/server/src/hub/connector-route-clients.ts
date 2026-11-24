import type { AsyncConnectorClientResolver } from './async-connector-client.js';
import { requestConnectorClient, type RequestConnectorClients } from './request-connector-client.js';

export type ConnectorRouteClients = {
  mode: 'async'; asyncConnectorClient: AsyncConnectorClientResolver; connectorClient?: never;
} | (RequestConnectorClients & { mode?: 'legacy' });

export function validateConnectorRouteClients(deps: ConnectorRouteClients): void {
  if (deps.mode === 'async' && typeof deps.asyncConnectorClient !== 'function')
    throw Error('Async Connector resolver is required before route registration');
}

/** Explicit async routes retain the original resolver ACK, not a raced view. */
export function resolveConnectorRouteClient(deps: ConnectorRouteClients, request: Request,
  id: string, maintenance: boolean, userId: string) {
  if (deps.mode === 'async')
    return deps.asyncConnectorClient(request, id, { maintenance, expectedUserId: userId });
  return requestConnectorClient(deps, request, id, maintenance, userId);
}
