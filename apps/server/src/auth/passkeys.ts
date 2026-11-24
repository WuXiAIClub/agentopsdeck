import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from '@simplewebauthn/server';
import { credentialHashForAudit } from './security.js';
import { synchronousAuthorization } from './synchronous-authorization.js';
import { AuthPersistenceError, PrivateAuthStoreGuard } from './private-store.js';

export type PasskeySessionBinding = { credentialHash: string; keyIdentityHash?: string };

export class PersistentDeckSessionSet extends Set<string> {
  private ready = false;
  private readonly persistence: PrivateAuthStoreGuard;
  private readonly bindings = new Map<string, PasskeySessionBinding>();

  constructor(file: string, private readonly credentialCurrent?: (binding: PasskeySessionBinding) => boolean) {
    super();
    this.persistence = new PrivateAuthStoreGuard(file);
    for (const entry of loadSessionTokens(file)) {
      super.add(entry.token);
      if (entry.binding) this.bindings.set(entry.token, entry.binding);
    }
    this.persistence.check();
    this.ready = true;
  }

  /** Worker boundary must distinguish a stale backing file from a miss. */
  assertCurrent() { this.persistence.check(); }

  override has(value: string) {
    if (!super.has(value) || !this.persistence.current()) return false;
    const binding = this.bindings.get(value);
    // Never downgrade a bound session to a legacy access-key session. Checks
    // are synchronous and performed on every authorization, after checking
    // the backing file's revision (without reparsing its contents).
    if (!binding) return true;
    try { return this.credentialCurrent?.(binding) === true; } catch { return false; }
  }

  /** Read-only provenance check; a passkey session never becomes a Key login. */
  isAccessKeySession(value: string) {
    return this.has(value) && !this.bindings.has(value);
  }

  override add(value: string, binding?: PasskeySessionBinding) {
    this.persistence.check();
    if (super.has(value)) return this;
    const bindings = new Map(this.bindings);
    if (binding) bindings.set(value, { ...binding });
    if (this.ready) this.save([...this, value], bindings);
    if (binding) this.bindings.set(value, { ...binding });
    super.add(value);
    return this;
  }

  override delete(value: string) {
    this.persistence.check();
    if (!super.has(value)) return false;
    if (this.ready) this.save([...this].filter(token => token !== value));
    this.bindings.delete(value);
    return super.delete(value);
  }

  override clear() {
    this.persistence.check();
    if (!this.size) return;
    if (this.ready) this.save([]);
    this.bindings.clear();
    super.clear();
  }

  private save(sessions: string[], bindings = this.bindings) {
    // Object records are intentionally ignored by older string-only readers:
    // a downgrade must not turn a bound token into an unrevocable legacy token.
    this.persistence.write({ sessions: sessions.map(token => bindings.has(token) ? { token, ...bindings.get(token) } : token) });
  }
}

function loadSessionTokens(file: string) {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { sessions?: unknown[] };
    if (!Array.isArray(parsed?.sessions)) throw new AuthPersistenceError();
    const entries = new Map<string, { token: string; binding?: PasskeySessionBinding }>();
    const seen = new Set<string>();
    for (const item of parsed.sessions) {
      const token = typeof item === 'string' ? item : (item as { token?: unknown } | null)?.token;
      if (typeof token !== 'string' || token.length <= 12) continue;
      if (seen.has(token)) { entries.delete(token); continue; }
      seen.add(token);
      if (typeof item === 'string') { entries.set(token, { token }); continue; }
      const binding = item as PasskeySessionBinding;
      if (!/^[a-f0-9]{24}$/.test(binding.credentialHash) || (binding.keyIdentityHash !== undefined && !/^[a-f0-9]{24}$/.test(binding.keyIdentityHash))) continue;
      entries.set(token, { token, binding: { credentialHash: binding.credentialHash, ...(binding.keyIdentityHash ? { keyIdentityHash: binding.keyIdentityHash } : {}) } });
    }
    return [...entries.values()];
  } catch { throw new AuthPersistenceError(); }
}

export type PasskeyStatus = {
  available: boolean;
  count: number;
};

export type SafePasskey = {
  id: string;
  label: string;
  transports: AuthenticatorTransportFuture[];
  createdAt: number;
  lastUsedAt?: number;
};

export type StoredPasskey = {
  id: string;
  publicKey: string;
  counter: number;
  transports?: AuthenticatorTransportFuture[];
  rpId: string;
  keyIdentityHash?: string;
  label: string;
  createdAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
};

