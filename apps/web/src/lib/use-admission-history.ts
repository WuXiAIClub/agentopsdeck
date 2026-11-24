import { useEffect, useMemo, useReducer } from 'react';
import type { ChatMessage } from '@agentopsdeck/shared';
import { createAdmissionHistoryTracker } from './message-admission';

export function useAdmissionHistory(sessionKey: string, messages: ChatMessage[], enabled = true) {
  const [, redraw] = useReducer((value: number) => value + 1, 0);
  const tracker = useMemo(() => createAdmissionHistoryTracker(sessionKey, redraw), [sessionKey, enabled]);
  useEffect(() => {
    if (enabled) tracker.activate(); else tracker.dispose();
    return () => tracker.dispose();
  }, [tracker, enabled]);
  useEffect(() => { if (enabled) tracker.observe(messages); }, [tracker, messages, enabled]);
  return { historyDelayed: enabled && tracker.delayed, refreshAccepted: tracker.accepted };
}
