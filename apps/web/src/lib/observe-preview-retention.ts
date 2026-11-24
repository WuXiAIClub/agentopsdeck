import { createPreviewRetention } from './preview-retention';

const surfaces = new WeakMap<Element, { observe: (target: Element, notify: (compact: boolean) => void) => () => void }>();

/** Desktop only. Never replace nodes containing a selection or keyboard focus. */
export function observePreviewRetention(target: Element, notify: (compact: boolean) => void) {
  const root = target.closest('.message-selection-surface');
  if (!root || !target.closest('.desktop-session-frame') || typeof IntersectionObserver === 'undefined') return () => {};
  let surface = surfaces.get(root);
  if (!surface) {
    const document = root.ownerDocument;
    const retention = createPreviewRetention<Element>({ protectedTarget: (element, compact) => {
      if (compact && element.contains(document.activeElement)) return true;
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed) return false;
      // Includes selections crossing cards/panes, not just an endpoint inside.
      for (let i = 0; i < selection.rangeCount; i++) if (selection.getRangeAt(i).intersectsNode(root)) return true;
      return false;
    } });
    const observer = new IntersectionObserver(entries => {
      retention.update(entries.map(entry => [entry.target, entry.isIntersecting] as const));
    }, { root, rootMargin: '800px 0px' });
    const reconsider = () => retention.flush();
    document.addEventListener('selectionchange', reconsider);
    root.addEventListener('focusin', reconsider);
    root.addEventListener('focusout', reconsider);
    const targets = new Set<Element>();
    surface = { observe(element, changed) {
      targets.add(element);
      const unregister = retention.register(element, changed);
      observer.observe(element);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        unregister(); observer.unobserve(element); targets.delete(element);
        if (targets.size) return;
        observer.disconnect(); retention.dispose(); surfaces.delete(root);
        document.removeEventListener('selectionchange', reconsider);
        root.removeEventListener('focusin', reconsider);
        root.removeEventListener('focusout', reconsider);
      };
    } };
    surfaces.set(root, surface);
  }
  return surface.observe(target, notify);
}
