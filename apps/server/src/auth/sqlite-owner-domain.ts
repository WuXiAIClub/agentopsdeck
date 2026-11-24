import { createHash } from 'node:crypto';
import { accessKeyFromRequest, safeEqual } from './access-key.js';
import { sessionTokenFromRequest, PasskeyChallengeCapacityError, PasskeyVerificationCapacityError,
  PasskeyVerificationRateError, PasskeyUnavailableError, PasskeyVerificationRejectedError } from './passkeys.js';
import { AuthPersistenceError } from './private-store.js';
import { synchronousAuthorizationCall } from './synchronous-authorization.js';
import type { SqlitePasskeys } from './sqlite-passkeys.js';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

/** Server-originated credential evidence, NEVER a serialized authorization
 * decision. The original SQL owner checks membership/credential revocation at
 * the mutation boundary. This port is for legacy standalone authority only:
 * Hub principals/callbacks and mutable process-local authority cannot use it. */
export type SqliteAuthEvidence = { sessionToken?: string; suppliedKeyDigest?: string };
/** Extract proof from raw Request credentials inside the trusted server. A
 * browser-visible 24-character audit identity is NOT a bearer credential.
 * Never accept a caller's evidence DTO from a request body/header directly. */
export function sqliteAuthEvidenceFromRequest(request: Request): SqliteAuthEvidence {
  const session = sessionTokenFromRequest(request), supplied = accessKeyFromRequest(request);
  return { ...(session !== undefined && /^[A-Za-z0-9_-]{43}$/.test(session) ? { sessionToken: session } : {}),
    ...(supplied === undefined ? {} : { suppliedKeyDigest: createHash('sha256').update(supplied).digest('hex') }) };
}
export type SqliteAuthCommands = {
  status: { input: Record<string, never>; output: ReturnType<SqlitePasskeys['status']> };
  list: { input: Record<string, never>; output: ReturnType<SqlitePasskeys['list']> };
  authorized: { input: SqliteAuthEvidence; output: boolean };
  sessionCurrent: { input: { token: string }; output: boolean };
  accessKeySession: { input: { token: string }; output: boolean };
  issueAdministratorSession: { input: { token: string; evidence: SqliteAuthEvidence }; output: null };
  issueUnrestrictedSession: { input: { token: string }; output: null };
  deleteSession: { input: { token: string }; output: boolean };
  clearSessions: { input: { evidence: SqliteAuthEvidence }; output: boolean };
  credentialCurrent: { input: { credentialHash: string }; output: boolean };
  revoke: { input: { credentialHash: string; evidence: SqliteAuthEvidence }; output: boolean };
  registrationOptions: { input: { origin: string; evidence: SqliteAuthEvidence };
    output: Awaited<ReturnType<SqlitePasskeys['registrationOptions']>> };
  authenticationOptions: { input: { origin: string }; output: Awaited<ReturnType<SqlitePasskeys['authenticationOptions']>> };
  verifyRegistration: { input: { origin: string; response: RegistrationResponseJSON; label?: string; evidence: SqliteAuthEvidence };
    output: Awaited<ReturnType<SqlitePasskeys['verifyRegistration']>> };
  verifyAuthentication: { input: { origin: string; response: AuthenticationResponseJSON };
    output: { verified: false } | { verified: true; sessionToken: string; credentialHash: string; keyIdentityHash?: string } };
};
export type SqliteAuthKind = keyof SqliteAuthCommands;
/** Only fixed, known domain refusals cross the worker boundary. Never
 * forward arbitrary exception text or classify uncertain SQL as retryable. */
