import type { DatabaseSync } from 'node:sqlite';
import type { CodexAppServer } from '../codex/app-server.js';
import type { TurnQueue } from '../commands/turn-queue.js';
import { AutomationStore, AutomationStoreConflict } from '../commands/automation-store.js';
import { AutomationConfigurationStore } from '../commands/automation-configuration.js';
import { AutomationTurnQueueAdapter } from '../commands/automation-queue-adapter.js';
import { AutomationRunner, automationQueueCommand } from '../commands/automation-runner.js';
import { AutomationScheduler } from '../commands/automation-scheduler.js';
import type { AutomationTarget } from '../commands/automation-policy.js';

/** Internal composition on the runtime owner's existing connection. No timers
 * start here. The host must explicitly start/stop the returned scheduler.
 * Connector identity is configured authority, NOT a native child connection. */
export type CodexAutomationRuntime = Pick<CodexAppServer, 'owns' | 'automationObservation' | 'send' | 'takeAutomationCompletions'>;
export function createCodexAutomation(db: DatabaseSync, queue: TurnQueue, codex: CodexAutomationRuntime,
  options: { owner: string; connectionId: string; available: () => boolean;
    authorized: (target: AutomationTarget) => boolean }) {
  const authorized = (target: AutomationTarget) => target.ownerId === options.owner
    && target.connectionId === options.connectionId && target.runtime === 'codex'
    && codex.owns(target.sessionId) && options.authorized(target);
  const observe = (target: AutomationTarget) => {
    if (!authorized(target)) throw new AutomationStoreConflict('forbidden');
    const view = codex.automationObservation(target.sessionId, target.ownerId);
    return { ...view, admissionAllowed: view.admissionAllowed && options.available() };
  };
  const store = new AutomationStore(db);
  const config = new AutomationConfigurationStore(db, (owner, target) => owner === options.owner && authorized(target));
  const adapter = new AutomationTurnQueueAdapter(db, queue, store, observe, authorized,
    (command, commit) => codex.send(command.target.sessionId, command.template, [], {
      actorId: command.target.ownerId, accept: () => commit,
    }));
  const runner = new AutomationRunner(store, adapter, (owner, receipt) => owner === options.owner && authorized(receipt.snapshot.rule.target));
  const scheduler = new AutomationScheduler(options.owner, store, runner, (target, rule) => ({
    ...observe(target), target, revision: rule.revision, authorityEpoch: rule.authorityEpoch,
    queueEmpty: !queue.hasPending(target.runtime, target.sessionId),
  }), authorized);
  const pollCompleted = async () => {
    if (!options.available()) return;
    for (const event of codex.takeAutomationCompletions(options.owner)) {
      const target: AutomationTarget = { ownerId: options.owner, connectionId: options.connectionId,
        runtime: 'codex', sessionId: event.sessionKey };
      if (!authorized(target) || !options.available()) continue;
      const proofs = db.prepare('SELECT request,fingerprint FROM automation_queue_receipts WHERE owner=? AND runtime=? AND native_id=? LIMIT 2')
        .all(options.owner, 'codex', event.commandId);
      if (proofs.length > 1) continue;
      let originRuleId: string | undefined;
      if (proofs.length) {
        const proof = proofs[0]!, receipt = store.receipt(options.owner, String(proof.request));
        if (!receipt || !['dispatching', 'unknown', 'queued'].includes(receipt.state)
          || receipt.snapshot.rule.target.sessionId !== target.sessionId
          || !authorized(receipt.snapshot.rule.target)
          || automationQueueCommand(receipt).fingerprint !== proof.fingerprint) continue;
        const original = await adapter.queryOriginal(target, receipt.requestId, String(proof.fingerprint));
        if (original.outcome !== 'accepted') continue;
        originRuleId = receipt.snapshot.rule.id;
      }
      await scheduler.completed(target, { kind: 'completion', turnId: event.turnId,
        startedAt: event.startedAt, completedAt: event.completedAt, outcome: 'completed', operation: 'message',
        authoritative: true, historical: false, origin: originRuleId ? 'automation' : 'manual',
        ...(originRuleId ? { originRuleId } : {}) });
    }
  };
  return { store, config, runner, scheduler, pollCompleted };
}
