import { existsSync, readFileSync } from 'node:fs';
import { PasskeyManager, PasskeyVerificationCapacityError, createDeckSession, type PasskeySessionBinding } from './passkeys.js';
import { AuthPersistenceError, PrivateAuthStoreGuard } from './private-store.js';
import { synchronousAuthorization } from './synchronous-authorization.js';
import type { SqliteAuthCommandStore } from './sqlite-owner-domain.js';

const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
type SessionRecord = { token: string; administrator?: true; keyIdentityHash?: string;
  credentialHash?: string; issuedAt?: number; expiresAt?: number };

class OriginalJsonSessionSet extends Set<string> {
  private readonly persistence: PrivateAuthStoreGuard;
  private records = new Map<string, SessionRecord>();
  constructor(file: string, private readonly currentKey: () => string | undefined,
    private readonly credentialCurrent: (binding: PasskeySessionBinding) => boolean,
    private readonly now: () => number) {
    super();
    this.persistence = new PrivateAuthStoreGuard(file);
    try {
      const parsed = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { sessions: [] };
      if (!Array.isArray(parsed?.sessions)) throw new AuthPersistenceError();
      const seen = new Set<string>();
      for (const entry of parsed.sessions) {
        const token = typeof entry === 'string' ? entry : entry?.token;
        if (typeof token !== 'string' || token.length <= 12) continue;
        if (seen.has(token)) { this.records.delete(token); super.delete(token); continue; }
        seen.add(token);
        if (!entry || typeof entry !== 'object') continue;
        if (entry.keyIdentityHash !== undefined && (typeof entry.keyIdentityHash !== 'string' || !/^[a-f0-9]{24}$/.test(entry.keyIdentityHash))) continue;
        const timed = Number.isSafeInteger(entry.issuedAt) && entry.issuedAt >= 0
          && Number.isSafeInteger(entry.expiresAt) && entry.expiresAt > entry.issuedAt
          && entry.expiresAt - entry.issuedAt <= SESSION_LIFETIME_MS;
        if (entry.administrator === true ? !timed || entry.credentialHash !== undefined
          : typeof entry.credentialHash !== 'string' || !/^[a-f0-9]{24}$/.test(entry.credentialHash)
            || ((entry.issuedAt !== undefined || entry.expiresAt !== undefined) && !timed)) continue;
        this.records.set(token, { token, ...(entry.administrator === true ? { administrator: true as const } : { credentialHash: entry.credentialHash }),
          ...(entry.keyIdentityHash === undefined ? {} : { keyIdentityHash: entry.keyIdentityHash }),
          ...(timed ? { issuedAt: entry.issuedAt, expiresAt: entry.expiresAt } : {}) });
        super.add(token);
      }
      this.persistence.check();
    } catch { throw new AuthPersistenceError(); }
  }
  assertCurrent() { this.persistence.check(); }
  override has(token: string) {
    if (!super.has(token) || !this.persistence.current()) return false;
    const record = this.records.get(token);
    if (!record || record.keyIdentityHash !== this.currentKey()) return false;
    if (record.expiresAt !== undefined && (this.now() < record.issuedAt! || this.now() >= record.expiresAt)) return false;
    if (record.administrator === true) return true;
    try { return this.credentialCurrent(record as PasskeySessionBinding) === true; } catch { return false; }
  }
  isAccessKeySession(token: string) { return this.has(token) && this.records.get(token)?.administrator === true; }
  override add(token: string, binding?: PasskeySessionBinding) {
    this.persistence.check();
    if (super.has(token)) return this;
    const issuedAt = this.now();
    const keyIdentityHash = binding ? binding.keyIdentityHash : this.currentKey();
    const record: SessionRecord = { token, ...(binding ? { credentialHash: binding.credentialHash } : { administrator: true }),
      ...(keyIdentityHash === undefined ? {} : { keyIdentityHash }), issuedAt, expiresAt: issuedAt + SESSION_LIFETIME_MS };
    const records = new Map(this.records); records.set(token, record);
    this.persistence.write({ sessions: [...records.values()] });
    this.records = records; super.add(token); return this;
  }
  override delete(token: string) {
    this.persistence.check();
    if (!super.has(token)) return false;
    const records = new Map(this.records); records.delete(token);
    this.persistence.write({ sessions: [...records.values()] });
    this.records = records; return super.delete(token);
  }
  override clear() {
    this.persistence.check();
    this.persistence.write({ sessions: [] }); this.records.clear(); super.clear();
  }
}

/** The ORIGINAL JSON implementations, not an importer or a second format.
 * Used only inside the complete owner worker, instead of the original SQLite
 * Auth connection. Each file retains its revision guard and atomic writer.
 * There is no new cross-file transaction or crash-lock stealing guarantee. */
