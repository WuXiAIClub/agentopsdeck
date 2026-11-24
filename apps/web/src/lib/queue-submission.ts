import { api, recoveryScope } from '../api';
import { CommandJournal, CommandNotSubmittedError, mutateQueueWithJournal, newCommandKey, type QueueMutation } from './command-recovery';

/** Owner/shared queue controls share one journal and one mutation attempt.
 * messageId is the original browser command key for shared sessions. */
export async function mutateQueueWithRecovery(scope: string | undefined, sessionKey: string,
  action: QueueMutation['action'], messageId: string, version: string, text = '') {
  if (!scope || recoveryScope() !== scope) throw new CommandNotSubmittedError('Account changed; reload before modifying the queue');
  const key = `queue-${action}.${newCommandKey()}`;
  try {
    await mutateQueueWithJournal(new CommandJournal(window.sessionStorage), scope, sessionKey, key, { action, messageId },
      () => action === 'edit' ? api.updateQueuedMessage(sessionKey, messageId, text, version, key, scope)
        : api.cancelQueuedMessage(sessionKey, messageId, version, key, scope),
      async () => {
        if (recoveryScope() !== scope) throw new Error('Account changed');
        const result = await api.queueMutationCommand(sessionKey, messageId, key, scope);
        if (recoveryScope() !== scope) throw new Error('Account changed');
        return result.command;
      });
  } finally { window.dispatchEvent(new CustomEvent('agentopsdeck:commands-changed')); }
}
