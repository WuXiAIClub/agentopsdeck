/** Leave time to click-to-enlarge while the source cache warms in the background. */
export const SOURCE_PREVIEW_HOVER_DELAY_MS = 2200;

export function scheduleSourcePreviewHover(show: () => void) {
  return setTimeout(show, SOURCE_PREVIEW_HOVER_DELAY_MS);
}