export type SqliteAuthRefusal = { refusal: 1 | 2 | 3 | 4 | 5; retryAfterSeconds: number };
export function sqliteAuthRefusal(kind: SqliteAuthKind, error: unknown): SqliteAuthRefusal | undefined {
  const refusal = error instanceof PasskeyChallengeCapacityError ? 1
    : error instanceof PasskeyVerificationCapacityError ? 2 : error instanceof PasskeyVerificationRateError ? 3
      : error instanceof PasskeyUnavailableError ? 4 : error instanceof PasskeyVerificationRejectedError ? 5 : undefined;
  if (refusal === undefined) return;
  const value = { refusal, retryAfterSeconds: refusal === 4 || refusal === 5 ? 0 : (error as PasskeyChallengeCapacityError).retryAfterSeconds } as SqliteAuthRefusal;
  return sqliteAuthRefusalError(kind, value) ? value : undefined;
}
export function sqliteAuthRefusalError(kind: SqliteAuthKind | 'close', value: SqliteAuthRefusal): Error | undefined {
  if (value.refusal === 4) return kind === 'authenticationOptions' && value.retryAfterSeconds === 0 ? new PasskeyUnavailableError() : undefined;
  if (value.refusal === 5) return (kind === 'verifyRegistration' || kind === 'verifyAuthentication') && value.retryAfterSeconds === 0
    ? new PasskeyVerificationRejectedError() : undefined;
  if (!Number.isSafeInteger(value.retryAfterSeconds) || value.retryAfterSeconds < 1 || value.retryAfterSeconds > 86400) return;
  if (value.refusal === 1 && (kind === 'registrationOptions' || kind === 'authenticationOptions'))
    return new PasskeyChallengeCapacityError(value.retryAfterSeconds);
  if (kind !== 'verifyRegistration' && kind !== 'verifyAuthentication') return;
  if (value.refusal === 2 && value.retryAfterSeconds === 1) return new PasskeyVerificationCapacityError();
  if (value.refusal === 3) return new PasskeyVerificationRateError(value.retryAfterSeconds);
}
export const SQLITE_AUTH_COMMAND_BYTES = 1024 * 1024;
export const SQLITE_AUTH_RESULT_BYTES = 2 * 1024 * 1024;
export const sqliteAuthKinds = ['status', 'list', 'authorized', 'sessionCurrent', 'accessKeySession',
  'issueAdministratorSession', 'deleteSession', 'clearSessions', 'credentialCurrent', 'revoke',
  'registrationOptions', 'authenticationOptions', 'verifyRegistration', 'verifyAuthentication', 'issueUnrestrictedSession'] as const satisfies readonly SqliteAuthKind[];
const identity = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{24}$/.test(value);
const token = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function fields(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function evidence(value: unknown): value is SqliteAuthEvidence {
  return record(value) && fields(value, [], ['sessionToken', 'suppliedKeyDigest'])
    && (!Object.hasOwn(value, 'sessionToken') || token(value.sessionToken))
    && (!Object.hasOwn(value, 'suppliedKeyDigest') || typeof value.suppliedKeyDigest === 'string' && /^[a-f0-9]{64}$/.test(value.suppliedKeyDigest));
}
function origin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && url.origin === value; } catch { return false; }
}
function response(value: unknown, registration: boolean) {
  return record(value) && fields(value, ['id', 'rawId', 'type', 'clientExtensionResults', 'response'], ['authenticatorAttachment'])
    && value.type === 'public-key' && typeof value.id === 'string' && value.id.length > 0
    && typeof value.rawId === 'string' && record(value.clientExtensionResults) && record(value.response)
    && typeof value.response.clientDataJSON === 'string'
    && (registration ? typeof value.response.attestationObject === 'string'
      : typeof value.response.authenticatorData === 'string' && typeof value.response.signature === 'string');
}
/** Parsed JSON only. No callback, SQL string, Request, path or arbitrary method
 * dispatch is part of the runtime command vocabulary. Offline import remains
 * a separately authorized stopped-owner operation, not a runtime RPC. */
