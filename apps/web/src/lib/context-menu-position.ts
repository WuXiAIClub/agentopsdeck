import {
  useLayoutEffect,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';

export interface ContextMenuPoint {
  x: number;
  y: number;
}

export interface ContextMenuSize {
  width: number;
  height: number;
}

export interface ContextMenuViewport {
  width: number;
  height: number;
}

export interface ComputeContextMenuPositionInput {
  point: ContextMenuPoint;
  menuSize: ContextMenuSize;
  viewport: ContextMenuViewport;
  margin?: number | undefined;
  bottomInset?: number | undefined;
  offset?: number | undefined;
}

export type ContextMenuTransformOrigin =
  | 'top left'
  | 'top right'
  | 'bottom left'
  | 'bottom right';

export interface ComputedContextMenuPosition {
  left: number;
  top: number;
  maxWidth: number;
  maxHeight: number;
  transformOrigin: ContextMenuTransformOrigin;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Computes viewport-safe context menu coordinates around a pointer location.
 * Prefers opening to the bottom-right of the cursor, flipping horizontally or
 * vertically around the cursor when doing so avoids overflow and offers more room.
 */
export function computeContextMenuPosition({
  point,
  menuSize,
  viewport,
  margin = 8,
  bottomInset = 0,
  offset = 2,
}: ComputeContextMenuPositionInput): ComputedContextMenuPosition {
  const safeMargin = Math.max(4, Math.round(margin));
  const safeBottomInset = Math.max(0, Math.round(bottomInset));
  const safeOffset = Math.max(0, Math.round(offset));
  const vw = Math.max(200, Math.round(viewport.width));
  const vh = Math.max(200, Math.round(viewport.height));

  const bottomLimit = Math.max(safeMargin + 80, vh - safeMargin - safeBottomInset);
  const maxWidth = Math.max(160, vw - safeMargin * 2);
  const maxHeight = Math.max(120, bottomLimit - safeMargin);

  const effectiveWidth = Math.min(Math.max(120, Math.round(menuSize.width)), maxWidth);
  const effectiveHeight = Math.min(Math.max(48, Math.round(menuSize.height)), maxHeight);

  const rightCandidate = point.x + safeOffset;
  const leftCandidate = point.x - effectiveWidth - safeOffset;
  const spaceRight = vw - safeMargin - rightCandidate;
  const spaceLeft = point.x - safeOffset - safeMargin;

  let flipX = false;
  let desiredLeft = rightCandidate;
  if (spaceRight < effectiveWidth && spaceLeft > spaceRight) {
    flipX = true;
    desiredLeft = leftCandidate;
  }

  const downCandidate = point.y + safeOffset;
  const upCandidate = point.y - effectiveHeight - safeOffset;
  const spaceBelow = bottomLimit - downCandidate;
  const spaceAbove = point.y - safeOffset - safeMargin;

  let flipY = false;
  let desiredTop = downCandidate;
  if (spaceBelow < effectiveHeight && spaceAbove > spaceBelow) {
    flipY = true;
    desiredTop = upCandidate;
  }

  const left = Math.round(clamp(desiredLeft, safeMargin, vw - effectiveWidth - safeMargin));
  const top = Math.round(clamp(desiredTop, safeMargin, bottomLimit - effectiveHeight));
  const transformOrigin: ContextMenuTransformOrigin = `${flipY ? 'bottom' : 'top'} ${flipX ? 'right' : 'left'}`;

  return {
    left,
    top,
    maxWidth,
    maxHeight,
    transformOrigin,
  };
}

export interface UseContextMenuPositionOptions {
  margin?: number | undefined;
  bottomInset?: number | undefined;
  offset?: number | undefined;
  autoFocus?: boolean | undefined;
}

export function applyContextMenuPosition(
  node: HTMLElement,
  point: ContextMenuPoint,
  options?: Omit<UseContextMenuPositionOptions, 'autoFocus'>,
): ComputedContextMenuPosition {
  const rect = node.getBoundingClientRect();
  const measuredWidth = Math.max(node.offsetWidth || 0, Math.ceil(rect.width) || 0, 240);
  const measuredHeight = Math.max(node.offsetHeight || 0, Math.ceil(rect.height) || 0, 200);
  const computed = computeContextMenuPosition({
    point,
    menuSize: {
      width: measuredWidth,
      height: measuredHeight,
    },
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
    },
    margin: options?.margin,
    bottomInset: options?.bottomInset,
    offset: options?.offset,
  });
  node.style.left = `${computed.left}px`;
  node.style.top = `${computed.top}px`;
  node.style.maxHeight = `${computed.maxHeight}px`;
  node.style.setProperty('--aod-ctx-max-h', `${computed.maxHeight}px`);
  node.style.transformOrigin = computed.transformOrigin;
  return computed;
}

export function useContextMenuPosition(
  open: boolean,
  point: ContextMenuPoint | null | undefined,
  menuRef: RefObject<HTMLElement | null>,
  options?: UseContextMenuPositionOptions,
): void {
  const margin = options?.margin;
  const bottomInset = options?.bottomInset;
  const offset = options?.offset;
  const autoFocus = options?.autoFocus ?? false;

  useLayoutEffect(() => {
    const node = menuRef.current;
    if (!open || !point || !node || typeof window === 'undefined') return;

    const update = () => {
      applyContextMenuPosition(node, point, { margin, bottomInset, offset });
    };

    update();
    if (autoFocus) {
      const firstItem = node.querySelector<HTMLElement>(
        'button[role="menuitem"]:not(:disabled), button:not(:disabled)',
      );
      firstItem?.focus({ preventScroll: true });
    }

    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    observer?.observe(node);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [open, point?.x, point?.y, menuRef, margin, bottomInset, offset, autoFocus]);
}

export function handleContextMenuKeyDown(
  event: ReactKeyboardEvent<HTMLElement>,
  onClose?: () => void,
): void {
  const target = event.target as HTMLElement | null;
  if (event.key === 'Escape') {
    if (onClose) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
    return;
  }
  if (
    !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) ||
    target?.matches('input, select, textarea')
  ) {
    return;
  }
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
  );
  if (!items.length) return;
  const activeIndex = items.indexOf(document.activeElement as HTMLButtonElement);
  const nextIndex =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : activeIndex < 0
          ? event.key === 'ArrowUp'
            ? items.length - 1
            : 0
          : (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  event.preventDefault();
  event.stopPropagation();
  items[nextIndex]?.focus({ preventScroll: true });
}
