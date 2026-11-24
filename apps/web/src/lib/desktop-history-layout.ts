// Keep searchable/selectable DOM and React state. Only the browser's offscreen
// layout/paint work is deferred; this is deliberately not history virtualization.
export const HISTORY_LAYOUT_IDLE_MS = 1200;
const ROW = '.desktop-message-with-tools';
const MANAGED = ['content-visibility', 'contain-intrinsic-block-size'] as const;
// The workspace gives this host explicit pixel dimensions. Placement/stacking alone
// does not change its descendants' measured content-box sizes.
const PANE_PLACEMENT = ['left', 'top', 'z-index'] as const;
// Only closed, completed tool tracks opt in to measured containment. Open/live
// tracks, media and independently scrollable previews keep full layout.
const RICH = '.source-inline-card, .markdown-file, .long-text-reference, img, video, audio, iframe, canvas, input, textarea, select, details, [contenteditable], [role="dialog"], .desktop-tool-detail, .mobile-tool-strip-detail, .desktop-tool-timeline:not([data-history-tool-layout="stable"]), .mobile-tool-strip:not([data-history-tool-layout="stable"])';
const STABLE_TOOLS = '.desktop-tool-timeline[data-history-tool-layout="stable"]';
const hasRichContent = (row: HTMLElement) => !!row.querySelector(RICH)
  || Array.from(row.querySelectorAll('.desktop-attached-tools')).some(tools => !tools.matches(STABLE_TOOLS) && !tools.querySelector(STABLE_TOOLS));

const isAppleTouchWebKit = () => {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent ?? '';
  const platform = navigator.platform ?? '';
  const maxTouchPoints = navigator.maxTouchPoints ?? 0;
  return /iP(hone|ad|od)/i.test(ua) || (platform === 'MacIntel' && maxTouchPoints > 1);
};

