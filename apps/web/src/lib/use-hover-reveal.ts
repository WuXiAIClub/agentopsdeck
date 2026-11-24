import { useEffect, useRef, useState } from 'react';

/** Transient presentation only. Hover, focus and menus keep the rail open;
 * crossing the short gap to its trigger does not close it. */
export function useHoverReveal(enabled: boolean) {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLElement>(null), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clear = () => { clearTimeout(timer.current); };
  const show = () => { clear(); if (enabled) setOpen(true); };
  const hide = () => {
    clear();
    const settle = () => {
      if (panel.current?.matches(':hover') || panel.current?.contains(document.activeElement)
        || document.querySelector('.action-menu-popover, [role="dialog"]')) {
        timer.current = setTimeout(settle, 300);
        return;
      }
      setOpen(false);
    };
    timer.current = setTimeout(settle, 300);
  };
  useEffect(() => {
    setOpen(false); clear();
    if (!enabled) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { clear(); setOpen(false); } };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Element && !panel.current?.contains(event.target)
        && !event.target.closest('[data-rail-reveal], .action-menu-popover, [role="dialog"]')) { clear(); setOpen(false); }
    };
    document.addEventListener('keydown', escape); document.addEventListener('pointerdown', outside);
    return () => { clear(); document.removeEventListener('keydown', escape); document.removeEventListener('pointerdown', outside); };
  }, [enabled]);
  return { open: enabled && open, panel, show, hide };
}
