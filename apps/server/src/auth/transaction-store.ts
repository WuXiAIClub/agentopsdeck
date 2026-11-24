import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { observedTransaction } from '../storage/observed-transaction.js';
import { requireConnectionReady } from '../storage/connection-recovery.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

const identity = (v: string) => typeof v === 'string' && v.length > 0 && v.length <= 512 && v === v.trim() && !/[\x00-\x1f\x7f]/.test(v);
const digest = (v: string) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const integer = (v: number) => Number.isSafeInteger(v) && v >= 0;
type Credential = { owner: string; id: string; rp: string; generation: number; version: number; counter: number; revoked: number };
export type VerifiedAuthIssue = {
  owner: string; credentialId: string; rpId: string; generation: number; expectedVersion: number;
  challengeDigest: string; sessionDigest: string; requestId: string; counter: number; expiresAt: number;
};
export type AuthIssueReceipt = { requestId: string; credentialId: string; generation: number; issuedAt: number; expiresAt: number };

/** ISOLATED reference store; NOT wired to production Passkeys/JSON auth.
 * Caller must cryptographically verify rpId/origin/signature/user verification,
 * and supply digests of high-entropy server-issued challenge/session tokens.
 * This store performs the post-verification CAS, challenge consumption, session
 * issuance and audit transaction. It never accepts a browser's "verified" flag.
 * Use one authoritative SQLite DB; this is not cross-host SQLite replication. */
