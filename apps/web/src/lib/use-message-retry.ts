import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { ChatMessage } from '@agentopsdeck/shared';
import { recoveryScope } from '../api';
import type { MessageRetryUpdate } from './message-submission';
import { applyMessageAdmission } from './message-admission';

export function useMessageRetryUpdates(sessionKey: string, update: Dispatch<SetStateAction<ChatMessage[]>>, refresh: () => Promise<void>) {
  const latest = useRef(refresh); latest.current = refresh;
  useEffect(() => {
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<MessageRetryUpdate>).detail;
      if (detail.scope !== recoveryScope() || detail.sessionKey !== sessionKey) return;
      update(items => items.map(item => item.id !== detail.oldKey ? item : detail.response
        ? applyMessageAdmission({ ...item, id: detail.key }, detail.response)
        : { ...item, id: detail.key, status: detail.status ?? 'outcome_unknown' }));
      void latest.current().catch(() => {});
    };
    window.addEventListener('agentopsdeck:message-retried', receive);
    return () => window.removeEventListener('agentopsdeck:message-retried', receive);
  }, [sessionKey, update]);
}
