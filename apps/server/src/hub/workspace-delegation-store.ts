import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { observedTransaction } from '../storage/observed-transaction.js';
import { observedParticipant } from '../storage/observed-participant.js';
import { validBoardUuid } from "@agentopsdeck/shared";
import { BOARD_CAPABILITY_TTL_MS, type BoardCapabilityInput } from "./workspace-board-capabilities.js";
import { createDelegationPreview, delegationPreviewCurrent, type DelegationPreview, type DelegationPreviewInput,
  type DelegationMember } from "./workspace-delegation-preview.js";

export const DELEGATION_STORE_LIMITS = { batches: 1024, bytes: 32 * 1024 * 1024, concurrency: 4 } as const;
export type DelegationMemberState = "prepared" | "dispatching" | "installed" | "rejected" | "unknown"
  | "cancelled" | "cleanup_pending" | "revoked";
export type DelegationReceipt = {
  requestId: string; member: DelegationMember; state: DelegationMemberState; bindingId: string | null;
  reason: "authority-changed" | "expired" | "provider-rejected" | null; updatedAt: number;
};
export type DelegationBatch = {
  owner: string; batchId: string; fingerprint: string; preview: DelegationPreview; grantExpiresAt: number;
  state: "prepared" | "confirmed" | "cancelled"; members: DelegationReceipt[];
};
export type DelegationIntent = {
  owner: string; batchId: string; boardId: string; boardRevision: number; requestId: string;
  member: DelegationMember; grant: BoardCapabilityInput;
};
export type DelegationOutcome = { requestId: string; state: "installed"; bindingId: string }
  | { requestId: string; state: "rejected" | "unknown" };
export class DelegationConflict extends Error {}
const text = (v: string) => typeof v === "string" && v.length > 0 && v.length <= 2048
  && v === v.trim() && !/[\u0000-\u001f\u007f]/.test(v);
const time = (v: number) => Number.isSafeInteger(v) && v >= 0;
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const final = (state: DelegationMemberState) => ["installed", "rejected", "cancelled", "revoked"].includes(state);

/** Internal durable coordination, not an authorization endpoint. Uses an existing
 * owner database, never opens a live Connector DB. Callers authenticate reads and
 * provide SERVER-OWNED catalogs/preflights. No credentials or arbitrary error text
 * are persisted. Receipts and cancellation tombstones are not age-pruned. */
