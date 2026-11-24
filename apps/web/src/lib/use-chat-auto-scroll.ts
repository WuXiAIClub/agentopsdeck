import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';

// Use the same bottom zone for the latest indicator and downward re-entry.
// Upward movement still pauses immediately, including inside this zone.
const BOTTOM_ZONE_PX = 140;
const TOUCH_GESTURE_PX = 12;
const bottomGap = (container: HTMLElement) => container.scrollHeight - container.clientHeight - container.scrollTop;
const position = (container: HTMLElement) => ({ top: container.scrollTop, height: container.scrollHeight, viewport: container.clientHeight });

export function computeResizeFollowScrollTop(input: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  enabled: boolean;
  following: boolean;
  selecting: boolean;
  touching: boolean;
}): number | null {
  if (input.clientHeight <= 0 || !input.enabled || !input.following || input.selecting || input.touching) {
    return null;
  }
  const targetTop = Math.max(0, input.scrollHeight - input.clientHeight);
  if (Math.abs(targetTop - input.scrollTop) <= 1) return null;
  return targetTop;
}

export function shouldReenterBottomFollow(input: {
  downwardIntent: boolean;
  previous: ReturnType<typeof position> | null;
  next: ReturnType<typeof position>;
  gap: number;
  following: boolean;
  touching: boolean;
}) {
  const { downwardIntent, previous, next, gap, following, touching } = input;
  const scrolledDown = previous !== null && next.top > previous.top + 0.5;
  const returned = downwardIntent && scrolledDown && gap <= BOTTOM_ZONE_PX;
  const reachedBottomEdge = scrolledDown && gap <= 4;
  const keptAtBottom = following && gap <= 2 && !touching;
  return {
    reenter: returned || reachedBottomEdge || keptAtBottom,
    snapToBottom: returned || reachedBottomEdge,
  };
}

