import { createCommandKey, type ChatMessage, type SendMessageResponse, type SendDeliveryMode, type SendMessageUpload } from '@agentopsdeck/shared';
import { api, invalidateSessionSnapshotReads, recoveryScope } from '../api.js';
import { CommandJournal, CommandNotSubmittedError, CommandOutcomeUnknownError, sendWithJournal } from './command-recovery.js';
import { sessionMessagePayload } from './session-address.js';
import { MessageRetryCache, inspectMessageRetry } from './message-retry.js';
export const messageRetryCache = new MessageRetryCache();
const retrying = new Set<string>();
window.addEventListener('agentopsdeck:auth-required', () => messageRetryCache.clear());
window.addEventListener('pagehide', () => messageRetryCache.clear());
export type MessageRetryUpdate = { scope: string; sessionKey: string; oldKey: string; key: string; response?: SendMessageResponse; status?: ChatMessage['status'] };

/** The original receipt resolved; update its bubble and discard the explicit
 * resend hint. This does not send anything or infer that execution completed. */
export function publishRecoveredMessage(scope: string, sessionKey: string, key: string, response: SendMessageResponse) {
  if (scope !== recoveryScope()) return;
  messageRetryCache.remove(scope, sessionKey, key);
  invalidateSessionSnapshotReads(sessionKey);
  window.dispatchEvent(new CustomEvent<MessageRetryUpdate>('agentopsdeck:message-retried', {
    detail: { scope, sessionKey, oldKey: key, key, response },
  }));
}

/** Owner and shared composers use the same preflight, bounded journal and
 * single POST / exact GET recovery. Navigation never retries the send. */
export async function sendMessageWithRecovery(sessionKey: string, payload: string, deliveryMode: SendDeliveryMode,
  mediaPayload: SendMessageUpload[], key: string, expectedRunId?: string) {
  const scope = recoveryScope();
  if (!scope) throw new CommandNotSubmittedError('Cannot identify the current Hub account; reload before submitting');
  sessionMessagePayload(sessionKey, payload, deliveryMode, mediaPayload, key, expectedRunId);
  let journal: CommandJournal;
  try { journal = new CommandJournal(window.sessionStorage); }
  catch { throw new CommandNotSubmittedError('Recovery storage unavailable; submission was not attempted'); }
  try {
    const response = await sendWithJournal(journal, scope, sessionKey, key,
      commandKey => api.sendMessage(sessionKey, payload, deliveryMode, mediaPayload, commandKey, scope, expectedRunId),
      async commandKey => (await api.messageCommand(sessionKey, commandKey, scope)).command);
    // Post-write reads must not join a GET started before admission. Existing
    // snapshot gates still reject late/obsolete responses already in flight.
    invalidateSessionSnapshotReads(sessionKey);
    return response;
  } catch (error) {
    if (error instanceof CommandOutcomeUnknownError && recoveryScope() === scope) messageRetryCache.put({ scope, sessionKey, key, text: payload, mode: deliveryMode, media: mediaPayload, ...(expectedRunId ? { expectedRunId } : {}) });
    throw error;
  } finally { window.dispatchEvent(new CustomEvent('agentopsdeck:commands-changed')); }
}

/** Explicit user action only. A fresh key requires informed confirmation, never an automatic retry. */
export async function resendUnknownMessage(sessionKey: string, key: string, confirm: () => Promise<boolean>) {
  const scope = recoveryScope(), lock = JSON.stringify([scope, sessionKey, key]);
  const original = scope && messageRetryCache.get(scope, sessionKey, key);
  if (!scope || !original || retrying.has(lock)) return 'unavailable';
  retrying.add(lock);
  const update = (value: Omit<MessageRetryUpdate, 'scope' | 'sessionKey' | 'oldKey'>) => {
    if (recoveryScope() !== scope) return;
    // Forget only the local hint; the original server audit receipt is retained.
    try {
      const journal = new CommandJournal(window.sessionStorage);
      const row = journal.list(scope, sessionKey).find(item => item.key === key);
      if (row) journal.forget(row);
    } catch { /* Storage cleanup must never turn a confirmed admission into failure. */ }
    messageRetryCache.remove(scope, sessionKey, key);
    window.dispatchEvent(new CustomEvent<MessageRetryUpdate>('agentopsdeck:message-retried', { detail: { scope, sessionKey, oldKey: key, ...value } }));
    window.dispatchEvent(new CustomEvent('agentopsdeck:commands-changed'));
  };
  try {
    const response = await inspectMessageRetry(key, async () => (await api.messageCommand(sessionKey, key, scope)).command);
    if (recoveryScope() !== scope) return 'unavailable';
    if (response) { update({ key, response }); invalidateSessionSnapshotReads(sessionKey); return 'recovered'; }
    if (!await confirm()) return 'cancelled';
    if (recoveryScope() !== scope || messageRetryCache.get(scope, sessionKey, key) !== original) return 'unavailable';
    // A receipt may settle while the confirmation is open. Check once more.
    const settled = await inspectMessageRetry(key, async () => (await api.messageCommand(sessionKey, key, scope)).command);
    if (recoveryScope() !== scope) return 'unavailable';
    if (settled) { update({ key, response: settled }); invalidateSessionSnapshotReads(sessionKey); return 'recovered'; }
    const next = createCommandKey(crypto.randomUUID());
    try {
      const sent = await sendMessageWithRecovery(sessionKey, original.text, original.mode, original.media, next, original.expectedRunId);
      update({ key: next, response: sent }); return 'resent';
    } catch (error) {
      if (!(error instanceof CommandNotSubmittedError)) update({ key: next, status: error instanceof CommandOutcomeUnknownError ? 'outcome_unknown' : 'failed' });
      throw error;
    }
  } finally { retrying.delete(lock); }
}
