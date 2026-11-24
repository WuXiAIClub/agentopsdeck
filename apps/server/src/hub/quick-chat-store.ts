import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { observedTransaction } from '../storage/observed-transaction.js';
import { requireConnectionReady } from '../storage/connection-recovery.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
export type QuickChatProfile = { id: string; revision: number; name: string; target: string; model: string; outputLimit: number };
export type QuickChatCapability = { ephemeralRequest: boolean; noPersistentThread: boolean; originalLookup: boolean; maxOutput: number; epoch: string };
export type QuickChatReceipt = { requestId: string; profile: QuickChatProfile; capabilityEpoch: string; fingerprint: string;
  state: 'admitted' | 'unknown' | 'completed' | 'failed'; createdAt: number; resultRef: string | null; resultExpiresAt: number | null };
export class QuickChatConflict extends Error {}
/** Owner-local synchronous authority only. Never transfer callbacks across a
 * worker boundary or accept one from a browser. */
export type QuickChatAuthority = () => boolean;
const text = (v: string, max = 512) => typeof v === 'string' && v.length > 0 && v.length <= max && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const integer = (v: number) => Number.isSafeInteger(v) && v >= 0;
function supported(capability: QuickChatCapability, limit: number) {
  return capability.ephemeralRequest === true && capability.noPersistentThread === true && capability.originalLookup === true
    && text(capability.epoch) && integer(capability.maxOutput) && limit > 0 && limit <= capability.maxOutput;
}
/** Q1 internal durable receipts. No session creation, native thread, timer or
 * model client exists here. Providers without proven ephemeral+lookup support
 * must remain disabled. Prompts never enter this DB; result bodies are only
 * stored encrypted in a separate expiring table, not in receipts. */
