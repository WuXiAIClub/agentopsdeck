import type { ChatMessage, SendMessageResponse } from '@agentopsdeck/shared';
import { hasMatchingRealMessage } from './optimistic-messages.js';

/** An ACK is acceptance, not execution. Do not leave the composer waiting for history. */
export function applyMessageAdmission(message: ChatMessage, response: SendMessageResponse): ChatMessage {
  return { ...message, id: response.idempotencyKey ?? message.id,
    localAdmission: true,
    status: response.status === 'queued' ? 'queued' : response.status === 'outcome_unknown' ? 'outcome_unknown' : 'sent',
    queueVersion: response.admission?.queueVersion,
    // Older Connectors cannot distinguish admission from waiting. Preserve the
    // pre-send busy hint, but never fabricate an edit/cancel precondition.
    queueDisposition: response.admission?.disposition ?? message.queueDisposition,
  };
}

export function refreshAfterAdmission(refresh: () => Promise<void>, failed: () => void) {
  // Keep refresh failures outside the send/recovery error boundary.
  void Promise.resolve().then(refresh).catch(failed);
}

/** Read-side notice only. Never resubmit, change an ACK, or clear send errors. */
export function createAdmissionHistoryTracker(sessionKey: string, changed: () => void) {
  const pending = new Map<symbol, { message: ChatMessage; exact: boolean; delayed: boolean }>();
  let latest: ChatMessage[] = [], active = true;
  const matches = (entry: { message: ChatMessage; exact: boolean }) => hasMatchingRealMessage(
    latest.filter(message => message.sessionKey === sessionKey && !message.localAdmission
      && message.role === 'user' && (message.status === 'sent' || message.status === 'queued')
      && (!entry.exact || message.id === entry.message.id)), entry.message);
  return {
    get delayed() { return [...pending.values()].some(entry => entry.delayed); },
    activate() { active = true; },
    dispose() { active = false; pending.clear(); latest = []; },
    observe(messages: ChatMessage[]) {
      if (!active) return;
      latest = messages;
      let removed = false;
      for (const [token, entry] of pending) if (matches(entry)) { pending.delete(token); removed = true; }
      if (removed) changed();
    },
    accepted(message: ChatMessage, response: SendMessageResponse, refresh: () => Promise<void>) {
      if (!active || message.sessionKey !== sessionKey) return;
      // Unknown delivery must retain its original receipt/recovery UI, not claim acceptance.
      if (response.status === 'outcome_unknown') return;
      const token = Symbol(), entry = { message: applyMessageAdmission(message, response),
        exact: !!response.idempotencyKey, delayed: false };
      if (!matches(entry)) pending.set(token, entry);
      refreshAfterAdmission(refresh, () => {
        // History may have arrived via SSE before this older refresh failed.
        if (!active || !pending.has(token)) return;
        entry.delayed = true;
        changed();
      });
    },
  };
}