type PasskeyStoreFile = {
  credentials: StoredPasskey[];
};

type ChallengeMeta = {
  challenge: string;
  rpId: string;
  origin: string;
  createdAt: number;
  keyIdentityHash?: string | undefined;
};

const CHALLENGE_TTL_MS = 5 * 60_000;

export class PasskeyChallengeCapacityError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('passkey_challenge_capacity');
    this.name = 'PasskeyChallengeCapacityError';
  }
}

export class PasskeyVerificationCapacityError extends Error {
  readonly retryAfterSeconds = 1;
  constructor() {
    super('passkey_verification_capacity');
    this.name = 'PasskeyVerificationCapacityError';
  }
}

export class PasskeyVerificationRateError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('passkey_verification_rate');
    this.name = 'PasskeyVerificationRateError';
  }
}

/** Fixed public domain refusal, not an arbitrary persistence exception. */
export class PasskeyUnavailableError extends Error {
  constructor() { super('No passkeys registered for this host'); this.name = 'PasskeyUnavailableError'; }
}

/** Rejection by the cryptographic verifier only. Never wrap a SQL mutation,
 * challenge claim/burn or persistence failure in this retryable domain error. */
export class PasskeyVerificationRejectedError extends Error {
  constructor() { super('passkey_verification_rejected'); this.name = 'PasskeyVerificationRejectedError'; }
}

export type RegistrationMetadata = { keyIdentityHash?: string; label?: string; isAuthorized?: () => boolean };

export class PasskeyManager {
  /** Does not reload, steal a lock or accept an external revision. */
  assertCurrent() { this.persistence.check(); }

  private readonly file: string;
  private readonly persistence: PrivateAuthStoreGuard;
  private credentials: StoredPasskey[];
  private registrationChallenges = new Map<string, ChallengeMeta>();
  private authenticationChallenges = new Map<string, ChallengeMeta>();
  private readonly pendingChallenges = new Map<Map<string, ChallengeMeta>, number>();
  private readonly maxChallenges: number;
  private readonly now: () => number;
  private readonly maxVerifications: number;
  private pendingVerifications = 0;
  private readonly maxVerificationsPerMinute: number;
  private verificationTimes: number[] = [];
  private lastVerificationTime = -Infinity;

  constructor(file: string, options: { maxChallenges?: number; maxVerifications?: number; maxVerificationsPerMinute?: number; now?: () => number } = {}) {
    this.maxChallenges = options.maxChallenges ?? 256;
    if (!Number.isSafeInteger(this.maxChallenges) || this.maxChallenges < 1 || this.maxChallenges > 256) {
      throw new Error('maxChallenges must be an integer between 1 and 256');
    }
    this.now = options.now ?? Date.now;
    this.maxVerifications = options.maxVerifications ?? 8;
    if (!Number.isSafeInteger(this.maxVerifications) || this.maxVerifications < 1 || this.maxVerifications > 32) {
      throw new Error('maxVerifications must be an integer between 1 and 32');
    }
    this.maxVerificationsPerMinute = options.maxVerificationsPerMinute ?? 120;
    if (!Number.isSafeInteger(this.maxVerificationsPerMinute) || this.maxVerificationsPerMinute < 1 || this.maxVerificationsPerMinute > 120) {
      throw new Error('maxVerificationsPerMinute must be an integer between 1 and 120');
    }
    this.file = file;
    this.persistence = new PrivateAuthStoreGuard(file);
    this.credentials = this.load();
    this.persistence.check();
  }

  status(keyIdentityHash?: string): PasskeyStatus {
    const count = this.activeCredentials(keyIdentityHash).length;
    return { available: count > 0, count };
  }

  list(keyIdentityHash?: string): SafePasskey[] {
    return this.activeCredentials(keyIdentityHash).map((credential) => ({
      id: credentialHashForAudit(credential.id),
      label: credential.label,
      transports: credential.transports ?? [],
      createdAt: credential.createdAt,
      ...(credential.lastUsedAt ? { lastUsedAt: credential.lastUsedAt } : {}),
    }));
  }

