import { api, invalidateSnapshotReads, recoveryScope } from '../api';
import { CommandJournal, CommandNotSubmittedError, newCommandKey, settingsWithJournal } from './command-recovery';
import { ownerSessionPath } from './session-address';
import type { GoalControl } from '@agentopsdeck/shared';

export async function updateSettingsWithRecovery(sessionKey: string, payload: { title: string } | { model: string | null; thinking?: string | null } | { goal: GoalControl }) {
  const scope = recoveryScope();
  if (!scope) throw new CommandNotSubmittedError('Cannot identify the current Hub account; reload before changing settings');
  ownerSessionPath(sessionKey);
  let journal: CommandJournal;
  try { journal = new CommandJournal(window.sessionStorage); }
  catch { throw new CommandNotSubmittedError('Recovery storage unavailable; settings were not changed'); }
  const check = () => { if (recoveryScope() !== scope) throw new Error('Account changed'); };
  const key = `settings.${newCommandKey()}`;
  try {
    const result = await settingsWithJournal(journal, scope, sessionKey, key,
      async () => { check(); const result = await api.updateSettings(sessionKey, payload, key, scope); check(); return result; },
      async () => { check(); const result = await api.settingsCommand(sessionKey, key, scope); check(); return result.command; });
    // The next snapshot must not join a GET started before this confirmation.
    invalidateSnapshotReads();
    return result;
  } finally { window.dispatchEvent(new CustomEvent('agentopsdeck:commands-changed')); }
}