export function useChatAutoScroll({ containerRef, followingRef, enabled, selectionActive, onMessagesBelowChange }: {
  containerRef: RefObject<HTMLElement | null>;
  followingRef: RefObject<boolean>;
  enabled: boolean;
  selectionActive: () => boolean;
  onMessagesBelowChange: (below: boolean) => void;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const current = useRef({ enabled, selectionActive, onMessagesBelowChange });
  const previousPositionRef = useRef<ReturnType<typeof position> | null>(null);
  const frameRef = useRef<number | undefined>(undefined);
  const manualRef = useRef(false);
  const selectingRef = useRef(false);
  const downwardIntentRef = useRef(false);
  const touchingRef = useRef(false);

  useLayoutEffect(() => {
    current.current = { enabled, selectionActive, onMessagesBelowChange };
  });

  const scrollToBottom = useCallback((_behavior: ScrollBehavior = 'auto', manual = false) => {
    // Coalesce requests without postponing the frame or losing an explicit
    // jump when a resize notification arrives before it runs.
    if (manual) {
      followingRef.current = true;
      touchingRef.current = false;
      selectingRef.current = false;
    }
    manualRef.current ||= manual;
    if (frameRef.current !== undefined) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = undefined;
      const force = manualRef.current;
      manualRef.current = false;
      const state = current.current;
      const container = containerRef.current;
      // Hidden panes report zero geometry. Preserve their intent until reveal.
      if (!container || container.clientHeight === 0) return;
      const gap = bottomGap(container);
      if (!selectingRef.current && !state.selectionActive() && (force || (state.enabled && followingRef.current && !touchingRef.current))) {
        if (force) followingRef.current = true;
        downwardIntentRef.current = false;
        if (force || Math.abs(gap) > 1) {
          const targetTop = container.scrollHeight;
          container.scrollTo({ top: targetTop, behavior: 'instant' });
          if (Math.abs(bottomGap(container)) > 1) {
            container.scrollTop = container.scrollHeight;
          }
        }
      }
      previousPositionRef.current = position(container);
      // A disabled/paused follower is not evidence of new content. Measure
      // even when scrolling is blocked, including image-only layout changes.
      state.onMessagesBelowChange(bottomGap(container) > BOTTOM_ZONE_PX);
    });
  }, [containerRef, followingRef]);

  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container || container.clientHeight === 0) return;
    const next = position(container);
    const previous = previousPositionRef.current;
    previousPositionRef.current = next;
    const gap = bottomGap(container);
    const decision = shouldReenterBottomFollow({
      downwardIntent: downwardIntentRef.current,
      previous,
      next,
      gap,
      following: followingRef.current,
      touching: touchingRef.current,
    });
    if (!selectingRef.current && !current.current.selectionActive() && decision.reenter) {
      followingRef.current = true;
      if (decision.snapToBottom && current.current.enabled && gap > 1 && !touchingRef.current) scrollToBottom();
    }
    current.current.onMessagesBelowChange(gap > BOTTOM_ZONE_PX);
  }, [containerRef, followingRef, scrollToBottom]);

  const pauseFollowing = useCallback(() => {
    followingRef.current = false;
    manualRef.current = false;
    downwardIntentRef.current = false;
  }, [followingRef]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;
    previousPositionRef.current = position(container);
    let touchY = 0;
    const pause = () => {
      if (container.scrollTop <= 0) return; // No upward scrolling is possible.
      pauseFollowing();
      previousPositionRef.current = position(container);
    };
    // A code preview can scroll independently. Only pause transcript follow
    // when the upward gesture can actually reach the outer scroll container.
    const nestedScroll = (target: EventTarget | null, down = false) => {
      for (let node = target instanceof Element ? target : null; node && node !== container; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1
          && ((down ? node.scrollTop + node.clientHeight < node.scrollHeight - 1 : node.scrollTop > 0)
            || /contain|none/.test(style.overscrollBehaviorY))) return true;
      }
      return false;
    };
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
      if (event.deltaY < 0 && !nestedScroll(event.target)) pause();
      if (event.deltaY > 0 && !nestedScroll(event.target, true)) downwardIntentRef.current = true;
    };
    const touchStart = (event: TouchEvent) => {
      touchingRef.current = false;
      touchY = event.touches[0]?.clientY ?? 0;
    };
    const touchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY ?? touchY;
      if (nextY - touchY > TOUCH_GESTURE_PX && !nestedScroll(event.target)) {
        touchingRef.current = true;
        pause();
        touchY = nextY;
      } else if (touchY - nextY > TOUCH_GESTURE_PX && !nestedScroll(event.target, true)) {
        touchingRef.current = true;
        downwardIntentRef.current = true;
        touchY = nextY;
      }
    };
    const touchEnd = (event: TouchEvent) => {
      touchingRef.current = event.touches.length > 0;
      if (!touchingRef.current && (followingRef.current || bottomGap(container) <= 4)) {
        followingRef.current = true;
        scrollToBottom();
      }
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) && !nestedScroll(event.target)) pause();
      if (['ArrowDown', 'PageDown', 'End'].includes(event.key) && !nestedScroll(event.target, true)) downwardIntentRef.current = true;
    };
    const pointerDown = (event: PointerEvent) => {
      downwardIntentRef.current = false;
      if (event.target === container && event.clientX >= container.getBoundingClientRect().left + container.clientWidth) {
        pause();
        downwardIntentRef.current = true; // Actual scroll direction is checked in handleScroll.
        return;
      }
      if (event.pointerType !== 'touch' && event.button === 0 && event.target instanceof Element
        && !event.target.closest('button, input, textarea, select, summary, a, [role="button"]')) selectingRef.current = true;
    };
    const releaseSelection = () => {
      selectingRef.current = false;
      touchingRef.current = false;
      scrollToBottom();
    };
    const selectionChange = () => { if (!selectingRef.current && !current.current.selectionActive()) scrollToBottom(); };
    const observer = new ResizeObserver(() => {
      const state = current.current;
      const syncTop = computeResizeFollowScrollTop({
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        clientHeight: container.clientHeight,
        enabled: state.enabled,
        following: followingRef.current,
        selecting: selectingRef.current || state.selectionActive(),
        touching: touchingRef.current,
      });
      if (syncTop !== null) {
        downwardIntentRef.current = false;
        container.scrollTop = container.scrollHeight;
        previousPositionRef.current = position(container);
        state.onMessagesBelowChange(bottomGap(container) > BOTTOM_ZONE_PX);
        return;
      }
      previousPositionRef.current = position(container);
      if (container.clientHeight > 0) {
        state.onMessagesBelowChange(bottomGap(container) > BOTTOM_ZONE_PX);
      }
    });
    observer.observe(content);
    observer.observe(container);
    container.addEventListener('wheel', wheel, { passive: true });
    container.addEventListener('touchstart', touchStart, { passive: true });
    container.addEventListener('touchmove', touchMove, { passive: true });
    container.addEventListener('touchend', touchEnd, { passive: true });
    container.addEventListener('touchcancel', touchEnd, { passive: true });
    container.addEventListener('keydown', keyDown);
    container.addEventListener('pointerdown', pointerDown);
    // Pointer release is not guaranteed to happen inside the transcript.
    document.addEventListener('pointerup', releaseSelection);
    document.addEventListener('pointercancel', releaseSelection);
    document.addEventListener('touchend', touchEnd, { passive: true });
    document.addEventListener('touchcancel', touchEnd, { passive: true });
    document.addEventListener('selectionchange', selectionChange);
    window.addEventListener('blur', releaseSelection);
    return () => {
      observer.disconnect();
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
      frameRef.current = undefined;
      manualRef.current = false;
      selectingRef.current = false;
      downwardIntentRef.current = false;
      touchingRef.current = false;
      container.removeEventListener('wheel', wheel);
      container.removeEventListener('touchstart', touchStart);
      container.removeEventListener('touchmove', touchMove);
      container.removeEventListener('touchend', touchEnd);
      container.removeEventListener('touchcancel', touchEnd);
      container.removeEventListener('keydown', keyDown);
      container.removeEventListener('pointerdown', pointerDown);
      document.removeEventListener('pointerup', releaseSelection);
      document.removeEventListener('pointercancel', releaseSelection);
      document.removeEventListener('touchend', touchEnd);
      document.removeEventListener('touchcancel', touchEnd);
      document.removeEventListener('selectionchange', selectionChange);
      window.removeEventListener('blur', releaseSelection);
    };
  }, [containerRef, followingRef, pauseFollowing, scrollToBottom]);

  return { contentRef, scrollToBottom, handleScroll, pauseFollowing };
}
