import type { AsyncConnectorClientResolver } from './async-connector-client.js';
import { ConnectorClientError, type ConnectorClientResolver } from './connector-client.js';
import type { HubPrincipal } from './identity.js';
import { synchronousHubPrincipalCall } from './request-authority.js';

/** Select by private, exact Request ownership, never by headers or a failed
 * external lookup. Internal bridge requests retain their revocable in-process
 * actor; they are not converted into worker credentials or cached HTTP proof.
 * Background clients remain outside this request-only selector. */
export function createApplicationConnectorClient(external: AsyncConnectorClientResolver,
  internal: WeakMap<Request, () => HubPrincipal | undefined>, original: ConnectorClientResolver): AsyncConnectorClientResolver {
  return async (request, connectionId, options = {}) => {
    if (request.signal.aborted) throw new ConnectorClientError(499, 'Connector request cancelled');
    if (!internal.has(request)) return external(request, connectionId, options);
    const actor = synchronousHubPrincipalCall(internal.get(request)!, []);
    if (!actor) throw new ConnectorClientError(401, 'Connector identity is unavailable');
    if (options.expectedUserId !== undefined && actor.userId !== options.expectedUserId)
      throw new ConnectorClientError(403, 'Connector identity changed');
    // The ordinary resolver cannot implement a narrowed binding transport.
    if (options.boardBindingsOnly) throw new ConnectorClientError(403, 'Task binding requires a dedicated transport');
    return original(connectionId, options.maintenance ?? false, actor.userId, options.grant);
  };
}
