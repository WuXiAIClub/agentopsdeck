import { createHash, randomUUID } from 'node:crypto';
import type { HubPrincipal } from './identity.js';
import type { DatabaseSync } from 'node:sqlite';
import { observedSavepoint } from '../storage/observed-savepoint.js';
import { WeixinError, type WeixinAccount, type WeixinMessage } from './weixin-transport.js';
import type { InteractionView } from '@agentopsdeck/shared';

type Vault = { read(id: string): string | undefined; write(id: string, secret: string): void; remove(id: string): void };
export type WeixinBinding = { id: string; user: string; keyId: string; phase: 'creating' | 'qr' | 'bound'; createdAt: number; expiresAt: number };
export type WeixinSecrets = { qrCode?: string; qrUrl?: string; baseUrl?: string; account?: WeixinAccount; cursor?: string;
  context?: string; contextAt?: number; lastMessageAt?: number; lastCommandAt?: number;
  stops?: Record<string, { session: string; run: string; expires: number }>;
  questions?: Record<string, { session: string; view: InteractionView }> };
export type WeixinDelivery = 'accepted' | 'unknown';
export type WeixinOriginalReceipt = Readonly<{ kind: 'weixin-original-receipt' }>;
const columns = 'id, user_id AS user, key_id AS keyId, phase, created_at AS createdAt, expires_at AS expiresAt';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Uses the Hub's sole SQLite owner and existing encrypted vault namespace.
 * Neither human login Keys nor provider credentials enter public DTOs/logs. */
