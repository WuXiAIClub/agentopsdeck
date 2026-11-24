import { createConditionalHistoryCache } from '@agentopsdeck/shared';
import type { Dispatch } from '../connector/transport.js';
import { AuthRouteReadWait, AuthReadCancelledError } from '../auth/route-read-wait.js';
import { AuthRoutePersistence } from '../auth/route-persistence.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { encodeHubMemberJson, type AsyncHubMemberOwner } from './async-member-owner.js';
import { hubMemberEvidence, HUB_MEMBER_COMMAND_BYTES } from './member-owner-domain.js';
import { validHubConnectorAccessCommand, validHubConnectorAccessReply,
  type HubConnectorAccessCommand } from './member-connector-access-domain.js';
import type { NodeGrantProof } from './node-grants.js';
import { originalRequestScope } from './original-request-scope.js';
import type { ContentBackgroundOwner } from './content-background-domain.js';
import type {NativeFileBackgroundOwner} from './native-file-background-domain.js';
import type { HubNotebookMachineCommand, HubNotebookMachineResult, NotebookMachineContext } from './member-notebook-machine-domain.js';
import { ConnectorClient, ConnectorClientError, authorizeBoardBindingRequest, authorizeFileBoardRequest,
  authorizeCardFileRequest, authorizeContentReplicaRequest, authorizeGrantedRead, authorizeSourceApprovalMediaRequest } from './connector-client.js';

export type AsyncConnectorOptions = { maintenance?: boolean; grant?: NodeGrantProof;
  boardBindingsOnly?: boolean | 'file-boards' | 'card-files' | 'content-replicas'; sourceApproval?: boolean; expectedUserId?: string };
export type AsyncConnectorClientResolver = ((request: Request, connectionId: string,
  options?: AsyncConnectorOptions) => Promise<ConnectorClient>) & {
    contentBackground?(access: ContentBackgroundOwner, reference: string): Promise<ConnectorClient>;
    nativeFileBackground?(access: NativeFileBackgroundOwner, reference: string): Promise<ConnectorClient>;
    notebookMachine?(access: {command(input: HubNotebookMachineCommand): Promise<HubNotebookMachineResult>},
      token: string, context: NotebookMachineContext): Promise<ConnectorClient>;
  };
export type AsyncConnectorClientPort = AsyncConnectorClientResolver & { close(): Promise<void> };

/** Request-bound complete-owner resolver. Never receives an authorized flag or
 * account ID. The original worker verifies identity and the connection/grant
 * in one savepoint; retry/header/JSON/SSE/media all re-read that authority.
 * A timed-out wait neither stops SQL nor releases the owner's admission slot.
 * Legacy anonymous/admin callbacks deliberately remain outside this interface. */
