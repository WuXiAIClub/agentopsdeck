/** Roughly half the workspace area, with reachable backdrop on every edge. */
export function focusedPaneRect(width: number, height: number) {
  const w = Math.min(Math.max(0, width - 32), Math.max(320, width * .72));
  const h = Math.min(Math.max(0, height - 32), Math.max(360, height * .76));
  return { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h };
}