export class WeixinStore {
  private readonly originals = new WeakMap<WeixinOriginalReceipt, { binding: string; event: string; delivery: boolean }>();
  constructor(private readonly db: DatabaseSync, private readonly vault: Vault, readonly enabled: boolean,
    private readonly keyPrincipal: (keyId: string) => HubPrincipal | undefined, private readonly now = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS hub_weixin_bindings (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE, key_id TEXT NOT NULL, phase TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, bot_hash TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS hub_weixin_attempts (user_id TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS hub_weixin_receipts (binding_id TEXT PRIMARY KEY, state TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS hub_weixin_deliveries (binding_id TEXT NOT NULL, event_hash TEXT NOT NULL, state TEXT NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY(binding_id,event_hash));
      CREATE TABLE IF NOT EXISTS hub_weixin_retired (binding_id TEXT PRIMARY KEY, retired_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS hub_weixin_targets (binding_id TEXT NOT NULL, handle TEXT NOT NULL, session_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL, watching INTEGER NOT NULL DEFAULT 0, snapshot TEXT,
        PRIMARY KEY(binding_id,handle), UNIQUE(binding_id,session_id));`);
  }
  private atomic<T>(fn: () => T extends PromiseLike<unknown> ? never : T): T {
    return observedSavepoint(this.db, 'weixin-binding-change', fn);
  }
  get(user: string): WeixinBinding | undefined {
    const row = this.db.prepare(`SELECT ${columns} FROM hub_weixin_bindings WHERE user_id=?`).get(user) as WeixinBinding | undefined;
    return row && row.expiresAt > this.now() && this.keyPrincipal(row.keyId)?.userId === row.user ? row : undefined;
  }
  active() {
    this.prune();
    return (this.db.prepare(`SELECT ${columns} FROM hub_weixin_bindings WHERE phase='bound' AND expires_at>? LIMIT 64`).all(this.now()) as WeixinBinding[])
      .filter(row => this.get(row.user)?.id === row.id);
  }
  current(row: WeixinBinding) {
    const current = this.get(row.user);
    return current?.id === row.id && current.keyId === row.keyId && current.createdAt === row.createdAt;
  }
  principal(row: WeixinBinding) { return this.current(row) ? this.keyPrincipal(row.keyId) : undefined; }
  prune() {
    // At most 64 rows, including configured administrator references that do
    // not belong in hub_login_keys. Reuse the same authority check as reads.
    const rows = this.db.prepare(`SELECT ${columns} FROM hub_weixin_bindings`).all() as WeixinBinding[];
    for (const row of rows) if (!this.current(row)) this.remove(row.user, row.id);
    // Unknown recovery facts are never evicted for space. Reclaim only old,
    // entirely confirmed retired ledgers, not a live binding's replay fence.
    this.atomic(() => {
      const retired = this.db.prepare(`SELECT binding_id AS id FROM hub_weixin_retired r
        WHERE retired_at<? AND NOT EXISTS (SELECT 1 FROM hub_weixin_deliveries d WHERE d.binding_id=r.binding_id AND d.state='unknown')
        AND NOT EXISTS (SELECT 1 FROM hub_weixin_receipts p WHERE p.binding_id=r.binding_id AND p.state='unknown')`).all(this.now() - 30 * 86400_000) as { id: string }[];
      for (const row of retired) {
        this.db.prepare('DELETE FROM hub_weixin_deliveries WHERE binding_id=?').run(row.id);
        this.db.prepare('DELETE FROM hub_weixin_receipts WHERE binding_id=?').run(row.id);
        this.db.prepare('DELETE FROM hub_weixin_retired WHERE binding_id=?').run(row.id);
      }
    });
  }
  secrets(row: WeixinBinding): WeixinSecrets {
    if (!this.current(row)) throw new WeixinError('denied');
    const value = this.vault.read(row.id); return value ? JSON.parse(value) : {};
  }
  save(row: WeixinBinding, secrets: WeixinSecrets) {
    if (!this.current(row)) throw new WeixinError('denied'); this.vault.write(row.id, JSON.stringify(secrets));
  }
  create(user: string, keyId: string, id: string) {
    if (!this.enabled) throw new WeixinError('not_configured');
    this.prune();
    return this.atomic(() => {
      if (this.keyPrincipal(keyId)?.userId !== user) throw new WeixinError('denied');
      const existing = this.get(user);
      if (existing) { if (existing.id !== id) throw new WeixinError('busy'); return { row: existing, fresh: false }; }
      if (this.db.prepare('SELECT 1 FROM hub_weixin_retired WHERE binding_id=?').get(id)) throw new WeixinError('expired');
      // Reserve retirement capacity at creation: unlink must always revoke,
      // even when all earlier bindings contain unknown, non-evictable effects.
      if ((this.db.prepare(`SELECT (SELECT count(*) FROM hub_weixin_retired)+(SELECT count(*) FROM hub_weixin_bindings) AS n`).get() as { n: number }).n >= 256) throw new WeixinError('busy');
      if ((this.db.prepare('SELECT count(*) AS n FROM hub_weixin_bindings WHERE expires_at>?').get(this.now()) as { n: number }).n >= 64) throw new WeixinError('busy');
      const budget = this.db.prepare('SELECT window,count FROM hub_weixin_attempts WHERE user_id=?').get(user) as { window: number; count: number } | undefined;
      if (budget && budget.window + 60_000 > this.now() && budget.count >= 3) throw new WeixinError('busy');
      this.db.prepare(`INSERT INTO hub_weixin_attempts VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET window=excluded.window,count=excluded.count`)
        .run(user, budget && budget.window + 60_000 > this.now() ? budget.window : this.now(), budget && budget.window + 60_000 > this.now() ? budget.count + 1 : 1);
      this.remove(user);
      const row: WeixinBinding = { id, user, keyId, phase: 'creating', createdAt: this.now(), expiresAt: this.now() + 300_000 };
      this.db.prepare('INSERT INTO hub_weixin_bindings VALUES(?,?,?,?,?,?,NULL)').run(id, user, keyId, row.phase, row.createdAt, row.expiresAt);
      return { row, fresh: true };
    });
  }
  qr(row: WeixinBinding, code: string, url: string, baseUrl: string) {
    this.atomic(() => { this.save(row, { qrCode: code, qrUrl: url, baseUrl }); this.db.prepare("UPDATE hub_weixin_bindings SET phase='qr' WHERE id=?").run(row.id); });
  }
  bind(row: WeixinBinding, account: WeixinAccount) {
    this.atomic(() => {
      this.save(row, { account, cursor: '', lastMessageAt: this.now() });
      try { this.db.prepare("UPDATE hub_weixin_bindings SET phase='bound', expires_at=?,bot_hash=? WHERE id=?")
        .run(this.now() + 30 * 86400_000, digest(account.botId), row.id); }
      catch { throw new WeixinError('denied'); }
    });
  }
  remove(user: string, expectedId?: string) {
    return this.atomic(() => {
      const row = this.db.prepare('SELECT id FROM hub_weixin_bindings WHERE user_id=?').get(user) as { id: string } | undefined;
      if (!row || expectedId && row.id !== expectedId) return;
      this.vault.remove(row.id);
      this.db.prepare('DELETE FROM hub_weixin_targets WHERE binding_id=?').run(row.id);
      this.db.prepare('INSERT OR IGNORE INTO hub_weixin_retired VALUES(?,?)').run(row.id, this.now());
      this.db.prepare('DELETE FROM hub_weixin_bindings WHERE id=?').run(row.id);
    });
  }
  claim(row: WeixinBinding, event: string) {
    if (!this.current(row)) throw new WeixinError('denied');
    if (this.db.prepare('SELECT 1 FROM hub_weixin_deliveries WHERE binding_id=? AND event_hash=?').get(row.id, digest(event))) return false;
    // Bounded lifetime ledger: fail closed at capacity; never evict replay protection.
    if ((this.db.prepare('SELECT count(*) AS n FROM hub_weixin_deliveries WHERE binding_id=?').get(row.id) as { n: number }).n >= 4096) throw new WeixinError('busy');
    return this.db.prepare("INSERT OR IGNORE INTO hub_weixin_deliveries VALUES(?,?,'unknown',?)").run(row.id, digest(event), this.now()).changes === 1;
  }
  settle(row: WeixinBinding, event: string, state: WeixinDelivery) {
    if (this.current(row)) this.db.prepare("UPDATE hub_weixin_deliveries SET state=CASE WHEN state='accepted' THEN state ELSE ? END WHERE binding_id=? AND event_hash=?").run(state, row.id, digest(event));
  }
  /** One transaction for cursor, de-duplication, throttling, context and intent.
   * Each returned work item retains its own original provider context. */
  receiveAdmission(row: WeixinBinding, expectedCursor: string, batch: { cursor: string; messages: WeixinMessage[] }, at = this.now()) {
    return this.atomic(() => {
      let secret = this.secrets(row);
      if (!secret.account || (secret.cursor ?? '') !== expectedCursor) throw new WeixinError('denied');
      if (typeof batch.cursor !== 'string' || batch.cursor.length > 64 * 1024 || !Array.isArray(batch.messages) || batch.messages.length > 100) throw new WeixinError('invalid_response');
      const admitted: WeixinMessage[] = [];
      for (const message of [...batch.messages].sort((a, b) => a.at - b.at)) {
        if (!message || typeof message.id !== 'string' || !message.id || message.id.length > 128
          || typeof message.peerId !== 'string' || !Number.isSafeInteger(message.at)
          || typeof message.text !== 'string' || message.text.length > 4000
          || typeof message.context !== 'string' || !message.context || message.context.length > 8192) throw new WeixinError('invalid_response');
        if (message.peerId !== secret.account!.peerId || message.at < row.createdAt || message.at < (secret.lastMessageAt ?? 0)
          || message.at < at - 120_000 || message.at > at + 30_000 || !this.claim(row, `in:${message.id}`)) continue;
        secret = { ...secret, lastMessageAt: message.at, context: message.context, contextAt: at };
        if ((secret.lastCommandAt ?? 0) + 3000 > at) continue;
        secret = { ...secret, lastCommandAt: at }; admitted.push({ ...message });
      }
      this.save(row, { ...secret, cursor: batch.cursor }); return admitted;
    });
  }
  private original(row: WeixinBinding, event: string, delivery: boolean) {
    const reference: WeixinOriginalReceipt = Object.freeze({ kind: 'weixin-original-receipt' });
    this.originals.set(reference, { binding: row.id, event: digest(event), delivery }); return reference;
  }
  claimAction(row: WeixinBinding, event: string): WeixinOriginalReceipt | undefined {
    return this.atomic(() => this.claim(row, event) ? this.original(row, event, false) : undefined);
  }
  deliveryAdmission(row: WeixinBinding, event: string, claimed = false, context?: string, at = this.now()) {
    return this.atomic(() => {
      const secret = this.secrets(row);
      if (!secret.account || !secret.context || (secret.contextAt ?? 0) + 24 * 3600_000 <= at) return;
      if (claimed) {
        if (!this.db.prepare("SELECT 1 FROM hub_weixin_deliveries WHERE binding_id=? AND event_hash=? AND state='unknown'").get(row.id, digest(event))) return;
      } else if (!this.claim(row, event)) return;
      this.recordDelivery(row, 'unknown');
      return { account: secret.account, context: context ?? secret.context, clientId: `agentopsdeck-${randomUUID()}`,
        reference: this.original(row, event, true) };
    });
  }
  /** Only an original private reference can settle an existing intent. It is
   * not an authority grant, and cannot create an intent or dispatch an effect. */
  settleOriginal(reference: WeixinOriginalReceipt, state: WeixinDelivery) {
    const original = this.originals.get(reference);
    if (!original || !['accepted', 'unknown'].includes(state)) throw new WeixinError('denied');
    this.atomic(() => {
      const update = this.db.prepare("UPDATE hub_weixin_deliveries SET state=CASE WHEN state='accepted' THEN state ELSE ? END WHERE binding_id=? AND event_hash=?")
        .run(state, original.binding, original.event);
      if (!update.changes) throw new WeixinError('unknown');
      if (original.delivery) {
        const fact = this.db.prepare('SELECT state FROM hub_weixin_deliveries WHERE binding_id=? AND event_hash=?').get(original.binding, original.event) as { state: WeixinDelivery };
        this.db.prepare(`INSERT INTO hub_weixin_receipts VALUES(?,?,?) ON CONFLICT(binding_id) DO UPDATE SET state=excluded.state,at=excluded.at`)
          .run(original.binding, fact.state, this.now());
      }
    });
  }
  receipt(row: WeixinBinding) {
    return this.db.prepare('SELECT state,at FROM hub_weixin_receipts WHERE binding_id=?').get(row.id) as { state: WeixinDelivery; at: number } | undefined;
  }
  recordDelivery(row: WeixinBinding, state: WeixinDelivery) {
    if (this.current(row)) this.db.prepare(`INSERT INTO hub_weixin_receipts VALUES(?,?,?) ON CONFLICT(binding_id) DO UPDATE SET state=excluded.state,at=excluded.at`).run(row.id, state, this.now());
  }
  target(row: WeixinBinding, session: string, handle: string) {
    if (!this.current(row)) throw new WeixinError('denied');
    this.db.prepare('DELETE FROM hub_weixin_targets WHERE binding_id=? AND expires_at<=? AND watching=0').run(row.id, this.now());
    if (!this.db.prepare('SELECT 1 FROM hub_weixin_targets WHERE binding_id=? AND session_id=?').get(row.id, session)
      && (this.db.prepare('SELECT count(*) AS n FROM hub_weixin_targets WHERE binding_id=?').get(row.id) as { n: number }).n >= 50) throw new WeixinError('busy');
    this.db.prepare(`INSERT INTO hub_weixin_targets(binding_id,handle,session_id,expires_at) VALUES(?,?,?,?)
      ON CONFLICT(binding_id,session_id) DO UPDATE SET expires_at=excluded.expires_at`).run(row.id, handle, session, this.now() + 30 * 60_000);
    return (this.db.prepare('SELECT handle FROM hub_weixin_targets WHERE binding_id=? AND session_id=?').get(row.id, session) as { handle: string }).handle;
  }
  targets(row: WeixinBinding) {
    if (!this.current(row)) throw new WeixinError('denied');
    return this.db.prepare('SELECT handle,session_id AS session,expires_at AS expiresAt,watching,snapshot FROM hub_weixin_targets WHERE binding_id=?').all(row.id) as
      { handle: string; session: string; expiresAt: number; watching: number; snapshot: string | null }[];
  }
  watch(row: WeixinBinding, handle: string, enabled: boolean) {
    const t = this.targets(row).find(t => t.handle === handle && t.expiresAt > this.now()); if (!t) throw new WeixinError('expired');
    this.db.prepare('UPDATE hub_weixin_targets SET watching=?,snapshot=NULL WHERE binding_id=? AND handle=?').run(enabled ? 1 : 0, row.id, handle);
  }
  snapshot(row: WeixinBinding, handle: string, snapshot: string) {
    if (this.current(row)) this.db.prepare('UPDATE hub_weixin_targets SET snapshot=? WHERE binding_id=? AND handle=?').run(snapshot, row.id, handle);
  }
}
