import React from 'react';
import { createRoot } from 'react-dom/client';
import { api, setApiBaseUrl, setRecoveryScope } from '../src/api';
import { CommandJournal, sendWithJournal } from '../src/lib/command-recovery';
import { CommandRecoveryNotice } from '../src/components/CommandRecoveryNotice';
import { readCachedMessages, writeCachedMessages } from '../src/lib/session-cache';
import { sessionAddress, sessionMessagePayload } from '../src/lib/session-address';
import { deleteSessionWithRecovery } from '../src/lib/session-deletion';
import { createSessionWithRecovery } from '../src/lib/session-creation';
import { updateSettingsWithRecovery } from '../src/lib/session-settings';
import type { MessageRetryUpdate } from '../src/lib/message-submission';
import '../src/styles.css';

const scope = new URL(location.href).searchParams.get('scope') ?? 'a'.repeat(64);
const ownerUserId = new URL(location.href).searchParams.get('owner');
const sessionKey = sessionAddress(ownerUserId ? { ownerUserId, sessionId: 'local:c3ludGhldGlj' } : 'local:c3ludGhldGlj').key;
setApiBaseUrl(location.origin);
setRecoveryScope(scope);
const journal = new CommandJournal(sessionStorage);
const creation = new URL(location.href).searchParams.has('creation');
const recovered: Array<{ scope: string; sessionKey: string; key: string; status: string }> = [];
window.addEventListener('agentopsdeck:message-retried', event => {
  const { scope, sessionKey, key, response } = (event as CustomEvent<MessageRetryUpdate>).detail;
  if (response) recovered.push({ scope, sessionKey, key, status: response.status });
});
(window as any).recoveryFixture = {
  recovered: () => recovered,
  seedRecovery(keys: string[]) {
    for (const key of keys) journal.begin(scope, sessionKey, key);
    window.dispatchEvent(new CustomEvent('agentopsdeck:commands-changed'));
  },
  async settings() {
    try { return await updateSettingsWithRecovery(sessionKey, { title: 'Synthetic private settings title' }); }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  },
  async createSession() {
    try { return await createSessionWithRecovery({ connectionId: 'local', agentId: 'codex' }, 'Synthetic private title'); }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  },
  async createAndEnter(behavior: 'wait' | 'fail' | 'account-change') {
    try {
      return await createSessionWithRecovery({ connectionId: 'local', agentId: 'codex' }, 'Synthetic private title', async () => {
        if (behavior === 'fail') throw new Error('Synthetic navigation failure');
        if (behavior === 'account-change') { setRecoveryScope('e'.repeat(64)); return; }
        await new Promise<void>(resolve => { (window as any).finishCreationEntry = resolve; });
      });
    } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  },
  async deleteSession() {
    try { await deleteSessionWithRecovery(sessionKey); return { removed: true }; }
    catch (error) { return { removed: false, error: error instanceof Error ? error.message : String(error) }; }
  },
  async submit(stop = false) {
    try {
      sessionMessagePayload(sessionKey, stop ? '/stop' : 'synthetic body not stored in recovery', 'web-only', [], 'synthetic-command', stop ? 'synthetic-turn' : undefined);
      await sendWithJournal(journal, scope, sessionKey, 'synthetic-command',
        (key) => api.sendMessage(sessionKey, stop ? '/stop' : 'synthetic body not stored in recovery', 'web-only', [], key, scope, stop ? 'synthetic-turn' : undefined),
        async (key) => (await api.messageCommand(sessionKey, key, scope)).command);
    } catch { /* The fixture intentionally loses both submission and query ACKs. */ }
    window.dispatchEvent(new CustomEvent('agentopsdeck:commands-changed'));
  },
  async cancelRead() {
    const controller = new AbortController();
    const read = api.messageCommand(sessionKey, 'stall', scope, controller.signal);
    setTimeout(() => controller.abort(), 100);
    try { await read; return false; } catch { return true; }
  },
  rows: () => journal.list(scope),
  writeCache: () => writeCachedMessages(sessionKey, [{ id: 'synthetic-message', role: 'assistant', text: 'synthetic cached reply', createdAt: 1, sessionKey }]),
  readCache: () => readCachedMessages(sessionKey),
};
createRoot(document.getElementById('root')!).render(<main style={{ padding: 12 }}>
  {creation ? <CommandRecoveryNotice onRecovered={async () => {}} onCreated={(key, target) => { (window as any).openedCreation = { key, target }; }} />
    : <CommandRecoveryNotice sessionKey={sessionKey} onRecovered={async () => {}} />}
</main>);
