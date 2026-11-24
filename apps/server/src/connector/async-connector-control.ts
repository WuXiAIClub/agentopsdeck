import type { AsyncConnectorOwner } from './async-connector-owner.js';
import type { ConnectorPrincipal, ConnectorScope } from '../auth/connector-token.js';
import { ConnectorUsersRequestError, type ConnectorUsersRequestPort } from './async-users-request.js';
import { ConnectorGrantRequestAborted, type ConnectorGrantRequestPort } from './async-grant-request.js';
import type { ConnectorStorageRequestPort } from './async-storage-request.js';
import { EXPECTED_NODE_HEADER } from './node-identity.js';
import { CONNECTOR_PROTOCOL_HEADER } from '@agentopsdeck/shared';
import { ReadRequestError, ReadRequestOwner, type ReadRequestContext } from '../lifecycle/read-request-owner.js';
import type { PerformanceDiagnostics } from '../diagnostics/performance.js';
import type { ConnectorGrantCommands, ConnectorHttpGrantKind } from './connector-grant-domain.js';
import type { ConnectorStorageCommands, ConnectorStorageKind } from './connector-storage-domain.js';
import { HTTPException } from 'hono/http-exception';
import { validConnectorOwnerOutput } from './connector-owner-domain.js';

export type ConnectorWriteAuthorityHandle = {
  readonly principal: ConnectorPrincipal;
  check(): Promise<void>;
};

/** Shared public entry points of the original Connector owner. This port owns
 * physical command lifetimes, not the database: closing it never closes the
 * shared owner. A terminated HTTP waiter cannot replay or cancel an SQL write. */
