import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { authSource } from './request-source.js';
import { observedSavepoint } from '../storage/observed-savepoint.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

export type AuthAuditEventType =
  | 'user_access_changed'
  | 'role_changed'
  | 'access_key_login'
  | 'access_key_logout'
  | 'member_key_issued'
  | 'member_key_revoked'
  | 'api_authz'
  | 'passkey_bind'
  | 'passkey_revoke'
  | 'passkey_assertion';

export type AuthAuditOutcome = 'success' | 'failure' | 'throttled';

export type AuthAuditRecord = {
  id: string;
  ts: number;
  event: AuthAuditEventType;
  outcome: AuthAuditOutcome;
  keyIdentityHash?: string | undefined;
  ipHash?: string | undefined;
  userAgentHash?: string | undefined;
  reason?: string | undefined;
  failureCount?: number | undefined;
  retryAfterSeconds?: number | undefined;
  passkeyCredentialHash?: string | undefined;
  userId?: string | undefined;
  keyId?: string | undefined;
  actorUserId?: string | undefined;
  authMethod?: 'member' | 'administrator' | undefined;
};

export type AuthRequestFingerprint = {
  ipHash: string;
  userAgentHash: string;
};

export type LoginAttemptLimiterOptions = {
  maxFailures: number;
  windowMs: number;
  lockoutMs: number;
  /** Process-local cardinality bound. Full maps share one overflow bucket. */
  maxBuckets?: number;
  now?: () => number;
};

export type LoginAttemptDecision = {
  allowed: boolean;
  failureCount: number;
  retryAfterSeconds?: number;
};

type AttemptBucket = {
  failures: number[];
  lockedUntil: number | undefined;
  expiresAt: number;
};

export type BoundPasskey = {
  id: string;
  keyIdentityHash: string;
  credentialIdHash: string;
  label?: string;
  transports: string[];
  createdAt: number;
  lastUsedAt?: number;
  revokedAt?: number;
};

export type BindPasskeyInput = {
  keyIdentityHash: string;
  credentialId: string;
  label?: string;
  transports?: string[];
  now?: number;
};

export class AuthAuditLog {
  #records: AuthAuditRecord[] = [];

