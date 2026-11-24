import { ConnectorClientError, type ConnectorClient, type ConnectorClientResolver } from './connector-client.js';
import type { AsyncConnectorClientResolver } from './async-connector-client.js';
import type { NodeGrantProof } from './node-grants.js';
import { connectorAuthorization } from './connector-authorization.js';

export type RequestConnectorClients = {
  connectorClient: ConnectorClientResolver;
  asyncConnectorClient?: AsyncConnectorClientResolver;
};

/** HTTP-only bridge during complete-owner migration. The async port receives
 * real request evidence, never an authorized flag or an owner credential.
 * Once selected it must not fall back to the synchronous resolver, even for a
 * failed lookup: that would bypass the retired/unknown owner's safety fence.
 * Background broker/lease cleanup has a separate lifetime and is not enrolled
 * by this adapter. Existing wire payloads and legacy sync callers are retained.
 */
export async function requestConnectorClient(deps: RequestConnectorClients, request: Request,
  connectionId: string, maintenance = false, userId?: string, grant?: NodeGrantProof, waitSignal?: AbortSignal) {
  // Keep the original Request as authority evidence. A stream/catalog deadline
  // may end its own wait without cloning evidence or cancelling original SQL.
  const signal = waitSignal ? AbortSignal.any([request.signal, waitSignal]) : request.signal;
  const cancelled = () => new ConnectorClientError(499, 'Connector request cancelled');
  if (signal.aborted) throw cancelled();
  // Bound the HTTP wait even for an injected port that never settles. This
  // stops delivery only, not original SQL or the owner's admission reservation.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new ConnectorClientError(503, 'Connector authority is unavailable')), 45_000);
  timer.unref?.();
  let client: ConnectorClient | undefined;
  const asyncPort = deps.asyncConnectorClient, legacyPort = deps.connectorClient;
  try {
    await connectorAuthorization(async () => {
      client = asyncPort
        ? await asyncPort(request, connectionId, { maintenance,
          ...(userId !== undefined ? { expectedUserId: userId } : {}), ...(grant ? { grant } : {}) })
        : legacyPort(connectionId, maintenance, userId, grant);
    }, AbortSignal.any([signal, deadline.signal]));
    if (signal.aborted) throw cancelled();
    if (!client) throw new ConnectorClientError(503, 'Connector authority is unavailable');
    return client;
  } catch (error) {
    if (signal.aborted) throw cancelled();
    throw error;
  } finally { clearTimeout(timer); }
}
