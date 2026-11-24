import { useEffect, useMemo, useState } from 'react';
import type { ChatMessage, QueuedMessagePage } from '@agentopsdeck/shared';
import { api, recoveryScope } from '../api';
import { observeQueuedMessage, queueObservationDelay } from './queue-observation';

/** One lightweight read loop per visible chat with pending messages. Never
 * waits for native transcript reads, never sends/mutates, pauses when hidden.
 * The fingerprint fences responses from before an admission/edit/navigation. */
export function useQueueObservation(sessionKey: string, messages: ChatMessage[]) {
  const scope = recoveryScope();
  const pending = messages.filter(message => message.role === 'user' && message.status === 'queued');
  const fingerprint = JSON.stringify([scope, sessionKey, pending.map(message => [message.id, message.queueVersion])]);
  const hasPending = pending.length > 0;
  const [snapshot, setSnapshot] = useState<{ fingerprint: string; items: QueuedMessagePage['items']; complete: boolean }>();
  useEffect(() => {
    if (!hasPending) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, busy = false, failures = 0;
    let interval = 3_000;
    const read = async () => {
      clearTimeout(timer);
      if (busy || controller.signal.aborted || document.hidden) return;
      busy = true;
      try {
        let cursor: string | null = '0';
        const items: QueuedMessagePage['items'] = [];
        // Bounded pagination; a partial page set must not imply absence.
        for (let page = 0; cursor !== null && page < 8; page++) {
          const result = await api.queuedMessages(sessionKey, cursor, controller.signal);
          if (!Array.isArray(result.items)) throw new Error('Queue snapshot unavailable');
          items.push(...result.items); cursor = result.nextCursor;
        }
        if (!controller.signal.aborted) setSnapshot({ fingerprint, items, complete: cursor === null });
        interval = queueObservationDelay(pending, items, cursor === null);
        failures = 0;
      } catch { failures++; /* Keep accepted state; a read failure is never a send failure. */ }
      finally {
        busy = false;
        if (!controller.signal.aborted) timer = setTimeout(() => void read(), Math.max(interval, Math.min(30_000, 3_000 * 2 ** Math.min(failures, 4))));
      }
    };
    const wake = () => { if (!document.hidden) void read(); };
    void read();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('agentopsdeck:commands-changed', wake);
    return () => {
      controller.abort(); clearTimeout(timer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
      window.removeEventListener('agentopsdeck:commands-changed', wake);
    };
  }, [fingerprint, hasPending, sessionKey]);
  return useMemo(() => snapshot?.fingerprint === fingerprint
    ? messages.map(message => observeQueuedMessage(message, snapshot.items, snapshot.complete)) : messages, [messages, snapshot, fingerprint]);
}
