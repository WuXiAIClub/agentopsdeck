import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';

/** Top-layer panels escape narrow pane clipping. Listeners exist only while open. */
export function AnchoredPanel({ open, onClose, anchor, children, label, keepMounted = false }: {
  open: boolean; onClose: () => void; anchor: RefObject<HTMLElement | null>; children: ReactNode; label: string; keepMounted?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element || !open) return;
    let frame = 0;
    const place = () => {
      frame = 0;
      if (!element.matches(':popover-open')) return;
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const width = element.offsetWidth, height = element.offsetHeight;
      element.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width))}px`;
      element.style.top = `${Math.max(8, Math.min(window.innerHeight - height - 8, rect.bottom + 6))}px`;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(place); };
    element.showPopover(); place();
    const observer = new ResizeObserver(schedule); observer.observe(element);
    window.addEventListener('resize', schedule); window.addEventListener('scroll', schedule, true);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true); if (element.matches(':popover-open')) element.hidePopover(); };
  }, [open, anchor]);
  return open || keepMounted ? <div ref={panel} popover="auto" className="caption-popover" role="region" aria-label={label}
    onToggle={event => { if (event.newState === 'closed') onClose(); }}>{children}</div> : null;
}
