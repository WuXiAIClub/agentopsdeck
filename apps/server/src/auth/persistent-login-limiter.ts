import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { observedTransaction } from '../storage/observed-transaction.js';
import { requireConnectionReady } from '../storage/connection-recovery.js';
import { LoginAttemptLimiter, type LoginAttemptDecision, type LoginAttemptLimiterOptions } from './security.js';

type Bucket = { failures: number[]; lockedUntil: number | undefined; expiresAt: number };
type Row = { failures: string; locked_until: number | null; expires_at: number };

/** Uses the existing Hub database owner. No new connection, timer or plaintext
 * source identifiers. BEGIN IMMEDIATE serializes updates across local owners of
 * this database; it does not coordinate separate databases or remote nodes. */
export class PersistentLoginAttemptLimiter extends LoginAttemptLimiter {
  readonly #policy: string;
  readonly #limit: number;
  readonly #clock: () => number;

  constructor(private readonly db: DatabaseSync, policy: LoginAttemptLimiterOptions) {
    super(policy);
    // Use the base owner's captured policy for identity AND enforcement. A
    // caller config mutation is not a permitted persistent policy migration.
    this.#limit = this.options.maxBuckets!;
    this.#clock = this.options.now!;
    this.#policy = JSON.stringify([this.options.maxFailures, this.options.windowMs, this.options.lockoutMs, this.#limit]);
    db.exec(`CREATE TABLE IF NOT EXISTS hub_login_limit_policy (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), policy TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS hub_login_limit_buckets (subject TEXT PRIMARY KEY, failures TEXT NOT NULL,
        locked_until INTEGER, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS hub_login_limit_expiry ON hub_login_limit_buckets(expires_at);`);
    this.#transaction(() => {
      const existing = this.#storedPolicy();
      if (existing && existing !== this.#policy) {
        const active = db.prepare('SELECT 1 FROM hub_login_limit_buckets WHERE expires_at > ? LIMIT 1').get(this.#clock());
        // Do not silently discard live bans on a config change or allow two
        // processes with different policies to reinterpret the same evidence.
        if (active) throw Error('auth_limiter_policy_conflict');
        db.exec('DELETE FROM hub_login_limit_buckets');
      }
      db.prepare('INSERT INTO hub_login_limit_policy VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET policy=excluded.policy').run(this.#policy);
    });
  }

  override check(subject: string): LoginAttemptDecision {
    // One read snapshot includes policy + subject + overflow. It neither writes
    // nor allocates a bucket for a successful or speculative login.
    return this.#transaction(() => {
      this.#assertPolicy();
      const now = this.#clock();
      return this.#decision(this.#read(this.#key(subject), now) ?? this.#read('overflow', now) ?? this.#empty(), now);
    }, false);
  }

  override recordFailure(subject: string): LoginAttemptDecision {
    return this.#transaction(() => {
      this.#assertPolicy();
      const now = this.#clock();
      this.db.prepare(`DELETE FROM hub_login_limit_buckets WHERE subject IN
        (SELECT subject FROM hub_login_limit_buckets WHERE expires_at <= ? ORDER BY expires_at LIMIT 32)`).run(now);
      let key = this.#key(subject);
      let bucket = this.#read(key, now);
      if (!bucket) {
        const overflow = this.#read('overflow', now);
        const count = this.db.prepare("SELECT COUNT(*) AS count FROM hub_login_limit_buckets WHERE subject != 'overflow'").get() as { count: number };
        if (overflow && (overflow.failures.length || overflow.lockedUntil !== undefined) || count.count >= this.#limit) {
          key = 'overflow';
          bucket = overflow;
        }
      }
      bucket ??= this.#empty();
      const current = this.#decision(bucket, now);
      if (!current.allowed) return current;
      bucket.failures.push(now);
      bucket.failures = bucket.failures.slice(-this.options.maxFailures);
      if (bucket.failures.length >= this.options.maxFailures) bucket.lockedUntil = now + this.options.lockoutMs;
      bucket.expiresAt = Math.max(bucket.expiresAt, now + this.options.windowMs + 1, bucket.lockedUntil ?? 0);
      this.db.prepare(`INSERT INTO hub_login_limit_buckets VALUES (?, ?, ?, ?) ON CONFLICT(subject) DO UPDATE SET
        failures=excluded.failures, locked_until=excluded.locked_until, expires_at=excluded.expires_at`)
        .run(key, JSON.stringify(bucket.failures), bucket.lockedUntil ?? null, bucket.expiresAt);
      return this.#decision(bucket, now);
    });
  }

  override recordSuccess(subject: string) {
    this.#transaction(() => {
      this.#assertPolicy();
      // Never erase shared overflow evidence on an unrelated success.
      this.db.prepare('DELETE FROM hub_login_limit_buckets WHERE subject = ?').run(this.#key(subject));
    });
  }

  #key(subject: string) { return createHash('sha256').update(subject).digest('hex'); }
  #empty(): Bucket { return { failures: [], lockedUntil: undefined, expiresAt: 0 }; }
  #storedPolicy() { return (this.db.prepare('SELECT policy FROM hub_login_limit_policy WHERE singleton = 1').get() as { policy: string } | undefined)?.policy; }
  #assertPolicy() { if (this.#storedPolicy() !== this.#policy) throw Error('auth_limiter_policy_conflict'); }
  #read(key: string, now: number): Bucket | undefined {
    const row = this.db.prepare('SELECT failures, locked_until, expires_at FROM hub_login_limit_buckets WHERE subject = ?').get(key) as Row | undefined;
    if (!row) return undefined;
    const failures: unknown = JSON.parse(row.failures);
    if (!Array.isArray(failures) || failures.length > this.options.maxFailures || failures.some(ts => !Number.isSafeInteger(ts))
      || !Number.isSafeInteger(row.expires_at) || row.locked_until !== null && !Number.isSafeInteger(row.locked_until)) throw Error('auth_limiter_corrupt');
    if (row.expires_at <= now) return undefined;
    return { failures: failures.filter(ts => ts >= now - this.options.windowMs),
      lockedUntil: row.locked_until !== null && row.locked_until > now ? row.locked_until : undefined, expiresAt: row.expires_at };
  }
  #decision(bucket: Bucket, now: number): LoginAttemptDecision {
    return bucket.lockedUntil !== undefined && bucket.lockedUntil > now
      ? { allowed: false, failureCount: bucket.failures.length, retryAfterSeconds: Math.max(1, Math.ceil((bucket.lockedUntil - now) / 1000)) }
      : { allowed: true, failureCount: bucket.failures.length };
  }
  #transaction<T>(action: () => T extends PromiseLike<unknown> ? never : T, write = true): T {
    // Joining an unrelated outer transaction would report success before its
    // commit. Refuse it; auth routes run outside Hub storage transactions.
    requireConnectionReady(this.db);
    if (this.db.isTransaction) throw Error('auth_limiter_nested_transaction');
    return observedTransaction(this.db, write ? 'auth-login-change' : 'auth-login-check', action,
      undefined, false, write ? 'immediate' : 'deferred');
  }
}