export class TransactionAuthStore {
  constructor(private readonly db: DatabaseSync, private readonly clock: () => number = Date.now,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {
    if (db.isTransaction) throw Error('auth-outer-transaction');
    db.exec(`CREATE TABLE IF NOT EXISTS auth_v2_credentials (
      owner TEXT NOT NULL,id TEXT NOT NULL,rp TEXT NOT NULL,generation INTEGER NOT NULL,version INTEGER NOT NULL,
      counter INTEGER NOT NULL,revoked INTEGER NOT NULL,PRIMARY KEY(owner,id),UNIQUE(rp,id));
      CREATE TABLE IF NOT EXISTS auth_v2_challenges (
      digest TEXT PRIMARY KEY,owner TEXT NOT NULL,credential TEXT NOT NULL,generation INTEGER NOT NULL,
      version INTEGER NOT NULL,expires INTEGER NOT NULL,consumed INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_v2_sessions (
      digest TEXT PRIMARY KEY,owner TEXT NOT NULL,credential TEXT NOT NULL,generation INTEGER NOT NULL,expires INTEGER NOT NULL,revoked INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_v2_receipts (
      owner TEXT NOT NULL,id TEXT NOT NULL,fingerprint TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(owner,id));
      CREATE TABLE IF NOT EXISTS auth_v2_events (
      seq INTEGER PRIMARY KEY,owner TEXT NOT NULL,credential TEXT NOT NULL,kind TEXT NOT NULL,generation INTEGER NOT NULL,at INTEGER NOT NULL);`);
  }
  private now() { const at = this.clock(); if (!integer(at)) throw Error('auth-clock'); return at; }
  private atomic<T>(fn: () => T extends PromiseLike<unknown> ? never : T): T {
    requireConnectionReady(this.db);
    if (this.db.isTransaction) throw Error('auth-outer-transaction');
    return observedTransaction(this.db, 'auth-issue-change', fn, this.diagnostics);
  }
  private event(owner: string, id: string, kind: string, generation: number, at: number) {
    this.db.prepare('INSERT INTO auth_v2_events(owner,credential,kind,generation,at) VALUES(?,?,?,?,?)').run(owner,id,kind,generation,at);
  }
  private credential(owner: string, id: string) {
    if (!identity(owner) || !identity(id)) throw Error('auth-scope');
    const c = this.db.prepare('SELECT * FROM auth_v2_credentials WHERE owner=? AND id=?').get(owner,id) as Credential | undefined;
    if (!c || c.revoked) throw Error('auth-unavailable'); return c;
  }
  private capacity(table: 'auth_v2_challenges' | 'auth_v2_sessions' | 'auth_v2_receipts' | 'auth_v2_credentials') {
    if (Number(this.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n) >= 10_000) throw Error('auth-capacity');
  }
  register(owner: string, id: string, rp: string, counter = 0) {
    if (![owner,id,rp].every(identity) || !integer(counter)) throw Error('auth-input');
    return this.atomic(() => {
      this.capacity('auth_v2_credentials'); const at = this.now();
      // Revoked identity tombstones cannot be silently registered again.
      this.db.prepare('INSERT INTO auth_v2_credentials VALUES(?,?,?,1,0,?,0)').run(owner,id,rp,counter);
      this.event(owner,id,'registered',1,at);
    });
  }
  prepareChallenge(owner: string, id: string, challengeDigest: string, expiresAt: number) {
    return this.atomic(() => {
      const c = this.credential(owner,id), now = this.now();
      if (!digest(challengeDigest) || !integer(expiresAt) || expiresAt <= now || expiresAt > now + 300_000) throw Error('auth-challenge');
      this.capacity('auth_v2_challenges');
      this.db.prepare('INSERT INTO auth_v2_challenges VALUES(?,?,?,?,?,?,0)').run(challengeDigest,owner,id,c.generation,c.version,expiresAt);
      return { generation: c.generation, expectedVersion: c.version };
    });
  }
  issueVerified(input: VerifiedAuthIssue): AuthIssueReceipt {
    const { owner, credentialId: id, rpId, generation, expectedVersion, challengeDigest, sessionDigest, requestId, counter, expiresAt } = input;
    if (![owner,id,rpId,requestId].every(identity) || ![generation,expectedVersion,counter,expiresAt].every(integer)
      || !digest(challengeDigest) || !digest(sessionDigest)) throw Error('auth-input');
    // Fixed ordering; no key-order-sensitive caller object and no raw tokens.
    const fingerprint = createHash('sha256').update(JSON.stringify([owner,id,rpId,generation,expectedVersion,challengeDigest,sessionDigest,requestId,counter,expiresAt])).digest('hex');
    return this.atomic(() => {
      const c = this.credential(owner,id), now = this.now();
      if (c.rp !== rpId || c.generation !== generation) throw Error('auth-stale');
      const receipt = this.db.prepare('SELECT fingerprint,payload FROM auth_v2_receipts WHERE owner=? AND id=?').get(owner,requestId) as {fingerprint:string;payload:string}|undefined;
      if (receipt) { if (receipt.fingerprint !== fingerprint) throw Error('auth-request-reused'); return JSON.parse(receipt.payload) as AuthIssueReceipt; }
      const challenge = this.db.prepare('SELECT * FROM auth_v2_challenges WHERE digest=?').get(challengeDigest);
      if (!challenge || challenge.owner !== owner || challenge.credential !== id || challenge.generation !== generation
        || challenge.version !== expectedVersion || challenge.consumed || Number(challenge.expires) <= now || c.version !== expectedVersion) throw Error('auth-challenge-stale');
      // Passkeys without counters may keep 0; otherwise require strict advance.
      if ((c.counter !== 0 || counter !== 0) && counter <= c.counter) throw Error('auth-counter');
      if (expiresAt <= now || expiresAt > now + 30 * 86400_000) throw Error('auth-expiry');
      this.capacity('auth_v2_sessions'); this.capacity('auth_v2_receipts');
      this.db.prepare('UPDATE auth_v2_credentials SET version=version+1,counter=? WHERE owner=? AND id=?').run(counter,owner,id);
      this.db.prepare('UPDATE auth_v2_challenges SET consumed=1 WHERE digest=?').run(challengeDigest);
      this.db.prepare('INSERT INTO auth_v2_sessions VALUES(?,?,?,?,?,0)').run(sessionDigest,owner,id,generation,expiresAt);
      const value = { requestId, credentialId: id, generation, issuedAt: now, expiresAt };
      this.db.prepare('INSERT INTO auth_v2_receipts VALUES(?,?,?,?)').run(owner,requestId,fingerprint,JSON.stringify(value));
      this.event(owner,id,'issued',generation,now); return value;
    });
  }
  authorize(sessionDigest: string): { owner: string; credentialId: string; generation: number } | undefined {
    if (this.db.isTransaction) throw Error('auth-outer-transaction');
    if (!digest(sessionDigest)) return;
    const row = this.db.prepare(`SELECT s.owner,s.credential,s.generation FROM auth_v2_sessions s
      JOIN auth_v2_credentials c ON c.owner=s.owner AND c.id=s.credential AND c.generation=s.generation
      WHERE s.digest=? AND s.revoked=0 AND c.revoked=0 AND s.expires>?`).get(sessionDigest,this.now());
    return row ? { owner: String(row.owner), credentialId: String(row.credential), generation: Number(row.generation) } : undefined;
  }
  revoke(owner: string, id: string, expectedGeneration: number) {
    return this.atomic(() => {
      const c = this.credential(owner,id); if (c.generation !== expectedGeneration) throw Error('auth-stale');
      this.db.prepare('UPDATE auth_v2_credentials SET revoked=1,generation=generation+1 WHERE owner=? AND id=?').run(owner,id);
      this.db.prepare('UPDATE auth_v2_sessions SET revoked=1 WHERE owner=? AND credential=?').run(owner,id);
      this.event(owner,id,'revoked',c.generation+1,this.now());
    });
  }
}
