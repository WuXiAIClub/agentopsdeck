import { api, recoveryEpoch, recoveryScope } from '../api.js';
import { CommandJournal, CommandNotSubmittedError, CommandRejectedError, CreationOutcomeUnknownError, commandIdentity, createWithJournal, creationPath, creationReceiptState, newCommandKey, recoverSavedCommand, type CreationTarget, type PendingCommand } from './command-recovery.js';

// Only the live creation flow owns these records. Reloading loses this set,
// so interrupted flows remain recoverable from the persistent journal.
const activeCreations = new Set<string>();
export function isActiveSessionCreation(row: PendingCommand) {
  return !!row.creation && activeCreations.has(commandIdentity(row));
}

export async function createSessionWithRecovery(requestedTarget: CreationTarget, label: string,
  enterSession?: (created: { key: string }) => void | Promise<void>) {
  const target = { ...requestedTarget };
  const scope = recoveryScope();
  const epoch = recoveryEpoch();
  if (!scope) throw new CommandNotSubmittedError('Cannot identify the current Hub account; reload before creating');
  creationPath(target);
  let journal: CommandJournal;
  try { journal = new CommandJournal(window.sessionStorage); }
  catch { throw new CommandNotSubmittedError('Recovery storage unavailable; creation was not attempted'); }
  const check = () => { if (recoveryScope() !== scope || recoveryEpoch() !== epoch) throw new Error('Account changed'); };
  for (const existing of journal.list(scope, undefined, 'creation')) {
    if (
      existing.state !== 'rejected' &&
      existing.creation?.connectionId === target.connectionId &&
      existing.creation?.agentId === target.agentId &&
      existing.creation?.ownerUserId === target.ownerUserId
    ) {
      if (isActiveSessionCreation(existing)) throw new CreationOutcomeUnknownError(existing.key);
      const identity = commandIdentity(existing);
      activeCreations.add(identity);
      let created: { key: string } | undefined;
      try {
        const state = await recoverSavedCommand(journal, existing, async () => {
          check();
          const result = await api.creationCommand(existing.creation!, existing.key, scope);
          check();
          if (creationReceiptState(result.command, existing.key, target) === 'accepted') {
            created = { key: result.command.result!.body.key as string };
          }
          return result.command;
        });
        check();
        if (state === 'accepted' && created) {
          if (enterSession) {
            await enterSession(created);
            check();
            journal.forget(existing);
          }
          return created;
        }
        if (state === 'rejected') throw new CommandRejectedError('Session creation rejected; review before trying a new command');
        throw new CreationOutcomeUnknownError(existing.key);
      } catch (error) {
        check();
        if (created || error instanceof CommandRejectedError) throw error;
        // HTTP errors, including 404/409, cannot prove the original native
        // creation had no effect. Keep its exact receipt and never POST anew.
        throw new CreationOutcomeUnknownError(existing.key);
      } finally {
        activeCreations.delete(identity);
        window.dispatchEvent(new CustomEvent('agentopsdeck:commands-changed'));
      }
    }
  }
  const key = `create.${newCommandKey()}`;
  const activeKey = commandIdentity({ scope, key, creation: target, state: 'outcome_unknown', createdAt: Date.now() });
  activeCreations.add(activeKey);
  try {
    const created = await createWithJournal(journal, scope, target, key,
      async () => { check(); const result = await api.createSession(target.agentId, label, target.connectionId, key, scope, target.ownerUserId); check(); return result; },
      async () => { check(); const result = await api.creationCommand(target, key, scope); check(); return result.command; },
      async () => {
        check();
        if (target.ownerUserId) return;
        const result = await api.verifyCreationConnection(target.connectionId, scope);
        check();
        if (result.connection.id !== target.connectionId || result.connection.identityStatus !== 'verified' || !result.connection.nodeId) {
          throw new Error('Connector identity not verified');
        }
      });
    check();
    if (enterSession) {
      await enterSession(created);
      check();
      // ACK alone is insufficient; dismiss only after this caller has entered
      // the confirmed session. Never clear other operations or accounts.
      const row = journal.list(scope, undefined, 'creation').find(row => commandIdentity(row) === activeKey);
      if (row) journal.forget(row);
    }
    return created;
  } finally {
    activeCreations.delete(activeKey);
    window.dispatchEvent(new CustomEvent('agentopsdeck:commands-changed'));
  }
}
