import type { FileBoardBinding } from './workspace-file-board.js';

export type BindingEdge = { card: string; session: string };
export type BindingPane = { id: string; sessionKey?: string };
export type BindingRect = { x: number; y: number; width: number; height: number };

export type BindingCurveOptions = {
  obstacles?: readonly BindingRect[];
  parallelIndex?: number;
  parallelCount?: number;
};

export type BindingGroupColorPaletteItem = {
  id: string;
  stroke: string;
  secondary: string;
  glow: string;
};

export const BINDING_GROUP_PALETTE: readonly BindingGroupColorPaletteItem[] = [
  { id: 'cyan', stroke: '#06b6d4', secondary: '#38bdf8', glow: 'rgba(6, 182, 212, 0.42)' },
  { id: 'emerald', stroke: '#10b981', secondary: '#34d399', glow: 'rgba(16, 185, 129, 0.42)' },
  { id: 'amber', stroke: '#f59e0b', secondary: '#fbbf24', glow: 'rgba(245, 158, 11, 0.42)' },
  { id: 'violet', stroke: '#8b5cf6', secondary: '#a78bfa', glow: 'rgba(139, 92, 246, 0.42)' },
  { id: 'rose', stroke: '#f43f5e', secondary: '#fb7185', glow: 'rgba(244, 63, 94, 0.42)' },
  { id: 'blue', stroke: '#3b82f6', secondary: '#60a5fa', glow: 'rgba(59, 130, 246, 0.42)' },
] as const;

export function bindingGroupColor(groupKey: string | number): BindingGroupColorPaletteItem {
  if (typeof groupKey === 'number' && Number.isFinite(groupKey)) {
    const idx = Math.abs(Math.trunc(groupKey)) % BINDING_GROUP_PALETTE.length;
    return BINDING_GROUP_PALETTE[idx]!;
  }
  const text = String(groupKey || 'default');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return BINDING_GROUP_PALETTE[hash % BINDING_GROUP_PALETTE.length]!;
}

/** Never infer a binding from card text, names or a pending request. */
export function bindingEdges(panes: BindingPane[], bindings: { paneId: string; binding: FileBoardBinding | null; sessionIds?: string[] }[]): BindingEdge[] {
  const result = new Map<string, BindingEdge>();
  for (const { paneId, binding, sessionIds } of bindings) {
    if (!panes.some(p => p.id === paneId)) continue;
    const activeIds = new Set<string>();
    if (binding?.state === 'active' && !binding.problem && binding.sessionId) activeIds.add(binding.sessionId);
    for (const id of sessionIds ?? []) if (id) activeIds.add(id);
    if (!activeIds.size) continue;
    for (const pane of panes) if (pane.id !== paneId && pane.sessionKey && activeIds.has(pane.sessionKey)) {
      result.set(JSON.stringify([paneId, pane.id]), { card: paneId, session: pane.id });
    }
  }
  return [...result.values()];
}

function segmentIntersectsRect(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  rect: BindingRect,
  padding = 10,
): boolean {
  const minX = rect.x - padding;
  const maxX = rect.x + rect.width + padding;
  const minY = rect.y - padding;
  const maxY = rect.y + rect.height + padding;
  // Sample points along the segment to detect collision with obstacle rect
  const steps = 8;
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps;
    const px = x1 + (x2 - x1) * t;
    const py = y1 + (y2 - y1) * t;
    if (px >= minX && px <= maxX && py >= minY && py <= maxY) {
      return true;
    }
  }
  return false;
}

