import type { PaneRect, PaneResizeEdge } from './workspace-layout.js';

export type AlignmentGuide = { axis: 'x' | 'y'; position: number; start: number; end: number };
export type SnapEdge = PaneResizeEdge | 'move';
// A small, non-accumulating capture radius: callers always supply the raw
// pointer delta from gesture start, so dragging beyond it immediately releases.
export const ALIGNMENT_RADIUS = 8;
export const MIN_CARD_GAP = 4;
export function alignWorkspaceRect(rect: PaneRect, neighbours: Iterable<PaneRect>, width: number, height: number,
  edge: SnapEdge = 'move', minimum = { width: 240, height: 288 }): { rect: PaneRect; guides: AlignmentGuide[] } {
  const result = { ...rect }, guides: AlignmentGuide[] = [];
  const others = [...neighbours];
  for (const axis of ['x', 'y'] as const) {
    const horizontal = axis === 'x', length = horizontal ? 'width' : 'height', cross = horizontal ? 'y' : 'x', crossLength = horizontal ? 'height' : 'width';
    const extent = horizontal ? width : height;
    const leading = edge === (horizontal ? 'left' : 'top') || edge === 'top-left' || (horizontal && edge === 'bottom-left') || (!horizontal && edge === 'top-right');
    if (edge !== 'move' && !leading && edge !== (horizontal ? 'right' : 'bottom') && edge !== 'bottom-right' && edge !== 'bottom-left' && edge !== 'top-right') continue;
    const offsets = edge === 'move' ? [0, rect[length], rect[length] / 2] : [leading ? 0 : rect[length]];
    let best: { delta: number; position: number; other: PaneRect | undefined } | undefined;
    const consider = (position: number, offset: number, other?: PaneRect) => {
      // Preserve deliberate positive gaps. Facing-edge attraction must not
      // swallow the last 4–12px into an edge-to-edge snap. Same-edge/centre
      // alignment on other rows and deliberate zero-gap placement still work.
      if (other && rect[cross] < other[cross] + other[crossLength] && rect[cross] + rect[crossLength] > other[cross]) {
        if (offset === 0 && position === other[axis] + other[length] && rect[axis] > position) return;
        if (offset === rect[length] && position === other[axis] && rect[axis] + offset < position) return;
      }
      const delta = position - (rect[axis] + offset);
      if (Math.abs(delta) > ALIGNMENT_RADIUS || (best && Math.abs(delta) >= Math.abs(best.delta))) return;
      const start = rect[axis] + (edge === 'move' || leading ? delta : 0);
      const size = rect[length] + (edge === 'move' ? 0 : leading ? -delta : delta);
      if (start < 0 || start + size > extent || (edge !== 'move' && size < Math.min(minimum[length], extent))) return;
      // A third card's closer alignment must not collapse an intentional
      // facing gap beside another neighbour.
      if (others.some(peer => {
        if (rect[cross] >= peer[cross] + peer[crossLength] || rect[cross] + rect[crossLength] <= peer[cross]) return false;
        const oldAfter = rect[axis] - peer[axis] - peer[length], after = start - peer[axis] - peer[length];
        const oldBefore = peer[axis] - rect[axis] - rect[length], before = peer[axis] - start - size;
        return oldAfter > 0 && after >= 0 && after < MIN_CARD_GAP || oldBefore > 0 && before >= 0 && before < MIN_CARD_GAP;
      })) return;
      best = { delta, position, other };
    };
    for (const offset of offsets) {
      consider(0, offset); consider(extent, offset);
      for (const other of others) {
        // Edges align even when cards are on separate rows/columns, like slides.
        consider(other[axis], offset, other);
        consider(other[axis] + other[length], offset, other);
        if (edge === 'move' && offset === rect[length] / 2) consider(other[axis] + other[length] / 2, offset, other);
        if (rect[cross] < other[cross] + other[crossLength] && rect[cross] + rect[crossLength] > other[cross]) {
          const after = rect[axis] - other[axis] - other[length], before = other[axis] - rect[axis] - rect[length];
          if (offset === 0 && after > 0 && after <= MIN_CARD_GAP) consider(other[axis] + other[length] + MIN_CARD_GAP, offset, other);
          if (offset === rect[length] && before > 0 && before <= MIN_CARD_GAP) consider(other[axis] - MIN_CARD_GAP, offset, other);
        }
      }
    }
    if (best) {
      if (edge === 'move' || leading) result[axis] += best.delta;
      if (edge !== 'move') result[length] += leading ? -best.delta : best.delta;
      guides.push({ axis, position: best.position, start: Math.min(rect[cross], best.other?.[cross] ?? 0),
        end: Math.max(rect[cross] + rect[crossLength], best.other ? best.other[cross] + best.other[crossLength] : horizontal ? height : width) });
    }
  }
  if (edge === 'move') {
    result.x = Math.max(0, Math.min(width - result.width, result.x));
    result.y = Math.max(0, Math.min(height - result.height, result.y));
  }
  return { rect: result, guides };
}