export function validSqliteAuthInput(kind: SqliteAuthKind, value: unknown): boolean {
  if (!record(value)) return false;
  switch (kind) {
    case 'status': case 'list': return fields(value, []);
    case 'authorized': return evidence(value);
    case 'sessionCurrent': case 'accessKeySession': case 'deleteSession': case 'issueUnrestrictedSession': return fields(value, ['token']) && token(value.token);
    case 'issueAdministratorSession': return fields(value, ['token', 'evidence']) && token(value.token) && evidence(value.evidence);
    case 'clearSessions': return fields(value, ['evidence']) && evidence(value.evidence);
    case 'credentialCurrent': return fields(value, ['credentialHash']) && identity(value.credentialHash);
    case 'revoke': return fields(value, ['credentialHash', 'evidence']) && identity(value.credentialHash) && evidence(value.evidence);
    case 'registrationOptions': return fields(value, ['origin', 'evidence']) && origin(value.origin) && evidence(value.evidence);
    case 'authenticationOptions': return fields(value, ['origin']) && origin(value.origin);
    case 'verifyRegistration': return fields(value, ['origin', 'response', 'evidence'], ['label']) && origin(value.origin)
      && evidence(value.evidence) && response(value.response, true) && (!Object.hasOwn(value, 'label') || typeof value.label === 'string');
    case 'verifyAuthentication': return fields(value, ['origin', 'response']) && origin(value.origin) && response(value.response, false);
  }
}
export function validSqliteAuthOutput(kind: SqliteAuthKind, value: unknown): boolean {
  switch (kind) {
    case 'authorized': case 'sessionCurrent': case 'accessKeySession': case 'deleteSession':
    case 'clearSessions': case 'credentialCurrent': case 'revoke': return typeof value === 'boolean';
    case 'issueAdministratorSession': case 'issueUnrestrictedSession': return value === null;
    case 'status': return record(value) && fields(value, ['available', 'count']) && Number.isSafeInteger(value.count)
      && Number(value.count) >= 0 && Number(value.count) <= 1024 && value.available === (Number(value.count) > 0);
    case 'list': return Array.isArray(value) && value.length <= 1024 && value.every(row => record(row)
      && fields(row, ['id', 'label', 'transports', 'createdAt'], ['lastUsedAt']) && identity(row.id)
      && typeof row.label === 'string' && Array.isArray(row.transports) && row.transports.every(t => typeof t === 'string')
      && typeof row.createdAt === 'number' && (row.lastUsedAt === undefined || typeof row.lastUsedAt === 'number'));
    case 'registrationOptions': return record(value) && typeof value.challenge === 'string' && record(value.rp)
      && record(value.user) && Array.isArray(value.pubKeyCredParams);
    case 'authenticationOptions': return record(value) && typeof value.challenge === 'string' && typeof value.rpId === 'string';
    case 'verifyRegistration': return record(value) && (value.verified === false && fields(value, ['verified'])
      || value.verified === true && fields(value, ['verified', 'count', 'credentialHash']) && identity(value.credentialHash)
      && Number.isSafeInteger(value.count) && Number(value.count) >= 1 && Number(value.count) <= 1024);
    case 'verifyAuthentication': return record(value) && (value.verified === false && fields(value, ['verified'])
      || value.verified === true && fields(value, ['verified', 'sessionToken', 'credentialHash'], ['keyIdentityHash'])
      && token(value.sessionToken) && identity(value.credentialHash)
      && (!Object.hasOwn(value, 'keyIdentityHash') || identity(value.keyIdentityHash)));
  }
}

/** Fixed-key owner. Rotation requires draining/closing this complete owner;
 * this is NOT an adapter for a mutable currentKey callback. Every awaited
 * caller must still check its process-local authority before delivery. */
export type SqliteAuthCommandStore = Pick<SqlitePasskeys, 'status' | 'list' | 'sessionAuthorized' | 'isAccessKeySession'
  | 'addAdministratorSession' | 'deleteSession' | 'clearSessions' | 'isCredentialCurrent' | 'revoke'
  | 'registrationOptions' | 'authenticationOptions' | 'verifyRegistration' | 'verifyAuthentication'>;
