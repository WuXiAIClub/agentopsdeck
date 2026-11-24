import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON } from '@simplewebauthn/server';
import { createDeckSession, relyingParty, storedToWebAuthnCredential, sanitizeLabel, isStoredPasskey,
  PasskeyChallengeCapacityError, PasskeyVerificationCapacityError, PasskeyVerificationRateError, PasskeyUnavailableError, PasskeyVerificationRejectedError,
  type StoredPasskey, type RegistrationMetadata, type PasskeySessionBinding } from './passkeys.js';
import { credentialHashForAudit } from './security.js';
import { AuthPersistenceError } from './private-store.js';
import { synchronousAuthorization } from './synchronous-authorization.js';
import { observedTransaction } from '../storage/observed-transaction.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { addSqlFailure } from '../storage/sql-failure-diagnostics.js';
import { synchronousSqliteIdentity, synchronousSqliteValue } from './synchronous-sqlite-value.js';
import { initializeSqliteAuthSchema } from './sqlite-schema.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const TTL = 300_000, SESSION_TTL = 30 * 86400_000;
type Challenge = { challenge: string; rpId: string; origin: string; keyIdentityHash?: string | undefined; at: number; claim: string };
type Credential = { value: StoredPasskey; version: number };

// SQLite TEXT extraction can truncate NUL or replace invalid UTF-8. Inspect the
// original SQL type and complete bytes, not String(row) or a repaired prefix.
// Legacy credential fields have no established byte cap; do not silently
// narrow their existing import contract here. Session bindings are emitted
// only by insertSession and contain at most two 24-character identities.
const textColumn = (column: string, maximum?: number) =>
  `CASE WHEN typeof(${column})='text'${maximum === undefined ? '' : ` AND length(CAST(${column} AS BLOB))<=${maximum}`} THEN CAST(${column} AS BLOB) ELSE NULL END`;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function storedText(bytes: unknown): string {
  if (!(bytes instanceof Uint8Array)) throw new AuthPersistenceError();
  try { return decoder.decode(bytes); } catch { throw new AuthPersistenceError(); }
}

/** Shared strict decoder for original-owner authority and read-only display
 * queries. No schema writes, record repair, session lookup or authorization. */
export function readStoredSqliteCredentials(db: DatabaseSync): Credential[] {
  const rows = db.prepare(`SELECT ${textColumn('id')} id, ${textColumn('payload')} payload,
    version, typeof(version) version_type FROM shared_auth_credentials ORDER BY id LIMIT 1025`).all();
  if (rows.length > 1024) throw new AuthPersistenceError();
  return rows.map(row => {
    const value: unknown = JSON.parse(storedText(row.payload)), version = row.version;
    if (!isStoredPasskey(value) || value.id !== storedText(row.id) || row.version_type !== 'integer'
      || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) throw new AuthPersistenceError();
    return { value, version };
  });
}

/** One authoritative local SQLite database, shared by same-host Hub processes.
 * Crypto is still SimpleWebAuthn's real verification. No browser verified flag,
 * plaintext session token, JSON dual-write, network SQLite or runtime migration.
 * Claims are one-shot even on failure/crash; final counter/session/audit writes
 * and challenge consumption commit together. */
