import { api, recoveryScope } from '../api';
import { CommandJournal, CommandNotSubmittedError, deleteWithJournal, newCommandKey } from './command-recovery';
import { ownerSessionPath } from './session-address';

// One deletion attempt; refresh recovery uses the existing command notice.
export async function deleteSessionWithRecovery(sessionKey: string) {
  const scope = recoveryScope();
  if (!scope) throw new CommandNotSubmittedError('Cannot identify the current Hub account; reload before deleting');
  ownerSessionPath(sessionKey); // Reject shared addresses before journaling.
  let journal: CommandJournal;
  try { journal = new CommandJournal(window.sessionStorage); }
  catch { throw new CommandNotSubmittedError('Recovery storage unavailable; deletion was not attempted'); }
  const check = () => { if (recoveryScope() !== scope) throw new Error('Account changed'); };
  const key = `delete.${newCommandKey()}`;
  try {
    await deleteWithJournal(journal, scope, sessionKey, key,
      async () => { check(); const result = await api.deleteSession(sessionKey, key, scope); check(); return result; },
      async () => { check(); const result = await api.deletionCommand(sessionKey, key, scope); check(); return result.command; });
  } finally { window.dispatchEvent(new CustomEvent('agentopsdeck:commands-changed')); }
}