export class DelegationStore {
  constructor(private readonly db: DatabaseSync, private readonly clock: () => number = Date.now) {}
  private scope(owner: string, id: string) {
    if (!text(owner) || !validBoardUuid(id)) throw new DelegationConflict("scope");
  }
  private now() { const at = this.clock(); if (!time(at)) throw new DelegationConflict("clock"); return at; }
  private schema() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS hub_delegation_batches (
      owner TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, budget_bytes INTEGER NOT NULL, PRIMARY KEY(owner,id));
      CREATE TABLE IF NOT EXISTS hub_delegation_cancellations (
      owner TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(owner,id));`);
  }
  private exists(table: string) {
    return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type=? AND name=?").get("table", table);
  }
  private atomic<T>(fn: () => T extends PromiseLike<unknown> ? never : T): T {
    return observedTransaction(this.db, 'delegation-store-change', () => { this.schema(); return fn(); }, undefined, true);
  }
  private committed() {
    // Otherwise an outer rollback could resurrect already-dispatched work.
    if (this.db.isTransaction) throw new DelegationConflict("top-level-commit-required");
  }
  read(owner: string, id: string): DelegationBatch | undefined {
    this.scope(owner, id);
    if (!this.exists("hub_delegation_batches")) return;
    const row = this.db.prepare("SELECT payload FROM hub_delegation_batches WHERE owner=? AND id=?").get(owner, id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as DelegationBatch : undefined;
  }
  private required(owner: string, id: string) {
    const value = this.read(owner, id); if (!value) throw new DelegationConflict("missing"); return value;
  }
  private member(batch: DelegationBatch, requestId: string) {
    if (!validBoardUuid(requestId)) throw new DelegationConflict("request");
    const member = batch.members.find(m => m.requestId === requestId);
    if (!member) throw new DelegationConflict("request"); return member;
  }
  private capacity(extra: number, adding = false) {
    const rows = this.db.prepare("SELECT count(*) AS n,coalesce(sum(budget_bytes),0) AS bytes FROM hub_delegation_batches").get() as { n: number; bytes: number };
    const tombstones = this.db.prepare("SELECT count(*) AS n FROM hub_delegation_cancellations").get() as { n: number };
    if ((adding && rows.n >= DELEGATION_STORE_LIMITS.batches) || tombstones.n > DELEGATION_STORE_LIMITS.batches
      || rows.bytes + extra > DELEGATION_STORE_LIMITS.bytes) throw new DelegationConflict("capacity");
  }
  private save(batch: DelegationBatch, adding = false) {
    const payload = JSON.stringify(batch);
    const previous = this.db.prepare("SELECT budget_bytes AS bytes FROM hub_delegation_batches WHERE owner=? AND id=?")
      .get(batch.owner, batch.batchId) as { bytes: number } | undefined;
    // Reserve all bounded receipt growth up front. A full store must still be
    // able to record outcomes and cancellation for already-admitted batches.
    const budget = previous?.bytes ?? Buffer.byteLength(payload) + batch.members.length * 256 + 128;
    if (Buffer.byteLength(payload) > budget) throw new DelegationConflict("receipt-capacity");
    this.capacity(previous ? 0 : budget, adding);
    this.db.prepare("INSERT INTO hub_delegation_batches VALUES (?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET payload=excluded.payload")
      .run(batch.owner, batch.batchId, payload, budget);
    return batch;
  }
  prepare(owner: string, batchId: string, input: DelegationPreviewInput, grantExpiresAt: number, guard?: () => unknown) {
    this.scope(owner, batchId);
    if (owner !== input.owner || !time(grantExpiresAt)) throw new DelegationConflict("scope-or-expiry");
    const at = this.now(), preview = createDelegationPreview(input, at);
    const fingerprint = digest([preview.fingerprint, grantExpiresAt]);
    return this.atomic(() => {
      if (guard) observedParticipant(this.db, 'delegation-authority-check', guard);
      const previous = this.read(owner, batchId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new DelegationConflict("batch-reused");
        return previous;
      }
      if (this.db.prepare("SELECT 1 FROM hub_delegation_cancellations WHERE owner=? AND id=?").get(owner, batchId)) throw new DelegationConflict("cancelled");
      if (!preview.confirmable || grantExpiresAt <= at || grantExpiresAt - at > BOARD_CAPABILITY_TTL_MS) throw new DelegationConflict("not-confirmable");
      const batch: DelegationBatch = { owner, batchId, fingerprint, preview, grantExpiresAt, state: "prepared",
        members: preview.members.map(member => ({ requestId: randomUUID(), member, state: "prepared", bindingId: null, reason: null, updatedAt: at })) };
      return this.save(batch, true);
    });
  }
  confirm(owner: string, id: string, current: DelegationPreviewInput, guard?: () => unknown) {
    this.scope(owner, id);
    return this.atomic(() => {
      if (guard) observedParticipant(this.db, 'delegation-authority-check', guard);
      const batch = this.required(owner, id);
      if (batch.state === "cancelled") throw new DelegationConflict("cancelled");
      // Repeated confirmations return the original result, never expand members.
      if (batch.state === "confirmed") return batch;
      const at = this.now();
      if (at >= batch.grantExpiresAt || !delegationPreviewCurrent(batch.preview, current, at)) throw new DelegationConflict("preview-changed-or-expired");
      batch.state = "confirmed"; return this.save(batch);
    });
  }
  intent(batch: DelegationBatch, member: DelegationReceipt): DelegationIntent {
    return structuredClone({ owner: batch.owner, batchId: batch.batchId, boardId: batch.preview.resource.resourceId,
      boardRevision: batch.preview.resource.revision, requestId: member.requestId, member: member.member,
      grant: { taskIds: batch.preview.resource.tasks.map(t => t.id), fields: batch.preview.resource.fields,
        expiresAt: batch.grantExpiresAt } });
  }
  /** Synchronous authoritative check inside the claim transaction. No async I/O
   * or grants in authorize. The adapter must fence again at its actual write. */
  claim(owner: string, id: string, requestId: string, authorize: (intent: DelegationIntent) => boolean,
    prepareEffect?: (intent: DelegationIntent) => unknown) {
    this.scope(owner, id); this.committed();
    return this.atomic(() => {
      const batch = this.required(owner, id), member = this.member(batch, requestId);
      if (batch.state !== "confirmed" || member.state !== "prepared") return { claimed: false, receipt: member };
      const at = this.now();
      if (at < batch.preview.createdAt || at >= batch.grantExpiresAt
        || observedParticipant(this.db, 'delegation-authority-check', () => authorize(this.intent(batch, member))) !== true) {
        member.state = "rejected"; member.reason = at < batch.preview.createdAt || at >= batch.grantExpiresAt ? "expired" : "authority-changed";
        member.updatedAt = at; this.save(batch); return { claimed: false, receipt: member };
      }
      if (batch.members.filter(m => m.state === "dispatching" || m.state === "unknown").length >= DELEGATION_STORE_LIMITS.concurrency)
        return { claimed: false, receipt: member };
      member.state = "dispatching"; member.updatedAt = at; this.save(batch);
      // The private binding/capability/vault participant shares THIS root
      // commit. Its result is inspected even if the outer caller discards it;
      // no credential may leave the worker before this transaction commits.
      if (prepareEffect) observedParticipant(this.db, 'delegation-authority-check', () => prepareEffect(this.intent(batch, member)));
      return { claimed: true, receipt: member };
    });
  }
  canWrite(owner: string, id: string, requestId: string, authorize: (intent: DelegationIntent) => boolean) {
    this.committed();
    const batch = this.required(owner, id), member = this.member(batch, requestId), at = this.now();
    return batch.state === "confirmed" && member.state === "dispatching" && at >= batch.preview.createdAt
      && at < batch.grantExpiresAt
      && observedParticipant(this.db, 'delegation-authority-check', () => authorize(this.intent(batch, member))) === true;
  }
  settle(owner: string, id: string, outcome: DelegationOutcome, guard?: () => unknown) {
    this.scope(owner, id);
    if (!["installed", "rejected", "unknown"].includes(outcome.state)
      || (outcome.state === "installed" && !validBoardUuid(outcome.bindingId))) throw new DelegationConflict("outcome");
    return this.atomic(() => {
      if (guard) observedParticipant(this.db, 'delegation-authority-check', guard);
      const batch = this.required(owner, id), member = this.member(batch, outcome.requestId);
      if (member.state === "prepared") throw new DelegationConflict("unclaimed");
      if (final(member.state)) {
        if (member.state === outcome.state && (outcome.state !== "installed" || member.bindingId === outcome.bindingId)) return member;
        // Late callbacks never resurrect cancellations or regress final success.
        if (member.state === "revoked" || member.state === "cancelled" || outcome.state === "unknown") return member;
        throw new DelegationConflict("terminal-outcome");
      }
      if (outcome.state === "installed") {
        if (member.bindingId !== null && member.bindingId !== outcome.bindingId) throw new DelegationConflict("binding-changed");
        member.bindingId = outcome.bindingId;
      }
      if (batch.state !== "cancelled") {
        member.state = outcome.state; member.reason = outcome.state === "rejected" ? "provider-rejected" : null;
      }
      member.updatedAt = Math.max(member.updatedAt, this.now()); this.save(batch); return member;
    });
  }
  /** This is a cancellation INTENT, not proof of capability revocation. All
   * dispatched items stay cleanup_pending until the adapter confirms fencing. */
  cancel(owner: string, id: string, guard?: () => unknown, revoke?: (batch: DelegationBatch) => unknown) {
    this.scope(owner, id); this.committed();
    return this.atomic(() => {
      if (guard) observedParticipant(this.db, 'delegation-authority-check', guard);
      const batch = this.read(owner, id);
      const exists = this.db.prepare("SELECT 1 FROM hub_delegation_cancellations WHERE owner=? AND id=?").get(owner, id);
      // Existing batches retain their own terminal state. Reserve the separate
      // tombstone table for cancellation that arrived BEFORE preparation.
      if (!batch && !exists) {
        const count = this.db.prepare("SELECT count(*) AS n FROM hub_delegation_cancellations").get() as { n: number };
        if (count.n >= DELEGATION_STORE_LIMITS.batches) throw new DelegationConflict("capacity");
        this.db.prepare("INSERT INTO hub_delegation_cancellations VALUES (?,?)").run(owner, id);
      }
      if (!batch) return;
      batch.state = "cancelled";
      for (const m of batch.members) {
        if (m.state === "prepared") m.state = "cancelled";
        else if (["dispatching", "installed", "unknown"].includes(m.state)) m.state = "cleanup_pending";
      }
      this.save(batch);
      if (revoke) observedParticipant(this.db, 'delegation-authority-check', () => revoke(batch));
      return batch;
    });
  }
  finishCancellation(owner: string, id: string, requestId: string, guard?: () => unknown) {
    this.scope(owner, id);
    return this.atomic(() => {
      if (guard) observedParticipant(this.db, 'delegation-authority-check', guard);
      const batch = this.required(owner, id), member = this.member(batch, requestId);
      if (batch.state !== "cancelled") throw new DelegationConflict("not-cancelled");
      if (member.state === "cleanup_pending") {
        member.state = "revoked"; member.updatedAt = Math.max(member.updatedAt, this.now()); this.save(batch);
      }
      return member;
    });
  }
}