export class OriginalJsonAuthCommandStore implements SqliteAuthCommandStore {
  readonly originalPasskeys: PasskeyManager;
  readonly sessions: OriginalJsonSessionSet;
  private closed = false;
  private readonly authenticationDeliveries = new Map<string, { expiresAt: number; isCurrent: () => boolean }>();
  private pendingDeliveries = 0;
  private readonly now: () => number;
  private readonly maxAuthenticationDeliveries: number;
  constructor(passkeysFile: string, sessionsFile: string, key?: string,
    options: ConstructorParameters<typeof PasskeyManager>[1] & { maxAuthenticationDeliveries?: number } = {},
    currentKey: () => string | undefined = () => key) {
    this.now = options.now ?? Date.now;
    this.maxAuthenticationDeliveries = options.maxAuthenticationDeliveries ?? 256;
    if (!Number.isSafeInteger(this.maxAuthenticationDeliveries) || this.maxAuthenticationDeliveries < 1 || this.maxAuthenticationDeliveries > 256) {
      throw new Error('maxAuthenticationDeliveries must be an integer between 1 and 256');
    }
    this.originalPasskeys = new PasskeyManager(passkeysFile, options);
    this.sessions = new OriginalJsonSessionSet(sessionsFile, currentKey,
      binding => this.originalPasskeys.isCredentialCurrent(binding.credentialHash, binding.keyIdentityHash), this.now);
    this.assertReady();
  }
  assertReady() {
    if (this.closed) throw new AuthPersistenceError();
    this.originalPasskeys.assertCurrent(); this.sessions.assertCurrent();
  }
  close() { this.closed = true; this.authenticationDeliveries.clear(); }
  invalidateAuthenticationDeliveries() { this.assertReady(); this.authenticationDeliveries.clear(); }
  status(key?: string) { this.assertReady(); return this.originalPasskeys.status(key); }
  list(key?: string) { this.assertReady(); return this.originalPasskeys.list(key); }
  isCredentialCurrent(hash: string, key?: string) { this.assertReady(); return this.originalPasskeys.isCredentialCurrent(hash, key); }
  sessionAuthorized(token: string) { this.assertReady(); return this.sessions.has(token); }
  /** Delivery proof is NOT session liveness. Keep the original verifier's
   * exact credential reference and challenge deadline inside this owner.
   * It cannot be reconstructed from a durable session after owner restart. */
  authenticationCurrent(token: string) {
    this.assertReady();
    const proof = this.authenticationDeliveries.get(token);
    if (!proof) return false;
    if (this.now() >= proof.expiresAt || !proof.isCurrent() || !this.sessions.has(token)) {
      this.authenticationDeliveries.delete(token); return false;
    }
    return true;
  }
  isAccessKeySession(token: string) { this.assertReady(); return this.sessions.isAccessKeySession(token); }
  addAdministratorSession(token: string) {
    this.assertReady(); if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AuthPersistenceError();
    this.sessions.add(token);
  }
  deleteSession(token: string) {
    this.assertReady(); const deleted = this.sessions.delete(token);
    this.authenticationDeliveries.delete(token); return deleted;
  }
  clearSessions(isAuthorized?: () => boolean) {
    this.assertReady(); if (!synchronousAuthorization(isAuthorized)) return false;
    this.sessions.clear(); this.authenticationDeliveries.clear(); return true;
  }
  revoke(...args: Parameters<PasskeyManager['revoke']>) { this.assertReady(); return this.originalPasskeys.revoke(...args); }
  async registrationOptions(...args: Parameters<PasskeyManager['registrationOptions']>) {
    this.assertReady(); const result = await this.originalPasskeys.registrationOptions(...args); this.assertReady(); return result;
  }
  async authenticationOptions(...args: Parameters<PasskeyManager['authenticationOptions']>) {
    this.assertReady(); const result = await this.originalPasskeys.authenticationOptions(...args); this.assertReady(); return result;
  }
  async verifyRegistration(...args: Parameters<PasskeyManager['verifyRegistration']>) {
    this.assertReady(); const result = await this.originalPasskeys.verifyRegistration(...args); this.assertReady(); return result;
  }
  async verifyAuthentication(...args: Parameters<PasskeyManager['verifyAuthentication']>) {
    this.assertReady();
    for (const [token, proof] of this.authenticationDeliveries) {
      if (this.now() >= proof.expiresAt) this.authenticationDeliveries.delete(token);
    }
    // Reserve before consuming a challenge or committing its counter. Never
    // evict a live proof, enqueue a retry or release a hung verification slot.
    if (this.authenticationDeliveries.size + this.pendingDeliveries >= this.maxAuthenticationDeliveries) {
      throw new PasskeyVerificationCapacityError();
    }
    this.pendingDeliveries++;
    try { return await this.verifyAuthenticationWithDelivery(...args); }
    finally { this.pendingDeliveries--; }
  }
  private async verifyAuthenticationWithDelivery(...args: Parameters<PasskeyManager['verifyAuthentication']>) {
    const result = await this.originalPasskeys.verifyAuthentication(...args); this.assertReady();
    if (!result.verified || !result.isCurrent()) return { verified: false as const };
    // Preserve the original JSON route's ordering: persist the verified
    // counter, then persist its bound session, then recheck before delivery.
    // A failed/unknown second write is never replayed or downgraded to a key
    // session; the first write is not falsely reported as rolled back.
    const sessionToken = createDeckSession();
    this.sessions.add(sessionToken, { credentialHash: result.credentialHash,
      ...(result.keyIdentityHash === undefined ? {} : { keyIdentityHash: result.keyIdentityHash }) });
    this.assertReady();
    if (!result.isCurrent() || !this.sessions.has(sessionToken)) throw new AuthPersistenceError();
    this.authenticationDeliveries.set(sessionToken, { expiresAt: result.deliveryExpiresAt, isCurrent: result.isCurrent });
    return { verified: true as const, sessionToken, credentialHash: result.credentialHash,
      keyIdentityHash: result.keyIdentityHash, isCurrent: () => this.authenticationCurrent(sessionToken) };
  }
}