  revoke(keyIdentityHash: string | undefined, passkeyId: string, now = Date.now(), isAuthorized?: () => boolean) {
    this.persistence.check();
    if (!synchronousAuthorization(isAuthorized)) return false;
    const credential = this.credentials.find((item) => {
      if (item.revokedAt !== undefined) return false;
      if (keyIdentityHash && item.keyIdentityHash && item.keyIdentityHash !== keyIdentityHash) return false;
      return credentialHashForAudit(item.id) === passkeyId;
    });
    if (!credential) return false;
    this.save(this.credentials.map(item => item === credential ? { ...item, revokedAt: now } : item));
    credential.revokedAt = now;
    return true;
  }

  async registrationOptions(request: Request, keyIdentityHash?: string): Promise<PublicKeyCredentialCreationOptionsJSON> {
    this.persistence.check();
    this.pruneChallenges();
    const { rpId, origin } = relyingParty(request);
    return this.createChallenge(this.registrationChallenges, { rpId, origin, keyIdentityHash }, () => generateRegistrationOptions({
      rpName: 'AgentOpsDeck',
      rpID: rpId,
      userName: 'agentopsdeck-operator',
      userDisplayName: 'AgentOpsDeck operator',
      userID: new TextEncoder().encode('agentopsdeck-operator'),
      attestationType: 'none',
      excludeCredentials: this.activeCredentials()
        .filter((credential) => credential.rpId === rpId)
        .map((credential) => credential.transports?.length ? { id: credential.id, transports: credential.transports } : { id: credential.id }),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
      },
    }));
  }

  async verifyRegistration(request: Request, response: RegistrationResponseJSON, metadata: RegistrationMetadata = {}) {
    this.persistence.check();
    return this.withVerificationSlot(() => this.verifyRegistrationWithinBudget(request, response, metadata));
  }

  private async verifyRegistrationWithinBudget(request: Request, response: RegistrationResponseJSON, metadata: RegistrationMetadata) {
    this.pruneChallenges();
    const matched = this.takeChallenge(this.registrationChallenges, request, response, metadata.keyIdentityHash);
    if (!matched) return { verified: false as const };
    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: matched.challenge,
      expectedOrigin: matched.origin,
      expectedRPID: matched.rpId,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo
      || this.now() >= matched.createdAt + CHALLENGE_TTL_MS
      || !synchronousAuthorization(metadata.isAuthorized)) return { verified: false as const };

    this.registrationChallenges.delete(matched.challenge);
    const credential = verification.registrationInfo.credential;
    // Credential IDs are immutable identities, including revoked tombstones.
    // A concurrent registration must not replace a key or revive a revoked one.
    if (this.credentials.some(item => item.id === credential.id)) return { verified: false as const };
    const transports = response.response.transports;
    const stored: StoredPasskey = {
      id: credential.id,
      publicKey: uint8ToBase64Url(credential.publicKey),
      counter: credential.counter,
      ...(transports?.length ? { transports } : {}),
      rpId: verification.registrationInfo.rpID ?? matched.rpId,
      ...(metadata.keyIdentityHash ? { keyIdentityHash: metadata.keyIdentityHash } : {}),
      label: sanitizeLabel(metadata.label) ?? `Passkey ${new Date().toLocaleString()}`,
      createdAt: Date.now(),
    };
    const credentials = this.credentials.concat(stored);
    this.save(credentials);
    this.credentials = credentials;
    return { verified: true as const, count: this.activeCredentials(metadata.keyIdentityHash).length, credentialHash: credentialHashForAudit(stored.id) };
  }

  async authenticationOptions(request: Request, keyIdentityHash?: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
    this.persistence.check();
    this.pruneChallenges();
    const { rpId, origin } = relyingParty(request);
    const credentials = this.activeCredentials(keyIdentityHash).filter((credential) => credential.rpId === rpId);
    if (credentials.length === 0) throw new Error('No passkeys registered for this host. Unlock with access key first, then bind a passkey.');
    return this.createChallenge(this.authenticationChallenges, { rpId, origin, keyIdentityHash }, () => generateAuthenticationOptions({
      rpID: rpId,
      allowCredentials: credentials.map((credential) => credential.transports?.length ? { id: credential.id, transports: credential.transports } : { id: credential.id }),
      userVerification: 'required',
    }));
  }

  async verifyAuthentication(request: Request, response: AuthenticationResponseJSON, keyIdentityHash?: string) {
    this.persistence.check();
    return this.withVerificationSlot(() => this.verifyAuthenticationWithinBudget(request, response, keyIdentityHash));
  }

  private async verifyAuthenticationWithinBudget(request: Request, response: AuthenticationResponseJSON, keyIdentityHash?: string) {
    this.pruneChallenges();
    const matched = this.takeChallenge(this.authenticationChallenges, request, response, keyIdentityHash);
    if (!matched) return { verified: false as const };
    const stored = this.activeCredentials(keyIdentityHash).find((credential) => credential.id === response.id && credential.rpId === matched.rpId);
    if (!stored) return { verified: false as const };

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: matched.challenge,
      expectedOrigin: matched.origin,
      expectedRPID: matched.rpId,
      credential: storedToWebAuthnCredential(stored),
      requireUserVerification: true,
    });
    const isCurrent = () => this.persistence.current() && this.credentials.includes(stored) && stored.revokedAt === undefined
      && this.now() < matched.createdAt + CHALLENGE_TTL_MS;
    if (!verification.verified || !isCurrent()) return { verified: false as const };

    // Crypto verification captured an earlier counter. Revalidate against the
    // latest committed value so concurrent assertions cannot roll it backwards.
    // Authenticators that always report zero remain supported.
    const nextCounter = verification.authenticationInfo.newCounter;
    if ((stored.counter > 0 || nextCounter > 0) && nextCounter <= stored.counter) return { verified: false as const };

    this.authenticationChallenges.delete(matched.challenge);
    const lastUsedAt = Date.now();
    this.save(this.credentials.map(item => item === stored ? { ...item, counter: nextCounter, lastUsedAt } : item));
    stored.counter = nextCounter;
    stored.lastUsedAt = lastUsedAt;
    // Kept server-local: the route must recheck after its await, before issuing
    // a session. This captures this exact credential, not a replaceable ID.
    return { verified: true as const, credentialHash: credentialHashForAudit(stored.id), keyIdentityHash: stored.keyIdentityHash,
      deliveryExpiresAt: matched.createdAt + CHALLENGE_TTL_MS, isCurrent };
  }

  private async withVerificationSlot<T>(verify: () => Promise<T>): Promise<T> {
    // Reject before consuming the one-shot challenge. No queue or background
    // retry, and hung work holds its slot until it actually settles.
    if (this.pendingVerifications >= this.maxVerifications) throw new PasskeyVerificationCapacityError();
    // Shared across registration and login, independent of attacker-controlled
    // source headers or credential IDs. Count successes and failures alike;
    // fast failures cannot evade the concurrency budget. No per-source maps.
    const now = Math.max(this.lastVerificationTime, this.now());
    this.lastVerificationTime = now;
    this.verificationTimes = this.verificationTimes.filter(time => time > now - 60_000);
    if (this.verificationTimes.length >= this.maxVerificationsPerMinute) {
      throw new PasskeyVerificationRateError(Math.max(1, Math.ceil((this.verificationTimes[0]! + 60_000 - now) / 1000)));
    }
    this.verificationTimes.push(now);
    this.pendingVerifications++;
    try { return await verify(); }
    finally { this.pendingVerifications--; }
  }

  private activeCredentials(keyIdentityHash?: string) {
    if (!this.persistence.current()) return [];
    return this.credentials.filter((credential) => {
      if (credential.revokedAt !== undefined) return false;
      if (keyIdentityHash && credential.keyIdentityHash && credential.keyIdentityHash !== keyIdentityHash) return false;
      return true;
    });
  }

  isCredentialCurrent(credentialHash: string, keyIdentityHash?: string) {
    return this.activeCredentials(keyIdentityHash).some(credential => credentialHashForAudit(credential.id) === credentialHash);
  }

  private takeChallenge(challenges: Map<string, ChallengeMeta>, request: Request,
    response: RegistrationResponseJSON | AuthenticationResponseJSON, keyIdentityHash: string | undefined) {
    try {
      const data = response?.response?.clientDataJSON;
      if (typeof data !== 'string' || data.length > 16_384) return;
      const { challenge } = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
      const meta = challenges.get(challenge);
      challenges.delete(challenge); // Every attempted verification is one-shot, including failures.
      const rp = relyingParty(request);
      if (meta && meta.origin === rp.origin && meta.rpId === rp.rpId && meta.keyIdentityHash === keyIdentityHash) return meta;
    } catch { return; }
  }

  private load() {
    if (!existsSync(this.file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PasskeyStoreFile>;
      if (!Array.isArray(parsed?.credentials)) throw new AuthPersistenceError();
      // Never silently repair an authority store. Dropping a malformed entry
      // or selecting one duplicate could hide a revocation, and the next save
      // would erase the evidence. Keep the bytes intact and require repair.
      const ids = new Set<string>();
      for (const credential of parsed.credentials) {
        if (!isStoredPasskey(credential) || ids.has(credential.id)) throw new AuthPersistenceError();
        ids.add(credential.id);
      }
      return parsed.credentials;
    } catch { throw new AuthPersistenceError(); }
  }

  private save(credentials: StoredPasskey[]) {
    this.persistence.write({ credentials });
  }

  private pruneChallenges() {
    const cutoff = this.now() - CHALLENGE_TTL_MS;
    for (const [challenge, meta] of this.registrationChallenges) {
      if (meta.createdAt <= cutoff) this.registrationChallenges.delete(challenge);
    }
    for (const [challenge, meta] of this.authenticationChallenges) {
      if (meta.createdAt <= cutoff) this.authenticationChallenges.delete(challenge);
    }
  }

  private async createChallenge<T extends { challenge: string }>(
    challenges: Map<string, ChallengeMeta>, metadata: Omit<ChallengeMeta, 'challenge' | 'createdAt'>,
    generate: () => Promise<T>,
  ): Promise<T> {
    // Reserve synchronously, before the generator yields. Pending generation and
    // issued challenges share one budget; existing challenges are never evicted.
    const pending = this.pendingChallenges.get(challenges) ?? 0;
    if (challenges.size + pending >= this.maxChallenges) {
      let retryMs = CHALLENGE_TTL_MS;
      for (const meta of challenges.values()) retryMs = Math.min(retryMs, meta.createdAt + CHALLENGE_TTL_MS - this.now());
      // A pending generator can fail and free its reservation before any expiry.
      if (pending > 0) retryMs = Math.min(retryMs, 1_000);
      throw new PasskeyChallengeCapacityError(Math.max(1, Math.ceil(retryMs / 1_000)));
    }
    this.pendingChallenges.set(challenges, pending + 1);
    try {
      const options = await generate();
      challenges.set(options.challenge, { ...metadata, challenge: options.challenge, createdAt: this.now() });
      return options;
    } finally {
      this.pendingChallenges.set(challenges, this.pendingChallenges.get(challenges)! - 1);
    }
  }
}

