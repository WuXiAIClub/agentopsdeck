import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { executeConnectorGrant, type ConnectorGrantCommands, type ConnectorGrantDependencies,
  type ConnectorHttpGrantKind } from './connector-grant-domain.js';
import { EXPECTED_NODE_HEADER } from './node-identity.js';

type Awaitable<T> = T | Promise<T>;
export interface ConnectorGrantRequestPort {
  execute<K extends ConnectorHttpGrantKind>(kind: K, request: Request, body?: unknown): Awaitable<ConnectorGrantCommands[K]['output']>;
}
export class ConnectorGrantRequestAborted extends Error {}
const evidence = (request: Request) => {
  if (request.signal.aborted) throw new ConnectorGrantRequestAborted();
  return { authorization: request.headers.get('authorization') ?? '', expectedNode: request.headers.get(EXPECTED_NODE_HEADER) ?? '' };
};
const input = <K extends ConnectorHttpGrantKind>(kind: K, request: Request, body: unknown): ConnectorGrantCommands[K]['input'] => ({
  ...evidence(request), ...(kind === 'authorizedGrantIssuer' || kind === 'authorizedGrantCreation' ? {} : { body }),
});
/** Entire original grant/queue/token domain only. Do not instantiate alongside
 * a synchronous writer. No fallback, implicit retry, or native execution. */
export class AsyncConnectorGrantRequests implements ConnectorGrantRequestPort {
  constructor(private readonly owner: AsyncConnectorOwner) {}
  execute<K extends ConnectorHttpGrantKind>(kind: K, request: Request, body?: unknown) {
    return this.owner.command(kind, input(kind, request, body));
  }
}
export function synchronousConnectorGrantRequests(deps: ConnectorGrantDependencies): ConnectorGrantRequestPort {
  return { execute: (kind, request, body) => executeConnectorGrant(kind, input(kind, request, body), deps) };
}