export function observeDesktopHistoryLayout(root: HTMLElement | null) {
  if (!root?.closest('.desktop-session-frame') || isAppleTouchWebKit() || typeof ResizeObserver === 'undefined'
    || typeof IntersectionObserver === 'undefined' || typeof MutationObserver === 'undefined'
    || typeof CSS === 'undefined' || !CSS.supports('content-visibility', 'auto') || !CSS.supports('contain-intrinsic-block-size', 'auto 1px')) return () => {};
  const document = root.ownerDocument;
  const paneHost = root.closest<HTMLElement>('.session-workspace-pane[data-workspace-pane]');
  type State = { near: boolean; height?: number | undefined; cold: boolean; due: number; rich: boolean };
  const rows = new Map<HTMLElement, State>();
  // Local observer deliveries must not revisit the whole mounted transcript.
  // Waiting contains only measured candidates in their idle grace period.
  const dirty = new Set<HTMLElement>();
  const waiting = new Set<HTMLElement>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerDue = Infinity;
  let disposed = false;
  let width: number | undefined;
  let selected = false;
  // One scratch declaration, not one temporary node per mutation.
  const scratch = document.createElement('div').style;
  const withoutStyles = (css: string | null, ignored: readonly string[]) => {
    scratch.cssText = css ?? '';
    for (const property of ignored) scratch.removeProperty(property);
    return scratch.cssText;
  };
  const wake = (row: HTMLElement, state: State) => {
    if (!state.cold) return;
    state.cold = false;
    for (const property of MANAGED) row.style.removeProperty(property);
    delete row.dataset.historyLayout;
  };
  const invalidate = (row: HTMLElement, state: State) => {
    dirty.add(row); waiting.delete(row);
    wake(row, state);
    state.height = undefined;
    state.due = Date.now() + HISTORY_LAYOUT_IDLE_MS;
    // Reobserve also requests a new real measurement when a mutation has not
    // changed the height. Never reuse the old placeholder after invalidation.
    resize.unobserve(row); resize.observe(row);
  };
  function schedule(due: number) {
    // Keep an earlier wakeup instead of resetting the timer on every stream
    // update. It may fire once early after a candidate is removed, but cannot
    // postpone another row's deadline or retain removed nodes.
    if (timer !== undefined && timerDue <= due) return;
    if (timer !== undefined) clearTimeout(timer);
    timerDue = due;
    timer = setTimeout(() => {
      timer = undefined; timerDue = Infinity;
      for (const row of waiting) dirty.add(row);
      waiting.clear();
      flush();
    }, Math.max(0, due - Date.now()));
  }
  function flush() {
    if (disposed) return;
    const now = Date.now();
    const active = document.activeElement;
    for (const row of dirty) {
      waiting.delete(row);
      const state = rows.get(row);
      if (!state) continue;
      const protectedRow = selected || state.rich || row.contains(active);
      if (state.near || protectedRow) { wake(row, state); continue; }
      if (rows.size <= 200 || state.cold || state.height === undefined || state.height <= 0) continue;
      if (state.due > now) { waiting.add(row); schedule(state.due); continue; }
      // ResizeObserver supplied content-box size while the row was fully laid
      // out. Batch only style writes here; no read/write geometry alternation.
      row.style.containIntrinsicBlockSize = `auto ${state.height}px`;
      row.style.contentVisibility = 'auto';
      row.dataset.historyLayout = 'auto';
      state.cold = true;
    }
    dirty.clear();
    if (!waiting.size && timer !== undefined) {
      clearTimeout(timer); timer = undefined; timerDue = Infinity;
    }
  }
  const invalidateAll = () => {
    if (disposed) return;
    for (const [row, state] of rows) invalidate(row, state);
    flush();
  };
  const resize = new ResizeObserver(entries => {
    if (disposed) return;
    // Process container width first so old per-row deliveries cannot become
    // new-width estimates. Hidden panes (zero width) stay fully laid out.
    const container = entries.find(entry => entry.target === root);
    if (container) {
      const nextWidth = container.contentRect.width;
      if (width === undefined) {
        width = nextWidth;
      } else if (Math.abs(width - nextWidth) >= 1.5) {
        width = nextWidth;
        invalidateAll();
        return;
      }
    }
    for (const entry of entries) {
      const row = entry.target as HTMLElement, state = rows.get(row);
      if (!state || state.cold || !width) continue;
      state.height = entry.contentRect.height;
      dirty.add(row);
    }
    flush();
  });
  const intersection = new IntersectionObserver(entries => {
    if (disposed) return;
    for (const entry of entries) {
      const row = entry.target as HTMLElement, state = rows.get(row);
      if (!state || state.near === entry.isIntersecting) continue;
      state.near = entry.isIntersecting;
      dirty.add(row);
      state.due = Date.now() + HISTORY_LAYOUT_IDLE_MS;
      if (state.near) invalidate(row, state);
    }
    flush();
  }, { root, rootMargin: '1000px 0px' });
  const register = (row: HTMLElement) => {
    if (rows.has(row) || !root.contains(row) || MANAGED.some(property => row.style.getPropertyValue(property))) return;
    rows.set(row, { near: true, cold: false, due: Infinity, rich: hasRichContent(row) });
    dirty.add(row);
    resize.observe(row); intersection.observe(row);
  };
  const visit = (node: Node, action: (row: HTMLElement) => void) => {
    if (!(node instanceof HTMLElement)) return;
    if (node.matches(ROW)) action(node);
    node.querySelectorAll<HTMLElement>(ROW).forEach(action);
  };
  const unregister = (row: HTMLElement) => {
    if (root.contains(row)) return; // React may move an existing keyed node.
    const state = rows.get(row);
    if (!state) return;
    wake(row, state); rows.delete(row); resize.unobserve(row); intersection.unobserve(row);
    dirty.delete(row); waiting.delete(row);
  };
  const mutations = new MutationObserver(records => {
    if (disposed) return;
    const changed = new Set<HTMLElement>();
    for (const record of records) {
      const element = record.target instanceof HTMLElement ? record.target : record.target.parentElement;
      const row = element?.closest<HTMLElement>(ROW);
      if (row && rows.has(row)) {
        // Ignore ONLY our two CSS properties. Other inline style edits still
        // invalidate, even if combined with our writes in the same delivery.
        const ownStyle = record.type === 'attributes' && record.attributeName === 'style' && record.target === row
          && withoutStyles(record.oldValue, MANAGED) === withoutStyles(row.getAttribute('style'), MANAGED);
        if (!ownStyle) changed.add(row);
      }
      for (const node of record.removedNodes) visit(node, unregister);
      for (const node of record.addedNodes) visit(node, register);
    }
    for (const row of changed) {
      const state = rows.get(row);
      if (!state) continue;
      state.rich = hasRichContent(row);
      invalidate(row, state);
    }
    flush();
  });
  mutations.observe(root, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeOldValue: true, attributeFilter: ['style', 'class', 'open', 'hidden', 'src', 'width', 'height', 'contenteditable', 'role', 'data-history-tool-layout'] });
  // Font preferences and inherited styles live on ancestors, outside the row
  // observer. Invalidate conservatively; don't retain old-width/old-font sizes.
  const ancestors = new MutationObserver(records => {
    if (disposed) return;
    // Selecting a pane or OS window changes z-index, height, or composer hover attributes.
    // Only invalidate offscreen history rows when the container width actually changed
    // or document/root typography/direction attributes changed.
    const nextWidth = root.clientWidth;
    if (width !== undefined && nextWidth > 0 && Math.abs(width - nextWidth) >= 1.5) {
      width = nextWidth;
      invalidateAll();
      return;
    }
    const affectsTypography = records.some(record => {
      if (record.type !== 'attributes') return false;
      if (record.attributeName === 'dir' || record.attributeName === 'lang') return true;
      if (record.target === document.documentElement || record.target === document.body) {
        return record.attributeName === 'class' || record.attributeName === 'style';
      }
      return false;
    });
    if (affectsTypography) invalidateAll();
  });
  for (let node: HTMLElement | null = root; node; node = node.parentElement)
    ancestors.observe(node, { attributes: true, attributeOldValue: true, attributeFilter: ['style', 'class', 'dir', 'lang'] });
  const selection = () => {
    if (disposed) return;
    const value = document.getSelection();
    const next = !!value && !value.isCollapsed && Array.from({ length: value.rangeCount }, (_, i) => value.getRangeAt(i)).some(range => range.intersectsNode(root));
    if (next === selected) return;
    selected = next;
    // Cross-message selection intentionally protects the entire transcript.
    for (const row of rows.keys()) dirty.add(row);
    flush();
  };
  const focus = (event: FocusEvent) => {
    if (disposed) return;
    for (const target of [event.target, event.relatedTarget]) {
      if (!(target instanceof HTMLElement)) continue;
      const row = target.closest<HTMLElement>(ROW);
      if (row && rows.has(row)) dirty.add(row);
    }
    flush();
  };
  const fonts = () => invalidateAll();
  document.addEventListener('selectionchange', selection);
  root.addEventListener('focusin', focus); root.addEventListener('focusout', focus);
  document.fonts?.addEventListener('loadingdone', fonts);
  resize.observe(root);
  root.querySelectorAll<HTMLElement>(ROW).forEach(register);
  selection();
  return () => {
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    resize.disconnect(); intersection.disconnect(); mutations.disconnect(); ancestors.disconnect();
    document.removeEventListener('selectionchange', selection);
    root.removeEventListener('focusin', focus); root.removeEventListener('focusout', focus);
    document.fonts?.removeEventListener('loadingdone', fonts);
    for (const [row, state] of rows) wake(row, state);
    rows.clear();
    dirty.clear(); waiting.clear();
  };
}