export function createAsyncConnectorClientResolver(owner: Pick<AsyncHubMemberOwner, 'command'>,
  local?: { connectionId: string; token: string; maintenanceToken?: string; boardBindingToken?: string; fileBoardToken?: string; sourceApprovalToken?: string; dispatch: Dispatch },
  diagnostics: PerformanceDiagnostics = performanceDiagnostics, timeoutMs = 30_000): AsyncConnectorClientPort {
  const persistence = new AuthRoutePersistence(diagnostics);
  const reads = new AuthRouteReadWait(persistence, diagnostics, timeoutMs);
  const historyCache = createConditionalHistoryCache();
  let closed = false;
  const checkOpen = () => { if (closed) throw new ConnectorClientError(503, 'Connector authority is unavailable'); };
  const resolve: AsyncConnectorClientResolver = async (request, connectionId, options = {}) => {
    checkOpen();
    const evidence = Object.freeze(hubMemberEvidence(request));
    const originalScope = originalRequestScope(request);
    const maintenance = options.maintenance ?? false, mode = options.boardBindingsOnly ?? false, sourceApproval = options.sourceApproval === true;
    // An expectation only: never an identity supplied to SQL. The worker still
    // derives the actor from private request evidence and pins recoveryScope.
    const expectedUserId = options.expectedUserId;
    if (expectedUserId !== undefined && (typeof expectedUserId !== 'string' || !expectedUserId
      || Buffer.byteLength(expectedUserId) > 16_384 || expectedUserId.includes('\0')))
      throw new ConnectorClientError(400, 'Invalid Connector identity expectation');
    if ((mode || sourceApproval) && (maintenance || options.grant)) throw new ConnectorClientError(403, 'Task binding requires connection ownership');
    if (mode && sourceApproval) throw new ConnectorClientError(403, 'Source approval requires session media transport');
    // Own the entire input before any await; getters, proxies and edits are
    // rejected/isolated by the same bounded private RPC encoder as the worker.
    let command: HubConnectorAccessCommand;
    try {
      command = JSON.parse(encodeHubMemberJson({ action: 'open', id: connectionId, maintenance,
        ...(options.grant ? { grant: options.grant } : {}) }, HUB_MEMBER_COMMAND_BYTES));
      if (!validHubConnectorAccessCommand(command)) throw new Error('invalid_connector_access');
    } catch { throw new ConnectorClientError(400, 'Invalid Connector access request'); }
    const read = async <T>(step: 6 | 63, work: () => Promise<T>): Promise<T> => {
      try {
        checkOpen();
        const value = (await reads.run(request, step, work)).value;
        checkOpen();
        return value;
      }
      catch (error) { throw new ConnectorClientError(error instanceof AuthReadCancelledError ? 499 : 503, 'Connector authority is unavailable'); }
    };
    const initial = await read(6, () => owner.command('memberSnapshot', evidence));
    if (!initial) throw new ConnectorClientError(401, 'Connector identity is unavailable');
    if (originalScope !== undefined && initial.recoveryScope !== originalScope)
      throw new ConnectorClientError(401, 'Connector identity changed');
    if (expectedUserId !== undefined && initial.principal.userId !== expectedUserId)
      throw new ConnectorClientError(403, 'Connector identity changed');
    const expectedScope = initial.recoveryScope;
    const access = async (next: HubConnectorAccessCommand) => {
      const value = await read(63, () => owner.command('connectorAccess', { evidence, expectedScope, command: next }));
      if (!validHubConnectorAccessReply(next, value)) throw new ConnectorClientError(503, 'Connector authority is unavailable');
      if (!value) throw new ConnectorClientError(401, 'Connector identity changed');
      if ('error' in value) throw new ConnectorClientError(value.error === 'missing' ? 404 : 403,
        value.error === 'missing' ? 'Connector connection not available' : 'Connector authorization changed');
      return value;
    };
    const result = await access(command);
    if (!('connection' in result) || result.connection.id !== connectionId
      || result.connection.ownerUserId !== (command.grant?.ownerUserId ?? initial.principal.userId)) {
      throw new ConnectorClientError(503, 'Connector authority is unavailable');
    }
    const { connection, epoch } = result;
    const grant = command.grant;
    const requestPolicy = mode === 'file-boards' ? authorizeFileBoardRequest : mode === 'card-files' ? authorizeCardFileRequest
      : mode === 'content-replicas' ? authorizeContentReplicaRequest
      : mode ? authorizeBoardBindingRequest : sourceApproval ? authorizeSourceApprovalMediaRequest
      : grant ? (path: string, method: string) => authorizeGrantedRead(grant, path, method) : undefined;
    const guard = async () => {
      const fresh = await access({ ...command, action: 'check', expectedEpoch: epoch });
      if (!('ok' in fresh) || fresh.epoch !== epoch) throw new ConnectorClientError(503, 'Connector authority is unavailable');
    };
    const authorization = { authorize: guard, ...(requestPolicy ? { request: requestPolicy } : {}),
      ...(connection.nodeId ? { nodeId: connection.nodeId } : {}),
      domain: JSON.stringify([initial.principal.userId, epoch, connection.nodeId, grant?.grantId, grant?.version]) };
    if (connection.kind === 'local') {
      if (!local || connection.ownerUserId !== 'default' || local.connectionId !== connection.id)
        throw new ConnectorClientError(503, 'Local Connector is not running in this process');
      const token = mode === true ? local.boardBindingToken
        : mode === 'file-boards' || mode === 'card-files' || mode === 'content-replicas' ? local.fileBoardToken
        : maintenance ? local.maintenanceToken
        : sourceApproval && initial.principal.admin && local.sourceApprovalToken ? local.sourceApprovalToken : local.token;
      if (!token) throw new ConnectorClientError(401, 'Connector scoped credential is missing');
      return new ConnectorClient('http://connector.example.invalid', token, local.dispatch, undefined, undefined, authorization, historyCache);
    }
    if (!result.token) throw new ConnectorClientError(401, maintenance ? 'Connector maintenance credential is missing' : 'Connector credential is missing');
    return new ConnectorClient(connection.connectorUrl, result.token, undefined, undefined, undefined, authorization, historyCache);
  };
  // Freeze retained clients as well as new resolution. An HTTP read deadline
  // does not settle the original owner command; close must retain that ACK.
  // The consuming route separately owns any admitted remote transport work.
  const contentBackground = async (access: ContentBackgroundOwner, reference: string) => {
    // This is a private, separately drained service lane. Do not manufacture a
    // request cookie/key or use a local general-purpose Connector token.
    const initial = await access.command({ action: 'access',reference });
    if (initial.action !== 'access') throw new ConnectorClientError(503,'Connector authority is unavailable');
    const { connection,epoch } = initial;
    const guard = async () => {
      const fresh = await access.command({ action: 'access',reference });
      if (fresh.action !== 'access' || fresh.epoch !== epoch || fresh.connection.id !== connection.id
        || fresh.connection.ownerUserId !== connection.ownerUserId || fresh.connection.nodeId !== connection.nodeId
        || fresh.connection.kind !== connection.kind || fresh.connection.connectorUrl !== connection.connectorUrl)
        throw new ConnectorClientError(403,'Connector authorization changed');
    };
    const authorization = { authorize: guard,request: authorizeContentReplicaRequest,
      ...(connection.nodeId ? { nodeId: connection.nodeId } : {}),domain: JSON.stringify(['content-background',reference,epoch,connection.nodeId]) };
    if (connection.kind === 'local') {
      if (!local || local.connectionId !== connection.id || connection.ownerUserId !== 'default' || !local.fileBoardToken)
        throw new ConnectorClientError(503,'Local Connector scoped credential is unavailable');
      return new ConnectorClient('http://connector.example.invalid',local.fileBoardToken,local.dispatch,undefined,undefined,authorization,historyCache);
    }
    if (!initial.token) throw new ConnectorClientError(401,'Connector credential is missing');
    return new ConnectorClient(connection.connectorUrl,initial.token,undefined,undefined,undefined,authorization,historyCache);
  };
  const nativeFileBackground = async (access: NativeFileBackgroundOwner, reference: string) => {
    if (closed) throw new ConnectorClientError(503, 'Connector authority is unavailable');
    const initial = await access.command({action: 'access', reference});
    if (initial.action !== 'access') throw new ConnectorClientError(503, 'Connector authority is unavailable');
    const {connection, epoch, domain} = initial;
    const guard = async () => {
      if (closed) throw new ConnectorClientError(503, 'Connector authority is unavailable');
      const fresh = await access.command({action: 'access', reference});
      if (fresh.action !== 'access' || fresh.domain !== domain || fresh.epoch !== epoch || fresh.connection.id !== connection.id
        || fresh.connection.ownerUserId !== connection.ownerUserId || fresh.connection.nodeId !== connection.nodeId
        || fresh.connection.kind !== connection.kind || fresh.connection.connectorUrl !== connection.connectorUrl)
        throw new ConnectorClientError(403, 'Connector authorization changed');
    };
    const authorization = {authorize: guard, request: domain === 'board' ? authorizeFileBoardRequest : authorizeCardFileRequest,
      ...(connection.nodeId ? {nodeId: connection.nodeId} : {}), domain: JSON.stringify(['native-file-background', reference, epoch, connection.nodeId])};
    if (connection.kind === 'local') {
      if (!local || local.connectionId !== connection.id || connection.ownerUserId !== 'default' || !local.fileBoardToken)
        throw new ConnectorClientError(503, 'Local Connector scoped credential is unavailable');
      return new ConnectorClient('http://connector.example.invalid', local.fileBoardToken, local.dispatch, undefined, undefined, authorization, historyCache);
    }
    if (!initial.token) throw new ConnectorClientError(401, 'Connector credential is missing');
    return new ConnectorClient(connection.connectorUrl, initial.token, undefined, undefined, undefined, authorization, historyCache);
  };
  const notebookMachine: NonNullable<AsyncConnectorClientResolver['notebookMachine']> = async (access, token, context) => {
    checkOpen();
    const initial = await access.command({action: 'access', token});
    if (!initial || initial.action !== 'access' || Object.entries(context).some(([k, v]) => initial.context[k as keyof NotebookMachineContext] !== v))
      throw new ConnectorClientError(403, 'Notebook authority changed');
    const {connection, epoch} = initial;
    const guard = async () => {
      checkOpen();
      const fresh = await access.command({action: 'access', token});
      if (!fresh || fresh.action !== 'access' || fresh.epoch !== epoch || fresh.token !== initial.token
        || Object.entries(context).some(([k, v]) => fresh.context[k as keyof NotebookMachineContext] !== v)
        || fresh.connection.id !== connection.id || fresh.connection.ownerUserId !== connection.ownerUserId
        || fresh.connection.nodeId !== connection.nodeId || fresh.connection.kind !== connection.kind || fresh.connection.connectorUrl !== connection.connectorUrl)
        throw new ConnectorClientError(403, 'Notebook authority changed');
    };
    const base = '/workspace/card-files', binding = base + '/' + encodeURIComponent(context.bindingId);
    const request = (path: string, method: string) => {
      authorizeCardFileRequest(path, method);
      if (method === 'GET' && (path === base || path === binding || path === binding + '/snapshot'
        || path.startsWith(binding + '/writes/')) || method === 'POST' && path === binding + '/writes') return;
      throw new ConnectorClientError(403, 'Notebook transport does not authorize this operation');
    };
    const authorization = {authorize: guard, request, nodeId: connection.nodeId!,
      domain: JSON.stringify(['notebook-machine', context.capabilityId, context.bindingId, epoch, connection.nodeId])};
    if (connection.kind === 'local') {
      if (!local || local.connectionId !== connection.id || connection.ownerUserId !== 'default' || !local.fileBoardToken)
        throw new ConnectorClientError(503, 'Local Connector scoped credential is unavailable');
      return new ConnectorClient('http://connector.example.invalid', local.fileBoardToken, local.dispatch, undefined, undefined, authorization, historyCache);
    }
    if (!initial.token) throw new ConnectorClientError(401, 'Connector credential is missing');
    return new ConnectorClient(connection.connectorUrl, initial.token, undefined, undefined, undefined, authorization, historyCache);
  };
  return Object.assign(resolve, {contentBackground, nativeFileBackground, notebookMachine, close: () => { closed = true; return persistence.close(); } });
}