/** Route through the nearest gutter with optional obstacle avoidance and parallel-edge spread. */
export function bindingCurve(a: BindingRect, b: BindingRect, options?: BindingCurveOptions): string | undefined {
  if (![a, b].every(r => [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0)) return;
  const ax = a.x + a.width / 2;
  const ay = a.y + a.height / 2;
  const bx = b.x + b.width / 2;
  const by = b.y + b.height / 2;
  const dist = Math.hypot(bx - ax, by - ay);

  const parallelCount = Math.max(1, options?.parallelCount ?? 1);
  const parallelIndex = options?.parallelIndex ?? 0;
  const parallelStep = dist < 180 ? 8 : 16;
  const parallelShift = parallelCount > 1 ? (parallelIndex - (parallelCount - 1) / 2) * parallelStep : 0;
  const obstacles = (options?.obstacles ?? []).filter(
    r => [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0,
  );

  const minBoundX = Math.max(8, Math.min(a.x, b.x) - Math.min(64, Math.max(18, dist * 0.32)));
  const maxBoundX = Math.max(a.x + a.width, b.x + b.width) + Math.min(64, Math.max(18, dist * 0.32));
  const minBoundY = Math.max(8, Math.min(a.y, b.y) - Math.min(64, Math.max(18, dist * 0.32)));
  const maxBoundY = Math.max(a.y + a.height, b.y + b.height) + Math.min(64, Math.max(18, dist * 0.32));
  const clampX = (v: number) => Math.max(minBoundX, Math.min(maxBoundX, v));
  const clampY = (v: number) => Math.max(minBoundY, Math.min(maxBoundY, v));

  if (Math.abs(ax - bx) >= Math.abs(ay - by)) {
    const direction = bx >= ax ? 1 : -1;
    const edgeGap = (bx - ax) * direction - (a.width + b.width) / 2;
    const x1 = edgeGap >= 8 ? ax + direction * a.width / 2 : ax;
    const x2 = edgeGap >= 8 ? bx - direction * b.width / 2 : bx;
    const y1 = ay + parallelShift * 0.35;
    const y2 = by + parallelShift * 0.35;
    const spanX = Math.abs(x2 - x1);
    const bend = Math.min(Math.max(10, dist * 0.32), Math.max(10, spanX / 2));

    let cy1 = y1 + parallelShift;
    let cy2 = y2 + parallelShift;
    if (obstacles.length > 0 && dist >= 180) {
      const blocking = obstacles.find(obs => segmentIntersectsRect(x1, y1, x2, y2, obs));
      if (blocking) {
        const obsCenterY = blocking.y + blocking.height / 2;
        const midY = (y1 + y2) / 2;
        const detourDir = midY <= obsCenterY ? -1 : 1;
        const detourMag = Math.min(72, Math.max(24, dist * 0.28));
        cy1 += detourDir * detourMag;
        cy2 += detourDir * detourMag;
      }
    }
    const cx1 = clampX(x1 + direction * bend);
    const cx2 = clampX(x2 - direction * bend);
    return `M ${x1} ${y1} C ${cx1} ${clampY(cy1)}, ${cx2} ${clampY(cy2)}, ${x2} ${y2}`;
  }

  const direction = by >= ay ? 1 : -1;
  const edgeGap = (by - ay) * direction - (a.height + b.height) / 2;
  const y1 = edgeGap >= 8 ? ay + direction * a.height / 2 : ay;
  const y2 = edgeGap >= 8 ? by - direction * b.height / 2 : by;
  const x1 = ax + parallelShift * 0.35;
  const x2 = bx + parallelShift * 0.35;
  const spanY = Math.abs(y2 - y1);
  const bend = Math.min(Math.max(10, dist * 0.32), Math.max(10, spanY / 2));

  let cx1 = x1 + parallelShift;
  let cx2 = x2 + parallelShift;
  if (obstacles.length > 0 && dist >= 180) {
    const blocking = obstacles.find(obs => segmentIntersectsRect(x1, y1, x2, y2, obs));
    if (blocking) {
      const obsCenterX = blocking.x + blocking.width / 2;
      const midX = (x1 + x2) / 2;
      const detourDir = midX <= obsCenterX ? -1 : 1;
      const detourMag = Math.min(72, Math.max(24, dist * 0.28));
      cx1 += detourDir * detourMag;
      cx2 += detourDir * detourMag;
    }
  }
  const cy1 = clampY(y1 + direction * bend);
  const cy2 = clampY(y2 - direction * bend);
  return `M ${x1} ${y1} C ${clampX(cx1)} ${cy1}, ${clampX(cx2)} ${cy2}, ${x2} ${y2}`;
}
