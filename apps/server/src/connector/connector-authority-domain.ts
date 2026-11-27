import { CONNECTOR_SCOPES, type ConnectorScope, type ConnectorPrincipal, type ConnectorTokenStore } from '../auth/connector-token.js';
import { AuthPersistenceError } from '../auth/private-store.js';
import type { ConnectorUser, ConnectorUserStore } from './connector-user-store.js';
import { CommandCapacity, CommandConflict } from '../commands/receipts.js';

type Empty = Record<string, never>;
export type AuthorizedResult<T> = { authorized: false } | { authorized: true; value: T };
type TokenMetadata = ReturnType<ConnectorTokenStore['list']>[number];
export type ConnectorAuthorityCommands = {
  tokenAuthenticate: { input: { authorization: string }; output: ConnectorPrincipal | null };
  tokenHasScope: { input: { tokenId: string; scope: ConnectorScope }; output: boolean };
  tokenDelegationHub: { input: { tokenId: string }; output: string | null };
  tokensList: { input: Empty; output: TokenMetadata[] };
  tokenCreate: { input: { label: string; scopes?: ConnectorScope[]; delegationHubId?: string }; output: ReturnType<ConnectorTokenStore['create']> };
  tokenRevoke: { input: { tokenId: string }; output: boolean };
  authorizedUsersList: { input: { authorization: string }; output: AuthorizedResult<ConnectorUser[]> };
  authorizedUserGet: { input: { authorization: string; id: string }; output: AuthorizedResult<ConnectorUser | null> };
  authorizedUserCreate: { input: { authorization: string; label: string }; output: AuthorizedResult<ConnectorUser> };
  authorizedUserUpdate: { input: { authorization: string; id: string; label: string }; output: AuthorizedResult<ConnectorUser | null> };
  authorizedUsersPermission: { input: { authorization: string; scope: 'users:read' | 'users:write' }; output: boolean };
  ahpClaim: { input: { authorization: string; tokenId: string; resource: string; key: string; digest: string };
    output: { state: 'fresh' | 'unknown' | 'unavailable' | 'denied' | 'conflict' | 'busy' } | { state: 'accepted'; id: string } };
  ahpSettle: { input: { resource: string; key: string; id: string | null }; output: boolean };
  ahpAdmission: { input: { authorization: string; tokenId: string }; output: boolean };
};
export type ConnectorAuthorityKind = keyof ConnectorAuthorityCommands;
// Append-only, continuing the original Connector command numbers.
export const connectorAuthoritySteps: Readonly<Record<ConnectorAuthorityKind, number>> = Object.freeze({
  tokenAuthenticate: 19, tokenHasScope: 20, tokenDelegationHub: 21, tokensList: 22,
  tokenCreate: 23, tokenRevoke: 24, authorizedUsersList: 25, authorizedUserGet: 26,
  authorizedUserCreate: 27, authorizedUserUpdate: 28,
  authorizedUsersPermission: 29,
  ahpClaim: 723, ahpSettle: 724,
  ahpAdmission: 725,
});
export const isConnectorAuthorityKind = (kind: string): kind is ConnectorAuthorityKind => Object.hasOwn(connectorAuthoritySteps, kind);
const str = (v: unknown): v is string => typeof v === 'string' && !v.includes('\0') && Buffer.byteLength(v) <= 4096;
const text = (v: unknown): v is string => str(v) && v.length > 0;
const integer = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const record = (v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && required.every(k => Object.hasOwn(v, k))
  && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const scopes = (v: unknown): v is ConnectorScope[] => Array.isArray(v) && v.length <= CONNECTOR_SCOPES.length
  && v.every(s => CONNECTOR_SCOPES.includes(s)) && new Set(v).size === v.length;
// The original durable format permits long strings, NUL and repeated scopes.
// Do not apply new-token admission policy to existing identities or replies.
// The enclosing serializer still enforces command/result byte and node budgets.
const storedString = (v: unknown): v is string => typeof v === 'string';
const storedId = (v: unknown): v is string => storedString(v) && v.length > 0;
const storedScopes = (v: unknown): v is ConnectorScope[] => Array.isArray(v)
  && v.every(s => CONNECTOR_SCOPES.includes(s));
const userLabel = (v: unknown): v is string => storedString(v) && !!v.trim() && Buffer.byteLength(v) <= 4096;
const hubId = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(v);
const authorization = (v: unknown) => str(v) && !/[\r\n]/.test(v);
const user = (v: unknown) => record(v, ['id', 'label', 'createdAt', 'updatedAt'])
  && storedId(v.id) && storedString(v.label) && integer(v.createdAt) && integer(v.updatedAt);
const metadata = (v: unknown) => record(v, ['id', 'label', 'scopes', 'createdAt'], ['revokedAt', 'delegationHubId', 'identityAmbiguous'])
  && storedId(v.id) && storedString(v.label) && storedScopes(v.scopes) && integer(v.createdAt)
  && (!Object.hasOwn(v, 'revokedAt') || integer(v.revokedAt))
  && (!Object.hasOwn(v, 'identityAmbiguous') || v.identityAmbiguous === true)
  && (!Object.hasOwn(v, 'delegationHubId') || hubId(v.delegationHubId)
    && (v.scopes as string[]).includes('messages:send') && (v.scopes as string[]).includes('execution:delegate'));
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
const ahpResource = (v: unknown) => typeof v === 'string' && v.startsWith('ahp-session:/') && uuid(v.slice(13));
const commandKey = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(v);
export function validConnectorAuthorityInput(kind: ConnectorAuthorityKind, v: unknown): boolean {
  switch (kind) {
    case 'ahpAdmission': return record(v, ['authorization', 'tokenId']) && authorization(v.authorization) && text(v.tokenId);
    case 'ahpClaim': return record(v, ['authorization', 'tokenId', 'resource', 'key', 'digest'])
      && authorization(v.authorization) && text(v.tokenId) && ahpResource(v.resource) && commandKey(v.key)
      && typeof v.digest === 'string' && /^[0-9a-f]{64}$/.test(v.digest);
    case 'ahpSettle': return record(v, ['resource', 'key', 'id'])
      && ahpResource(v.resource) && commandKey(v.key) && (v.id === null || uuid(v.id));
    case 'tokensList': return record(v, []);
    case 'tokenHasScope': return record(v, ['tokenId', 'scope']) && storedId(v.tokenId) && CONNECTOR_SCOPES.includes(v.scope as ConnectorScope);
    case 'tokenDelegationHub': case 'tokenRevoke': return record(v, ['tokenId']) && storedId(v.tokenId);
    case 'tokenCreate': return record(v, ['label'], ['scopes', 'delegationHubId']) && str(v.label)
      && (!Object.hasOwn(v, 'scopes') || scopes(v.scopes))
      && (!Object.hasOwn(v, 'delegationHubId') || hubId(v.delegationHubId)
        && Array.isArray(v.scopes) && v.scopes.includes('execution:delegate') && v.scopes.includes('messages:send'));
    case 'tokenAuthenticate': case 'authorizedUsersList': return record(v, ['authorization']) && authorization(v.authorization);
    case 'authorizedUsersPermission': return record(v, ['authorization', 'scope']) && authorization(v.authorization)
      && (v.scope === 'users:read' || v.scope === 'users:write');
    case 'authorizedUserGet': return record(v, ['authorization', 'id']) && authorization(v.authorization) && storedId(v.id);
    case 'authorizedUserCreate': return record(v, ['authorization', 'label']) && authorization(v.authorization) && userLabel(v.label);
    case 'authorizedUserUpdate': return record(v, ['authorization', 'id', 'label']) && authorization(v.authorization) && storedId(v.id) && userLabel(v.label);
  }
}
export function validConnectorAuthorityOutput(kind: ConnectorAuthorityKind, v: unknown): boolean {
  switch (kind) {
    case 'ahpClaim': return record(v, ['state'], ['id']) && (v.state === 'accepted' ? uuid(v.id)
      : !Object.hasOwn(v, 'id') && ['fresh', 'unknown', 'unavailable', 'denied', 'conflict', 'busy'].some(state => state === v.state));
    case 'ahpSettle': case 'ahpAdmission': return typeof v === 'boolean';
    case 'tokenAuthenticate': return v === null || record(v, ['tokenId', 'label', 'scopes']) && storedId(v.tokenId) && storedString(v.label) && storedScopes(v.scopes);
    case 'tokenHasScope': case 'tokenRevoke': case 'authorizedUsersPermission': return typeof v === 'boolean';
    case 'tokenDelegationHub': return v === null || hubId(v);
    case 'tokensList': return Array.isArray(v) && v.length <= 16_384 && v.every(metadata);
    case 'tokenCreate': return record(v, ['token', 'record']) && text(v.token) && /^aod_conn_[A-Za-z0-9_-]{32}$/.test(v.token) && metadata(v.record);
    default:
      if (record(v, ['authorized']) && v.authorized === false) return true;
      if (!record(v, ['authorized', 'value']) || v.authorized !== true) return false;
      return kind === 'authorizedUsersList' ? Array.isArray(v.value) && v.value.length <= 16_384 && v.value.every(user)
        : kind === 'authorizedUserCreate' ? user(v.value) : v.value === null || user(v.value);
  }
}

/** Private owner port, not an HTTP token-management endpoint. Token management
 * must retain the operator gate when its callers migrate. All user authorization
 * and the corresponding SQL run without await in this original Worker turn. */
export async function executeConnectorAuthority(kind: ConnectorAuthorityKind, input: unknown,
  owner: Pick<ConnectorUserStore, 'commands' | 'sdkCommandAdmissionOpen' | 'listUsers' | 'getUser' | 'createUser' | 'updateUser'>,
  tokens: ConnectorTokenStore | undefined): Promise<unknown> {
  if (!tokens || !validConnectorAuthorityInput(kind, input)) throw new AuthPersistenceError();
  const v = input as Record<string, unknown>;
  const allowed = (authorization: string, tokenId: string) => {
    const principal = tokens.authenticateAuthorization(authorization);
    return principal?.tokenId === tokenId && principal.scopes.includes('messages:send')
      && !principal.scopes.includes('execution:delegate');
  };
  switch (kind) {
    case 'ahpAdmission': return allowed(v.authorization as string, v.tokenId as string) && owner.sdkCommandAdmissionOpen;
    case 'ahpClaim': {
      const claim = input as ConnectorAuthorityCommands['ahpClaim']['input'];
      class AdmissionDenied extends Error {}
      class AdmissionUnavailable extends Error {}
      const check = () => {
        if (!allowed(claim.authorization, claim.tokenId)) throw new AdmissionDenied();
        if (!owner.sdkCommandAdmissionOpen) throw new AdmissionUnavailable();
      };
      try {
        check();
        const result = await owner.commands.claimAsync(JSON.stringify(['ahp-text', claim.resource]), claim.key,
          { digest: claim.digest }, false, undefined, undefined, undefined, false, check, check);
        check();
        if (result.fresh) return { state: 'fresh' };
        const id = result.receipt.result?.body.id;
        if (result.receipt.result?.status === 200 && uuid(id)) return { state: 'accepted', id };
        return { state: result.receipt.result?.status === 409 ? 'busy' : 'unknown' };
      } catch (error) {
        if (error instanceof CommandConflict) return { state: 'conflict' };
        if (error instanceof AdmissionDenied) return { state: 'denied' };
        if (error instanceof CommandCapacity || error instanceof AdmissionUnavailable) return { state: 'unavailable' };
        throw error;
      }
    }
    case 'ahpSettle': {
      const result = input as ConnectorAuthorityCommands['ahpSettle']['input'];
      const receipt = owner.commands.settle(JSON.stringify(['ahp-text', result.resource]), result.key,
        result.id === null ? { status: 409, body: {} } : { status: 200, body: { id: result.id } });
      return receipt.state === (result.id === null ? 'rejected' : 'accepted');
    }
    case 'tokenAuthenticate': return tokens.authenticateAuthorization(v.authorization as string) ?? null;
    case 'tokenHasScope': return tokens.hasScope(v.tokenId as string, v.scope as ConnectorScope);
    case 'tokenDelegationHub': return tokens.delegationHubId(v.tokenId as string) ?? null;
    case 'tokensList': return tokens.list();
    case 'tokenCreate': return tokens.create(input as ConnectorAuthorityCommands['tokenCreate']['input']);
    case 'tokenRevoke': return tokens.revoke(v.tokenId as string);
    // Observation only: never exported as authority for a later SQL write.
    // A large historical label need not cross the port just to check a scope.
    case 'authorizedUsersPermission': return tokens.authenticateAuthorization(v.authorization as string)?.scopes.includes(v.scope as ConnectorScope) ?? false;
    default: {
      const scope = kind === 'authorizedUsersList' || kind === 'authorizedUserGet' ? 'users:read' : 'users:write';
      const principal = tokens.authenticateAuthorization(v.authorization as string);
      if (!principal?.scopes.includes(scope)) return { authorized: false };
      const value = kind === 'authorizedUsersList' ? owner.listUsers()
        : kind === 'authorizedUserGet' ? owner.getUser(v.id as string) ?? null
        : kind === 'authorizedUserCreate' ? owner.createUser(v.label as string)
        : owner.updateUser(v.id as string, v.label as string) ?? null;
      return { authorized: true, value };
    }
  }
}
