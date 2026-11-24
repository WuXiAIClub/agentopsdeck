import { DELEGATION_STORE_LIMITS, DelegationStore, type DelegationIntent, type DelegationOutcome } from "./workspace-delegation-store.js";

/** Server adapter contract, never browser-provided callbacks.
 * authorize: synchronous current owner/resource revision, exact node/runtime/
 * session/epoch and task-field permission check, not a tag membership check.
 * install: uses ONLY intent.requestId; must call beforeWrite after all awaits and
 * immediately before issuing/installing. Existing binding authority/revocation
 * fences still apply. No automatic send, new session, or whole-file capability.
 * query: read the ORIGINAL durable binding request, never install or replay.
 * cancel: durably fence that request first (even if not installed yet). Return
 * revoked only when both access revocation and remote cleanup are confirmed;
 * missing/unknown remote evidence is cleanup_pending, not successful deletion.
 */
export type DelegationAdapter = {
  authorize: (intent: DelegationIntent) => boolean;
  install: (intent: DelegationIntent, beforeWrite: () => boolean) => Promise<DelegationOutcome>;
  query: (intent: DelegationIntent) => Promise<DelegationOutcome>;
  cancel: (intent: DelegationIntent) => Promise<"revoked" | "cleanup_pending">;
};

/** Internal coordinator. Not registered with HTTP routes/schedulers. All writes
 * require explicit calls; restart alone does not resume or retry installations. */
export class DelegationRunner {
  constructor(private readonly store: DelegationStore, private readonly adapter: DelegationAdapter) {}
  private async bounded<T>(items: T[], action: (item: T) => Promise<void>) {
    let next = 0, stopped = false;
    const results = await Promise.allSettled(Array.from({ length: Math.min(items.length, DELEGATION_STORE_LIMITS.concurrency) }, async () => {
      try { while (!stopped && next < items.length) { const item = items[next++]!; await action(item); } }
      catch (error) { stopped = true; throw error; }
    }));
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    // Do not report completion while another worker is still performing I/O.
    if (failures.length) throw new AggregateError(failures.map(r => r.reason), "Delegation operation incomplete");
  }
  async run(owner: string, batchId: string) {
    const batch = this.store.read(owner, batchId); if (!batch) return;
    await this.bounded(batch.members, async member => {
      const claim = this.store.claim(owner, batchId, member.requestId, intent => this.adapter.authorize(intent));
      if (!claim.claimed) return;
      const intent = this.store.intent(batch, claim.receipt);
      let outcome: DelegationOutcome;
      try {
        outcome = await this.adapter.install(intent, () => this.store.canWrite(owner, batchId, member.requestId,
          current => this.adapter.authorize(current)));
        if (outcome.requestId !== member.requestId) throw new Error("Mismatched binding receipt");
        this.store.settle(owner, batchId, outcome);
      } catch {
        // A throw/timeout/malformed response is NOT proof that installation failed.
        // Do not persist raw errors: they may contain endpoints or credentials.
        this.store.settle(owner, batchId, { requestId: member.requestId, state: "unknown" });
      }
    });
    return this.store.read(owner, batchId);
  }
  async reconcile(owner: string, batchId: string) {
    const batch = this.store.read(owner, batchId); if (!batch) return;
    await this.bounded(batch.members.filter(m => m.state === "dispatching" || m.state === "unknown"), async member => {
      try {
        const outcome = await this.adapter.query(this.store.intent(batch, member));
        if (outcome.requestId === member.requestId) this.store.settle(owner, batchId, outcome);
      } catch { /* Keep the original unknown/in-flight receipt, never redispatch. */ }
    });
    return this.store.read(owner, batchId);
  }
  async cancel(owner: string, batchId: string) {
    const batch = this.store.cancel(owner, batchId); if (!batch) return;
    await this.bounded(batch.members.filter(m => m.state === "cleanup_pending"), async member => {
      try {
        if (await this.adapter.cancel(this.store.intent(batch, member)) === "revoked")
          this.store.finishCancellation(owner, batchId, member.requestId);
      } catch { /* Tombstone is committed; report cleanup pending for this member. */ }
    });
    return this.store.read(owner, batchId);
  }
}