export class AsyncConnectorControl {
  private readonly work: ReadRequestOwner;
  constructor(private readonly owner: Pick<AsyncConnectorOwner, 'command'>,
    options: { waitMs?: number; diagnostics?: PerformanceDiagnostics } = {}) {
    this.work = new ReadRequestOwner('connector-sqlite-command', { ...options, limit: 32 });
  }
  private principal(authorization: string) { return this.owner.command('tokenAuthenticate', { authorization }); }
  private current(actor: ConnectorPrincipal | null, original: ConnectorPrincipal, scope?: ConnectorScope) {
    return actor?.tokenId === original.tokenId && (!scope || actor.scopes.includes(scope));
  }
  private async run<T>(request: Request, action: (authorization: string, context: ReadRequestContext) => Promise<T>): Promise<T> {
    // Snapshot headers before any await. Request headers are mutable objects.
    const authorization = request.headers.get('authorization') ?? '';
    return (await this.work.run(request, context => action(authorization, context))).value;
  }
  identity(request: Request) {
    return this.run(request, async (authorization, context) => {
      const original = await this.principal(authorization); context.check();
      if (!original) return false;
      const current = await this.principal(authorization); context.check();
      return this.current(current, original);
    });
  }
  async writeScope(request: Request, scope: ConnectorScope): Promise<ConnectorWriteAuthorityHandle> {
    const authorization = request.headers.get('authorization') ?? '';
    const original = (await this.work.run(request, async context => {
      const actor = await this.principal(authorization); context.check();
      if (!validConnectorOwnerOutput('tokenAuthenticate', actor)) throw new HTTPException(503);
      if (!actor || !actor.scopes.includes(scope)) throw new HTTPException(403);
      return structuredClone(actor);
    })).value;
    return {
      principal: original,
      check: async () => {
        if (request.signal.aborted) throw new ReadRequestError(408);
        await this.work.run(request, async context => {
          const actor = await this.principal(authorization); context.check();
          if (!validConnectorOwnerOutput('tokenAuthenticate', actor)) throw new HTTPException(503);
          if (!this.current(actor, original, scope)) throw new HTTPException(403);
        });
      },
    };
  }
  private async user<T>(request: Request, scope: 'users:read' | 'users:write',
    action: (authorization: string) => Promise<T>, denied: T): Promise<T> {
    try {
      return await this.run(request, async (authorization, context) => {
        const original = await this.principal(authorization); context.check();
        if (!original?.scopes.includes(scope)) return denied;
        // The business command independently reauthenticates in its original
        // worker turn. This preflight is never supplied as write authority.
        const result = await action(authorization); context.check();
        const current = await this.principal(authorization); context.check();
        return this.current(current, original, scope) ? result : denied;
      });
    } catch (error) {
      if (error instanceof ReadRequestError) throw new ConnectorUsersRequestError(error.status === 408 ? 499 : 503);
      throw error;
    }
  }
  readonly users: ConnectorUsersRequestPort = {
    authorize: (request, scope) => this.user(request, scope,
      authorization => this.owner.command('authorizedUsersPermission', { authorization, scope }), false),
    list: request => this.user(request, 'users:read',
      authorization => this.owner.command('authorizedUsersList', { authorization }), { authorized: false }),
    create: (request, label) => this.user(request, 'users:write',
      authorization => this.owner.command('authorizedUserCreate', { authorization, label }), { authorized: false }),
    update: (request, id, label) => this.user(request, 'users:write',
      authorization => this.owner.command('authorizedUserUpdate', { authorization, id, label }), { authorized: false }),
  };
  readonly grants: ConnectorGrantRequestPort = {
    execute: async <K extends ConnectorHttpGrantKind>(kind: K, request: Request, body?: unknown): Promise<ConnectorGrantCommands[K]['output']> => {
      const expectedNode = request.headers.get(EXPECTED_NODE_HEADER) ?? '';
      // No mutable caller object crosses an authorization await.
      const originalBody: unknown = body === undefined ? undefined : structuredClone(body);
      try {
        return await this.run(request, async (authorization, context) => {
          const evidence = { authorization, expectedNode };
          const original = await this.owner.command('authorizedGrantIssuer', evidence); context.check();
          if (original.status !== 200) return original;
          const result = await this.owner.command(kind, { ...evidence,
            ...(kind === 'authorizedGrantIssuer' || kind === 'authorizedGrantCreation' ? {} : { body: originalBody }) });
          context.check();
          const current = await this.owner.command(kind === 'authorizedGrantCreation' ? 'authorizedGrantCreation' : 'authorizedGrantIssuer', evidence); context.check();
          if (current.status !== 200) return current;
          if (current.value.issuerTokenId !== original.value.issuerTokenId || current.value.hubId !== original.value.hubId
            || current.value.nodeId !== original.value.nodeId) return { status: 403, error: 'Delegation issuer authorization changed' };
          if (result.status === 200 && (result.value.issuerTokenId !== original.value.issuerTokenId
            || result.value.hubId !== original.value.hubId || result.value.nodeId !== original.value.nodeId)) {
            throw new Error('Connector control unavailable');
          }
          return kind === 'authorizedGrantCreation' ? current : result;
        }) as ConnectorGrantCommands[K]['output'];
      } catch (error) {
        if (error instanceof ReadRequestError && error.status === 408) throw new ConnectorGrantRequestAborted();
        throw error;
      }
    },
  };
  readonly storage: ConnectorStorageRequestPort = {
    execute: <K extends ConnectorStorageKind>(kind: K, request: Request): Promise<ConnectorStorageCommands[K]['output']> => {
      const expectedNode = request.headers.get(EXPECTED_NODE_HEADER) ?? '';
      const protocol = request.headers.get(CONNECTOR_PROTOCOL_HEADER) ?? '';
      const originPresent = request.headers.has('origin');
      return this.run<ConnectorStorageCommands[K]['output']>(request, async (authorization, context) => {
        const evidence = { authorization, expectedNode, protocol, originPresent };
        const original = await this.principal(authorization); context.check();
        if (!original) return { status: 403, error: 'Storage maintenance unavailable' };
        const result = await this.owner.command(kind, evidence); context.check();
        if (result.status !== 200) return result;
        // Recovery is the original operator-policy check, including update vs
        // lifecycle scope and the latter's exact node/protocol/non-browser gate.
        const delivery = await this.owner.command('authorizedStorageRecovery', evidence); context.check();
        if (delivery.status !== 200) return delivery;
        const current = await this.principal(authorization); context.check();
        return this.current(current, original) ? result : { status: 403, error: 'Storage maintenance unavailable' };
      });
    },
  };
  close() { return this.work.close(); }
}
