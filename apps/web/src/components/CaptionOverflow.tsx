import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { useI18n } from '../lib/i18n';
import { captionSelection, captionTitleBudget } from '../lib/caption-priority';

const pixels = (style: CSSStyleDeclaration, property: string) => parseFloat(style.getPropertyValue(property)) || 0;

/** Keep controllers mounted in the same DOM location: resizing must not reload
 * files, lose a notebook draft, or duplicate a session command. */
export function CaptionOverflow({ children }: { children: ReactNode }) {
  const { t } = useI18n(), id = useId();
  const host = useRef<HTMLDivElement>(null), tools = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const [collapsed, setCollapsed] = useState(false), [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const root = host.current, content = tools.current, caption = root?.closest('.session-pane-caption');
    const title = caption?.querySelector<HTMLElement>('.session-pane-drag-title');
    if (!root || !content || !caption || !title) return;
    let frame = 0;
    let openLayout: number[][] = [];
    let sizes: { element: HTMLElement; width: number }[] = [];
    const items = (parent: Element): HTMLElement[] => [...parent.children].flatMap(child =>
      child.matches('.caption-popover') ? [] : child.matches('.session-pane-status-actions, .session-pane-custom-actions, .resource-card-tools') ? items(child) : child instanceof HTMLElement ? [child] : []);
    const layout = () => [caption, ...caption.children].map(element => {
      const rect = element.getBoundingClientRect();
      return [rect.x, rect.y, rect.width, rect.height];
    });
    const beforeToggle = (event: ToggleEvent) => {
      if (event.newState === 'open') {
        // A native popover lifts its entire subtree into the top layer. Keep
        // fitting controls at their original viewport coordinates and reserve
        // the toolbar's footprint; only overflow items participate in its flex
        // layout. No React controller is cloned, moved or remounted.
        const { width, height } = root.getBoundingClientRect();
        const inline = items(content).filter(element => !element.hasAttribute('data-caption-hidden'))
          .map(element => ({ element, rect: element.getBoundingClientRect(), color: getComputedStyle(element).color }));
        openLayout = layout();
        Object.assign(root.style, { width: `${width}px`, height: `${height}px` });
        for (const { element, rect, color } of inline) {
          element.setAttribute('data-caption-inline', '');
          for (const [key, value] of Object.entries({ left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px`, color })) {
            element.style.setProperty(`--caption-inline-${key}`, value);
          }
        }
      } else {
        for (const key of ['width', 'height']) root.style.removeProperty(key);
        for (const element of items(content)) {
          element.removeAttribute('data-caption-inline');
          for (const key of ['left', 'top', 'width', 'height', 'color']) element.style.removeProperty(`--caption-inline-${key}`);
        }
        openLayout = [];
      }
    };
    const measure = () => {
      frame = 0;
      if (content.matches(':popover-open')) {
        // Resize/move closes the popup before a fresh inline measurement.
        // Popup dimensions must never become input to priority selection.
        // Flex layout can round a pinned fractional width by a subpixel when
        // the popover leaves normal flow. This is not a resize or navigation.
        const current = layout();
        if (current.length !== openLayout.length || current.some((rect, index) =>
          rect.some((value, axis) => Math.abs(value - openLayout[index]![axis]!) > 0.5))) content.hidePopover();
        return;
      }
      // Unified OS desktop window bars are right-aligned action clusters overlaid in the titlebar;
      // mutating title.style.width or collapsing items on an auto-width inline-flex container
      // creates a ResizeObserver feedback loop (flickering/jumping action icons).
      if (caption.hasAttribute('data-unified-window-bar')) {
        const elements = items(content);
        sizes = elements.map(element => ({ element, width: element.getBoundingClientRect().width }));
        for (const element of elements) {
          if (element.hasAttribute('data-caption-hidden')) element.removeAttribute('data-caption-hidden');
          if (element.inert) element.inert = false;
        }
        title.style.removeProperty('width');
        title.style.removeProperty('margin-inline-end');
        setCollapsed(prev => (prev ? false : prev));
        return;
      }
      // Measure the original controls, never copies or the wrapped popup. All
      // visibility changes finish before paint and controllers stay mounted.
      const elements = items(content);
      for (const element of elements) element.removeAttribute('data-caption-hidden');
      sizes = elements.map(element => ({ element, width: Math.round(element.getBoundingClientRect().width) }));
      const css = getComputedStyle(caption), width = Math.round(caption.clientWidth);
      const fixed = [...caption.children].filter(child => child !== title && child !== root).reduce((sum, child) => sum + child.getBoundingClientRect().width, 0);
      const gaps = (caption.children.length - 1) * pixels(css, 'column-gap');
      const available = Math.round(width - fixed - gaps - pixels(css, 'padding-left') - pixels(css, 'padding-right'));
      // Measure rendered text nodes, not the flex-grown title container. Ranges
      // retain full text width even when the parent visually ellipsizes it.
      const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT);
      let intrinsic = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const range = document.createRange(); range.selectNodeContents(node);
        intrinsic += range.getBoundingClientRect().width;
      }
      // Input values are DOM properties, not text nodes. Measure their actual
      // font instead of reserving the browser's default input width.
      const context = document.createElement('canvas').getContext('2d');
      for (const input of title.querySelectorAll('input')) {
        if (!input.getClientRects().length || !context) continue;
        const style = getComputedStyle(input), value = input.value || input.placeholder;
        context.font = style.font;
        intrinsic += context.measureText(value).width + value.length * pixels(style, 'letter-spacing')
          + pixels(style, 'padding-left') + pixels(style, 'padding-right');
      }
      for (const button of title.querySelectorAll('button')) {
        const width = button.getBoundingClientRect().width;
        if (width) intrinsic += width + pixels(getComputedStyle(button.parentElement!), 'column-gap');
      }
      // Keep triggerWidth constant (26px) even when the trigger button is display:none
      // so toggling collapsed state never shifts the threshold by 2px on the next frame.
      const triggerWidth = 26;
      // The empty inline group still has a 3px flex gap before More.
      const titleBudget = Math.round(captionTitleBudget(available, intrinsic + 2, triggerWidth + 3));
      const separation = Math.round(Math.min(triggerWidth * 3, Math.max(0, available - titleBudget - triggerWidth - 3)));
      const nextWidthPx = `${titleBudget}px`;
      const nextSepPx = `${separation}px`;
      if (title.style.width !== nextWidthPx) title.style.width = nextWidthPx;
      if (title.style.marginInlineEnd !== nextSepPx) title.style.marginInlineEnd = nextSepPx;
      const { overflow, hidden } = captionSelection(sizes.map(({ element, width }) => {
        const value = Number(element.dataset.captionPriority);
        return { width, priority: Number.isFinite(value) ? value : 50 };
      }), available - titleBudget - separation, triggerWidth);
      for (const [index, { element }] of sizes.entries()) {
        const hide = hidden.has(index);
        if (element.hasAttribute('data-caption-hidden') !== hide) {
          element.toggleAttribute('data-caption-hidden', hide);
        }
        if (element.inert !== hide) element.inert = hide;
      }
      setCollapsed(prev => (prev === overflow ? prev : overflow));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    // Status text and safety controls can change without changing pane width.
    for (const child of [caption, content, ...[...caption.children].filter(c => c !== title)]) observer.observe(child);
    // Portals and conditional actions can arrive after the caption mounts.
    const mutations = new MutationObserver(records => {
      const elements = items(content);
      const changed = elements.length !== sizes.length || elements.some((element, index) => element !== sizes[index]?.element)
        || records.some(record => record.type === 'attributes');
      // Nested panels and their text may update while More is open. Closing
      // their ancestor would dismiss them; only changed actions/priorities
      // require a fresh selection, not every descendant mutation.
      if (changed && content.matches(':popover-open')) content.hidePopover();
      schedule();
    });
    const textChanges = { childList: true, subtree: true, characterData: true };
    mutations.observe(content, { ...textChanges, attributes: true, attributeFilter: ['data-caption-priority'] });
    mutations.observe(title, textChanges);
    const events: [EventTarget, string, EventListener, boolean?][] = [
      [title, 'input', schedule], [title, 'captionchange', schedule],
      [content, 'toggle', schedule], [content, 'beforetoggle', beforeToggle as EventListener],
      [window, 'resize', () => { if (content.matches(':popover-open')) content.hidePopover(); schedule(); }],
      [window, 'scroll', schedule, true],
    ];
    for (const [target, name, handler, capture] of events) target.addEventListener(name, handler, capture);
    measure();
    return () => {
      observer.disconnect(); mutations.disconnect();
      for (const property of ['width', 'margin-inline-end']) title.style.removeProperty(property);
      for (const [target, name, handler, capture] of events) target.removeEventListener(name, handler, capture);
      cancelAnimationFrame(frame);
    };
  }, []);
  useLayoutEffect(() => {
    const element = tools.current;
    if (!element || !open || !collapsed) return;
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    // The geometry observer above closes More if its anchor moves. Position it
    // once on opening; a second set of resize/scroll listeners is unnecessary.
    const width = element.offsetWidth, height = element.offsetHeight;
    for (const [axis, limit, size, position] of [
      ['left', window.innerWidth, width, rect.right - width],
      ['top', window.innerHeight, height, rect.bottom + 6],
    ] as const) element.style[axis] = `${Math.max(8, Math.min(limit - size - 8, position))}px`;
  }, [open, collapsed]);
  return <div ref={host} className="caption-overflow" data-collapsed={collapsed}>
    <div ref={tools} id={id} className="caption-overflow-content" popover={collapsed ? 'auto' : undefined} role={collapsed ? 'group' : undefined} aria-label={t('Pane tools')}
      onToggle={event => {
        const nextOpen = event.newState === 'open';
        for (const element of event.currentTarget.querySelectorAll<HTMLElement>('[data-caption-hidden]')) element.inert = !nextOpen;
        setOpen(nextOpen);
      }}>{children}</div>
    <button ref={trigger} type="button" style={collapsed ? undefined : { display: 'none' }} popoverTarget={id} aria-label={t('Pane tools')} title={t('Pane tools')} aria-expanded={open}><MoreHorizontal size={15} /></button>
  </div>;
}
