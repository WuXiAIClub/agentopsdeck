import { useEffect, useRef, type RefObject } from 'react';
import type { SessionSummary } from '@agentopsdeck/shared';
import { api, recoveryEpoch, recoveryScope } from '../api';
import { sessionRunOutcome } from './live-session';
import { completionViewReadable, createCompletionAutoRead, finalReplyExposed } from './completion-auto-read';
import { layoutUnreadEvents } from './layout-unread-events';

export function useCompletionAutoRead(root: RefObject<HTMLElement | null>, session: SessionSummary,
  replyId: string | undefined, ready: boolean, onSeen: (session: SessionSummary) => void) {
  const latest = useRef({ session, replyId, ready, onSeen });
  const acknowledged = useRef<string | undefined>(undefined);
  latest.current = { session, replyId, ready, onSeen };
  useEffect(() => {
    let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
    const scope = recoveryScope(), epoch = recoveryEpoch();
    const controller = createCompletionAutoRead({
      current: () => {
        const state = latest.current, host = root.current;
        if (stopped || !scope || recoveryScope() !== scope || recoveryEpoch() !== epoch
          || !host || !state.replyId || !state.session.runtime?.turnId) return;
        const pane = host.closest<HTMLElement>('[data-workspace-pane]');
        if (!completionViewReadable({ foreground: !document.hidden, focused: document.hasFocus(), online: navigator.onLine,
          ready: state.ready, active: !pane || pane.dataset.active === 'true', collapsed: !!pane && (pane.dataset.collapsed === 'true' || pane.hidden),
          dimmed: pane?.dataset.dimmed === 'true', synchronized: state.session.runtime.sync === 'current',
          completed: sessionRunOutcome(state.session) === 'completed' })) return;
        const reply = [...host.querySelectorAll<HTMLElement>('[data-final-reply="true"]')]
          .find(element => element.dataset.messageSearchId === state.replyId);
        if (!reply) return;
        const rect = host.getBoundingClientRect(), paneRect = pane?.getBoundingClientRect() ?? rect;
        const viewport = { top: Math.max(0, rect.top, paneRect.top), bottom: Math.min(innerHeight, rect.bottom, paneRect.bottom),
          left: Math.max(0, rect.left, paneRect.left), right: Math.min(innerWidth, rect.right, paneRect.right) };
        if (!finalReplyExposed(reply.getBoundingClientRect(), viewport)) return;
        const identity = { scope, epoch, sessionKey: state.session.sessionKey, turnId: state.session.runtime.turnId, replyId: state.replyId };
        if (acknowledged.current === JSON.stringify(identity)) return;
        // A dialog, floating card or other overlay covering the reply is not
        // evidence that the user could see it.
        const replyRect = reply.getBoundingClientRect();
        const hit = document.elementFromPoint((Math.max(replyRect.left, viewport.left) + Math.min(replyRect.right, viewport.right)) / 2,
          Math.min(replyRect.bottom - 4, viewport.bottom - 4));
        if (!hit || !host.contains(hit)) return;
        return identity;
      },
      observe: api.observeCompletion,
      read: (key, proof) => api.readCompletion(key, proof.token, proof.throughSequence, crypto.randomUUID()),
      seen: identity => {
        acknowledged.current = JSON.stringify(identity);
        try { latest.current.onSeen(latest.current.session); }
        catch { /* Local storage can be unavailable; durable ACK still succeeded. */ }
        finally { layoutUnreadEvents.receive(identity.scope, { type: 'completion.read', sessionKey: identity.sessionKey }); }
      },
    });
    // A small dwell allows layout/auto-scroll to settle. Errors leave unread
    // intact and retry at the existing summary cadence, without popups.
    const wake = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void controller.attempt().catch(() => {}), 600);
    };
    const host = root.current;
    host?.addEventListener('scroll', wake, { passive: true });
    const resize = new ResizeObserver(wake); if (host) resize.observe(host);
    window.addEventListener('focus', wake); window.addEventListener('resize', wake); window.addEventListener('online', wake);
    window.addEventListener('pointerup', wake); window.addEventListener('keyup', wake);
    document.addEventListener('visibilitychange', wake);
    const interval = setInterval(wake, 15_000);
    wake();
    return () => {
      stopped = true; clearTimeout(timer); clearInterval(interval); resize.disconnect();
      host?.removeEventListener('scroll', wake); window.removeEventListener('focus', wake);
      window.removeEventListener('resize', wake); window.removeEventListener('online', wake);
      window.removeEventListener('pointerup', wake); window.removeEventListener('keyup', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [root, session.sessionKey, session.runtime?.turnId, session.runtime?.sync, session.runCompletedAt, replyId, ready]);
}
