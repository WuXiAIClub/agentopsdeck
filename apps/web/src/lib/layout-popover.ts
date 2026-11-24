import { useLayoutEffect, type CSSProperties, type RefObject } from 'react';

export type PopoverPlacement = 'right-start' | 'bottom-start' | 'bottom-end';

export interface PopoverRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface PopoverViewport {
  width: number;
  height: number;
}

export interface PopoverSize {
  width: number;
  height: number;
}

export interface ComputeAnchoredPopoverInput {
  anchor: PopoverRect;
  viewport: PopoverViewport;
  popoverSize: PopoverSize;
  placement?: PopoverPlacement | undefined;
  gap?: number | undefined;
  margin?: number | undefined;
}

export interface ComputedPopoverPosition {
  position: 'fixed';
  top: number;
  left: number;
  maxHeight: number;
  maxWidth: number;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

export function computeAnchoredPopoverStyle({
  anchor,
  viewport,
  popoverSize,
  placement = 'bottom-start',
  gap = 8,
  margin = 12,
}: ComputeAnchoredPopoverInput): ComputedPopoverPosition {
  const safeMargin = Math.max(4, Math.round(margin));
  const safeGap = Math.max(0, Math.round(gap));
  const vw = Math.max(240, Math.round(viewport.width));
  const vh = Math.max(240, Math.round(viewport.height));
  const maxWidth = Math.max(180, vw - safeMargin * 2);
  const maxHeight = Math.max(180, vh - safeMargin * 2);

  const effectiveWidth = Math.min(Math.max(120, Math.round(popoverSize.width)), maxWidth);
  const effectiveHeight = Math.min(Math.max(80, Math.round(popoverSize.height)), maxHeight);

  let desiredLeft = anchor.left;
  let desiredTop = anchor.bottom + safeGap;

  if (placement === 'right-start') {
    const rightSpace = vw - (anchor.right + safeGap) - safeMargin;
    const leftSpace = anchor.left - safeGap - safeMargin;
    if (rightSpace >= effectiveWidth || rightSpace >= leftSpace) {
      desiredLeft = anchor.right + safeGap;
    } else {
      desiredLeft = anchor.left - safeGap - effectiveWidth;
    }
    desiredTop = anchor.top;
  } else {
    desiredLeft = placement === 'bottom-end' ? anchor.right - effectiveWidth : anchor.left;
    const belowSpace = vh - (anchor.bottom + safeGap) - safeMargin;
    const aboveSpace = anchor.top - safeGap - safeMargin;
    if (belowSpace < effectiveHeight && aboveSpace > belowSpace) {
      desiredTop = anchor.top - safeGap - effectiveHeight;
    } else {
      desiredTop = anchor.bottom + safeGap;
    }
  }

  const left = Math.round(clamp(desiredLeft, safeMargin, vw - effectiveWidth - safeMargin));
  const top = Math.round(clamp(desiredTop, safeMargin, vh - effectiveHeight - safeMargin));

  return {
    position: 'fixed',
    top,
    left,
    maxHeight,
    maxWidth,
  };
}

export interface UseViewportPopoverOptions {
  defaultPlacement?: PopoverPlacement | undefined;
  railPlacement?: PopoverPlacement | undefined;
  gap?: number | undefined;
  margin?: number | undefined;
}

export function useViewportPopover(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  popoverRef: RefObject<HTMLElement | null>,
  options?: UseViewportPopoverOptions,
): void {
  const defaultPlacement = options?.defaultPlacement ?? 'bottom-start';
  const railPlacement = options?.railPlacement ?? 'right-start';
  const gap = options?.gap;
  const margin = options?.margin ?? 12;

  useLayoutEffect(() => {
    if (!open || typeof window === 'undefined') return;

    let rafId = 0;
    const updatePosition = () => {
      const trigger = triggerRef.current;
      const popover = popoverRef.current;
      if (!trigger || !popover) return;

      const inRail = Boolean(trigger.closest('#workspace-layout-tools, .primary-navigation'));
      const placement = inRail ? railPlacement : defaultPlacement;
      const effectiveGap = gap ?? (inRail ? 10 : 6);

      popover.style.position = 'fixed';
      popover.style.right = 'auto';
      popover.style.bottom = 'auto';
      popover.style.maxHeight = `${Math.max(180, window.innerHeight - margin * 2)}px`;
      popover.style.maxWidth = `${Math.max(180, window.innerWidth - margin * 2)}px`;

      const anchorRect = trigger.getBoundingClientRect();
      const popRect = popover.getBoundingClientRect();
      const computed = computeAnchoredPopoverStyle({
        anchor: {
          top: anchorRect.top,
          left: anchorRect.left,
          right: anchorRect.right,
          bottom: anchorRect.bottom,
          width: anchorRect.width,
          height: anchorRect.height,
        },
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
        },
        popoverSize: {
          width: popRect.width || popover.offsetWidth || 280,
          height: popRect.height || popover.offsetHeight || 240,
        },
        placement,
        gap: effectiveGap,
        margin,
      });

      const style: CSSProperties = {
        position: computed.position,
        top: `${computed.top}px`,
        left: `${computed.left}px`,
        maxHeight: `${computed.maxHeight}px`,
        maxWidth: `${computed.maxWidth}px`,
      };
      popover.style.position = style.position!;
      popover.style.top = String(style.top);
      popover.style.left = String(style.left);
      popover.style.maxHeight = String(style.maxHeight);
      popover.style.maxWidth = String(style.maxWidth);
    };

    const scheduleUpdate = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(updatePosition);
    };

    updatePosition();
    const resizeObserver =
      typeof ResizeObserver !== 'undefined' && popoverRef.current
        ? new ResizeObserver(() => scheduleUpdate())
        : null;
    if (resizeObserver && popoverRef.current) {
      resizeObserver.observe(popoverRef.current);
    }

    window.addEventListener('resize', scheduleUpdate, { passive: true });
    window.addEventListener('scroll', scheduleUpdate, { capture: true, passive: true });

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('scroll', scheduleUpdate, true);
    };
  }, [open, triggerRef, popoverRef, defaultPlacement, railPlacement, gap, margin]);
}