export function createDeckSession() {
  return randomBytes(32).toString('base64url');
}

export function sessionCookieHeader(token: string, request: Request) {
  const secure = isSecureRequest(request);
  return [
    `agentopsdeck_session=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=2592000',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearSessionCookieHeader(request: Request) {
  const secure = isSecureRequest(request);
  return [
    'agentopsdeck_session=',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function sessionTokenFromRequest(request: Request) {
  return cookieValue(request, 'agentopsdeck_session');
}

export function sanitizeLabel(label: string | undefined) {
  const trimmed = label?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80);
}

export function storedToWebAuthnCredential(credential: StoredPasskey): WebAuthnCredential {
  return {
    id: credential.id,
    publicKey: base64UrlToUint8(credential.publicKey),
    counter: credential.counter,
    ...(credential.transports?.length ? { transports: credential.transports } : {}),
  };
}

export function relyingParty(request: Request) {
  const origin = request.headers.get('origin') ?? new URL(request.url).origin;
  const host = new URL(origin).hostname;
  return { origin, rpId: host };
}

function isSecureRequest(request: Request) {
  const url = new URL(request.url);
  return url.protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https' || request.headers.get('origin')?.startsWith('https://');
}

function cookieValue(request: Request, name: string) {
  const cookie = request.headers.get('cookie');
  if (!cookie) return undefined;
  for (const part of cookie.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (rawKey === name) {
      try { return decodeURIComponent(rawValue.join('=')); }
      catch { return undefined; }
    }
  }
  return undefined;
}

function uint8ToBase64Url(value: Uint8Array) {
  return Buffer.from(value).toString('base64url');
}

function base64UrlToUint8(value: string) {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

export function isStoredPasskey(value: unknown): value is StoredPasskey {
  if (!value || typeof value !== 'object') return false;
  const credential = value as Partial<StoredPasskey>;
  return typeof credential.id === 'string' && credential.id.length > 0
    && typeof credential.publicKey === 'string' && credential.publicKey.length > 0
    && typeof credential.counter === 'number' && Number.isSafeInteger(credential.counter) && credential.counter >= 0
    && typeof credential.rpId === 'string' && credential.rpId.length > 0;
}