  constructor(private readonly limit = 1000, private readonly db?: DatabaseSync,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {
    db?.exec(`CREATE TABLE IF NOT EXISTS hub_auth_audit (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id TEXT, record TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS hub_auth_audit_user ON hub_auth_audit(user_id, sequence);
    CREATE TABLE IF NOT EXISTS hub_auth_audit_metadata (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), started_at INTEGER NOT NULL);`);
    this.atomic('auth-audit-initialize', () => {
      db?.prepare('INSERT OR IGNORE INTO hub_auth_audit_metadata VALUES (1, ?)').run(Date.now());
      this.prune();
    });
  }

  /** Retention is a mutation, including page/list. Use the ORIGINAL Hub
   * connection and preserve its enclosing identity transaction when nested.
   * A savepoint release is not proof of that parent's durable commit. No
   * replay, callback serialization, new writer or asynchronous SQL claim. */
  private atomic<T>(operation: 'auth-audit-initialize' | 'auth-audit-append' | 'auth-audit-page' | 'auth-audit-list',
    work: () => T extends PromiseLike<unknown> ? never : T): T {
    return this.db ? observedSavepoint(this.db, operation, work, this.diagnostics) : work();
  }

  private prune() {
    this.db?.prepare('DELETE FROM hub_auth_audit WHERE ts < ? OR sequence IN (SELECT sequence FROM hub_auth_audit ORDER BY sequence DESC LIMIT -1 OFFSET ?)')
      .run(Date.now() - 90 * 24 * 60 * 60 * 1000, this.limit);
  }

  page(options: { limit?: number; userId?: string | undefined; before?: number | undefined } = {}) {
    return this.atomic('auth-audit-page', () => {
      const limit = Math.max(1, Math.min(100, Math.floor(options.limit || 50)));
      this.prune();
      const rows = this.db?.prepare(`SELECT sequence, record FROM hub_auth_audit
        WHERE (? IS NULL OR user_id = ?) AND (? IS NULL OR sequence < ?) ORDER BY sequence DESC LIMIT ?`)
        .all(options.userId ?? null, options.userId ?? null, options.before ?? null, options.before ?? null, limit + 1) as Array<{ sequence: number; record: string }> | undefined;
      const records = rows ? rows.slice(0, limit).map(row => JSON.parse(row.record) as AuthAuditRecord)
        : this.#records.filter(record => !options.userId || record.userId === options.userId).slice(-limit).reverse();
      const metadata = this.db?.prepare('SELECT started_at FROM hub_auth_audit_metadata WHERE singleton = 1').get() as { started_at: number } | undefined;
      return { records, nextCursor: rows && rows.length > limit ? String(rows[limit - 1]!.sequence) : undefined,
        retentionDays: this.db ? 90 : undefined, maxRecords: this.limit, persistent: Boolean(this.db), startedAt: metadata?.started_at };
    });
  }

  append(record: Omit<AuthAuditRecord, 'id' | 'ts'> & { ts?: number }) {
    const next: AuthAuditRecord = {
      id: randomUUID(),
      ts: record.ts ?? Date.now(),
      event: record.event,
      outcome: record.outcome,
    };
    if (record.keyIdentityHash) next.keyIdentityHash = record.keyIdentityHash;
    if (record.ipHash) next.ipHash = record.ipHash;
    if (record.userAgentHash) next.userAgentHash = record.userAgentHash;
    if (record.reason) next.reason = sanitizeReason(record.reason);
    if (record.failureCount !== undefined) next.failureCount = record.failureCount;
    if (record.retryAfterSeconds !== undefined) next.retryAfterSeconds = record.retryAfterSeconds;
    if (record.passkeyCredentialHash) next.passkeyCredentialHash = record.passkeyCredentialHash;
    if (record.userId) next.userId = record.userId;
    if (record.keyId) next.keyId = record.keyId;
    if (record.actorUserId) next.actorUserId = record.actorUserId;
    if (record.authMethod) next.authMethod = record.authMethod;
    if (this.db) {
      return this.atomic('auth-audit-append', () => {
        this.db!.prepare('INSERT INTO hub_auth_audit (ts, user_id, record) VALUES (?, ?, ?)').run(next.ts, next.userId ?? null, JSON.stringify(next));
        this.prune();
        return next;
      });
    }
    this.#records.push(next);
    if (this.#records.length > this.limit) this.#records.splice(0, this.#records.length - this.limit);
    return next;
  }

  list(limit = 100) {
    const count = Math.max(0, Math.min(this.limit, Number.isFinite(limit) ? Math.floor(limit) : 100));
    if (count === 0) return [];
    return this.atomic('auth-audit-list', () => {
      this.prune();
      if (this.db) return (this.db.prepare('SELECT record FROM hub_auth_audit ORDER BY sequence DESC LIMIT ?').all(count) as Array<{ record: string }>)
        .reverse().map(row => JSON.parse(row.record) as AuthAuditRecord);
      return this.#records.slice(-count);
    });
  }
}

export class LoginAttemptLimiter {
  #buckets = new Map<string, AttemptBucket>();
  #overflow: AttemptBucket = { failures: [], lockedUntil: undefined, expiresAt: 0 };
  #sweepCursor: MapIterator<[string, AttemptBucket]> | undefined;
  readonly #maxBuckets: number;
  readonly #now: () => number;
  protected readonly options: Readonly<LoginAttemptLimiterOptions>;

  constructor(options: LoginAttemptLimiterOptions) {
    // The running policy belongs to this instance. Borrowing a mutable config
    // would change enforcement after validation and, for persistent subclasses,
    // without changing the original SQL policy identity. Read each field once;
    // freeze only our detached primitive/function snapshot, never caller input.
    this.options = Object.freeze({ maxFailures: options.maxFailures, windowMs: options.windowMs,
      lockoutMs: options.lockoutMs, maxBuckets: options.maxBuckets ?? 10_000, now: options.now ?? Date.now });
    this.#maxBuckets = this.options.maxBuckets!;
    for (const [name, value] of Object.entries({ maxBuckets: this.#maxBuckets, maxFailures: this.options.maxFailures,
      windowMs: this.options.windowMs, lockoutMs: this.options.lockoutMs })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
    }
    this.#now = this.options.now!;
  }

  check(subject: string): LoginAttemptDecision {
    const now = this.#now();
    this.#sweep(now);
    // Merely checking a new identity must not allocate persistent state.
    return this.#decision(this.#existing(subject, now) ?? this.#overflow, now);
  }

  #decision(bucket: AttemptBucket, now: number): LoginAttemptDecision {
    this.#prune(bucket, now);
    if (bucket.lockedUntil !== undefined && bucket.lockedUntil > now) {
      return {
        allowed: false,
        failureCount: bucket.failures.length,
        retryAfterSeconds: secondsUntil(bucket.lockedUntil, now),
      };
    }
    return { allowed: true, failureCount: bucket.failures.length };
  }

  recordFailure(subject: string): LoginAttemptDecision {
    const now = this.#now();
    this.#sweep(now);
    this.#prune(this.#overflow, now);
    let bucket = this.#existing(subject, now);
    if (!bucket) {
      // Do not evict active bans. Shared overflow evidence survives freed slots
      // and unrelated successful logins, otherwise identity churn can reset it.
      if (this.#buckets.size >= this.#maxBuckets || this.#overflow.failures.length || this.#overflow.lockedUntil !== undefined) {
        bucket = this.#overflow;
      } else {
        bucket = { failures: [], lockedUntil: undefined, expiresAt: 0 };
        this.#buckets.set(subject, bucket);
      }
    }
    const current = this.#decision(bucket, now);
    // In-flight requests admitted before a ban must not extend it indefinitely
    // or grow the timestamp array beyond the configured threshold.
    if (!current.allowed) return current;
    bucket.failures.push(now);
    if (bucket.failures.length > this.options.maxFailures) bucket.failures.splice(0, bucket.failures.length - this.options.maxFailures);
    if (bucket.failures.length >= this.options.maxFailures) {
      bucket.lockedUntil = now + this.options.lockoutMs;
    }
    // Preserve the existing inclusive window boundary (ts >= now - windowMs).
    bucket.expiresAt = Math.max(bucket.expiresAt, now + this.options.windowMs + 1, bucket.lockedUntil ?? 0);
    return this.#decision(bucket, now);
  }

  recordSuccess(subject: string) {
    this.#buckets.delete(subject);
  }

  #existing(subject: string, now: number) {
    const bucket = this.#buckets.get(subject);
    if (bucket && bucket.expiresAt <= now) {
      this.#buckets.delete(subject);
      return undefined;
    }
    return bucket;
  }

