/** An asynchronous send acknowledgement must not pull focus out of another
 * editor/pane, a notebook, or a dialog. Only restore an actually vacant focus. */
export function mayRestoreComposerFocus(input: HTMLElement | null, active: Element | null, body: HTMLElement) {
  if (!input?.isConnected) return false;
  const pane = input.closest('[data-workspace-pane]');
  if (pane && pane.getAttribute('data-active') !== 'true') return false;
  return active === input || active === null || active === body;
}

/** Hover is an intentional pane switch, except during an existing interaction. */
export function isPeerEditor(active: Element | null) {
  return !!active?.matches('.desktop-composer-textarea, .notebook-rich-content[contenteditable="true"]');
}

export function mayHoverComposerFocus(state: {
  mouse: boolean; buttons: number; composing: boolean; dragging: boolean;
  selectedText: boolean; overlay: boolean; otherEditor: boolean; collapsed: boolean;
}) {
  return state.mouse && state.buttons === 0 && !state.composing && !state.dragging
    && !state.selectedText && !state.overlay && !state.otherEditor && !state.collapsed;
}

/** Coordinates, not an invisible hit layer: text in this area stays selectable. */
export function isComposerRevealZone(y: number, top: number, height: number) {
  return [y, top, height].every(Number.isFinite) && height > 0
    && y >= top + height * .85 && y <= top + height;
}

/** When a session pane is enlarged/tall (height >= 600px or maximized), the
 * message composer remains visible by default unless explicitly collapsed. */
export function isPaneEnlargedForComposer(state: {
  dense?: boolean | undefined;
  maximized?: boolean | undefined;
}) {
  return state.maximized === true || state.dense === false;
}

export function shouldShowComposerByDefault(state: {
  dense?: boolean | undefined;
  maximized?: boolean | undefined;
  explicitlyCollapsed?: boolean | undefined;
}) {
  if (state.explicitlyCollapsed) return false;
  return isPaneEnlargedForComposer(state);
}

export const COMPOSER_IDLE_HIDE_MS = 8_000;
export function mayHideIdleComposer(state: {
  split: boolean; pointerInPane: boolean; pointerInComposer: boolean;
  composing: boolean; selectedText: boolean; busy: boolean; overlay: boolean;
  enlarged?: boolean | undefined;
}) {
  if (state.enlarged) return false;
  return state.split && state.pointerInPane && !state.pointerInComposer
    && !state.composing && !state.selectedText && !state.busy && !state.overlay;
}
