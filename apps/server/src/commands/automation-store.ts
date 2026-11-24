import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { observedTransaction } from '../storage/observed-transaction.js';
import { evaluateAutomation, readAutomationRule, type AutomationObservation, type AutomationRule, type AutomationTrigger } from "./automation-policy.js";

export type AutomationReservationState = "reserved" | "dispatching" | "unknown" | "queued" | "rejected" | "cancelled";
import type { StoredAutomationRule } from '@agentopsdeck/shared';
export type { StoredAutomationRule } from '@agentopsdeck/shared';
export type AutomationReservation = {
  requestId: string; triggerKey: string; trigger: AutomationTrigger; snapshot: StoredAutomationRule;
  reservedAt: number; updatedAt: number; state: AutomationReservationState;
};
type RuleRow = { payload: string; revoked: number };
type ReservationRow = { payload: string; state: AutomationReservationState; updated_at: number };
export class AutomationStoreConflict extends Error {}
export const AUTOMATION_STORE_LIMITS = { rules: 1000, receipts: 20_000, receiptsPerRule: 4096, bytes: 64 * 1024 * 1024 } as const;
const text = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 256 && s.trim() === s && !/[\u0000-\u001f\u007f]/.test(s);
const time = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const occupied = (s: AutomationReservationState) => !["rejected", "cancelled"].includes(s);
const targetKey = (r: AutomationRule) => JSON.stringify([r.target.ownerId, r.target.connectionId, r.target.runtime, r.target.sessionId]);

/** Internal owner-store primitive, deliberately NOT wired to a timer or queue.
 * Callers must authenticate/authorize the exact target and supply trustworthy
 * execution observations. No DB operation below is a permission grant.
 * Uses an existing owner connection; never opens a production database itself.
 * Receipts/tombstones are retained. Capacity exhaustion fails closed.
 */
export class AutomationStore {
  constructor(private readonly db: DatabaseSync, private readonly clock: () => number = Date.now) {}

