/** One observer for many preview cards, with independent one-shot ownership.
 * Keep the existing viewport/rootMargin semantics; no transcript unmounting. */
export function createOnceVisibleObserver(factory: () => typeof IntersectionObserver | undefined = () => globalThis.IntersectionObserver) {
  const targets = new Map<Element, Set<() => void>>();
  let observer: IntersectionObserver | undefined;
  const disconnectIfEmpty = () => {
    if (targets.size) return;
    observer?.disconnect();
    observer = undefined;
  };
  return (target: Element, onVisible: () => void) => {
    const Observer = factory();
    if (!Observer) { onVisible(); return () => {}; }
    if (!observer) {
      const activeObserver = new Observer(entries => {
        if (observer !== activeObserver) return;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const callbacks = targets.get(entry.target);
          if (!callbacks) continue;
          targets.delete(entry.target);
          activeObserver.unobserve(entry.target);
          for (const callback of callbacks) callback();
        }
        disconnectIfEmpty();
      }, { rootMargin: '120px' });
      observer = activeObserver;
    }
    let callbacks = targets.get(target);
    if (!callbacks) { callbacks = new Set(); targets.set(target, callbacks); observer.observe(target); }
    const notify = () => onVisible();
    callbacks.add(notify);
    return () => {
      // An old cleanup cannot unobserve a later subscription to the same node.
      if (targets.get(target) !== callbacks) return;
      callbacks.delete(notify);
      if (!callbacks.size) { targets.delete(target); observer?.unobserve(target); }
      disconnectIfEmpty();
    };
  };
}

export const observeOnceVisible = createOnceVisibleObserver();
