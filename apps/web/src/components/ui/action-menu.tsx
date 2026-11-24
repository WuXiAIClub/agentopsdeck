import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type Action = { label: string; icon?: ReactNode; disabled?: boolean; destructive?: boolean; run: () => void };
/** Viewport-anchored menus escape scroll/stacking contexts without raising an
 * entire session rail over the workspace. Keyboard focus stays local. */
export function ActionMenu({ label, children, items }: { label: string; children: ReactNode; items: Action[] }) {
  const [open, setOpen] = useState(false), [position, setPosition] = useState({ left: 8, top: 8 });
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), id = useId();
  const close = (restore = false) => { setOpen(false); if (restore) trigger.current?.focus({ preventScroll: true }); };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect(), popup = menu.current?.getBoundingClientRect();
      if (!rect || !popup) return;
      setPosition({ left: Math.max(8, Math.min(rect.right - popup.width, window.innerWidth - popup.width - 8)),
        top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - popup.height - 8)) });
    };
    place(); menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    const outside = (event: Event) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) close();
    };
    const scroll = (event: Event) => { if (!(event.target instanceof Node && menu.current?.contains(event.target))) place(); };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('focusin', outside);
    window.addEventListener('resize', place); window.addEventListener('scroll', scroll, true);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('focusin', outside); window.removeEventListener('resize', place); window.removeEventListener('scroll', scroll, true); };
  }, [open]);
  return <><button ref={trigger} type="button" className="action-menu-trigger" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
    onPointerDown={event => event.stopPropagation()} onClick={() => setOpen(value => !value)}>{children}</button>
    {open && createPortal(<div ref={menu} id={id} role="menu" aria-label={label} className="action-menu-popover" style={position} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }
    }}>{items.map(item => <button type="button" key={item.label} role="menuitem" disabled={item.disabled} className={item.destructive ? 'is-destructive' : undefined}
      onClick={() => { close(true); item.run(); }}>{item.icon}{item.label}</button>)}</div>, document.body)}</>;
}
