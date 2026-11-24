import { api, invalidateSnapshotReads, recoveryScope } from '../api';
import { CommandJournal, CommandNotSubmittedError, compactWithJournal, newCommandKey } from './command-recovery';
import { ownerSessionPath } from './session-address';

export async function compactSessionWithRecovery(sessionKey: string, sdk: boolean) {
  if (!sdk) return api.compactSession(sessionKey);
  const scope = recoveryScope();
  if (!scope) throw new CommandNotSubmittedError('Cannot identify the current Hub account; reload before compacting');
  ownerSessionPath(sessionKey);
  let journal: CommandJournal;
  try { journal = new CommandJournal(window.sessionStorage); }
  catch { throw new CommandNotSubmittedError('Recovery storage unavailable; compaction was not attempted'); }
  const check = () => { if (recoveryScope() !== scope) throw new Error('Account changed'); };
  const key = `compact.${newCommandKey()}`;
  try {
    const result = await compactWithJournal(journal, scope, sessionKey, key,
      async () => { check(); const result = await api.compactSession(sessionKey, true, key, scope); check(); return result; },
      async () => { check(); const result = await api.compactCommand(sessionKey, key, scope); check(); return result.command; });
    invalidateSnapshotReads();
    return result;
  } finally { window.dispatchEvent(new CustomEvent('agentopsdeck:commands-changed')); }
}