  private schema() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS automation_rules (
      owner TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(owner,id));
      CREATE TABLE IF NOT EXISTS automation_reservations (
        owner TEXT NOT NULL, rule_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
        trigger_key TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(owner,rule_id,trigger_key),
        FOREIGN KEY(owner,rule_id) REFERENCES automation_rules(owner,id));
      CREATE INDEX IF NOT EXISTS automation_reservations_scope ON automation_reservations(owner,rule_id);`);
  }
  private transaction<T>(fn: () => T): T {
    return observedTransaction(this.db, 'automation-store-change', () => {
      // Do not cache schema existence: an enclosing transaction can roll it back.
      this.schema();
      return fn() as T extends PromiseLike<unknown> ? never : T;
    }, undefined, true);
  }
  private now() { const n = this.clock(); if (!time(n)) throw new Error("Invalid automation clock"); return n; }
  private scope(owner: string, id: string) { if (!text(owner) || !text(id)) throw new Error("Invalid automation scope"); }
  private hasTable(name: string) { return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type=? AND name=?").get("table", name); }
  private rule(owner: string, id: string): StoredAutomationRule | undefined {
    const row = this.db.prepare("SELECT payload,revoked FROM automation_rules WHERE owner=? AND id=?").get(owner, id) as RuleRow | undefined;
    if (!row) return undefined;
    const stored = JSON.parse(row.payload) as StoredAutomationRule;
    const parsed = readAutomationRule(stored.rule);
    if (!parsed || parsed.id !== id || parsed.target.ownerId !== owner || typeof stored.template !== "string"
      || hash(stored.template) !== stored.templateHash || stored.revoked !== Boolean(row.revoked)) throw new Error("Invalid automation rule evidence");
    return stored;
  }
  read(owner: string, id: string): StoredAutomationRule | undefined {
    this.scope(owner, id);
    return this.hasTable("automation_rules") ? this.rule(owner, id) : undefined;
  }
  /** Bounded owner-local enumeration for the scheduler; never includes another
   * owner's templates or silently truncates an over-capacity/corrupt store. */
  list(owner: string): StoredAutomationRule[] {
    this.scope(owner, owner);
    if (!this.hasTable("automation_rules")) return [];
    const rows = this.db.prepare("SELECT id FROM automation_rules WHERE owner=? ORDER BY id LIMIT ?")
      .all(owner, AUTOMATION_STORE_LIMITS.rules + 1) as { id: string }[];
    if (rows.length > AUTOMATION_STORE_LIMITS.rules) throw new AutomationStoreConflict("capacity");
    return rows.map(row => this.rule(owner, row.id)!);
  }
  private decode(row: ReservationRow): AutomationReservation {
    const value = JSON.parse(row.payload) as AutomationReservation;
    return { ...value, state: row.state, updatedAt: row.updated_at };
  }
  receipt(owner: string, requestId: string): AutomationReservation | undefined {
    this.scope(owner, requestId);
    if (!this.hasTable("automation_reservations")) return undefined;
    const row = this.db.prepare("SELECT payload,state,updated_at FROM automation_reservations WHERE owner=? AND request_id=?").get(owner, requestId) as ReservationRow | undefined;
    return row ? this.decode(row) : undefined;
  }
  private receipts(owner: string, id: string) {
    return (this.db.prepare("SELECT payload,state,updated_at FROM automation_reservations WHERE owner=? AND rule_id=?").all(owner, id) as ReservationRow[]).map(row => this.decode(row));
  }
  private capacity(extra: string, rule: boolean, creating = true) {
    const rules = this.db.prepare("SELECT count(*) AS n,coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes FROM automation_rules").get() as { n: number; bytes: number };
    const receipts = this.db.prepare("SELECT count(*) AS n,coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes FROM automation_reservations").get() as { n: number; bytes: number };
    if (creating && (rule ? rules.n >= AUTOMATION_STORE_LIMITS.rules : receipts.n >= AUTOMATION_STORE_LIMITS.receipts)
      || rules.bytes + receipts.bytes + Buffer.byteLength(extra) > AUTOMATION_STORE_LIMITS.bytes) throw new AutomationStoreConflict("capacity");
  }
  /** Every edit advances revision AND authority epoch. A retry of the current
   * identical revision returns the same value. Target changes require a new ID;
   * edits cannot clear occupied lifetime counts or resurrect a revoked rule. */
  save(owner: string, input: AutomationRule, template: string, expectedRevision: number): StoredAutomationRule {
    const rule = readAutomationRule(input);
    if (!rule || rule.target.ownerId !== owner || !time(expectedRevision) || rule.revision !== expectedRevision + 1
      || typeof template !== "string" || !template.trim() || template.length > 8192 || Buffer.byteLength(template) > 32768 || template.includes("\0")) throw new Error("Invalid automation configuration");
    // Canonical key order makes config retries independent of JSON field order.
    const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)])) : value;
    const stored: StoredAutomationRule = { rule: stable(rule) as AutomationRule, template, templateHash: hash(template), revoked: false };
    return this.transaction(() => {
      const prior = this.rule(owner, rule.id);
      if (prior?.revoked) throw new AutomationStoreConflict("revoked");
      if (prior && JSON.stringify(prior) === JSON.stringify(stored)) return prior;
      if ((prior?.rule.revision ?? 0) !== expectedRevision || rule.authorityEpoch !== (prior?.rule.authorityEpoch ?? 0) + 1
        || prior && targetKey(prior.rule) !== targetKey(rule)) throw new AutomationStoreConflict("revision-or-target");
      this.capacity(JSON.stringify(stored), true, !prior);
      this.db.prepare("INSERT INTO automation_rules(owner,id,payload) VALUES(?,?,?) ON CONFLICT(owner,id) DO UPDATE SET payload=excluded.payload")
        .run(owner, rule.id, JSON.stringify(stored));
      // Only undispatched work can be safely released. In-flight/unknown work
      // retains its count and exact request ID for reconciliation.
      this.db.prepare("UPDATE automation_reservations SET state=?,updated_at=? WHERE owner=? AND rule_id=? AND state=?")
        .run("cancelled", this.now(), owner, rule.id, "reserved");
      return stored;
    });
  }
  revoke(owner: string, id: string, expectedRevision: number): StoredAutomationRule {
    this.scope(owner, id);
    return this.transaction(() => {
      const prior = this.rule(owner, id);
      if (!prior || prior.rule.revision !== expectedRevision) throw new AutomationStoreConflict("revision");
      if (prior.revoked) return prior;
      const rule = readAutomationRule({ ...prior.rule, enabled: false, revision: prior.rule.revision + 1, authorityEpoch: prior.rule.authorityEpoch + 1 });
      if (!rule) throw new AutomationStoreConflict("revision-overflow");
      const next = { ...prior, rule, revoked: true };
      this.db.prepare("UPDATE automation_rules SET payload=?,revoked=1 WHERE owner=? AND id=?").run(JSON.stringify(next), owner, id);
      this.db.prepare("UPDATE automation_reservations SET state=?,updated_at=? WHERE owner=? AND rule_id=? AND state=?")
        .run("cancelled", this.now(), owner, id, "reserved");
      return next;
    });
  }
  reserve(owner: string, id: string, trigger: AutomationTrigger, observed: AutomationObservation): AutomationReservation {
    this.scope(owner, id);
    return this.transaction(() => {
      const stored = this.rule(owner, id);
      if (!stored || stored.revoked) throw new AutomationStoreConflict("missing-or-revoked");
      const all = this.receipts(owner, id), at = this.now();
      const view = { ...observed, now: at };
      // First establish trusted target/trigger eligibility, then return an old
      // receipt. Unknown is never a fresh reservation or permission to retry.
      const identity = evaluateAutomation(stored.rule, trigger, { occupied: 0, reservedAt: [], consumedTriggers: new Set() }, view);
      if (!identity.eligible) throw new AutomationStoreConflict(identity.reason);
      const prior = all.find(r => r.triggerKey === identity.triggerKey);
      if (prior) return prior;
      const times = all.map(r => r.reservedAt);
      const decision = evaluateAutomation(stored.rule, trigger, {
        occupied: all.filter(r => occupied(r.state)).length, reservedAt: times.filter(n => n > at - 3_600_000),
        ...(times.length ? { lastReservedAt: Math.max(...times) } : {}), consumedTriggers: new Set(all.map(r => r.triggerKey)),
      }, view);
      if (!decision.eligible) throw new AutomationStoreConflict(decision.reason);
      if (all.length >= AUTOMATION_STORE_LIMITS.receiptsPerRule) throw new AutomationStoreConflict("capacity");
      const reservation: AutomationReservation = { requestId: randomUUID(), triggerKey: decision.triggerKey,
        trigger: structuredClone(trigger), snapshot: stored, reservedAt: at, updatedAt: at, state: "reserved" };
      this.capacity(JSON.stringify(reservation), false);
      this.db.prepare("INSERT INTO automation_reservations VALUES(?,?,?,?,?,?,?)")
        .run(owner, id, reservation.requestId, reservation.triggerKey, JSON.stringify(reservation), reservation.state, at);
      return reservation;
    });
  }
  /** Exactly one caller can claim a reservation. After a crash at this boundary
   * query the ORIGINAL request; there is no lease expiry or automatic resend. */
  beginDispatch(owner: string, requestId: string, observed: AutomationObservation): { claimed: boolean; receipt: AutomationReservation } {
    this.scope(owner, requestId);
    // A SAVEPOINT release is not durable: an outer rollback after a send could
    // resurrect the reservation. Claim must commit before returning authority
    // to the future dispatcher (which must still hold the admission fence).
    if (this.db.isTransaction) throw new AutomationStoreConflict("dispatch-requires-top-level-commit");
    return this.transaction(() => {
      const receipt = this.receipt(owner, requestId);
      if (!receipt) throw new AutomationStoreConflict("missing");
      if (receipt.state !== "reserved") return { claimed: false, receipt };
      const current = this.rule(owner, receipt.snapshot.rule.id), at = this.now();
      if (!current || current.revoked || current.rule.revision !== receipt.snapshot.rule.revision
        || current.rule.authorityEpoch !== receipt.snapshot.rule.authorityEpoch || at < receipt.reservedAt) throw new AutomationStoreConflict("authority-or-clock");
      const decision = evaluateAutomation(current.rule, receipt.trigger,
        { occupied: 0, reservedAt: [], consumedTriggers: new Set() }, { ...observed, now: at });
      if (!decision.eligible) throw new AutomationStoreConflict(decision.reason);
      this.db.prepare("UPDATE automation_reservations SET state=?,updated_at=? WHERE owner=? AND request_id=?").run("dispatching", at, owner, requestId);
      return { claimed: true, receipt: { ...receipt, state: "dispatching", updatedAt: at } };
    });
  }
  /** Evidence comes from the trusted queue adapter/original-request query, NOT
   * from an HTTP client or a timeout. Only confirmed non-acceptance frees count. */
  settle(owner: string, requestId: string, evidence: "unknown" | "accepted" | "confirmed-not-accepted"): AutomationReservation {
    this.scope(owner, requestId);
    if (!["unknown", "accepted", "confirmed-not-accepted"].includes(evidence)) throw new Error("Invalid automation evidence");
    return this.transaction(() => {
      const receipt = this.receipt(owner, requestId);
      if (!receipt) throw new AutomationStoreConflict("missing");
      const state = evidence === "accepted" ? "queued" : evidence === "unknown" ? "unknown" : "rejected";
      if (receipt.state === state) return receipt;
      if (!["dispatching", "unknown"].includes(receipt.state)) throw new AutomationStoreConflict("terminal-or-unclaimed");
      const at = this.now();
      if (at < receipt.updatedAt) throw new AutomationStoreConflict("clock");
      this.db.prepare("UPDATE automation_reservations SET state=?,updated_at=? WHERE owner=? AND request_id=?").run(state, at, owner, requestId);
      return { ...receipt, state, updatedAt: at };
    });
  }
}
