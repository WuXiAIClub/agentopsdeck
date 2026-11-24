import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';

/** Top-layer, non-modal palette: stays in the notebook DOM for focus and font
 * inheritance, but cannot be clipped by a narrow/scrolling card. No autofocus:
 * the editor's selection must survive opening and applying several styles. */
export function NotebookPopover({ anchor, onClose, className, label, children }: {
  anchor: RefObject<HTMLElement | null>; onClose: () => void; className: string; label: string; children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useLayoutEffect(() => {
    const node = panel.current, button = anchor.current;
    if (!node || !button) return;
    node.showPopover?.();
    const position = () => {
      const rect = button.getBoundingClientRect(), viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
      node.style.width = `${Math.min(310, Math.max(0, width - 16))}px`;
      node.style.maxHeight = `${Math.max(0, height - 16)}px`;
      const bounds = node.getBoundingClientRect();
      const y = rect.bottom + 6 + bounds.height <= top + height - 8 ? rect.bottom + 6 : rect.top - bounds.height - 6;
      node.style.left = `${Math.max(left + 8, Math.min(rect.left, left + width - bounds.width - 8))}px`;
      node.style.top = `${Math.max(top + 8, Math.min(y, top + height - bounds.height - 8))}px`;
    };
    position();
    const resize = new ResizeObserver(position); resize.observe(node); resize.observe(button);
    const outside = (event: Event) => {
      if (event.target instanceof Node && !node.contains(event.target) && !button.contains(event.target)) close.current();
    };
    let focusFrame = 0;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        cancelAnimationFrame(focusFrame);
        focusFrame = requestAnimationFrame(() => {
          const active = document.activeElement;
          if (active && !node.contains(active) && !button.contains(active)) close.current();
        });
      }
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation(); close.current(); button.focus({ preventScroll: true });
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', position); window.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position); window.visualViewport?.addEventListener('scroll', position);
    return () => {
      resize.disconnect(); cancelAnimationFrame(focusFrame);
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true);
      window.visualViewport?.removeEventListener('resize', position); window.visualViewport?.removeEventListener('scroll', position);
      node.hidePopover?.();
    };
  }, [anchor]);
  return <div ref={panel} popover="manual" className={`notebook-popover ${className}`} role="group" aria-label={label}>{children}</div>;
}
