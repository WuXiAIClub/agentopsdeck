import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../lib/i18n';
import { Code2 } from 'lucide-react';
import { scheduleSourcePreviewHover } from '../lib/source-preview-hover';

// One observer per pane, not per file reference in a long transcript.
const panes = new WeakMap<Element, { listeners: Set<(value: boolean) => void>; observer: ResizeObserver; narrow: boolean }>();
let dismissPreview: (() => void) | undefined;
function observePane(pane: Element, listener: (value: boolean) => void) {
  let entry = panes.get(pane);
  if (!entry) {
    const listeners = new Set<(value: boolean) => void>();
    entry = { listeners, narrow: pane.getBoundingClientRect().width <= 520, observer: new ResizeObserver(entries => {
      if (!entries[0]) return;
      const next = entries[0].contentRect.width <= 520;
      if (entry!.narrow === next) return;
      entry!.narrow = next;
      listeners.forEach(notify => notify(next));
    }) };
    panes.set(pane, entry); entry.observer.observe(pane);
  }
  entry.listeners.add(listener); listener(entry.narrow);
  return () => {
    entry!.listeners.delete(listener);
    if (!entry!.listeners.size) { entry!.observer.disconnect(); panes.delete(pane); }
  };
}

/** Narrow panes defer rendering; pointer intent may warm the existing source cache. */
export function NarrowSourcePreview({ path, line, children, prewarm }: {
  path: string; line: number; children: ReactNode; prewarm?: () => (() => void) | undefined;
}) {
  const { t } = useI18n(), id = useId();
  const root = useRef<HTMLSpanElement>(null), popup = useRef<HTMLSpanElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const warmRelease = useRef<(() => void) | undefined>(undefined);
  const restoringFocus = useRef(false);
  const [narrow, setNarrow] = useState<boolean>(), [open, setOpen] = useState(false), [focused, setFocused] = useState(false);
  const clear = () => { clearTimeout(timer.current); timer.current = undefined; };
  const releaseWarm = () => { warmRelease.current?.(); warmRelease.current = undefined; };
  const warm = () => { if (!warmRelease.current) warmRelease.current = prewarm?.(); };
  const close = () => { clear(); releaseWarm(); setOpen(false); setFocused(false); };
  const dismiss = () => {
    if (root.current?.contains(document.activeElement)) {
      restoringFocus.current = true; trigger.current?.focus(); restoringFocus.current = false;
    }
    close();
  };
  const enter = () => { clear(); warm(); timer.current = scheduleSourcePreviewHover(() => setOpen(true)); };
  const leave = () => { clear(); releaseWarm(); timer.current = setTimeout(() => {
    if (!focused && !popup.current?.contains(document.activeElement)) setOpen(false);
  }, 200); };
  useLayoutEffect(() => {
    const pane = root.current?.closest('[data-workspace-pane]');
    if (!pane) { setNarrow(false); return; }
    return observePane(pane, value => { close(); setNarrow(value); });
  }, []);
  useLayoutEffect(() => {
    close();
    return () => { clear(); releaseWarm(); };
  }, [path, line, prewarm]);
  useLayoutEffect(() => {
    if (!open || !narrow || !popup.current || !trigger.current) return;
    dismissPreview?.(); dismissPreview = close;
    const el = popup.current, rect = trigger.current.getBoundingClientRect();
    const width = Math.min(focused ? 1100 : 640, innerWidth - 24), height = focused ? innerHeight * .9 : Math.min(440, innerHeight - 24);
    el.style.width = `${width}px`; el.style.maxHeight = `${height}px`;
    el.style.left = `${focused ? (innerWidth-width)/2 : Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`;
    el.style.top = `${focused ? innerHeight*.05 : Math.max(8, Math.min(rect.bottom + 6, innerHeight - height - 8))}px`;
    el.showPopover(); // Top layer escapes the pane's overflow; does not steal focus.
    if (focused) el.focus({ preventScroll: true });
    const scroll = (event: Event) => { if (!focused && (!(event.target instanceof Node) || !el.contains(event.target))) close(); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); }
    };
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    window.addEventListener('resize', close);
    document.addEventListener('scroll', scroll, true);
    document.addEventListener('keydown', key, true);
    document.addEventListener('pointerdown', outside, true);
    return () => {
      if (dismissPreview === close) dismissPreview = undefined;
      if (el.matches(':popover-open')) el.hidePopover();
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', scroll, true);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('pointerdown', outside, true);
    };
  }, [open, narrow, focused]);
  return <span ref={root} className="source-responsive-preview" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
  }}>
    {narrow === false ? children : <>
      <button ref={trigger} type="button" className="source-hover-trigger" title={path} aria-label={t('Source preview {path}:{line}', { path, line })}
        aria-expanded={open} aria-controls={open ? id : undefined} onPointerEnter={event => { if (event.pointerType !== 'touch') enter(); }}
        onPointerLeave={leave} onFocus={event => {
          // Mouse focus precedes click: do not insert a hover popup in that gap.
          if (!restoringFocus.current && event.currentTarget.matches(':focus-visible')) { clear(); warm(); setOpen(true); }
        }} onClick={() => { clear(); warm(); setFocused(true); setOpen(true); }}>
        <Code2 size={14} aria-hidden="true" /><span>{path.split(/[\\/]/).at(-1)}:{line}</span>
      </button>
      {open && narrow ? <span ref={popup} id={id} popover="manual" className={`source-hover-popup${focused ? ' source-focus-popup' : ''}`}
        role={focused ? 'dialog' : undefined} aria-modal={focused ? false : undefined}
        aria-label={focused ? t('Source preview {path}:{line}', { path, line }) : undefined} tabIndex={-1}
        onPointerEnter={clear} onPointerLeave={leave}>
        <button type="button" className="source-hover-close" onClick={dismiss}>{t('Close')}</button>
        {children}
      </span> : null}
    </>}
  </span>;
}