export class SqlitePasskeys {
  readonly sessions: SqliteAuthSessions;
  constructor(readonly db: DatabaseSync, private readonly currentKey: () => string | undefined, private readonly now = Date.now,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {
    initializeSqliteAuthSchema(db, diagnostics);
    this.sessions = new SqliteAuthSessions(this);
  }
  private time() {
    const value = synchronousSqliteValue(this.db, this.now, this);
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new AuthPersistenceError();
    return value;
  }
  private readCurrentKey(): string | undefined {
    return synchronousSqliteIdentity(this.db, this.currentKey, this);
  }
  private readFailed(step: 1 | 2 | 3, error: unknown) {
    // Failure-only, rate-limited numeric evidence. No identities, SQL, tokens,
    // exception text or damaged bytes; logging cannot change authorization.
    try {
      const trace = this.diagnostics.start('auth-passkey-read');
      trace.add('step', step); addSqlFailure(trace, error); trace.finish(true);
    } catch { /* Observation is never an authorization grant. */ }
  }
  private atomic<T>(fn: (checkParticipant: (value: unknown) => void) => T extends PromiseLike<unknown> ? never : T): T {
    try { return observedTransaction<T>(this.db, 'auth-passkey-change', (_commit, checkParticipant) => fn(checkParticipant), this.diagnostics); }
    catch (e) {
      if (e instanceof PasskeyChallengeCapacityError || e instanceof PasskeyVerificationCapacityError
        || e instanceof PasskeyVerificationRateError) throw e;
      throw new AuthPersistenceError();
    }
  }
  private audit(kind: string, id: string) {
    this.limit('shared_auth_audit', 100_000);
    this.db.prepare('INSERT INTO shared_auth_audit(kind,identity,at) VALUES(?,?,?)').run(kind, credentialHashForAudit(id), this.time());
  }
  private limit(table: 'shared_auth_credentials' | 'shared_auth_sessions' | 'shared_auth_audit', maximum: number) {
    if (Number(this.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n) >= maximum) throw new AuthPersistenceError();
  }
  private all(): Credential[] {
    try { return readStoredSqliteCredentials(this.db); }
    catch (error) { this.readFailed(1, error); throw new AuthPersistenceError(); }
  }
  private active(key?: string) { return this.all().filter(c => c.value.revokedAt === undefined && (!key || c.value.keyIdentityHash === key)); }
  status(key?: string) { const count = this.active(key).length; return { available: count > 0, count }; }
  list(key?: string) { return this.active(key).map(({ value: c }) => ({ id: credentialHashForAudit(c.id), label: c.label,
    transports: c.transports ?? [], createdAt: c.createdAt, ...(c.lastUsedAt === undefined ? {} : { lastUsedAt: c.lastUsedAt }) })); }
  isCredentialCurrent(id: string, key?: string) { return this.active(key).some(c => credentialHashForAudit(c.value.id) === id); }
  /** Explicit trusted offline import only. Existing JSON sessions are NEVER
   * copied; the operator must authorize invalidating them. Tombstones retained. */
  importLegacy(credentials: unknown, invalidateLegacySessions: boolean) {
    if (!invalidateLegacySessions || !Array.isArray(credentials) || credentials.length > 1024
      || credentials.some(c => !isStoredPasskey(c)) || new Set(credentials.map(c => c.id)).size !== credentials.length) throw new AuthPersistenceError();
    this.atomic(() => {
      if (this.all().length || this.db.prepare('SELECT 1 FROM shared_auth_sessions LIMIT 1').get()
        || this.db.prepare('SELECT 1 FROM shared_auth_audit LIMIT 1').get()) throw new AuthPersistenceError();
      for (const c of credentials) this.db.prepare('INSERT INTO shared_auth_credentials VALUES(?,?,0)').run(c.id, JSON.stringify(c));
      this.audit('legacy-import-sessions-invalidated', 'migration');
    });
  }
  revoke(key: string | undefined, id: string, at = this.time(), isAuthorized?: () => boolean) {
    return this.atomic(checkParticipant => {
      if (!synchronousAuthorization(isAuthorized, checkParticipant)) return false;
      const found = this.active(key).find(c => credentialHashForAudit(c.value.id) === id); if (!found) return false;
      const value = { ...found.value, revokedAt: at };
      this.db.prepare('UPDATE shared_auth_credentials SET payload=?,version=version+1 WHERE id=?').run(JSON.stringify(value), value.id);
      this.db.prepare("DELETE FROM shared_auth_sessions WHERE json_extract(binding,'$.credentialHash')=?").run(id);
      this.audit('revoked', value.id); return true;
    });
  }
  private create(kind: string, request: Request, key?: string): Challenge {
    return this.atomic(() => {
      const at = this.time(); this.db.prepare('DELETE FROM shared_auth_challenges WHERE expires<=?').run(at);
      const n = Number(this.db.prepare('SELECT count(*) n FROM shared_auth_challenges WHERE kind=?').get(kind)!.n);
      if (n >= 256) throw new PasskeyChallengeCapacityError(1);
      const meta: Challenge = { ...relyingParty(request), keyIdentityHash: key, challenge: createDeckSession(), at, claim: randomUUID() };
      this.db.prepare('INSERT INTO shared_auth_challenges VALUES(?,?,?,?,NULL)').run(hash(meta.challenge), kind, JSON.stringify(meta), at + TTL);
      return meta;
    });
  }
  private take(kind: string, request: Request, response: { response: { clientDataJSON: string } }, key?: string): Challenge | undefined {
    let challenge: unknown;
    try { const raw = response?.response?.clientDataJSON; if (typeof raw !== 'string' || raw.length > 16384) return;
      challenge = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')).challenge; } catch { return; }
    if (typeof challenge !== 'string' || challenge.length > 128) return;
    return this.atomic(() => {
      const at = this.time(), row = this.db.prepare(`SELECT ${textColumn('payload')} payload, expires,
        typeof(expires) expires_type, claim FROM shared_auth_challenges WHERE digest=? AND kind=?`).get(hash(challenge as string), kind);
      if (!row || row.claim) return;
      let meta: Challenge;
      try {
        const value: unknown = JSON.parse(storedText(row.payload));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AuthPersistenceError();
        const candidate = value as Partial<Challenge>;
        if (candidate.challenge !== challenge || typeof candidate.rpId !== 'string' || !candidate.rpId
          || typeof candidate.origin !== 'string' || !candidate.origin
          || (candidate.keyIdentityHash !== undefined && typeof candidate.keyIdentityHash !== 'string')
          || typeof candidate.at !== 'number' || !Number.isSafeInteger(candidate.at) || candidate.at < 0
          || !Number.isSafeInteger(candidate.at + TTL) || row.expires_type !== 'integer' || row.expires !== candidate.at + TTL
          || typeof candidate.claim !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(candidate.claim))
          throw new AuthPersistenceError();
        meta = candidate as Challenge;
      } catch (error) { this.readFailed(2, error); throw new AuthPersistenceError(); }
      if (row.expires <= at) return;
      const limits = this.db.prepare('SELECT * FROM shared_auth_limits WHERE id=1').get();
      if (limits && at < Number(limits.observed)) throw new AuthPersistenceError();
      const fresh = !limits || at - Number(limits.window) >= 60_000;
      if (!fresh && Number(limits.count) >= 120) throw new PasskeyVerificationRateError(1);
      if (Number(this.db.prepare('SELECT count(*) n FROM shared_auth_challenges WHERE claim IS NOT NULL AND expires>?').get(at)!.n) >= 8) throw new PasskeyVerificationCapacityError();
      this.db.prepare('INSERT INTO shared_auth_limits VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET window=excluded.window,count=excluded.count,observed=excluded.observed')
        .run(fresh ? at : limits!.window!, fresh ? 1 : Number(limits!.count) + 1, at);
      this.db.prepare('UPDATE shared_auth_challenges SET claim=? WHERE digest=? AND claim IS NULL').run(meta.claim, hash(meta.challenge));
      const rp = relyingParty(request);
      if (meta.rpId !== rp.rpId || meta.origin !== rp.origin || meta.keyIdentityHash !== key || at < meta.at) {
        this.db.prepare('DELETE FROM shared_auth_challenges WHERE digest=?').run(hash(meta.challenge)); return;
      }
      return meta;
    });
  }
  private current(meta: Challenge) {
    const at = this.time(); return meta.keyIdentityHash === this.readCurrentKey() && at >= meta.at && at < meta.at + TTL
      && !!this.db.prepare('SELECT 1 FROM shared_auth_challenges WHERE digest=? AND claim=?').get(hash(meta.challenge), meta.claim);
  }
  private consume(meta: Challenge) { this.db.prepare('DELETE FROM shared_auth_challenges WHERE digest=? AND claim=?').run(hash(meta.challenge), meta.claim); }
  private burn(meta: Challenge) {
    // A failed final transaction may leave its durable claim behind. It cannot
    // be reused; cleanup is optional and must not hide the original failure.
    try { this.consume(meta); } catch { /* Claimed attempts expire, never replay. */ }
  }
  async registrationOptions(request: Request, key?: string) {
    const meta = this.create('registration', request, key);
    try { return await generateRegistrationOptions({ rpName: 'AgentOpsDeck', rpID: meta.rpId, challenge: new Uint8Array(Buffer.from(meta.challenge, 'base64url')),
      userName: 'agentopsdeck-operator', userDisplayName: 'AgentOpsDeck operator', userID: new TextEncoder().encode('agentopsdeck-operator'), attestationType: 'none',
      excludeCredentials: this.active(key).filter(c => c.value.rpId === meta.rpId).map(c => ({ id: c.value.id, transports: c.value.transports ?? [] })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' } });
    } catch (e) { this.db.prepare('DELETE FROM shared_auth_challenges WHERE digest=? AND claim IS NULL').run(hash(meta.challenge)); throw e; }
  }
  async verifyRegistration(request: Request, response: RegistrationResponseJSON, metadata: RegistrationMetadata = {}) {
    const meta = this.take('registration', request, response, metadata.keyIdentityHash); if (!meta) return { verified: false as const };
    try {
      const proof = await verifyRegistrationResponse({ response, expectedChallenge: meta.challenge, expectedOrigin: meta.origin, expectedRPID: meta.rpId, requireUserVerification: true })
        .catch(() => { throw new PasskeyVerificationRejectedError(); });
      if (!proof.verified || !proof.registrationInfo) return { verified: false as const };
      const c = proof.registrationInfo.credential;
      return this.atomic(checkParticipant => {
        if (!this.current(meta) || !synchronousAuthorization(metadata.isAuthorized, checkParticipant) || this.all().some(v => v.value.id === c.id)) return { verified: false as const };
        this.limit('shared_auth_credentials', 1024);
        const value: StoredPasskey = { id: c.id, publicKey: Buffer.from(c.publicKey).toString('base64url'), counter: c.counter,
          rpId: meta.rpId, transports: response.response.transports ?? [], createdAt: this.time(), label: sanitizeLabel(metadata.label) ?? 'Passkey',
          ...(meta.keyIdentityHash ? { keyIdentityHash: meta.keyIdentityHash } : {}) };
        if (!isStoredPasskey(value)) throw new AuthPersistenceError();
        this.db.prepare('INSERT INTO shared_auth_credentials VALUES(?,?,0)').run(value.id, JSON.stringify(value));
        this.consume(meta); this.audit('registered', value.id);
        return { verified: true as const, count: this.status(metadata.keyIdentityHash).count, credentialHash: credentialHashForAudit(value.id) };
      });
    } finally { this.burn(meta); }
  }
  async authenticationOptions(request: Request, key?: string) {
    const rp = relyingParty(request), credentials = this.active(key).filter(c => c.value.rpId === rp.rpId);
    if (!credentials.length) throw new PasskeyUnavailableError();
    const meta = this.create('authentication', request, key);
    try { return await generateAuthenticationOptions({ rpID: rp.rpId, challenge: new Uint8Array(Buffer.from(meta.challenge, 'base64url')), userVerification: 'required',
      allowCredentials: credentials.map(c => ({ id: c.value.id, transports: c.value.transports ?? [] })) });
    } catch (e) { this.db.prepare('DELETE FROM shared_auth_challenges WHERE digest=? AND claim IS NULL').run(hash(meta.challenge)); throw e; }
  }
  async verifyAuthentication(request: Request, response: AuthenticationResponseJSON, key?: string) {
    const meta = this.take('authentication', request, response, key); if (!meta) return { verified: false as const };
    try {
      const captured = this.active(key).find(c => c.value.id === response.id && c.value.rpId === meta.rpId);
      if (!captured) return { verified: false as const };
      const proof = await verifyAuthenticationResponse({ response, expectedChallenge: meta.challenge, expectedOrigin: meta.origin,
        expectedRPID: meta.rpId, credential: storedToWebAuthnCredential(captured.value), requireUserVerification: true })
        .catch(() => { throw new PasskeyVerificationRejectedError(); });
      if (!proof.verified) return { verified: false as const };
      return this.atomic(() => {
        const current = this.active(key).find(c => c.value.id === response.id), counter = proof.authenticationInfo.newCounter;
        if (!this.current(meta) || !current || current.version !== captured.version
          || (current.value.counter > 0 || counter > 0) && counter <= current.value.counter) return { verified: false as const };
        const credentialHash = credentialHashForAudit(current.value.id), sessionToken = createDeckSession();
        this.db.prepare('UPDATE shared_auth_credentials SET payload=?,version=version+1 WHERE id=?')
          .run(JSON.stringify({ ...current.value, counter, lastUsedAt: this.time() }), current.value.id);
        this.insertSession(sessionToken, { credentialHash, ...(key ? { keyIdentityHash: key } : {}) });
        this.consume(meta); this.audit('issued', current.value.id);
        return { verified: true as const, credentialHash, keyIdentityHash: key, sessionToken,
          isCurrent: () => this.sessionAuthorized(sessionToken) };
      });
    } finally { this.burn(meta); }
  }
  private insertSession(token: string, binding: PasskeySessionBinding | { keyIdentityHash?: string }) {
    const at = this.time(); this.db.prepare('DELETE FROM shared_auth_sessions WHERE expires<=?').run(at);
    this.limit('shared_auth_sessions', 10000);
    this.db.prepare('INSERT INTO shared_auth_sessions VALUES(?,?,?)').run(hash(token), JSON.stringify(binding), at + SESSION_TTL);
  }
  addAdministratorSession(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AuthPersistenceError();
    this.atomic(() => {
      const key = this.readCurrentKey();
      this.insertSession(token, key === undefined ? {} : { keyIdentityHash: key });
      this.audit('administrator-issued', hash(token));
      // Session and audit must bind to one identity even if a synchronous
      // participant changes the configured key before original-owner commit.
      if (this.readCurrentKey() !== key) throw new AuthPersistenceError();
    });
  }
  private authorizedBinding(token: string): Partial<PasskeySessionBinding> | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    try {
      const at = this.time(), row = this.db.prepare(`SELECT ${textColumn('binding', 512)} binding, expires,
        typeof(expires) expires_type FROM shared_auth_sessions WHERE digest=?`).get(hash(token));
      if (!row) return null;
      if (row.expires_type !== 'integer' || !Number.isSafeInteger(row.expires)) throw new AuthPersistenceError();
      if (Number(row.expires) <= at || Number(row.expires) > at + SESSION_TTL) return null;
      const b = JSON.parse(storedText(row.binding)) as Partial<PasskeySessionBinding>;
      if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some(k => !['keyIdentityHash', 'credentialHash'].includes(k))) throw new AuthPersistenceError();
      for (const k of ['credentialHash', 'keyIdentityHash'] as const) {
        if (Object.hasOwn(b, k) && (typeof b[k] !== 'string' || !/^[a-f0-9]{24}$/.test(b[k]!))) throw new AuthPersistenceError();
      }
      return b.keyIdentityHash === this.readCurrentKey() && (b.credentialHash === undefined || this.isCredentialCurrent(b.credentialHash, b.keyIdentityHash)) ? b : null;
    } catch (error) { this.readFailed(3, error); return null; }
  }
  sessionAuthorized(token: string) { return this.authorizedBinding(token) !== null; }
  isAccessKeySession(token: string) {
    const binding = this.authorizedBinding(token);
    return binding !== null && binding.credentialHash === undefined;
  }
  deleteSession(token: string) { return this.atomic(() => this.db.prepare('DELETE FROM shared_auth_sessions WHERE digest=?').run(hash(token)).changes > 0); }
  clearSessions(isAuthorized?: () => boolean) {
    return this.atomic(checkParticipant => {
      if (!synchronousAuthorization(isAuthorized, checkParticipant)) return false;
      this.db.exec('DELETE FROM shared_auth_sessions'); this.audit('sessions-cleared', 'all'); return true;
    });
  }
}

/** Set-compatible authorization boundary; token enumeration is deliberately empty
 * because only one-way digests are persisted. Membership always reads SQLite. */
class SqliteAuthSessions extends Set<string> {
  constructor(private readonly owner: SqlitePasskeys) { super(); }
  override has(token: string) { return this.owner.sessionAuthorized(token); }
  isAccessKeySession(token: string) { return this.owner.isAccessKeySession(token); }
  override add(token: string, binding?: PasskeySessionBinding): this {
    if (binding) throw new AuthPersistenceError(); // Passkey issuance MUST be atomic above.
    this.owner.addAdministratorSession(token); return this;
  }
  override delete(token: string) { return this.owner.deleteSession(token); }
  override clear() { this.owner.clearSessions(); }
}