export class QuickChatStore {
  constructor(private readonly db: DatabaseSync, private readonly now = Date.now, private readonly resultKey?: Buffer,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {}
  private scope(owner: string, id: string) { if (!text(owner) || !text(id)) throw new QuickChatConflict('scope'); }
  private exists() { return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='quick_chat_profiles'").get(); }
  private transaction<T>(fn: (checkParticipant: (value: unknown) => void) => T extends PromiseLike<unknown> ? never : T,
    authorized?: QuickChatAuthority, denial = 'authority'): T {
    requireConnectionReady(this.db);
    if (this.db.isTransaction) throw new QuickChatConflict('outer-transaction');
    return observedTransaction(this.db, 'quick-chat-change', (_commit, checkParticipant) => {
      const check = () => {
        if (!authorized) return;
        const allowed = authorized(); checkParticipant(allowed);
        if (allowed !== true) throw new QuickChatConflict(denial);
      };
      check();
      this.db.exec(`CREATE TABLE IF NOT EXISTS quick_chat_profiles(owner TEXT,id TEXT,payload TEXT,PRIMARY KEY(owner,id));
        CREATE TABLE IF NOT EXISTS quick_chat_receipts(owner TEXT,id TEXT,profile_id TEXT,state TEXT,payload TEXT,PRIMARY KEY(owner,id));
        CREATE TABLE IF NOT EXISTS quick_chat_results(owner TEXT,id TEXT,expires INTEGER,body BLOB,nonce BLOB,tag BLOB,PRIMARY KEY(owner,id));`);
      const result = fn(checkParticipant);
      checkParticipant(result);
      // Check again after all statements, before the original root COMMIT.
      // Return no sending permit if the original root transaction rolls back.
      check();
      return result;
    }, this.diagnostics);
  }
  profile(owner: string, id: string): QuickChatProfile | undefined {
    this.scope(owner, id); if (!this.exists()) return;
    const row = this.db.prepare('SELECT payload FROM quick_chat_profiles WHERE owner=? AND id=?').get(owner, id);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  profiles(owner: string): QuickChatProfile[] {
    this.scope(owner, 'profiles'); if (!this.exists()) return [];
    return this.db.prepare('SELECT payload FROM quick_chat_profiles WHERE owner=? ORDER BY id').all(owner).map(r => JSON.parse(String(r.payload)));
  }
  receipts(owner: string): QuickChatReceipt[] {
    this.scope(owner, 'receipts'); if (!this.exists()) return [];
    return this.db.prepare('SELECT id FROM quick_chat_receipts WHERE owner=? ORDER BY rowid DESC LIMIT 32').all(owner)
      .map(r => this.receipt(owner, String(r.id))!);
  }
  saveProfile(owner: string, expectedRevision: number, raw: Omit<QuickChatProfile, 'revision'>, capability: QuickChatCapability,
    authorized?: QuickChatAuthority) {
    this.scope(owner, raw.id);
    if (!integer(expectedRevision) || !integer(expectedRevision + 1) || !text(raw.name, 80) || !text(raw.target) || !text(raw.model, 128)
      || !integer(raw.outputLimit) || !supported(capability, raw.outputLimit)) throw new QuickChatConflict('unsupported-profile');
    return this.transaction(() => {
      const previous = this.profile(owner, raw.id);
      if ((previous?.revision ?? 0) !== expectedRevision) throw new QuickChatConflict('revision');
      if (!previous && Number(this.db.prepare('SELECT count(*) n FROM quick_chat_profiles WHERE owner=?').get(owner)!.n) >= 32) throw new QuickChatConflict('profile-capacity');
      const profile: QuickChatProfile = { id: raw.id, name: raw.name, target: raw.target, model: raw.model, outputLimit: raw.outputLimit, revision: expectedRevision + 1 };
      this.db.prepare('INSERT INTO quick_chat_profiles VALUES(?,?,?) ON CONFLICT(owner,id) DO UPDATE SET payload=excluded.payload').run(owner, profile.id, JSON.stringify(profile));
      return profile;
    }, authorized);
  }
  receipt(owner: string, id: string): QuickChatReceipt | undefined {
    this.scope(owner, id); if (!this.exists()) return;
    const row = this.db.prepare('SELECT payload FROM quick_chat_receipts WHERE owner=? AND id=?').get(owner, id);
    if (!row) return;
    const receipt = JSON.parse(String(row.payload)) as QuickChatReceipt;
    if (receipt.resultExpiresAt !== null && this.now() >= receipt.resultExpiresAt) receipt.resultRef = null;
    return receipt;
  }
  admit(owner: string, requestId: string, profileId: string, revision: number, input: string, capability: QuickChatCapability,
    authorized?: QuickChatAuthority) {
    this.scope(owner, requestId);
    if (typeof input !== 'string' || !input.trim() || input.length > 8000) throw new QuickChatConflict('input');
    return this.transaction(() => {
      const fingerprint = hash([profileId, revision, input]), old = this.receipt(owner, requestId);
      if (old) { if (old.fingerprint !== fingerprint) throw new QuickChatConflict('request-reused'); return old; }
      const profile = this.profile(owner, profileId);
      if (!profile || profile.revision !== revision || !supported(capability, profile.outputLimit)) throw new QuickChatConflict('profile-changed-or-unsupported');
      const active = this.db.prepare("SELECT profile_id FROM quick_chat_receipts WHERE owner=? AND state IN ('admitted','unknown')").all(owner);
      if (active.length >= 2 || active.some(r => r.profile_id === profileId)) throw new QuickChatConflict('inflight-capacity');
      const recent = this.db.prepare("SELECT count(*) n FROM quick_chat_receipts WHERE owner=? AND CAST(json_extract(payload,'$.createdAt') AS INTEGER)>?").get(owner, this.now() - 60_000)!;
      if (Number(recent.n) >= 3) throw new QuickChatConflict('rate-capacity');
      const providerRecent = this.db.prepare("SELECT count(*) n FROM quick_chat_receipts WHERE CAST(json_extract(payload,'$.createdAt') AS INTEGER)>?").get(this.now() - 60_000)!;
      if (Number(providerRecent.n) >= 10) throw new QuickChatConflict('provider-rate-capacity');
      if (Number(this.db.prepare('SELECT count(*) n FROM quick_chat_receipts WHERE owner=?').get(owner)!.n) >= 1024) throw new QuickChatConflict('receipt-capacity');
      const now = this.now(); if (!integer(now)) throw new QuickChatConflict('clock');
      const receipt: QuickChatReceipt = { requestId, profile, capabilityEpoch: capability.epoch, fingerprint, state: 'admitted', createdAt: now, resultRef: null, resultExpiresAt: null };
      this.db.prepare('INSERT INTO quick_chat_receipts VALUES(?,?,?,?,?)').run(owner, requestId, profileId, receipt.state, JSON.stringify(receipt)); return receipt;
    }, authorized);
  }
  claim(owner: string, requestId: string, input: string, capability: QuickChatCapability, authorized: () => boolean) {
    return this.transaction(checkParticipant => {
      const receipt = this.receipt(owner, requestId); if (!receipt) throw new QuickChatConflict('missing');
      if (receipt.state !== 'admitted') return { claimed: false, receipt };
      if (receipt.fingerprint !== hash([receipt.profile.id, receipt.profile.revision, input])) throw new QuickChatConflict('input-changed');
      const allowed = authorized(); checkParticipant(allowed);
      if (allowed !== true || this.profile(owner, receipt.profile.id)?.revision !== receipt.profile.revision
        || receipt.capabilityEpoch !== capability.epoch || !supported(capability, receipt.profile.outputLimit)) throw new QuickChatConflict('preflight');
      receipt.state = 'unknown'; this.write(owner, receipt); return { claimed: true, receipt };
    }, authorized, 'preflight');
  }
  private write(owner: string, receipt: QuickChatReceipt) {
    this.db.prepare('UPDATE quick_chat_receipts SET state=?,payload=? WHERE owner=? AND id=?').run(receipt.state, JSON.stringify(receipt), owner, receipt.requestId);
  }
  /** Cancel only before dispatch; an unknown native result cannot free a slot. */
  cancelAdmitted(owner: string, requestId: string, authorized?: QuickChatAuthority) {
    return this.transaction(() => {
      const receipt = this.receipt(owner, requestId); if (!receipt) throw new QuickChatConflict('missing');
      if (receipt.state === 'failed') return receipt;
      if (receipt.state !== 'admitted') throw new QuickChatConflict('already-dispatched');
      receipt.state = 'failed'; this.write(owner, receipt); return receipt;
    }, authorized);
  }
  reconcile(owner: string, requestId: string, state: 'completed' | 'failed', resultRef: string | null,
    authorized?: QuickChatAuthority) {
    if (!['completed', 'failed'].includes(state) || state === 'failed' && resultRef !== null || resultRef !== null && !/^[a-zA-Z0-9_-]{1,128}$/.test(resultRef)) throw new QuickChatConflict('result');
    return this.transaction(() => {
      const receipt = this.receipt(owner, requestId); if (!receipt) throw new QuickChatConflict('missing');
      if (receipt.state === state) return receipt; // No result resurrection after expiry/clear.
      if (receipt.state !== 'unknown') throw new QuickChatConflict('transition');
      const now = this.now(); if (!integer(now) || now < receipt.createdAt || !integer(now + 86400000)) throw new QuickChatConflict('clock');
      receipt.state = state; receipt.resultRef = resultRef; receipt.resultExpiresAt = resultRef ? now + 86400000 : null;
      this.write(owner, receipt); return receipt;
    }, authorized);
  }
  clearResult(owner: string, requestId: string, authorized?: QuickChatAuthority) {
    this.transaction(() => { const receipt = this.receipt(owner, requestId); if (!receipt) throw new QuickChatConflict('missing');
      if (!['completed', 'failed'].includes(receipt.state)) throw new QuickChatConflict('not-terminal');
      this.db.prepare('DELETE FROM quick_chat_results WHERE owner=? AND id=?').run(owner, requestId);
      receipt.resultRef = null; receipt.resultExpiresAt = null; this.write(owner, receipt); }, authorized);
  }
  /** Encrypt and finish in one transaction: a crash cannot publish a receipt
   * whose result body was never saved. Expiration never clears unknown work. */
  complete(owner: string, requestId: string, output: string, authorized?: QuickChatAuthority) {
    if (!this.resultKey || this.resultKey.length !== 32 || typeof output !== 'string' || !output.trim() || output.length > 32000)
      throw new QuickChatConflict('result');
    return this.transaction(() => {
      const receipt = this.receipt(owner, requestId); if (!receipt) throw new QuickChatConflict('missing');
      if (receipt.state === 'completed') return receipt;
      if (receipt.state !== 'unknown') throw new QuickChatConflict('transition');
      const now = this.now(), expires = now + 86400_000;
      if (!integer(now) || now < receipt.createdAt || !integer(expires)) throw new QuickChatConflict('clock');
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.resultKey!, nonce);
      cipher.setAAD(Buffer.from(JSON.stringify([owner, requestId, expires])));
      const body = Buffer.concat([cipher.update(output, 'utf8'), cipher.final()]);
      this.db.prepare('DELETE FROM quick_chat_results WHERE expires<=?').run(now);
      this.db.prepare('INSERT INTO quick_chat_results VALUES(?,?,?,?,?,?)').run(owner, requestId, expires, body, nonce, cipher.getAuthTag());
      receipt.state = 'completed'; receipt.resultRef = hash([owner, requestId]); receipt.resultExpiresAt = expires;
      this.write(owner, receipt); return receipt;
    }, authorized);
  }
  result(owner: string, requestId: string): string | undefined {
    this.purgeExpired();
    return this.peekResult(owner, requestId);
  }
  /** Pure owner-local read for recovery snapshots. Expired ciphertext stays
   * invisible; physical cleanup belongs to the existing bounded sweep, not a
   * cancelled observer or a read-only RPC. Never expire receipt replay bars. */
  peekResult(owner: string, requestId: string): string | undefined {
    const receipt = this.receipt(owner, requestId);
    if (!receipt?.resultRef || receipt.state !== 'completed' || !this.resultKey) return;
    const r = this.db.prepare('SELECT * FROM quick_chat_results WHERE owner=? AND id=? AND expires>?').get(owner, requestId, this.now());
    if (!r) return;
    const cipher = createDecipheriv('aes-256-gcm', this.resultKey, r.nonce as Uint8Array);
    cipher.setAAD(Buffer.from(JSON.stringify([owner, requestId, Number(r.expires)]))); cipher.setAuthTag(r.tag as Uint8Array);
    return Buffer.concat([cipher.update(r.body as Uint8Array), cipher.final()]).toString('utf8');
  }
  /** Called on startup, reads and a bounded service timer. Receipts remain
   * immutable replay barriers; physical SQLite pages/backups are not erased. */
  purgeExpired() {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='quick_chat_results'").get()) return;
    this.db.prepare('DELETE FROM quick_chat_results WHERE expires<=?').run(this.now());
  }
}
