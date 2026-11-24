import type { DatabaseSync } from 'node:sqlite';
import { AutomationStore, AutomationStoreConflict } from './automation-store.js';
import { evaluateAutomation, type AutomationObservation, type AutomationTarget } from './automation-policy.js';
import { automationQueueCommand, type AutomationAdmissionContext, type AutomationQueueAdapter,
  type AutomationQueueCommand, type AutomationQueueEvidence } from './automation-runner.js';
import type { TurnQueue, TurnQueueCommit } from './turn-queue.js';

export type AutomationRuntimeObservation = Omit<AutomationObservation, 'target' | 'revision' | 'authorityEpoch' | 'queueEmpty'>;
export type NativeAutomationSender = (command: AutomationQueueCommand, commit: TurnQueueCommit) => Promise<unknown>;
const targetKey = (t: AutomationTarget) => JSON.stringify([t.ownerId, t.connectionId, t.runtime, t.sessionId]);

/** Real TurnQueue transaction adapter. The injected native driver must use its
 * normal send admission callback; it must NOT start native work directly.
 * Existing worker Goal/history/authorization checks remain authoritative.
 * Merely constructing this adapter never schedules or sends a message. */
export class AutomationTurnQueueAdapter implements AutomationQueueAdapter {
  private readonly active = new Set<string>();
  constructor(private readonly db: DatabaseSync, private readonly queue: TurnQueue, private readonly store: AutomationStore,
    private readonly observe: (target: AutomationTarget) => AutomationRuntimeObservation,
    private readonly authorized: (target: AutomationTarget) => boolean,
    private readonly send: NativeAutomationSender) {
    db.exec(`CREATE TABLE IF NOT EXISTS automation_queue_receipts (
      owner TEXT NOT NULL, request TEXT NOT NULL, target TEXT NOT NULL, fingerprint TEXT NOT NULL,
      runtime TEXT NOT NULL, native_id TEXT NOT NULL, PRIMARY KEY(owner,request));`);
  }
  private view(target: AutomationTarget, context: AutomationAdmissionContext, queueEmpty: boolean): AutomationObservation {
    if (!this.authorized(target)) throw new AutomationStoreConflict('forbidden');
    return { ...this.observe(target), target, revision: context.revision, authorityEpoch: context.authorityEpoch, queueEmpty };
  }
  async withAdmission<T>(target: AutomationTarget, run: (view: AutomationObservation,
    enqueue: (command: AutomationQueueCommand) => Promise<AutomationQueueEvidence>) => Promise<T>, context: AutomationAdmissionContext): Promise<T> {
    const key = targetKey(target);
    if (this.active.has(key) || this.active.size >= 16) throw new AutomationStoreConflict('admission-busy');
    this.active.add(key);
    let open = true, invoked = false;
    try {
      const view = this.view(target, context, !this.queue.hasPending(target.runtime, target.sessionId));
      return await run(view, async command => {
        if (!open || invoked || targetKey(command.target) !== key) throw new AutomationStoreConflict('admission-reused');
        invoked = true;
        const original = await this.queryOriginal(target, command.requestId, command.fingerprint);
        if (original.outcome === 'accepted') return original;
        // The native driver can perform asynchronous work. Authority, revision,
        // maintenance, idle/Goal observation and queue are rechecked at COMMIT.
        await this.send(command, (db, turn) => {
          if (!open || db !== this.db || !db.isTransaction || !turn || turn.mirror
            || turn.runtime !== target.runtime || turn.sessionKey !== target.sessionId
            || turn.actorId !== target.ownerId) throw new AutomationStoreConflict('queue-transaction');
          const receipt = this.store.receipt(target.ownerId, command.requestId);
          const current = this.store.read(target.ownerId, context.ruleId);
          if (!receipt || receipt.state !== 'dispatching' || !current || current.revoked
            || current.rule.id !== receipt.snapshot.rule.id || current.rule.revision !== context.revision
            || current.rule.authorityEpoch !== context.authorityEpoch || !current.rule.enabled
            || targetKey(current.rule.target) !== key
            || JSON.stringify(automationQueueCommand(receipt)) !== JSON.stringify(command)) throw new AutomationStoreConflict('authority-or-command');
          const fresh = this.view(target, context, this.queue.canAdmitAutomationInTransaction(db, turn.runtime, turn.sessionKey, turn.id));
          const eligible = evaluateAutomation(current.rule, receipt.trigger,
            { occupied: 0, reservedAt: [], consumedTriggers: new Set() }, fresh);
          if (!eligible.eligible) throw new AutomationStoreConflict(eligible.reason);
          if (Number(db.prepare('SELECT count(*) n FROM automation_queue_receipts').get()!.n) >= 20000) throw new AutomationStoreConflict('queue-receipt-capacity');
          // No UPSERT: a second accepted native row must roll back, including
          // concurrent adapters and restarts, even if the request is identical.
          db.prepare('INSERT INTO automation_queue_receipts VALUES(?,?,?,?,?,?)')
            .run(target.ownerId, command.requestId, key, command.fingerprint, turn.runtime, turn.id);
        });
        return this.queryOriginal(target, command.requestId, command.fingerprint);
      });
    } finally { open = false; this.active.delete(key); }
  }
  async queryOriginal(target: AutomationTarget, requestId: string, fingerprint: string): Promise<AutomationQueueEvidence> {
    if (!this.authorized(target)) throw new AutomationStoreConflict('forbidden');
    const row = this.db.prepare('SELECT target,fingerprint FROM automation_queue_receipts WHERE owner=? AND request=?')
      .get(target.ownerId, requestId);
    if (row && (row.target !== targetKey(target) || row.fingerprint !== fingerprint)) throw new AutomationStoreConflict('queue-identity');
    // Queue rows are ephemeral; durable admission receipt survives consumption.
    return { requestId, fingerprint, outcome: row ? 'accepted' : 'unknown' };
  }
}
