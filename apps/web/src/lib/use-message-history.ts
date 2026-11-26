import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { ChatMessage } from '@agentopsdeck/shared';
import { countWindowMessages, MESSAGE_WINDOW_CHAT_LIMIT, visibleMessages } from '../components/messages';
import { createHistoryAnchorIndex } from './history-anchor-index';
import { desktopHistoryReads, type HistoryReadSchedule } from './history-read-scheduler';
import { createHistoryBackfillAttempts, type HistoryBackfillOutcome } from './history-backfill-attempts';
import { shouldTriggerHistoryLoadAtTop } from './message-history';

export function useMessageHistory({ messages, hiddenCount, loading, loadMore, containerRef, followingRef, autoScrollEnabled = true, automaticReadPriority }: {
  messages: ChatMessage[]; hiddenCount: number; loading?: boolean | undefined;
  loadMore?: ((schedule?: HistoryReadSchedule, signal?: AbortSignal) => Promise<HistoryBackfillOutcome>) | undefined;
  containerRef: RefObject<HTMLElement | null>; followingRef: RefObject<boolean>;
  autoScrollEnabled?: boolean | undefined;
  automaticReadPriority?: (() => number) | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const pending = useRef(false);
  const manualLoad = useRef<Promise<void> | undefined>(undefined);
  const upwardIntent = useRef(false);
  const [autoAttempt] = useState(createHistoryBackfillAttempts);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [retryRevision, setRetryRevision] = useState(0);
  // Once the reader expands history, live appends must not evict its oldest row.
  // Composer/search state must not rebuild the history window and every
  // downstream grouping. Expansion and every actual history update still do.
  const visible = useMemo(() => expanded ? messages : visibleMessages(messages), [expanded, messages]);
  const latest = useRef({ messages, visible, hiddenCount, loading, loadMore, autoScrollEnabled, automaticReadPriority });
  latest.current = { messages, visible, hiddenCount, loading, loadMore, autoScrollEnabled, automaticReadPriority };
  const isFollowing = () => Boolean(followingRef.current && latest.current.autoScrollEnabled);
  const automatic = useRef<{ controller: AbortController; scheduled?: { expedite(): void }; expedited: boolean } | undefined>(undefined);
  useEffect(() => () => {
    const run = automatic.current;
    automatic.current = undefined;
    run?.controller.abort();
    pending.current = false;
    manualLoad.current = undefined;
    clearTimeout(retryTimer.current);
    autoAttempt.reset();
  }, []);
  const anchor = useRef<{ id: string; top: number; waitingForHeadId?: string | undefined } | undefined>(undefined);
  const bottomPin = useRef<{ waitingForHeadId?: string | undefined } | undefined>(undefined);
  const prevVisibleRef = useRef<{ sessionKey?: string | undefined; firstId?: string | undefined; length: number }>({ length: 0 });
  const anchorIndex = useRef<ReturnType<typeof createHistoryAnchorIndex> | undefined>(undefined);
  useLayoutEffect(() => {
    if (!containerRef.current) return;
    const index = createHistoryAnchorIndex(containerRef.current);
    anchorIndex.current = index;
    return () => { index.dispose(); anchorIndex.current = undefined; };
  }, [containerRef]);
  const rememberAnchor = (waitForPage = false) => {
    const saved = anchorIndex.current?.capture();
    const headId = latest.current.visible[0]?.id ?? latest.current.messages[0]?.id;
    if (saved) {
      anchor.current = {
        ...saved,
        ...(waitForPage && headId !== undefined ? { waitingForHeadId: headId } : {}),
      };
    }
  };
  const rememberBeforePrepend = (waitForPage = false) => {
    const headId = latest.current.visible[0]?.id ?? latest.current.messages[0]?.id;
    rememberAnchor(waitForPage);
    if (isFollowing()) {
      bottomPin.current = waitForPage && headId !== undefined ? { waitingForHeadId: headId } : {};
    }
  };
  const loadOlder = async () => {
    if (upwardIntent.current && automatic.current) {
      automatic.current.expedited = true;
      automatic.current.scheduled?.expedite();
    }
    if (manualLoad.current) return manualLoad.current;
    const state = latest.current;
    if (pending.current || state.loading || !upwardIntent.current) return;
    upwardIntent.current = false;
    if (state.visible.length < state.messages.length) {
      rememberBeforePrepend(false);
      setExpanded(true);
      return;
    }
    if (!state.loadMore || state.hiddenCount <= 0) return;
    pending.current = true;
    rememberBeforePrepend(true);
    setExpanded(true);
    const work = Promise.resolve(state.loadMore()).then(() => undefined, () => undefined).finally(() => {
      pending.current = false;
      if (manualLoad.current === work) manualLoad.current = undefined;
    });
    manualLoad.current = work;
    return work;
  };
  const loadOlderRef = useRef(loadOlder);
  loadOlderRef.current = loadOlder;
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let touchY = 0;
    const nestedScrollUp = (target: EventTarget | null) => {
      for (let node = target instanceof Element ? target : null; node && node !== container; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1
          && (node.scrollTop > 0 || /contain|none/.test(style.overscrollBehaviorY))) return true;
      }
      return false;
    };
    const triggerAtTop = () => {
      // When already at scrollTop === 0 (or content fits without overflowing),
      // browsers emit no scroll event on upward gestures. Trigger older-history
      // loading directly and pause bottom-following so the reader stays anchored.
      const state = latest.current;
      const decision = shouldTriggerHistoryLoadAtTop({
        scrollTop: container.scrollTop,
        visibleCount: state.visible.length,
        totalCount: state.messages.length,
        hiddenCount: state.hiddenCount,
        hasLoadMore: Boolean(state.loadMore),
        pending: pending.current,
        loading: Boolean(state.loading),
      });
      if (!decision.trigger) return;
      if (decision.pauseFollowing && followingRef.current) followingRef.current = false;
      void loadOlderRef.current();
    };
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
      if (event.deltaY < 0 && !nestedScrollUp(event.target)) {
        upwardIntent.current = true;
        triggerAtTop();
      }
    };
    const touchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY ?? 0; };
    const touchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY ?? touchY;
      if (y > touchY && !nestedScrollUp(event.target)) {
        upwardIntent.current = true;
        triggerAtTop();
      }
      touchY = y;
    };
    const key = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) && !nestedScrollUp(event.target)) {
        upwardIntent.current = true;
        triggerAtTop();
      }
    };
    const pointer = (event: PointerEvent) => {
      if (event.target === container && event.clientX >= container.getBoundingClientRect().left + container.clientWidth) upwardIntent.current = true;
    };
    container.addEventListener('wheel', wheel, { passive: true });
    container.addEventListener('touchstart', touchStart, { passive: true });
    container.addEventListener('touchmove', touchMove, { passive: true });
    container.addEventListener('keydown', key);
    container.addEventListener('pointerdown', pointer);
    return () => {
      container.removeEventListener('wheel', wheel); container.removeEventListener('touchstart', touchStart);
      container.removeEventListener('touchmove', touchMove); container.removeEventListener('keydown', key);
      container.removeEventListener('pointerdown', pointer);
    };
  }, [containerRef, followingRef]);
  useLayoutEffect(() => {
    const container = containerRef.current;
    const currentSessionKey = visible[0]?.sessionKey ?? messages[0]?.sessionKey;
    const currentFirstId = visible[0]?.id;
    const prev = prevVisibleRef.current;
    const sessionChanged = currentSessionKey !== undefined && prev.sessionKey !== undefined && currentSessionKey !== prev.sessionKey;
    if (sessionChanged) {
      anchor.current = undefined;
      bottomPin.current = undefined;
    }
    const prepended = !sessionChanged
      && prev.length > 0
      && visible.length > prev.length
      && currentFirstId !== undefined
      && prev.firstId !== undefined
      && currentFirstId !== prev.firstId;
    prevVisibleRef.current = { sessionKey: currentSessionKey, firstId: currentFirstId, length: visible.length };

    if (!container) return;
    const waitingHeadId = bottomPin.current?.waitingForHeadId ?? anchor.current?.waitingForHeadId;
    if (waitingHeadId !== undefined && !prepended) {
      if (!pending.current) {
        anchor.current = undefined;
        bottomPin.current = undefined;
      }
      return;
    }

    if (bottomPin.current || (prepended && isFollowing())) {
      bottomPin.current = undefined;
      if (isFollowing() && container.clientHeight > 0) {
        container.scrollTop = container.scrollHeight;
        anchor.current = undefined;
        return;
      }
    }
    if (!anchor.current) return;
    const saved = anchor.current;
    anchor.current = undefined;
    const node = anchorIndex.current?.get(saved.id);
    if (node) container.scrollTop += node.getBoundingClientRect().top - saved.top;
  }, [visible, messages, expanded]);
  // Tool events do not consume the 200-conversation-message initial budget.
  // Page in bounded chunks and never spin on an unavailable/unchanged response.
  useEffect(() => {
    const key = `${messages[0]?.sessionKey}:${messages[0]?.id}:${messages.length}:${hiddenCount}`;
    if (!loadMore || loading || pending.current || hiddenCount <= 0
      || countWindowMessages(messages) >= MESSAGE_WINDOW_CHAT_LIMIT) return;
    const attempt = autoAttempt.begin(key);
    if (!attempt) return;
    pending.current = true;
    // Mobile retains its direct-loading path; desktop alone opts into scheduling.
    if (!automaticReadPriority) {
      rememberBeforePrepend(true);
      let outcome: HistoryBackfillOutcome;
      void loadMore().then(value => { outcome = value; }).catch(() => {}).finally(() => {
        pending.current = false;
        if (outcome !== undefined) {
          anchor.current = undefined;
          bottomPin.current = undefined;
        }
        const delay = autoAttempt.retryDelay(attempt, outcome);
        if (delay !== undefined) {
          clearTimeout(retryTimer.current);
          retryTimer.current = setTimeout(() => {
            if (autoAttempt.release(attempt)) setRetryRevision(value => value + 1);
          }, delay);
        }
      });
      return;
    }
    const run: NonNullable<typeof automatic.current> = { controller: new AbortController(), expedited: false };
    automatic.current = run;
    const schedule: HistoryReadSchedule = (read, signal) => {
      const scheduled = desktopHistoryReads.schedule(() => {
        // Capture geometry at dispatch, not while waiting behind other panes.
        rememberBeforePrepend(true);
        return read();
      }, { signal, priority: () => latest.current.automaticReadPriority?.() ?? 5 });
      run.scheduled = scheduled;
      if (run.expedited) scheduled.expedite();
      return scheduled.promise;
    };
    schedule.expedite = () => { run.expedited = true; run.scheduled?.expedite(); };
    // Loaders own visible read errors; cancellation of queued work is not a sync
    // failure and must not create an unhandled rejection during pane disposal.
    let outcome: HistoryBackfillOutcome;
    void loadMore(schedule, run.controller.signal).then(value => { outcome = value; }).catch(() => {}).finally(() => {
      if (automatic.current !== run) return;
      automatic.current = undefined;
      pending.current = false;
      if (outcome !== undefined) {
        anchor.current = undefined;
        bottomPin.current = undefined;
      }
      const delay = autoAttempt.retryDelay(attempt, outcome);
      if (delay !== undefined && !run.controller.signal.aborted) {
        clearTimeout(retryTimer.current);
        retryTimer.current = setTimeout(() => {
          if (autoAttempt.release(attempt)) setRetryRevision(value => value + 1);
        }, delay);
      }
    });
  }, [messages, hiddenCount, loading, loadMore, retryRevision]);
  return { visible, loadOlder };
}
