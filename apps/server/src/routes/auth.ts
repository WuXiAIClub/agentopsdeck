import type { Context, Hono } from 'hono';
import type { LoginAttemptDecision } from '../auth/security.js';
import { AuthRoutePersistence, type AuthPasskeyStore, type AuthRouteSessionStore, type AuthRouteAuthority, type AuthRouteAuditStore, type AuthRouteLoginLimiter, type Awaitable } from '../auth/route-persistence.js';
import { copyLoginAttemptDecision } from '../auth/login-attempt-decision.js';
import type { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { clearSessionCookieHeader, createDeckSession, sessionCookieHeader, PasskeyChallengeCapacityError, PasskeyVerificationCapacityError, PasskeyVerificationRateError } from '../auth/passkeys.js';
import { clearAccessCookieHeader as clearLegacyAccessCookieHeader, isValidAccessKey } from '../auth/access-key.js';
import { fingerprintRequest, keyIdentityHash, loginLimiterSubject } from '../auth/security.js';
import { AuthPersistenceError } from '../auth/private-store.js';
import { AuthReadCancelledError, AuthRouteReadWait } from '../auth/route-read-wait.js';
import { AuthBodyError, AuthBodyReader, AUTH_KEY_BODY_BYTES, AUTH_PASSKEY_BODY_BYTES } from '../auth/request-body.js';
import { synchronousAuthorizationCall } from '../auth/synchronous-authorization.js';
import type { RequestAuthorization } from '../auth/awaited-request-authorization.js';

type AuthRoutesDeps = {
  accessKey: string | undefined;
  passkeys: AuthPasskeyStore;
  sessions: AuthRouteSessionStore;
  observeAuthorization?: RequestAuthorization;
  auditLog: AuthRouteAuditStore;
  loginLimiter: AuthRouteLoginLimiter;
  lockoutSeconds: number;
  memberLogin?: (key: string | undefined, request: Request) => Awaitable<string | undefined>;
  // Original domain lookup of the NEW session, not a cached supplied-key grant.
  memberSessionCurrent?: (token: string, request: Request) => Awaitable<boolean>;
  memberKeyIdentity?: (key: string | undefined) => Awaitable<{ userId: string; keyId: string } | undefined>;
  auditIdentity?: (request: Request) => Awaitable<{ userId: string; keyId?: string; authMethod: 'member' | 'administrator' } | undefined>;
  revokeMemberSession?: (token: string, request: Request) => Awaitable<void>;
  recoveryScope?: (request: Request) => Awaitable<string | undefined>;
  diagnostics?: PerformanceDiagnostics;
  readWaitMs?: number;
} & ({ authority: AuthRouteAuthority; isAuthorizedRequest?: never }
  | { isAuthorizedRequest: (request: Request) => boolean; authority?: AuthRouteAuthority });

export function registerAuthRoutes(app: Hono, deps: AuthRoutesDeps) {
  // Complete async authority needs no fabricated synchronous grant. Legacy
  // callbacks remain local to the original SQL participant, never an awaited
  // observation coerced into transaction permission.
  if (!deps.authority && typeof deps.isAuthorizedRequest !== 'function') throw new AuthPersistenceError();
  const currentKeyHash = () => deps.accessKey ? keyIdentityHash(deps.accessKey) : undefined;
  const bodies = new AuthBodyReader();
  const persistence = new AuthRoutePersistence(deps.diagnostics);
  const reads = new AuthRouteReadWait(persistence, deps.diagnostics, deps.readWaitMs);
  const appendAudit = (record: Parameters<AuthRouteAuditStore['append']>[0]) =>
    persistence.run(14, () => deps.auditLog.append(record));
  const persistenceFailure = (c: Context, error: unknown) => error instanceof AuthReadCancelledError
    ? c.json({ error: 'request_cancelled' }, 408) : c.json({ error: 'auth_persistence_failed' }, 503);
  // SQL participants must receive the original result, including unexpected
  // Promise values, so their transaction guard can latch and inspect it.
  // HTTP observation below inspects the original function before invoking it.
  const legacyAuthorization = (request: Request) => deps.isAuthorizedRequest?.(request) ?? false;
  const authorize = async (request: Request) => {
    const key = currentKeyHash();
    if (deps.authority && deps.authority.keyIdentityHash !== key) return false;
    try { return (deps.authority ? (await reads.run(request, 6, () => deps.authority!.authorize(request))).value
      : deps.observeAuthorization ? (await reads.run(request, 6, () => deps.observeAuthorization!(request))).value
      : synchronousAuthorizationCall(deps.isAuthorizedRequest!, [request], undefined, deps, deps.diagnostics)) === true
      && currentKeyHash() === key; }
    catch (error) { if (error instanceof AuthReadCancelledError) throw error; throw new AuthPersistenceError(); }
  };
  // Async authority refusal must not become a truthy Promise or the generic
  // framework's exception logger/500. Keep storage unavailability distinct
  // from a confirmed negative permission decision.
  const boundary = (handler: (c: Context) => Promise<Response>) => async (c: Context) => {
    try { return await handler(c); } catch (error) {
      if (error instanceof AuthPersistenceError) return persistenceFailure(c, error);
      return c.json({ error: 'auth_operation_failed' }, 500);
    }
  };

  app.get('/api/auth/status', boundary(async (c) => {
    c.header('Cache-Control', 'no-store');
    const keyHash = currentKeyHash();
    let passkeys;
    try { passkeys = (await reads.run(c.req.raw, 1, () => deps.passkeys.status(keyHash))).value; }
    catch (error) { return persistenceFailure(c, error); }
    let authenticated = await authorize(c.req.raw);
    let recoveryScope = authenticated && deps.recoveryScope
      ? (await reads.run(c.req.raw, 12, () => deps.recoveryScope!(c.req.raw))).value : undefined;
    // A completed scope read cannot outlive revocation or key rotation.
    authenticated = authenticated && await authorize(c.req.raw) && currentKeyHash() === keyHash;
    if (!authenticated) recoveryScope = undefined;
    return c.json({ authenticated, recoveryScope, passkeys });
  }));

  app.post('/api/auth/login', boundary(async (c) => {
    c.header('Cache-Control', 'no-store');
    const fingerprint = fingerprintRequest(c.req.raw);
    const subject = loginLimiterSubject(fingerprint);
    const loginKey = deps.accessKey;
    const throttled = async (decision: LoginAttemptDecision) => {
      const retryAfterSeconds = decision.retryAfterSeconds ?? deps.lockoutSeconds;
      c.header('Retry-After', String(retryAfterSeconds));
      await appendAudit({
        event: 'access_key_login',
        outcome: 'throttled',
        ...fingerprint,
        reason: 'too_many_failures',
        failureCount: decision.failureCount,
        retryAfterSeconds,
      });
      return c.json({ error: 'too_many_attempts', retryAfterSeconds }, 429);
    };
    const preflight = (await reads.run(c.req.raw, 17, async () => copyLoginAttemptDecision(await deps.loginLimiter.check(subject)))).value;
    if (!preflight.allowed) return throttled(preflight);

    let body: { accessKey?: unknown } | null;
    try { body = await bodies.read(c.req.raw, AUTH_KEY_BODY_BYTES) as typeof body; }
    catch (error) {
      // Preserve malformed-login failure accounting, but not resource failures.
      if (error instanceof AuthBodyError && error.status === 400) body = null;
      else if (error instanceof AuthBodyError) {
        if (error.status === 429) c.header('Retry-After', '1');
        return c.json({ error: error.message, ...(error.status === 429 ? { retryAfterSeconds: 1 } : {}) }, error.status);
      } else throw error;
    }
    // Another request may have established a ban while this body was pending.
    // Recheck before memberLogin, which can create a session as a side effect.
    const afterBody = (await reads.run(c.req.raw, 17, async () => copyLoginAttemptDecision(await deps.loginLimiter.check(subject)))).value;
    if (!afterBody.allowed) return throttled(afterBody);
    // The awaited policy read is not an issuance grant from an earlier key.
    if (deps.accessKey !== loginKey) return c.json({ error: 'unauthorized' }, 401);
    const supplied = typeof body?.accessKey === 'string' ? body.accessKey.trim() : undefined;
    // Refuse missing final proof before starting the original session mutation.
    if (deps.memberLogin && !deps.memberSessionCurrent) persistence.refuse(8);
    const memberSession = deps.memberLogin ? (await persistence.run(8, async () => {
      const value = await deps.memberLogin!(supplied, c.req.raw);
      // Original mutation has already been dispatched. An invalid ACK is
      // unknown, not a pre-dispatch refusal or confirmed successful issuance.
      if (value !== undefined && (typeof value !== 'string' || value.length === 0)) throw new AuthPersistenceError();
      return value;
    })).value : undefined;
    if (!memberSession && (supplied?.startsWith('hub_key_') || !isValidAccessKey(supplied, deps.accessKey))) {
      const result = (await persistence.run(18, async () => copyLoginAttemptDecision(await deps.loginLimiter.recordFailure(subject)))).value;
      if (c.req.raw.signal.aborted) throw new AuthReadCancelledError();
      const retryAfterSeconds = result.retryAfterSeconds ?? deps.lockoutSeconds;
      await appendAudit({
        event: 'access_key_login',
        outcome: result.allowed ? 'failure' : 'throttled',
        ...fingerprint,
        reason: 'invalid_access_key',
        failureCount: result.failureCount,
        retryAfterSeconds: result.allowed ? undefined : retryAfterSeconds,
      });
      if (!result.allowed) {
        c.header('Retry-After', String(retryAfterSeconds));
        return c.json({ error: 'too_many_attempts', retryAfterSeconds }, 429);
      }
      return c.json({ error: 'invalid access key' }, 401);
    }

    const token = memberSession ?? createDeckSession();
    let passkeys;
    try {
      if (!memberSession) await persistence.run(4, () => deps.sessions.add(token));
      passkeys = (await reads.run(c.req.raw, 1, () => deps.passkeys.status(currentKeyHash()))).value;
    }
    catch (error) {
      if (error instanceof AuthPersistenceError) return persistenceFailure(c, error);
      throw error;
    }
    const memberIdentity = memberSession && deps.memberKeyIdentity
      ? (await reads.run(c.req.raw, 9, () => deps.memberKeyIdentity!(supplied))).value : undefined;
    // Persistence has already happened; this does not undo or replay it.
    // Never deliver a session from a rotated key or a revoked SQL session.
    if (!memberSession && (deps.authority && (await reads.run(c.req.raw, 7, () => deps.authority!.sessionCurrent(token))).value !== true
      || deps.accessKey !== loginKey)) return c.json({ error: 'unauthorized' }, 401);
    if (memberSession && (await reads.run(c.req.raw, 13, () => deps.memberSessionCurrent!(token, c.req.raw))).value !== true)
      return c.json({ error: 'unauthorized' }, 401);
    await persistence.run(19, async () => {
      const result: unknown = await deps.loginLimiter.recordSuccess(subject);
      if (result !== undefined) throw new AuthPersistenceError();
    });
    await appendAudit({
      event: 'access_key_login',
      outcome: 'success',
      ...fingerprint,
      ...(memberSession ? memberIdentity : { userId: 'default' }),
      authMethod: memberSession ? 'member' : 'administrator',
      keyIdentityHash: supplied ? keyIdentityHash(supplied) : undefined,
    });
    // Audit acknowledgement is another owner wait, not a cached session grant.
    // The original issuance is retained even when delivery is now refused.
    if (!memberSession && (deps.authority && (await reads.run(c.req.raw, 7, () => deps.authority!.sessionCurrent(token))).value !== true
      || deps.accessKey !== loginKey)) return c.json({ error: 'unauthorized' }, 401);
    if (memberSession && (await reads.run(c.req.raw, 13, () => deps.memberSessionCurrent!(token, c.req.raw))).value !== true)
      return c.json({ error: 'unauthorized' }, 401);
    if (!memberSession && deps.sessions.has && (await reads.run(c.req.raw, 7, () => deps.sessions.has!(token))).value !== true)
      return c.json({ error: 'unauthorized' }, 401);
    if (!memberSession && deps.accessKey !== loginKey) return c.json({ error: 'unauthorized' }, 401);
    if (c.req.raw.signal.aborted) throw new AuthReadCancelledError();
    c.header('Set-Cookie', sessionCookieHeader(token, c.req.raw));
    return c.json({ ok: true, passkeys });
  }));

  app.post('/api/auth/logout', boundary(async (c) => {
    c.header('Cache-Control', 'no-store');
    const cookie = c.req.header('cookie') ?? '';
    const cookieRequest = new Request(c.req.url, { headers: { cookie } });
    const identity = cookie && deps.auditIdentity ? (await reads.run(c.req.raw, 10, () => deps.auditIdentity!(cookieRequest))).value : undefined;
    const token = /(?:^|;\s*)agentopsdeck_session=([^;]+)/.exec(cookie)?.[1];
    if (token) {
      try {
        const decoded = decodeURIComponent(token);
        await persistence.run(5, () => deps.sessions.delete(decoded));
        if (deps.revokeMemberSession) await persistence.run(11, () => deps.revokeMemberSession!(decoded, c.req.raw));
      } catch (error) {
        if (error instanceof AuthPersistenceError) return persistenceFailure(c, error);
        if (!(error instanceof URIError)) throw error;
        // Invalid cookies are not an authenticated session.
      }
    }
    c.header('Set-Cookie', clearSessionCookieHeader(c.req.raw));
    c.header('Set-Cookie', clearLegacyAccessCookieHeader(), { append: true });
    if (identity || (!deps.auditIdentity && await authorize(c.req.raw))) await appendAudit({
      event: 'access_key_logout',
      outcome: 'success',
      ...fingerprintRequest(c.req.raw),
      ...identity,
    });
    return c.json({ ok: true });
  }));

  app.get('/api/auth/audit', boundary(async (c) => {
    const keyHash = currentKeyHash();
    if (!await authorize(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
    if (deps.auditIdentity && (await reads.run(c.req.raw, 10, () => deps.auditIdentity!(c.req.raw))).value?.authMethod !== 'administrator') return c.json({ error: 'forbidden' }, 403);
    if (!await authorize(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
    c.header('Cache-Control', 'no-store');
    const limit = Number(c.req.query('limit') ?? 100);
    let result;
    if (c.req.query('page') === 'true') {
      const cursor = c.req.query('before');
      const before = cursor === undefined ? undefined : Number(cursor);
      if (before !== undefined && (!Number.isSafeInteger(before) || before <= 0)) return c.json({ error: 'invalid cursor' }, 400);
      result = (await persistence.run(15, () => deps.auditLog.page({ limit: Number.isFinite(limit) ? limit : 50, userId: c.req.query('userId'), before }, c.req.raw))).value;
    } else {
      result = { records: (await persistence.run(16, () => deps.auditLog.list(Number.isFinite(limit) ? limit : 100, c.req.raw))).value };
    }
    // These methods prune in the original Hub transaction domain; an HTTP
    // deadline must not release or replay them. Recheck delivery separately.
    if (deps.auditIdentity && (await reads.run(c.req.raw, 10, () => deps.auditIdentity!(c.req.raw))).value?.authMethod !== 'administrator') return c.json({ error: 'forbidden' }, 403);
    if (!await authorize(c.req.raw) || currentKeyHash() !== keyHash) return c.json({ error: 'unauthorized' }, 401);
    if (c.req.raw.signal.aborted) throw new AuthReadCancelledError();
    return c.json(result);
  }));

  app.get('/api/auth/passkeys', boundary(async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!await authorize(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
    const keyHash = currentKeyHash();
    let passkeys;
    try { passkeys = (await reads.run(c.req.raw, 2, () => deps.passkeys.list(keyHash))).value; }
    catch (error) { return persistenceFailure(c, error); }
    if (!await authorize(c.req.raw) || currentKeyHash() !== keyHash) return c.json({ error: 'unauthorized' }, 401);
    return c.json({ passkeys });
  }));

  app.delete('/api/auth/passkeys/:id', boundary(async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!await authorize(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
    const id = c.req.param('id');
    if (id === undefined) return c.json({ error: 'invalid_passkey_id' }, 400);
    const keyHash = currentKeyHash();
    let denied = false;
    const isAuthorized = () => {
      const allowed = legacyAuthorization(c.req.raw);
      const keyCurrent = currentKeyHash() === keyHash;
      denied ||= allowed !== true || !keyCurrent;
      // Preserve an unexpected original Promise/thenable for the ORIGINAL
      // SQL participant inspector. Converting it to false here would hide
      // callback writes and its late continuation, even after key rotation.
      return allowed === true ? keyCurrent : allowed;
    };
    let revoked: boolean;
    try { revoked = (await persistence.run(3, () => deps.authority
      ? deps.authority.revoke(c.req.raw, keyHash, id) : deps.passkeys.revoke(keyHash, id, undefined, isAuthorized))).value; }
    catch (error) {
      if (error instanceof AuthPersistenceError) return persistenceFailure(c, error);
      throw error;
    }
    if (denied || currentKeyHash() !== keyHash || !revoked && !await authorize(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
    await appendAudit({
      event: 'passkey_revoke',
      outcome: revoked ? 'success' : 'failure',
      ...fingerprintRequest(c.req.raw),
      keyIdentityHash: currentKeyHash(),
      passkeyCredentialHash: id,
      reason: revoked ? 'revoked' : 'not_found',
    });
    if (currentKeyHash() !== keyHash) return c.json({ error: 'unauthorized' }, 401);
    const reauthenticate = revoked && !await authorize(c.req.raw);
    if (reauthenticate) c.header('Set-Cookie', clearSessionCookieHeader(c.req.raw));
    return c.json({ ok: revoked, ...(reauthenticate ? { reauthenticate: true } : {}) }, revoked ? 200 : 404);
  }));

  app.post('/api/auth/passkeys/register/options', boundary(async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!await authorize(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
    try {
      const keyHash = currentKeyHash();
      const options = await deps.passkeys.registrationOptions(c.req.raw, keyHash);
      if (!await authorize(c.req.raw) || currentKeyHash() !== keyHash) return c.json({ error: 'unauthorized' }, 401);
      return c.json(options);
    } catch (error) {
      if (error instanceof AuthPersistenceError) return persistenceFailure(c, error);
      if (error instanceof PasskeyChallengeCapacityError) {
        c.header('Retry-After', String(error.retryAfterSeconds));
        return c.json({ error: error.message, retryAfterSeconds: error.retryAfterSeconds }, 429);
      }
      return c.json({ error: normalizeError(error) }, 500);
    }
  }));

  app.post('/api/auth/passkeys/register/verify', boundary(async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!await authorize(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
    try {
      const body = await bodies.read(c.req.raw, AUTH_PASSKEY_BODY_BYTES) as { label?: unknown } | null;
      if (!await authorize(c.req.raw)) return c.json({ error: 'unauthorized' }, 401);
      const response = registrationCredentialFromBody(body);
      const label = typeof body?.label === 'string' ? body.label : undefined;
      const metadata: { keyIdentityHash?: string; label?: string; isAuthorized: () => boolean } = {
        isAuthorized: () => legacyAuthorization(c.req.raw),
      };
      const keyHash = currentKeyHash();
      if (keyHash) metadata.keyIdentityHash = keyHash;
      if (label) metadata.label = label;
      const result = await (deps.authority
        ? deps.authority.verifyRegistration(c.req.raw, response, {
          ...(keyHash === undefined ? {} : { keyIdentityHash: keyHash }), ...(label === undefined ? {} : { label }) })
        : deps.passkeys.verifyRegistration(c.req.raw, response, metadata));
      if (!await authorize(c.req.raw) || currentKeyHash() !== keyHash) return c.json({ error: 'unauthorized' }, 401);
      if (!result.verified) return c.json({ error: 'passkey registration failed' }, 400);
      await appendAudit({
        event: 'passkey_bind',
        outcome: 'success',
        ...fingerprintRequest(c.req.raw),
        keyIdentityHash: currentKeyHash(),
        passkeyCredentialHash: result.credentialHash,
      });
      const passkeys = (await reads.run(c.req.raw, 1, () => deps.passkeys.status(currentKeyHash()))).value;
      if (!await authorize(c.req.raw) || currentKeyHash() !== keyHash) return c.json({ error: 'unauthorized' }, 401);
      return c.json({ ok: true, passkeys });
    } catch (error) {
      if (error instanceof AuthBodyError) {
        if (error.status === 429) c.header('Retry-After', '1');
        return c.json({ error: error.message, ...(error.status === 429 ? { retryAfterSeconds: 1 } : {}) }, error.status);
      }
      if (error instanceof PasskeyVerificationCapacityError || error instanceof PasskeyVerificationRateError) {
        c.header('Retry-After', String(error.retryAfterSeconds));
        return c.json({ error: error.message, retryAfterSeconds: error.retryAfterSeconds }, 429);
      }
      if (error instanceof AuthPersistenceError) return persistenceFailure(c, error);
      await appendAudit({
        event: 'passkey_bind',
        outcome: 'failure',
        ...fingerprintRequest(c.req.raw),
        keyIdentityHash: currentKeyHash(),
        reason: normalizeError(error),
      });
      return c.json({ error: normalizeError(error) }, 500);
    }
  }));

  app.post('/api/auth/passkeys/login/options', boundary(async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      return c.json(await deps.passkeys.authenticationOptions(c.req.raw, currentKeyHash()));
    } catch (error) {
      if (error instanceof AuthPersistenceError) return persistenceFailure(c, error);
      if (error instanceof PasskeyChallengeCapacityError) {
        c.header('Retry-After', String(error.retryAfterSeconds));
        return c.json({ error: error.message, retryAfterSeconds: error.retryAfterSeconds }, 429);
      }
      return c.json({ error: normalizeError(error) }, 500);
    }
  }));

  app.post('/api/auth/passkeys/login/verify', boundary(async (c) => {
    c.header('Cache-Control', 'no-store');
    try {
      const response = await bodies.read(c.req.raw, AUTH_PASSKEY_BODY_BYTES) as Parameters<AuthPasskeyStore['verifyAuthentication']>[1];
      const verificationKey = currentKeyHash();
      const result = await deps.passkeys.verifyAuthentication(c.req.raw, response, verificationKey);
      if (!result.verified || (await reads.run(c.req.raw, 7, () => result.isCurrent())).value !== true || currentKeyHash() !== verificationKey) {
        await appendAudit({
          event: 'passkey_assertion',
          outcome: 'failure',
          ...fingerprintRequest(c.req.raw),
          reason: 'verification_failed',
        });
        return c.json({ error: 'passkey verification failed' }, 401);
      }
      // Shared storage has already committed the counter, challenge consumption, audit and
      // hashed session together. A second issuance would break that boundary.
      const token = 'sessionToken' in result ? result.sessionToken : createDeckSession();
      const keyHash = currentKeyHash();
      if (!('sessionToken' in result)) await persistence.run(4, () => deps.sessions.add(token,
        { credentialHash: result.credentialHash, ...(keyHash ? { keyIdentityHash: keyHash } : {}) }));
      const passkeys = (await reads.run(c.req.raw, 1, () => deps.passkeys.status(currentKeyHash()))).value;
      // The owner may have revoked the credential while session persistence
      // or status was pending. Never publish a success cookie from that grant.
      if ((await reads.run(c.req.raw, 7, () => result.isCurrent())).value !== true || currentKeyHash() !== verificationKey) return c.json({ error: 'passkey verification failed' }, 401);
      await appendAudit({
        event: 'passkey_assertion',
        outcome: 'success',
        ...fingerprintRequest(c.req.raw),
        keyIdentityHash: result.keyIdentityHash,
        passkeyCredentialHash: result.credentialHash,
      });
      if ((await reads.run(c.req.raw, 7, () => result.isCurrent())).value !== true || currentKeyHash() !== verificationKey) return c.json({ error: 'passkey verification failed' }, 401);
      if (!('sessionToken' in result) && deps.sessions.has && (await reads.run(c.req.raw, 7, () => deps.sessions.has!(token))).value !== true)
        return c.json({ error: 'passkey verification failed' }, 401);
      if (currentKeyHash() !== verificationKey) return c.json({ error: 'passkey verification failed' }, 401);
      if (c.req.raw.signal.aborted) throw new AuthReadCancelledError();
      c.header('Set-Cookie', sessionCookieHeader(token, c.req.raw));
      return c.json({ ok: true, passkeys });
    } catch (error) {
      if (error instanceof AuthBodyError) {
        if (error.status === 429) c.header('Retry-After', '1');
        return c.json({ error: error.message, ...(error.status === 429 ? { retryAfterSeconds: 1 } : {}) }, error.status);
      }
      if (error instanceof PasskeyVerificationCapacityError || error instanceof PasskeyVerificationRateError) {
        c.header('Retry-After', String(error.retryAfterSeconds));
        return c.json({ error: error.message, retryAfterSeconds: error.retryAfterSeconds }, 429);
      }
      if (error instanceof AuthPersistenceError) return persistenceFailure(c, error);
      await appendAudit({
        event: 'passkey_assertion',
        outcome: 'failure',
        ...fingerprintRequest(c.req.raw),
        reason: normalizeError(error),
      });
      return c.json({ error: normalizeError(error) }, 500);
    }
  }));
  return { get pending() { return persistence.pending; }, close: () => persistence.close() };
}

export const __test_registrationCredentialFromBody = registrationCredentialFromBody;

function registrationCredentialFromBody(body: any) {
  // Frontend may send either the credential directly, or { credential, label }.
  // A WebAuthn registration credential itself also has a `response` field, so
  // never unwrap body.response when body.id is present; doing so drops the
  // credential id and SimpleWebAuthn raises "Missing credential ID".
  if (body?.credential) return body.credential;
  if (body?.id) return body;
  return body?.response ?? body;
}

function normalizeError(_error: unknown) {
  return 'auth_operation_failed';
}
