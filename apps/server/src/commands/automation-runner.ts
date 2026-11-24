import { createHash } from 'node:crypto';
import { AutomationStore, AutomationStoreConflict, type AutomationReservation } from './automation-store.js';
import type { AutomationObservation, AutomationTarget } from './automation-policy.js';

export type AutomationQueueCommand = { requestId: string; target: AutomationTarget; fingerprint: string; template: string };
export type AutomationQueueEvidence = { requestId: string; fingerprint: string; outcome: 'accepted' | 'confirmed-not-accepted' | 'unknown' };
export type AutomationAdmissionContext = { ruleId: string; revision: number; authorityEpoch: number };
export interface AutomationQueueAdapter {
  /** A future concrete adapter MUST hold the target's queue/admission fence
   * from observe through enqueue. No async discovery between those two steps.
   * Returning accepted proves queue admission only, never native completion. */
  withAdmission<T>(target: AutomationTarget, run: (observation: AutomationObservation,
    enqueue: (command: AutomationQueueCommand) => Promise<AutomationQueueEvidence>) => Promise<T>, context: AutomationAdmissionContext): Promise<T>;
  /** Original identity lookup only. Missing/timeout is unknown, NOT rejection. */
  queryOriginal(target: AutomationTarget, requestId: string, fingerprint: string): Promise<AutomationQueueEvidence>;
}
const terminal = (r: AutomationReservation) => ['queued', 'rejected', 'cancelled'].includes(r.state);
export const automationQueueCommand = (receipt: AutomationReservation): AutomationQueueCommand => ({
  requestId: receipt.requestId, target: structuredClone(receipt.snapshot.rule.target), template: receipt.snapshot.template,
  fingerprint: createHash('sha256').update(JSON.stringify([receipt.requestId, receipt.triggerKey, receipt.snapshot])).digest('hex'),
});
/** Internal bridge only; not instantiated by a scheduler or HTTP route.
 * No auto-retry, new request IDs or catch-up sends. The durable dispatch claim
 * precedes queue IO; restart uses queryOriginal even if the crash was pre-IO. */
export class AutomationRunner {
  constructor(private readonly store: AutomationStore, private readonly adapter: AutomationQueueAdapter,
    private readonly authorized: (owner: string, receipt: AutomationReservation) => boolean) {}
  private read(owner: string, requestId: string) {
    const receipt = this.store.receipt(owner, requestId);
    if (!receipt || !this.authorized(owner, receipt)) throw new AutomationStoreConflict('forbidden-or-missing');
    return receipt;
  }
  private settle(owner: string, requestId: string, evidence: AutomationQueueEvidence) {
    const current = this.read(owner, requestId), command = automationQueueCommand(current);
    if (terminal(current)) return current; // A late timeout cannot undo original-query success.
    if (!evidence || evidence.requestId !== requestId || evidence.fingerprint !== command.fingerprint
      || !['accepted', 'confirmed-not-accepted', 'unknown'].includes(evidence.outcome)) throw new AutomationStoreConflict('queue-evidence');
    return this.store.settle(owner, requestId, evidence.outcome);
  }
  private markUnknown(owner: string, requestId: string) {
    const current = this.read(owner, requestId);
    return current.state === 'dispatching' ? this.store.settle(owner, requestId, 'unknown') : current;
  }
  async dispatch(owner: string, requestId: string): Promise<AutomationReservation> {
    const initial = this.read(owner, requestId);
    if (initial.state !== 'reserved') return initial;
    return this.adapter.withAdmission(initial.snapshot.rule.target, async (view, enqueue) => {
      this.read(owner, requestId); // Recheck after asynchronous fence acquisition.
      const claim = this.store.beginDispatch(owner, requestId, view);
      if (!claim.claimed) return claim.receipt;
      const command = automationQueueCommand(claim.receipt);
      try { return this.settle(owner, requestId, await enqueue(command)); }
      catch { return this.markUnknown(owner, requestId); }
    }, { ruleId: initial.snapshot.rule.id, revision: initial.snapshot.rule.revision, authorityEpoch: initial.snapshot.rule.authorityEpoch });
  }
  async recover(owner: string, requestId: string): Promise<AutomationReservation> {
    const receipt = this.read(owner, requestId);
    if (receipt.state === 'reserved' || terminal(receipt)) return receipt;
    const command = automationQueueCommand(receipt);
    try { return this.settle(owner, requestId, await this.adapter.queryOriginal(command.target, requestId, command.fingerprint)); }
    catch { return this.markUnknown(owner, requestId); }
  }
}
