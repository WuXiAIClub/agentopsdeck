import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { MessageItem } from './incremental-message-items.js';

export const INITIAL_TAIL_RENDER_ITEMS = 32;
export const PROGRESSIVE_TAIL_RENDER_STEPS = [32, 96, 200] as const;

export function nextProgressiveTailCount(
  currentLimit: number,
  totalItems: number,
  steps: readonly number[] = PROGRESSIVE_TAIL_RENDER_STEPS,
): number {
  if (totalItems <= 0) return 0;
  const initial = steps[0] ?? INITIAL_TAIL_RENDER_ITEMS;
  if (totalItems <= initial || currentLimit >= totalItems) return totalItems;
  for (const step of steps) {
    if (step > currentLimit) return Math.min(totalItems, step);
  }
  return totalItems;
}

export function sliceTailRenderItems<T>(
  items: readonly MessageItem<T>[],
  tailLimit: number,
  bypass = false,
): readonly MessageItem<T>[] {
  if (bypass || tailLimit >= items.length || items.length <= INITIAL_TAIL_RENDER_ITEMS) return items;
  return items.slice(items.length - Math.max(1, Math.min(items.length, tailLimit)));
}

export function resolveProgressivePrependScrollTop(input: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  following: boolean;
  anchorDeltaTop?: number | undefined;
}): number | undefined {
  if (input.clientHeight <= 0) return undefined;
  if (input.following) return input.scrollHeight;
  if (input.anchorDeltaTop !== undefined && Number.isFinite(input.anchorDeltaTop)) {
    return Math.max(0, input.scrollTop + input.anchorDeltaTop);
  }
  return undefined;
}

const ANCHOR_SELECTOR = '[data-message-search-id]';

function captureTopAnchor(container: HTMLElement | null | undefined) {
  if (!container || container.clientHeight <= 0) return undefined;
  const top = container.getBoundingClientRect().top;
  for (const row of container.querySelectorAll<HTMLElement>(ANCHOR_SELECTOR)) {
    const id = row.dataset.messageSearchId;
    if (id && row.getBoundingClientRect().bottom > top) return { id, top: row.getBoundingClientRect().top };
  }
  return undefined;
}

export function useProgressiveTailRenderItems<T>({
  sessionKey,
  items,
  bypass = false,
  containerRef,
  followingRef,
  autoScrollEnabled = true,
}: {
  sessionKey: string;
  items: readonly MessageItem<T>[];
  bypass?: boolean;
  containerRef?: RefObject<HTMLElement | null> | undefined;
  followingRef?: RefObject<boolean> | undefined;
  autoScrollEnabled?: boolean | undefined;
}): readonly MessageItem<T>[] {
  const lastSessionKeyRef = useRef(sessionKey);
  const settledSessionRef = useRef<string | null>(null);
  const [tailLimit, setTailLimit] = useState<number>(() => INITIAL_TAIL_RENDER_ITEMS);
  const pendingAnchorRef = useRef<{ id: string; top: number } | undefined>(undefined);
  const prevSliceRef = useRef<{ key: string; head?: MessageItem<T> | undefined; tail?: MessageItem<T> | undefined; len: number }>({ key: sessionKey, len: 0 });

  if (lastSessionKeyRef.current !== sessionKey) {
    lastSessionKeyRef.current = sessionKey;
    settledSessionRef.current = null;
    pendingAnchorRef.current = undefined;
    if (tailLimit !== INITIAL_TAIL_RENDER_ITEMS) setTailLimit(INITIAL_TAIL_RENDER_ITEMS);
  }

  const effectiveBypass = bypass || settledSessionRef.current === sessionKey || items.length <= INITIAL_TAIL_RENDER_ITEMS;

  useEffect(() => {
    if (effectiveBypass || tailLimit >= items.length) {
      if (items.length > 0) settledSessionRef.current = sessionKey;
      return;
    }
    let cancelled = false;
    const raf = typeof window !== 'undefined' && window.requestAnimationFrame
      ? window.requestAnimationFrame.bind(window)
      : (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16) as unknown as number;
    const cancel = typeof window !== 'undefined' && window.cancelAnimationFrame
      ? window.cancelAnimationFrame.bind(window)
      : (id: number) => clearTimeout(id);
    const handle = raf(() => {
      if (cancelled) return;
      pendingAnchorRef.current = captureTopAnchor(containerRef?.current);
      setTailLimit(current => {
        const next = nextProgressiveTailCount(current, items.length);
        if (next >= items.length && items.length > 0) settledSessionRef.current = sessionKey;
        return next;
      });
    });
    return () => { cancelled = true; cancel(handle); };
  }, [containerRef, effectiveBypass, items.length, sessionKey, tailLimit]);

  const rendered = useMemo(() => sliceTailRenderItems(items, tailLimit, effectiveBypass), [items, tailLimit, effectiveBypass]);

  useLayoutEffect(() => {
    const prev = prevSliceRef.current;
    const head = rendered[0], tail = rendered.at(-1);
    const prepended = prev.key === sessionKey && prev.len > 0 && rendered.length > prev.len
      && head !== prev.head && (tail === prev.tail || pendingAnchorRef.current !== undefined);
    prevSliceRef.current = { key: sessionKey, head, tail, len: rendered.length };
    const saved = pendingAnchorRef.current;
    pendingAnchorRef.current = undefined;
    const container = containerRef?.current;
    if (!prepended || !container || container.clientHeight <= 0) return;
    const following = Boolean((followingRef ? followingRef.current : true) && autoScrollEnabled);
    let anchorDeltaTop: number | undefined;
    if (!following && saved) {
      for (const row of container.querySelectorAll<HTMLElement>(ANCHOR_SELECTOR)) {
        if (row.dataset.messageSearchId === saved.id) {
          anchorDeltaTop = row.getBoundingClientRect().top - saved.top;
          break;
        }
      }
    }
    const nextTop = resolveProgressivePrependScrollTop({
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
      following,
      anchorDeltaTop,
    });
    if (nextTop !== undefined) container.scrollTop = nextTop;
  }, [autoScrollEnabled, containerRef, followingRef, rendered, sessionKey]);

  return rendered;
}
