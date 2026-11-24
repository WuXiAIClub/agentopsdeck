const MIN_LAYOUT_HEIGHT_PX = 320;
const KEYBOARD_OFFSET_THRESHOLD_PX = 48;

const TEXT_INPUT_TYPES = new Set([
  '',
  'email',
  'number',
  'password',
  'search',
  'tel',
  'text',
  'url',
]);

export type ViewportKeyboardMetricsInput = {
  windowInnerHeight?: number | undefined;
  documentClientHeight?: number | undefined;
  visualViewportHeight?: number | undefined;
  visualViewportOffsetTop?: number | undefined;
  editableFocused: boolean;
};

export type ViewportKeyboardMetrics = {
  layoutHeight: number;
  rawKeyboardOffset: number;
  keyboardOffset: number;
};

function finitePixel(value: number | undefined, fallback = 0) {
  return Number.isFinite(value) ? Math.max(0, Math.round(value as number)) : fallback;
}

export function computeViewportKeyboardMetrics(input: ViewportKeyboardMetricsInput): ViewportKeyboardMetrics {
  const visualViewportHeight = finitePixel(input.visualViewportHeight);
  const layoutHeight = Math.max(
    finitePixel(input.windowInnerHeight),
    finitePixel(input.documentClientHeight),
    visualViewportHeight,
    MIN_LAYOUT_HEIGHT_PX,
  );
  const viewportBottom = finitePixel(input.visualViewportOffsetTop) + (visualViewportHeight || layoutHeight);
  const rawKeyboardOffset = Math.max(0, layoutHeight - viewportBottom);
  const keyboardOffset = input.editableFocused && rawKeyboardOffset >= KEYBOARD_OFFSET_THRESHOLD_PX ? rawKeyboardOffset : 0;

  return { layoutHeight, rawKeyboardOffset, keyboardOffset };
}

export function isTextEntryElement(element: Element | null | undefined) {
  if (!element) return false;
  const tagName = element.tagName.toLowerCase();
  if (element.hasAttribute('disabled') || element.hasAttribute('readonly')) return false;
  if (tagName === 'textarea') return true;
  if (tagName === 'input') return TEXT_INPUT_TYPES.has((element.getAttribute('type') ?? 'text').toLowerCase());
  if (element instanceof HTMLElement && element.isContentEditable) return true;
  return element.getAttribute('contenteditable') === 'true';
}
