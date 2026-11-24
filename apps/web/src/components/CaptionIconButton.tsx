import { useEffect, useId, useLayoutEffect, useRef, useState, type ComponentPropsWithRef } from 'react';
import { createPortal } from 'react-dom';

function positionTooltipElement(element: HTMLElement, anchor: Element | null) {
  const rect = anchor?.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return;
  const width = element.offsetWidth || 80;
  const height = element.offsetHeight || 26;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.x + (rect.width - width) / 2));
  const preferBottom = rect.bottom + 6;
  const top = preferBottom + height + 8 > window.innerHeight && rect.top - height - 6 >= 8
    ? rect.top - height - 6
    : Math.max(8, Math.min(window.innerHeight - height - 8, preferBottom));
  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
}

/** No idle listeners or polling. The manual top-layer hint escapes pane clipping and opens immediately (0ms). */
export function CaptionIconButton({ label, title, priority = 50, children, onClick, ...props }: ComponentPropsWithRef<'button'> & { label: string; priority?: number }) {
  const anchor = useRef<HTMLSpanElement>(null), hint = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false), id = useId();
  const close = () => setOpen(false);
  const tooltipText = title && title !== label ? `${label} · ${title}` : label;
  useLayoutEffect(() => {
    const element = hint.current;
    if (!open || !element) return;
    const place = () => positionTooltipElement(element, anchor.current);
    place();
    // A panel can restore focus to this button inside its own native popover
    // operation. Opening another popover synchronously then throws in Chromium.
    // Defer one frame, and cancel if focus/pointer has already moved away.
    const frame = requestAnimationFrame(() => {
      if (!element.isConnected || !anchor.current?.isConnected) return;
      try { element.showPopover(); place(); }
      catch (error) {
        if (error instanceof DOMException && error.name === 'InvalidStateError') close();
        else throw error;
      }
    });
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', escape);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', escape);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      if (element.matches(':popover-open')) element.hidePopover();
    };
  }, [open]);
  return <span ref={anchor} className="caption-icon-anchor" data-caption-priority={priority}
    onPointerEnter={event => { if (event.pointerType === 'touch') return; setOpen(true); }}
    onPointerLeave={close} onFocus={() => setOpen(true)} onBlur={close}>
    <button {...props} type="button" className={`caption-icon-button ${props.className ?? ''}`} aria-label={label} aria-describedby={open ? id : undefined}
      onClick={event => { close(); onClick?.(event); }}>{children}</button>
    {open && createPortal(<span ref={hint} id={id} popover="manual" role="tooltip" className="caption-icon-tooltip">{tooltipText}</span>, document.body)}
  </span>;
}

const INSTANT_TOOLTIP_SCOPE_SELECTOR = [
  '.session-pane-caption',
  '.os-window-controls',
  '.os-window-subtoolbar',
  '.resource-card-tools',
  '.saved-layouts-strip',
  '.notebook-header',
  '.os-browser-tabbar',
  '.os-browser-navbar',
  '.os-explorer-toolbar',
  '.os-settings-header',
  '.os-desktop-taskbar',
].join(', ');

function restoreStashedTitle(el: HTMLElement | null) {
  if (!el) return;
  const stashed = el.getAttribute('data-instant-title');
  if (stashed !== null) {
    if (!el.getAttribute('title')) {
      el.setAttribute('title', stashed);
    }
    el.removeAttribute('data-instant-title');
  }
}

function resolveInstantTooltipTarget(raw: EventTarget | null): { element: HTMLElement; text: string } | null {
  if (!(raw instanceof Element)) return null;
  const candidate = raw.closest('button, summary');
  if (!(candidate instanceof HTMLElement)) return null;
  if (candidate.closest('.caption-icon-anchor')) return null;
  if (!candidate.closest(INSTANT_TOOLTIP_SCOPE_SELECTOR)) return null;
  const rawTitle = candidate.getAttribute('title') || candidate.getAttribute('data-instant-title') || '';
  const ariaLabel = candidate.getAttribute('aria-label') || '';
  const text = (rawTitle || ariaLabel).trim();
  if (!text) return null;
  // Skip if button already displays identical visible text (unless it had an explicit title attribute).
  const visibleText = (candidate.textContent || '').trim();
  if (!rawTitle && visibleText && visibleText === text) return null;
  return { element: candidate, text };
}

/**
 * Provides 0ms instant hover tooltips for top-right toolbar / window control buttons
 * that otherwise rely on slow native browser `title` attributes (~700ms OS delay).
 */
export function InstantToolbarTooltips() {
  const hintRef = useRef<HTMLSpanElement>(null);
  const activeElRef = useRef<HTMLElement | null>(null);
  const [tip, setTip] = useState<{ text: string; target: HTMLElement } | null>(null);

  useEffect(() => {
    const clearActive = () => {
      if (activeElRef.current) {
        restoreStashedTitle(activeElRef.current);
        activeElRef.current = null;
      }
      setTip(prev => (prev ? null : prev));
    };

    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const resolved = resolveInstantTooltipTarget(event.target);
      if (!resolved) {
        if (activeElRef.current && !(event.target instanceof Node && activeElRef.current.contains(event.target))) {
          clearActive();
        }
        return;
      }
      const { element, text } = resolved;
      if (activeElRef.current && activeElRef.current !== element) {
        restoreStashedTitle(activeElRef.current);
      }
      const existingTitle = element.getAttribute('title');
      if (existingTitle) {
        element.setAttribute('data-instant-title', existingTitle);
        element.removeAttribute('title');
      }
      activeElRef.current = element;
      setTip({ text, target: element });
    };

    const onPointerOut = (event: PointerEvent) => {
      const current = activeElRef.current;
      if (!current) return;
      const related = event.relatedTarget;
      if (related instanceof Node && current.contains(related)) return;
      clearActive();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') clearActive();
    };

    document.addEventListener('pointerover', onPointerOver, true);
    document.addEventListener('pointerout', onPointerOut, true);
    document.addEventListener('pointerdown', clearActive, true);
    window.addEventListener('scroll', clearActive, true);
    window.addEventListener('resize', clearActive);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      clearActive();
      document.removeEventListener('pointerover', onPointerOver, true);
      document.removeEventListener('pointerout', onPointerOut, true);
      document.removeEventListener('pointerdown', clearActive, true);
      window.removeEventListener('scroll', clearActive, true);
      window.removeEventListener('resize', clearActive);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  useLayoutEffect(() => {
    const element = hintRef.current;
    if (!tip || !element) return;
    if (!tip.target.isConnected) {
      setTip(null);
      return;
    }
    const place = () => positionTooltipElement(element, tip.target);
    place();
    const frame = requestAnimationFrame(() => {
      if (!element.isConnected || !tip.target.isConnected) return;
      try {
        if (!element.matches(':popover-open')) element.showPopover();
        place();
      } catch {
        // Ignore transient top-layer conflicts
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      if (element.matches(':popover-open')) element.hidePopover();
    };
  }, [tip]);

  if (!tip || typeof document === 'undefined') return null;
  return createPortal(
    <span ref={hintRef} popover="manual" role="tooltip" className="caption-icon-tooltip">
      {tip.text}
    </span>,
    document.body,
  );
}