export async function executeSqliteAuthCommand<K extends SqliteAuthKind>(store: SqliteAuthCommandStore,
  accessKeyDigest: string | undefined, kind: K, input: SqliteAuthCommands[K]['input'],
  originalAuthority?: () => boolean): Promise<SqliteAuthCommands[K]['output']> {
  if (!validSqliteAuthInput(kind, input) || accessKeyDigest !== undefined && !/^[a-f0-9]{64}$/.test(accessKeyDigest)) throw new AuthPersistenceError();
  const key = accessKeyDigest?.slice(0, 24);
  const p = input as Record<string, unknown>;
  // Optional callback is created INSIDE the original worker, never received
  // from the command body. A mutation rechecks it inside its own transaction.
  // Standalone callers retain their original evidence-based contract.
  const authorized = (proof: SqliteAuthEvidence) => originalAuthority !== undefined
    ? synchronousAuthorizationCall(originalAuthority, [])
    : (proof.sessionToken !== undefined && store.sessionAuthorized(proof.sessionToken))
    || accessKeyDigest === undefined || (proof.suppliedKeyDigest !== undefined && safeEqual(accessKeyDigest, proof.suppliedKeyDigest));
  const proof = p.evidence as SqliteAuthEvidence;
  let value: unknown;
  switch (kind) {
    case 'status': value = store.status(key); break;
    case 'list': value = store.list(key); break;
    case 'authorized': value = authorized(input as SqliteAuthEvidence); break;
    case 'sessionCurrent': value = store.sessionAuthorized(p.token as string); break;
    case 'accessKeySession': value = store.isAccessKeySession(p.token as string); break;
    case 'issueAdministratorSession':
      // An existing passkey/member session is not evidence of a key login.
      if (accessKeyDigest === undefined || proof.suppliedKeyDigest === undefined || !safeEqual(accessKeyDigest, proof.suppliedKeyDigest)) throw new AuthPersistenceError();
      store.addAdministratorSession(p.token as string); value = null; break;
    case 'issueUnrestrictedSession':
      // Original no-Key login persists an unbound session too. Configuration
      // is pinned in this owner; a request may never downgrade a keyed owner.
      if (accessKeyDigest !== undefined) throw new AuthPersistenceError();
      store.addAdministratorSession(p.token as string); value = null; break;
    case 'deleteSession': value = store.deleteSession(p.token as string); break;
    case 'clearSessions':
      value = store.clearSessions(() => authorized(proof)); break;
    case 'credentialCurrent': value = store.isCredentialCurrent(p.credentialHash as string, key); break;
    case 'revoke': value = store.revoke(key, p.credentialHash as string, undefined, () => authorized(proof)); break;
    case 'registrationOptions':
      if (!authorized(proof)) throw new AuthPersistenceError();
      value = await store.registrationOptions(new Request(p.origin as string), key); break;
    case 'authenticationOptions': value = await store.authenticationOptions(new Request(p.origin as string), key); break;
    case 'verifyRegistration': value = await store.verifyRegistration(new Request(p.origin as string), p.response as RegistrationResponseJSON,
      { ...(key === undefined ? {} : { keyIdentityHash: key }), ...(p.label === undefined ? {} : { label: p.label as string }),
        isAuthorized: () => authorized(proof) }); break;
    case 'verifyAuthentication': {
      const result = await store.verifyAuthentication(new Request(p.origin as string), p.response as AuthenticationResponseJSON, key);
      value = result.verified ? { verified: true, sessionToken: result.sessionToken, credentialHash: result.credentialHash,
        ...(result.keyIdentityHash === undefined ? {} : { keyIdentityHash: result.keyIdentityHash }) } : { verified: false };
      // Never serialize isCurrent or turn its old result into a permission
      // grant. Delivery requires a NEW awaited current command (the original
      // JSON verifier additionally retains its exact challenge-bound proof).
      break;
    }
  }
  if (!validSqliteAuthOutput(kind, value)) throw new AuthPersistenceError();
  return value as SqliteAuthCommands[K]['output'];
}
