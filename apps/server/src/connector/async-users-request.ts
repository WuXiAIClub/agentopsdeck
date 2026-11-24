import type { AsyncConnectorOwner } from './async-connector-owner.js';
import type { ConnectorTokenStore } from '../auth/connector-token.js';
import type { ConnectorUser, ConnectorUserStore } from './connector-user-store.js';
import type { AuthorizedResult } from './connector-authority-domain.js';

type Awaitable<T> = T | Promise<T>;
type Scope = 'users:read' | 'users:write';
export interface ConnectorUsersRequestPort {
  authorize(request: Request, scope: Scope): Awaitable<boolean>;
  list(request: Request): Awaitable<AuthorizedResult<ConnectorUser[]>>;
  create(request: Request, label: string): Awaitable<AuthorizedResult<ConnectorUser>>;
  update(request: Request, id: string, label: string): Awaitable<AuthorizedResult<ConnectorUser | null>>;
}
export class ConnectorUsersRequestError extends Error {
  constructor(readonly status: 499 | 503) { super('connector_storage_unavailable'); }
}
const header = (request: Request) => {
  if (request.signal.aborted) throw new ConnectorUsersRequestError(499);
  return request.headers.get('authorization') ?? '';
};

/** Candidate; runtime activation requires migrating every shared DB caller.
 * Preflight preserves HTTP error precedence, never authorizes a later write.
 * The actual SQL command carries the original credential and reauthenticates
 * at the original Worker execution point. No fallback or unknown-write replay. */
export class AsyncConnectorUsersRequests implements ConnectorUsersRequestPort {
  constructor(private readonly owner: AsyncConnectorOwner) {}
  authorize(request: Request, scope: Scope) {
    return this.owner.command('authorizedUsersPermission', { authorization: header(request), scope });
  }
  list(request: Request) { return this.owner.command('authorizedUsersList', { authorization: header(request) }); }
  create(request: Request, label: string) { return this.owner.command('authorizedUserCreate', { authorization: header(request), label }); }
  update(request: Request, id: string, label: string) {
    return this.owner.command('authorizedUserUpdate', { authorization: header(request), id, label });
  }
}

/** Legacy adapter keeps the same DTOs and repeats the original permission check
 * after request-body awaits. It must never coexist with an async writer to the
 * same files; application root selects exactly one implementation. */
export function synchronousConnectorUsersRequests(users: ConnectorUserStore, tokens: ConnectorTokenStore): ConnectorUsersRequestPort {
  const allowed = (request: Request, scope: Scope) => !!tokens.authenticateAuthorization(header(request))?.scopes.includes(scope);
  return {
    authorize: allowed,
    list(request) { return allowed(request, 'users:read') ? { authorized: true, value: users.listUsers() } : { authorized: false }; },
    create(request, label) { return allowed(request, 'users:write') ? { authorized: true, value: users.createUser(label) } : { authorized: false }; },
    update(request, id, label) { return allowed(request, 'users:write') ? { authorized: true, value: users.updateUser(id, label) ?? null } : { authorized: false }; },
  };
}
