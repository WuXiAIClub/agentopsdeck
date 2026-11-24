import { useEffect, useRef, useState } from 'react';
import type { SessionSummary } from '@agentopsdeck/shared';
import { createPaneCompletionTracker } from './pane-completion';
import { recordCompletionDiagnostic, clearCompletionDiagnostics } from './completion-diagnostics';
import { subscribeRecoveryScope } from '../api';
import { sessionRunOutcome } from './live-session';

/** A witnessed run or new terminal identity produces attention, never old Done. */
export function usePaneCompletion(sessions: SessionSummary[]) {
  const tracker = useRef(createPaneCompletionTracker(recordCompletionDiagnostic));
  const sequence = useRef(0);
  const [completed, setCompleted] = useState<ReadonlyMap<string, number>>(new Map());
  const active = useRef(new Map<string, number>());
  const pending = useRef(new Map<string, number>());
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const changed = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', changed);
    const unsubscribe = subscribeRecoveryScope(() => {
      clearCompletionDiagnostics(); tracker.current = createPaneCompletionTracker(recordCompletionDiagnostic);
      pending.current.clear(); active.current.clear();
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear(); setCompleted(new Map());
    });
    return () => { document.removeEventListener('visibilitychange', changed); unsubscribe(); };
  }, []);
  useEffect(() => {
    const present = new Set(sessions.map(session => session.sessionKey));
    tracker.current.prune(present);
    let changed = false;
    const remove = (key: string) => {
      clearTimeout(timers.current.get(key)); timers.current.delete(key);
      pending.current.delete(key);
      if (active.current.delete(key)) changed = true;
    };
    for (const key of timers.current.keys()) if (!present.has(key)) remove(key);
    for (const key of pending.current.keys()) if (!present.has(key)) pending.current.delete(key);
    for (const session of sessions) {
      const key = session.sessionKey;
      const transition = tracker.current.observe(session);
      const outcome = sessionRunOutcome(session);
      if (transition === 'running' || outcome === 'failed' || outcome === 'interrupted' || session.runtime?.operation === 'compact') remove(key);
      else if (transition === 'completed') {
        pending.current.set(key, Date.now());
        recordCompletionDiagnostic(key, 'queued', { visible });
      }
    }
    if (!visible || document.visibilityState === 'hidden') {
      // Do not spend the entire animation in a background tab. Retain one
      // recent attention per pane, including one interrupted by tab hiding.
      for (const key of active.current.keys()) {
        if (!pending.current.has(key)) pending.current.set(key, Date.now());
        recordCompletionDiagnostic(key, 'deferred-hidden');
      }
      if (active.current.size) { active.current.clear(); changed = true; }
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    } else {
      for (const [key, at] of pending.current) {
        pending.current.delete(key);
        if (Date.now() - at > 300_000) { recordCompletionDiagnostic(key, 'expired-hidden'); continue; }
        const nextSequence = ++sequence.current;
        active.current.set(key, nextSequence); changed = true;
        recordCompletionDiagnostic(key, 'scheduled', { sequence: nextSequence });
        clearTimeout(timers.current.get(key));
        timers.current.set(key, setTimeout(() => {
          timers.current.delete(key); active.current.delete(key);
          recordCompletionDiagnostic(key, 'attention-expired', { sequence: nextSequence });
          setCompleted(new Map(active.current));
        }, 2_700));
      }
    }
    if (changed) setCompleted(new Map(active.current));
  }, [sessions, visible]);
  useEffect(() => () => { for (const timer of timers.current.values()) clearTimeout(timer); }, []);
  return completed;
}
