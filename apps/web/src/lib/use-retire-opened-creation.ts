import { useEffect } from 'react';
import { api, recoveryScope } from '../api';
import { CommandJournal, creationReceiptState } from './command-recovery';
import { isActiveSessionCreation } from './session-creation';
import { sessionAddress } from './session-address';

/** Retire older clients' confirmed shortcuts when their exact session is open.
 * Bounded GET-only reconciliation, independent of whether a banner is mounted
 * (the mobile chat intentionally does not mount the global creation notice). */
export function useRetireOpenedCreation(activeSessionKey: string | undefined) {
  const scope = recoveryScope();
  useEffect(() => {
    if (!scope || !activeSessionKey) return;
    const controller = new AbortController();
    const checked = new Set<string>();
    let busy = false;
    const sweep = async () => {
      if (busy || controller.signal.aborted) return;
      busy = true;
      try {
        const journal = new CommandJournal(window.sessionStorage);
        const rows = journal.list(scope, undefined, 'creation').filter(row => row.state === 'accepted' && !isActiveSessionCreation(row));
        for (const row of rows) {
          if (checked.size >= 4 || controller.signal.aborted) break;
          if (checked.has(row.key)) continue;
          checked.add(row.key);
          try {
            const { command } = await api.creationCommand(row.creation!, row.key, scope, controller.signal);
            if (controller.signal.aborted || recoveryScope() !== scope) break;
            if (creationReceiptState(command, row.key, row.creation!) !== 'accepted') continue;
            const key = command.result!.body.key as string;
            const address = sessionAddress(row.creation!.ownerUserId ? { ownerUserId: row.creation!.ownerUserId, sessionId: key } : key);
            if (address.key !== activeSessionKey) continue;
            journal.forget(row);
            window.dispatchEvent(new CustomEvent('agentopsdeck:commands-changed'));
          } catch { /* Unavailable or mismatched receipts retain their shortcut. */ }
        }
      } catch { /* Leave damaged/unavailable storage to the recovery UI. */ }
      finally { busy = false; }
    };
    const changed = () => { void sweep(); };
    changed();
    window.addEventListener('agentopsdeck:commands-changed', changed);
    return () => { controller.abort(); window.removeEventListener('agentopsdeck:commands-changed', changed); };
  }, [scope, activeSessionKey]);
}
