import { useEffect, useRef, type PointerEvent, type WheelEvent, type KeyboardEvent, type TouchEvent } from 'react';
import {
  isPeerEditor,
  isComposerRevealZone,
  mayHoverComposerFocus,
  mayHideIdleComposer,
  isPaneEnlargedForComposer,
  COMPOSER_IDLE_HIDE_MS,
} from './composer-focus';

// Closed caption popovers intentionally retain layout boxes for measurement.
// Geometry alone does not mean a blocking overlay is open or visible.
function hasBlockingOverlay() {
  return [...document.querySelectorAll<HTMLElement>('[aria-modal="true"],dialog[open],[role="menu"],[popover]:popover-open,[data-message-focus],.notebook-appearance')]
    .some(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible');
}

function isHostEnlarged(pane: HTMLElement) {
  return isPaneEnlargedForComposer({
    dense: pane.dataset.dense === 'true' ? true : pane.dataset.dense === 'false' ? false : undefined,
    maximized: pane.dataset.maximized === 'true',
  });
}

/** Only real mouse movement starts focus-following; polling/remounts cannot. */
export function usePaneHoverFocus(notebook = false) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const composing = useRef(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pointer = useRef<{ pane: HTMLElement; x: number; y: number } | undefined>(undefined);
  const touchY = useRef<number | undefined>(undefined);
  const cancel = () => { clearTimeout(timer.current); timer.current = undefined; clearTimeout(idleTimer.current); idleTimer.current = undefined; };
  function readHistory(pane: HTMLElement) {
    if (notebook || composing.current || pane.querySelector('.desktop-composer-dock[data-busy="true"]')) return false;
    // Enlarged/tall session panes keep their composer visible by default unless explicitly collapsed.
    if (isHostEnlarged(pane)) return false;
    cancel();
    pane.dataset.composerReading = 'true';
    delete pane.dataset.hoverComposer;
    const active = document.activeElement;
    if (active instanceof HTMLElement && pane.contains(active) && active.matches('.desktop-composer-textarea')) active.blur();
    return true;
  }
  function wheel(event: WheelEvent<HTMLElement>, onActivate?: () => void) {
    if (event.deltaY < 0 && event.target instanceof Element && event.target.closest('.message-selection-surface') && readHistory(event.currentTarget)) onActivate?.();
  }
  function touchStart(event: TouchEvent<HTMLElement>) {
    touchY.current = event.target instanceof Element && event.target.closest('.message-selection-surface') ? event.touches[0]?.clientY : undefined;
  }
  function touchMove(event: TouchEvent<HTMLElement>, onActivate?: () => void) {
    if (touchY.current !== undefined && event.touches.length === 1 && event.touches[0]!.clientY - touchY.current > 4 && readHistory(event.currentTarget)) onActivate?.();
  }
  function key(event: KeyboardEvent<HTMLElement>) {
    if (['PageUp', 'Home'].includes(event.key) && event.target instanceof Element && !event.target.closest('input,textarea,[contenteditable="true"]')) readHistory(event.currentTarget);
  }
  function armIdle() {
    clearTimeout(idleTimer.current);
    if (notebook || !pointer.current) return;
    idleTimer.current = setTimeout(() => {
      idleTimer.current = undefined;
      const current = pointer.current;
      if (!current?.pane.isConnected) return;
      const { pane, x, y } = current;
      const hovered = document.elementFromPoint(x, y);
      const active = document.activeElement;
      const activeDraftInPane =
        active instanceof HTMLTextAreaElement &&
        pane.contains(active) &&
        active.matches('.desktop-composer-textarea') &&
        active.value.length > 0;
      if (!mayHideIdleComposer({
        split: !!pane.closest('[data-split="true"]'),
        pointerInPane: pane.contains(hovered),
        pointerInComposer: !!hovered?.closest('.desktop-composer-dock'),
        composing: composing.current,
        selectedText: !!window.getSelection()?.toString(),
        busy: activeDraftInPane || !!pane.querySelector('.desktop-composer-dock[data-busy="true"]'),
        overlay: hasBlockingOverlay(),
        enlarged: isHostEnlarged(pane),
      })) return;
      // Only release this pane's composer focus; never blur another editor or
      // notebook. Draft contents and the existing scroll anchor are untouched.
      if (active instanceof HTMLElement && pane.contains(active) && active.matches('.desktop-composer-textarea')) active.blur();
      delete pane.dataset.hoverComposer;
    }, COMPOSER_IDLE_HIDE_MS);
  }
  useEffect(() => {
    const start = () => { composing.current = true; cancel(); };
    const end = () => { composing.current = false; armIdle(); };
    const blur = () => { end(); cancel(); };
    const activity = (event: Event) => {
      cancel();
      if (!notebook && event instanceof globalThis.KeyboardEvent && !event.defaultPrevented && !event.altKey
        && ((!event.ctrlKey && !event.metaKey && (event.key.length === 1 || event.key === 'Process' || event.keyCode === 229))
          || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') || (event.shiftKey && event.key === 'Insert'))) {
        const pane = document.querySelector<HTMLElement>('[data-workspace-pane][data-active="true"]');
        const active = document.activeElement;
        const editing = active instanceof HTMLElement && (active.isContentEditable || active.matches('input,textarea,select,button,a,[role="button"]'));
        const overlay = hasBlockingOverlay();
        const input = pane?.querySelector<HTMLTextAreaElement>('.desktop-composer-textarea:not(:disabled):not([readonly])');
        if (pane && input && !composing.current && !editing && !overlay && !window.getSelection()?.toString()) {
          delete pane.dataset.composerReading;
          delete pane.dataset.composerCollapsed;
          pane.dataset.hoverComposer = 'true';
          input.focus({ preventScroll: true });
        }
      }
      armIdle();
    };
    document.addEventListener('compositionstart', start, true);
    document.addEventListener('compositionend', end, true);
    document.addEventListener('keydown', activity, true);
    document.addEventListener('input', activity, true);
    document.addEventListener('selectionchange', activity);
    window.addEventListener('blur', blur);
    return () => {
      cancel();
      document.removeEventListener('compositionstart', start, true);
      document.removeEventListener('compositionend', end, true);
      document.removeEventListener('keydown', activity, true);
      document.removeEventListener('input', activity, true);
      document.removeEventListener('selectionchange', activity);
      window.removeEventListener('blur', blur);
    };
  }, []);
  function move(event: PointerEvent<HTMLElement>, dragging: boolean, onActivate?: () => void) {
    cancel();
    const pane = event.currentTarget, { clientX: x, clientY: y, pointerType, buttons } = event;
    // Most pointer moves happen inside the already focused pane. Avoid DOM-wide
    // overlay scans on that hot path and on touch/drag/IME interactions.
    if (pointerType !== 'mouse' || buttons || composing.current || dragging) return;
    pointer.current = { pane, x, y };
    armIdle();
    // Entering the transcript is also an intentional pane switch. Restricting
    // focus to the bottom strip left the highlighted pane and typing target
    // disagreeing, particularly when coming from a notebook. Existing selection,
    // overlay, editor and IME guards still apply before the delayed focus.
    const allowed = () => {
      const active = document.activeElement;
      const hovered = document.elementFromPoint(x, y);
      const overlay = hasBlockingOverlay();
      const interactive = hovered?.closest('button,a,input,textarea,select,summary,[contenteditable],[role="separator"]');
      return pane.isConnected && pane.contains(hovered) && (!interactive || notebook && interactive.matches('.notebook-rich-content[contenteditable="true"]')
        || !notebook && interactive.matches('.desktop-composer-textarea,.composer-reveal'))
        && mayHoverComposerFocus({ mouse: pointerType === 'mouse', buttons, composing: composing.current, dragging,
          selectedText: !!window.getSelection()?.toString(), overlay,
          otherEditor: active instanceof HTMLElement && (active.isContentEditable || active.matches('input,textarea,select')) && !isPeerEditor(active),
          collapsed: pane.dataset.collapsed === 'true' });
    };
    timer.current = setTimeout(() => {
      timer.current = undefined;
      if (!allowed()) return;
      onActivate?.();
      // If the user explicitly collapsed the composer, do not auto-open it on hover.
      if (!notebook && pane.dataset.composerCollapsed === 'true') {
        const active = document.activeElement;
        if (active instanceof HTMLElement && !pane.contains(active) && isPeerEditor(active)) active.blur();
        return;
      }
      // Pane activation and typing intent are distinct. Reading elsewhere in
      // the pane must not open the composer; the bottom 15% (or composer itself)
      // explicitly exits reading mode. Measure only after the hover delay.
      if (!notebook) {
        const bounds = pane.getBoundingClientRect();
        const hovered = document.elementFromPoint(x, y);
        if (!isComposerRevealZone(y, bounds.top, bounds.height) && !hovered?.closest('.desktop-composer-dock')) {
          // Do not leave the keyboard targeting the previous session/notebook
          // while this pane is highlighted. Typing can reveal this pane later.
          const active = document.activeElement;
          if (active instanceof HTMLElement && !pane.contains(active) && isPeerEditor(active)) active.blur();
          return;
        }
      }
      const input = pane.querySelector<HTMLElement>(notebook ? '.notebook-rich-content[contenteditable="true"]' : '.desktop-composer-textarea');
      if (!input || input.matches(':disabled,[readonly]') || notebook && !input.getClientRects().length) return;
      // Keep geometry stable while selecting text anywhere in this pane.
      // Only leaving the whole pane releases the pointer latch.
      if (!notebook) { delete pane.dataset.composerReading; pane.dataset.hoverComposer = 'true'; }
      input.focus({ preventScroll: true });
    }, 120);
  }
  function leave(event: PointerEvent<HTMLElement>) {
    cancel();
    pointer.current = undefined;
    delete event.currentTarget.dataset.hoverComposer;
  }
  return { move, cancel, leave, wheel, key, touchStart, touchMove };
}
