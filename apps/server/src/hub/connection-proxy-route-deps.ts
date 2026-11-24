import type { Context } from 'hono';
import type { HubStore } from './hub-store.js';
import type { HubPrincipal } from './identity.js';
import type { AsyncHubConnectionProxyAccess } from './async-connection-proxy-access.js';
import type { AsyncConnectorClientResolver } from './async-connector-client.js';
import type { ConnectorClientResolver } from './connector-client.js';
import { HubMemberRequestError } from './async-member-request.js';

/** The production async composition has no synchronous authority or database.
 * Keep the transitional legacy composition explicit for existing embedders. */
export type HubConnectionProxyRouteDeps = {
  mode: 'async';
  access: AsyncHubConnectionProxyAccess;
  asyncConnectorClient: AsyncConnectorClientResolver;
  hubStore?: never;
  principal?: never;
  connectorClient?: never;
} | {
  mode?: 'legacy';
  hubStore: HubStore;
  principal: (c: Context) => HubPrincipal;
  connectorClient: ConnectorClientResolver;
  access?: AsyncHubConnectionProxyAccess;
  asyncConnectorClient?: AsyncConnectorClientResolver;
};

export function validateHubConnectionProxyRouteDeps(deps: HubConnectionProxyRouteDeps): void {
  if (deps.mode === 'async' && (typeof deps.access?.begin !== 'function'
    || typeof deps.access?.close !== 'function' || typeof deps.asyncConnectorClient !== 'function'))
    throw Error('Async Hub connection proxy ports are required before route registration');
}

export function legacyHubConnectionProxyDeps(deps: HubConnectionProxyRouteDeps) {
  if (deps.mode === 'async') throw new HubMemberRequestError(503);
  return deps;
}

/** Do not race away the original resolver. The route's HubRequestWork owns
 * this lifetime, including an ACK arriving after cancellation or shutdown. */
export async function resolveHubConnectionProxyClient(deps: HubConnectionProxyRouteDeps,
  request: Request, connectionId: string, userId: string, options?: { sourceApproval?: boolean; admin?: boolean }) {
  if (deps.asyncConnectorClient)
    return deps.asyncConnectorClient(request, connectionId, {
      maintenance: false, expectedUserId: userId, ...(options?.sourceApproval ? { sourceApproval: true } : {}),
    });
  return legacyHubConnectionProxyDeps(deps).connectorClient(connectionId, false, userId, undefined, options);
}
