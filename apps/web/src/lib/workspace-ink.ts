import { DRAWING_CANVAS, DRAWING_MAX_POINTS, DRAWING_MAX_STROKE_POINTS, type DrawingContent, type DrawingPoint } from '@agentopsdeck/shared';

export const inkBudget = (value: DrawingContent) => Math.max(0, Math.min(DRAWING_MAX_STROKE_POINTS,
  DRAWING_MAX_POINTS - (value.strokes ?? []).reduce((total, stroke) => total + stroke.points.length, 0)));
/** Integer, canvas-bounded samples; sub-2px movement is skipped. No allocation per rejected sample. */
export function appendInkPoint(points: DrawingPoint[], x: number, y: number, limit: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(limit) || points.length >= Math.min(Math.floor(limit), DRAWING_MAX_STROKE_POINTS)) return false;
  const next: DrawingPoint = [Math.round(Math.max(0, Math.min(DRAWING_CANVAS.width, x))), Math.round(Math.max(0, Math.min(DRAWING_CANVAS.height, y)))];
  const last = points.at(-1);
  if (last && Math.hypot(next[0] - last[0], next[1] - last[1]) < 2) return false;
  points.push(next); return true;
}
/** Numbers only, never imported SVG commands/markup. A single sample is a round-capped dot. */
export function inkPath(points: DrawingPoint[]): string {
  if (!points.length) return '';
  return `M${points.map(([x, y]) => `${x},${y}`).join('L')}${points.length === 1 ? 'l0,0' : ''}`;
}
