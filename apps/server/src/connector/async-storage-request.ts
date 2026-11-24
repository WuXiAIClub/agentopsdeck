import type { AsyncConnectorOwner } from './async-connector-owner.js';
import { EXPECTED_NODE_HEADER } from './node-identity.js';
import { CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { executeConnectorStorage, type ConnectorStorageCommands, type ConnectorStorageDependencies, type ConnectorStorageKind } from './connector-storage-domain.js';

export interface ConnectorStorageRequestPort {
  execute<K extends ConnectorStorageKind>(kind: K, request: Request): Promise<ConnectorStorageCommands[K]['output']>;
}
export class ConnectorStorageRequestAborted extends Error {}
const evidence = (request: Request) => {
  if (request.signal.aborted) throw new ConnectorStorageRequestAborted();
  return { authorization: request.headers.get('authorization') ?? '', expectedNode: request.headers.get(EXPECTED_NODE_HEADER) ?? '',
    protocol: request.headers.get(CONNECTOR_PROTOCOL_HEADER) ?? '', originPresent: request.headers.has('origin') };
};
/** Accepted work retains its original outcome. Client abort is not permission
 * to kill an owner, cancel admitted SQL, retry, or synthesize checkpoint proof. */
export class AsyncConnectorStorageRequests implements ConnectorStorageRequestPort {
  constructor(private readonly owner: AsyncConnectorOwner) {}
  execute<K extends ConnectorStorageKind>(kind: K, request: Request) { return this.owner.command(kind, evidence(request)); }
}
export function synchronousConnectorStorageRequests(deps: ConnectorStorageDependencies): ConnectorStorageRequestPort {
  return { execute: (kind, request) => executeConnectorStorage(kind, evidence(request), deps) };
}