  #sweep(now: number) {
    // Incremental and request-driven: no timer, no full-map scan at saturation.
    this.#sweepCursor ??= this.#buckets.entries();
    for (let count = 0; count < 32; count++) {
      const entry = this.#sweepCursor.next();
      if (entry.done) { this.#sweepCursor = undefined; break; }
      const [subject, bucket] = entry.value;
      if (bucket.expiresAt <= now) this.#buckets.delete(subject);
    }
  }

  #prune(bucket: AttemptBucket, now: number) {
    const min = now - this.options.windowMs;
    bucket.failures = bucket.failures.filter((ts) => ts >= min);
    if (bucket.lockedUntil !== undefined && bucket.lockedUntil <= now) bucket.lockedUntil = undefined;
  }
}

export class PasskeyCredentialStore {
  #passkeys = new Map<string, BoundPasskey>();

  bind(input: BindPasskeyInput) {
    const now = input.now ?? Date.now();
    const credentialIdHash = sensitiveHash(input.credentialId);
    for (const existing of this.#passkeys.values()) {
      if (existing.keyIdentityHash !== input.keyIdentityHash) continue;
      if (existing.credentialIdHash !== credentialIdHash) continue;
      if (existing.revokedAt !== undefined) continue;
      throw new Error('passkey already bound for key identity');
    }
    const passkey: BoundPasskey = {
      id: randomUUID(),
      keyIdentityHash: input.keyIdentityHash,
      credentialIdHash,
      transports: normalizeTransports(input.transports),
      createdAt: now,
    };
    if (input.label) passkey.label = sanitizeLabel(input.label);
    this.#passkeys.set(passkey.id, passkey);
    return passkey;
  }

  list(keyIdentityHash: string) {
    return [...this.#passkeys.values()]
      .filter((passkey) => passkey.keyIdentityHash === keyIdentityHash && passkey.revokedAt === undefined)
      .map((passkey) => ({ ...passkey }));
  }

  revoke(keyIdentityHash: string, passkeyId: string, now = Date.now()) {
    const passkey = this.#passkeys.get(passkeyId);
    if (!passkey || passkey.keyIdentityHash !== keyIdentityHash || passkey.revokedAt !== undefined) return false;
    passkey.revokedAt = now;
    return true;
  }

  markUsed(keyIdentityHash: string, credentialId: string, now = Date.now()) {
    const credentialIdHash = sensitiveHash(credentialId);
    for (const passkey of this.#passkeys.values()) {
      if (passkey.keyIdentityHash !== keyIdentityHash) continue;
      if (passkey.credentialIdHash !== credentialIdHash) continue;
      if (passkey.revokedAt !== undefined) return undefined;
      passkey.lastUsedAt = now;
      return { ...passkey };
    }
    return undefined;
  }
}

export function fingerprintRequest(request: Request): AuthRequestFingerprint {
  return {
    ipHash: sensitiveHash(authSource(request) ?? 'unknown-ip'),
    userAgentHash: sensitiveHash(request.headers.get('user-agent') ?? 'unknown-ua'),
  };
}

export function loginLimiterSubject(fingerprint: AuthRequestFingerprint) {
  // User-Agent is useful audit context, not an identity: changing it must not
  // reset a ban or allocate another limiter bucket.
  return fingerprint.ipHash;
}

export function keyIdentityHash(accessKey: string) {
  return sensitiveHash(accessKey);
}

export function credentialHashForAudit(credentialId: string) {
  return sensitiveHash(credentialId);
}

function sensitiveHash(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function secondsUntil(until: number, now: number) {
  return Math.max(1, Math.ceil((until - now) / 1000));
}

function sanitizeReason(reason: string) {
  return reason.replace(/[^a-z0-9_.:-]/gi, '_').slice(0, 64);
}

function sanitizeLabel(label: string) {
  return label.trim().slice(0, 80);
}

function normalizeTransports(transports: string[] | undefined) {
  return [...new Set((transports ?? [])
    .map((transport) => transport.trim().toLowerCase())
    .filter((transport) => /^[a-z0-9_-]{1,32}$/.test(transport)))];
}
