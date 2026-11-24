/** Geometry and identity model used by the multi-session workspace.
 * Stable pane IDs survive split/float/dock; layout never sends or stops runs. */
import { websitePaneTarget } from './workspace-website.js';
import { alignWorkspaceRect } from './workspace-snap.js';
export const MIN_PANE_WIDTH = 240;
export const MIN_PANE_HEIGHT = 288;
export const MIN_FLOAT_WIDTH = 272;
export const MIN_FLOAT_HEIGHT = 384;
export function paneMinimum(pane?: Pick<Pane, 'kind'>, floating = false) {
  return pane?.kind === 'file-browser' ? { width: 240, height: 240 }
    : pane && (pane.kind === undefined || pane.kind === 'session' || pane.kind === 'notebook' || pane.kind === 'taskboard')
      ? { width: 1, height: floating ? MIN_FLOAT_HEIGHT : MIN_PANE_HEIGHT }
    : { width: floating ? MIN_FLOAT_WIDTH : MIN_PANE_WIDTH, height: floating ? MIN_FLOAT_HEIGHT : MIN_PANE_HEIGHT };
}
export function dockFitsWorkspace(layout: SessionWorkspace, width: number, height: number) {
  const geometry = projectWorkspace(layout, width, height);
  return [...geometry.panes].every(([id, rect]) => {
    const minimum = paneMinimum(layout.panes.find(pane => pane.id === id));
    return rect.width >= minimum.width - .5 && rect.height >= minimum.height - .5;
  });
}
export type DockSize = { width: number; height: number };
export type SessionPane = { id: string; kind?: 'session'; sessionKey: string; dockSize?: DockSize };
export type DashboardPane = { id: string; kind: 'dashboard'; resourceId: 'overview'; sessionKey?: never; dockSize?: DockSize };
export type NotebookPane = { id: string; kind: 'notebook'; target: 'session' | 'hub'; resourceId: string; sessionKey?: never; dockSize?: DockSize };
export type TaskboardPane = { id: string; kind: 'taskboard' | 'statuscard'; resourceId: string; sessionKey?: never; dockSize?: DockSize };
export type DrawingPane = { id: string; kind: 'drawing' | 'native-drawio'; resourceId: string; sessionKey?: never; dockSize?: DockSize };
export type MediaPane = { id: string; kind: 'media'; resourceId: 'library'; sessionKey?: never; dockSize?: DockSize };
export type WebsitePane = { id: string; kind: 'website'; resourceId: string; sessionKey?: never; dockSize?: DockSize };
export type ResearchPane = { id: string; kind: 'research'; resourceId: 'search'; sessionKey?: never; dockSize?: DockSize };
export type TerminalPane = { id: string; kind: 'terminal'; resourceId: 'catalog'; sessionKey?: never; dockSize?: DockSize };
export type BrowserPane = { id: string; kind: 'browser'; resourceId: string; sessionKey?: never; dockSize?: DockSize };
export type MetricCardPane = { id: string; kind: 'metric-card'; resourceId: string; sessionKey?: never; dockSize?: DockSize };
export type ReportPane = { id: string; kind: 'report'; resourceId: string; sessionKey?: never; dockSize?: DockSize };
export type ModeratorPane = { id: string; kind: 'moderator'; resourceId: 'control'; sessionKey?: never; dockSize?: DockSize };
export type DockerPane = { id: string; kind: 'docker'; resourceId: 'manager'; sessionKey?: never; dockSize?: DockSize };
export type SubagentsPane = { id: string; kind: 'subagents'; resourceId: 'follow'; sessionKey?: never; dockSize?: DockSize };
export type FilePane = { id: string; kind: 'file-browser' | 'file-editor' | 'image-viewer' | 'git-tree' | 'issue-source'; resourceId: string; sessionKey?: never; dockSize?: DockSize };
export type Pane = (SessionPane | DashboardPane | NotebookPane | TaskboardPane | DrawingPane | MediaPane | WebsitePane | ResearchPane | TerminalPane | BrowserPane | MetricCardPane | ReportPane | ModeratorPane | DockerPane | SubagentsPane | FilePane) & { dockFrame?: PaneRect; fileLinks?: string[] };
export const isSessionPane = (pane: Pane): pane is SessionPane => pane.kind === undefined || pane.kind === 'session';
/** Non-session identities must never enter the message transport. The reserved
 * control prefix also keeps existing session collapse keys backward-compatible. */
export const paneKey = (pane: Pane): string => isSessionPane(pane) ? pane.sessionKey : pane.kind === 'notebook' ? `\u0000notebook:${JSON.stringify([pane.target, pane.resourceId])}` : `\u0000${pane.kind}:${pane.resourceId}`;
export const paneSessionKey = (pane: Pane): string | undefined => isSessionPane(pane) ? pane.sessionKey : pane.kind === 'notebook' && pane.target === 'session' ? pane.resourceId : undefined;
export function validPane(value: unknown): value is Pane {
  if (!value || typeof value !== 'object') return false;
  const pane = value as Pane;
  if (typeof pane.id !== 'string' || !pane.id || pane.id.length > 4096) return false;
  if (pane.fileLinks !== undefined && (!Array.isArray(pane.fileLinks) || pane.fileLinks.length > 32
    || pane.fileLinks.some(key => typeof key !== 'string' || !key || key.length > 4096) || new Set(pane.fileLinks).size !== pane.fileLinks.length)) return false;
  if (pane.dockFrame !== undefined && (!pane.dockFrame || ![pane.dockFrame.x, pane.dockFrame.y, pane.dockFrame.width, pane.dockFrame.height].every(n => Number.isFinite(n) && n >= 0 && n <= 1)
    || !pane.dockFrame.width || !pane.dockFrame.height || pane.dockFrame.x + pane.dockFrame.width > 1.000001 || pane.dockFrame.y + pane.dockFrame.height > 1.000001)) return false;
  if (pane.dockSize !== undefined && (!pane.dockSize || typeof pane.dockSize !== 'object'
    || ![pane.dockSize.width, pane.dockSize.height].every(value => Number.isFinite(value) && value > 0 && value <= 1))) return false;
  if (isSessionPane(pane)) return typeof pane.sessionKey === 'string' && !!pane.sessionKey && pane.sessionKey.length <= 4096 && !/[\x00-\x1f]/.test(pane.sessionKey);
  if (pane.kind === 'file-browser' || pane.kind === 'file-editor' || pane.kind === 'image-viewer' || pane.kind === 'git-tree' || pane.kind === 'issue-source') return pane.sessionKey === undefined
    && typeof pane.resourceId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(pane.resourceId);
  if (pane.kind === 'moderator') return pane.resourceId === 'control' && pane.sessionKey === undefined;
  if (pane.kind === 'docker') return pane.resourceId === 'manager' && pane.sessionKey === undefined;
  if (pane.kind === 'subagents') return pane.resourceId === 'follow' && pane.sessionKey === undefined;
  if (pane.kind === 'media') return pane.resourceId === 'library' && pane.sessionKey === undefined;
  if (pane.kind === 'research') return pane.resourceId === 'search' && pane.sessionKey === undefined;
  if (pane.kind === 'terminal') return pane.resourceId === 'catalog' && pane.sessionKey === undefined;
  if (pane.kind === 'browser') return pane.sessionKey === undefined && typeof pane.resourceId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(pane.resourceId);
  if (pane.kind === 'metric-card') return pane.sessionKey === undefined && typeof pane.resourceId === 'string' && /^(catalog|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(pane.resourceId);
  if (pane.kind === 'report') return pane.sessionKey === undefined && typeof pane.resourceId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(pane.resourceId);
  if (pane.kind === 'website') return pane.sessionKey === undefined && typeof pane.resourceId === 'string' && (pane.resourceId === 'catalog' || !!websitePaneTarget(pane.resourceId));
  if (pane.kind === 'notebook') return pane.sessionKey === undefined && typeof pane.resourceId === 'string' && (pane.target === 'session'
    ? validPane({ id: pane.id, sessionKey: pane.resourceId }) : pane.target === 'hub' && /^(default|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(pane.resourceId));
  return ((pane.kind === 'dashboard' && pane.resourceId === 'overview') || ((pane.kind === 'taskboard' || pane.kind === 'statuscard' || pane.kind === 'drawing' || pane.kind === 'native-drawio') && typeof pane.resourceId === 'string' && /^(default|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(pane.resourceId))) && pane.sessionKey === undefined;
}
export type Dock = { kind: 'pane'; id: string } | { kind: 'empty'; id: string } | { kind: 'split'; axis: 'horizontal' | 'vertical'; ratio: number; first: Dock; second: Dock };
export type FloatingPane = { id: string; x: number; y: number; width: number; height: number };
export type SessionWorkspace = { version: 1 | 2; panes: Pane[]; dock: Dock | null; floating: FloatingPane[]; active: string | null };
export type WorkspacePreset = 'single' | 'columns' | 'rows' | 'grid' | 'left-stack';
export const MAX_DOCKED_SESSIONS = 12;
export const MAX_FLOATING_SESSIONS = 4;
// Documents have a separate bounded DOM/storage budget, never a chat slot.
export const MAX_RESOURCE_PANES = 16;
export const MAX_DOCKED_PANES = MAX_DOCKED_SESSIONS + MAX_RESOURCE_PANES;
export const MAX_FLOATING_PANES = MAX_FLOATING_SESSIONS + MAX_RESOURCE_PANES;
export const MAX_WORKSPACE_PANES = MAX_DOCKED_SESSIONS + MAX_FLOATING_SESSIONS + MAX_RESOURCE_PANES;
export const MAX_DOCK_VACANCIES = 4;
export const MAX_DOCK_DEPTH = MAX_DOCKED_PANES + MAX_DOCK_VACANCIES - 1;
export type DockSide = 'left' | 'right' | 'top' | 'bottom';
export type DockDrop = { target: string | null; side: DockSide | 'center'; slack?: { ratio: number; retained: DockSize } };
export const emptyWorkspace = (): SessionWorkspace => ({ version: 1, panes: [], dock: null, floating: [], active: null });
const leaf = (id: string): Dock => ({ kind: 'pane', id });
const split = (axis: 'horizontal' | 'vertical', first: Dock, second: Dock): Dock => ({ kind: 'split', axis, ratio: .5, first, second });
export type PaneRect = { x: number; y: number; width: number; height: number };
/** Shrink within the allocated cell, leaving deliberate blank space. Split
 * ratios and neighboring panes remain untouched; minimums adapt on resize. */
export function fitDockPane(rect: PaneRect, preferred?: DockSize, minimum = paneMinimum()): PaneRect {
  return preferred ? { ...rect, width: Math.min(rect.width, Math.max(minimum.width, rect.width * preferred.width)),
    height: Math.min(rect.height, Math.max(minimum.height, rect.height * preferred.height)) } : rect;
}
export function resizeDockPane(layout: SessionWorkspace, id: string, size: DockSize): SessionWorkspace {
  if (![size.width, size.height].every(value => Number.isFinite(value) && value > 0) || !dockPaneIds(layout.dock).includes(id)) return layout;
  const dockSize = { width: Math.min(1, size.width), height: Math.min(1, size.height) };
  return { ...layout, panes: layout.panes.map(pane => pane.id === id ? { ...pane, dockSize } : pane) };
}
export type DividerRect = PaneRect & { path: string; axis: 'horizontal' | 'vertical'; ratio: number; minRatio: number; maxRatio: number; parent: PaneRect };

/** Free docked frames are normalized to the workspace, not a split cell. The
 * original tree remains the compatible seed for untouched panes/presets. */
export function projectWorkspace(layout: SessionWorkspace, width: number, height: number) {
  const geometry = projectDock(layout.dock, width, height, 10, new Map(layout.panes.map(pane => [pane.id, paneMinimum(pane)])));
  for (const pane of layout.panes) {
    const cell = geometry.panes.get(pane.id);
    if (!cell) continue;
    const frame = pane.dockFrame;
    if (frame && pane.kind === 'file-browser') {
      const minimum = paneMinimum(pane), w = Math.min(width, Math.max(minimum.width, frame.width * width)), h = Math.min(height, Math.max(minimum.height, frame.height * height));
      geometry.panes.set(pane.id, { x: Math.min(frame.x * width, width - w), y: Math.min(frame.y * height, height - h), width: w, height: h });
    } else geometry.panes.set(pane.id, frame ? { x: frame.x * width, y: frame.y * height, width: frame.width * width, height: frame.height * height } : fitDockPane(cell, pane.dockSize, paneMinimum(pane)));
  }
  // Split handles would unexpectedly resize neighbours behind manual frames.
  if (layout.panes.some(pane => pane.dockFrame)) geometry.dividers = [];
  return geometry;
}
export function setDockFrame(layout: SessionWorkspace, id: string, rect: PaneRect, width: number, height: number): SessionWorkspace {
  if (width <= 0 || height <= 0 || ![rect.x, rect.y, rect.width, rect.height, width, height].every(Number.isFinite)
    || !dockPaneIds(layout.dock).includes(id)) return layout;
  const minimum = paneMinimum(layout.panes.find(pane => pane.id === id));
  const w = Math.min(width, Math.max(Math.min(minimum.width, width), rect.width)), h = Math.min(height, Math.max(Math.min(minimum.height, height), rect.height));
  const frame = { x: Math.max(0, Math.min(width - w, rect.x)) / width, y: Math.max(0, Math.min(height - h, rect.y)) / height, width: w / width, height: h / height };
  return { ...layout, panes: layout.panes.map(pane => pane.id === id ? { ...pane, dockFrame: frame } : pane) };
}
/** Snap a translated pane to nearby edges and minimum 4px gaps, independently on
 * each axis. No neighbour is moved and no float slot is consumed. */
export function snapPaneRect(rect: PaneRect, neighbours: Iterable<PaneRect>, width: number, height: number): PaneRect {
  return alignWorkspaceRect(rect, neighbours, width, height).rect;
}
export type PaneResizeEdge = DockSide | 'bottom-right' | 'bottom-left' | 'top-left' | 'top-right';
export function resizePaneEdge(rect: PaneRect, edge: PaneResizeEdge, dx: number, dy: number, width: number, height: number,
  minimum = { width: MIN_PANE_WIDTH, height: MIN_PANE_HEIGHT }): PaneRect {
  if (edge === 'bottom-right' || edge === 'bottom-left' || edge === 'top-left' || edge === 'top-right') return resizePaneEdge(
    resizePaneEdge(rect, edge === 'top-left' || edge === 'bottom-left' ? 'left' : 'right', dx, 0, width, height, minimum),
    edge === 'bottom-right' || edge === 'bottom-left' ? 'bottom' : 'top', 0, dy, width, height, minimum);
  const minW = Math.min(minimum.width, width), minH = Math.min(minimum.height, height);
  if (edge === 'left') { const x = Math.max(0, Math.min(rect.x + rect.width - minW, rect.x + dx)); return { ...rect, x, width: rect.x + rect.width - x }; }
  if (edge === 'top') { const y = Math.max(0, Math.min(rect.y + rect.height - minH, rect.y + dy)); return { ...rect, y, height: rect.y + rect.height - y }; }
  return edge === 'right' ? { ...rect, width: Math.max(minW, Math.min(width - rect.x, rect.width + dx)) }
    : { ...rect, height: Math.max(minH, Math.min(height - rect.y, rect.height + dy)) };
}

/** Subtract occupied frames, retaining a bounded set of disjoint free regions.
 * This is geometry only: no new host or network request during a drag. */
export function freeDockAreas(rects: Iterable<PaneRect>, width: number, height: number, minimum = paneMinimum()): PaneRect[] {
  let free: PaneRect[] = [{ x: 0, y: 0, width, height }];
  for (const rect of rects) {
    const occupied = { x: rect.x - 10, y: rect.y - 10, right: rect.x + rect.width + 10, bottom: rect.y + rect.height + 10 };
    free = free.flatMap(area => {
      const left = Math.max(area.x, occupied.x), top = Math.max(area.y, occupied.y), right = Math.min(area.x + area.width, occupied.right), bottom = Math.min(area.y + area.height, occupied.bottom);
      if (left >= right || top >= bottom) return [area];
      return [
        { x: area.x, y: area.y, width: area.width, height: top - area.y },
        { x: area.x, y: bottom, width: area.width, height: area.y + area.height - bottom },
        { x: area.x, y: top, width: left - area.x, height: bottom - top },
        { x: right, y: top, width: area.x + area.width - right, height: bottom - top },
      ].filter(region => region.width > 0 && region.height > 0);
    }).sort((a, b) => b.width * b.height - a.width * a.height).slice(0, 128);
  }
  return free.filter(area => area.width >= minimum.width && area.height >= minimum.height);
}
export function availableDockArea(rects: Iterable<PaneRect>, x: number, y: number, width: number, height: number, minimum = paneMinimum()): PaneRect | undefined {
  return freeDockAreas(rects, width, height, minimum).find(area => x >= area.x && x <= area.x + area.width && y >= area.y && y <= area.y + area.height);
}

/** Equalize along each axis without changing pane identities or the tree topology. */
export function equalizeDock(dock: Dock | null): Dock | null {
  if (!dock || dock.kind !== 'split') return dock;
  const span = (node: Dock, axis: 'horizontal' | 'vertical'): number => node.kind !== 'split' ? 1
    : node.axis === axis ? span(node.first, axis) + span(node.second, axis) : Math.max(span(node.first, axis), span(node.second, axis));
  const first = equalizeDock(dock.first)!, second = equalizeDock(dock.second)!;
  return { ...dock, first, second, ratio: span(first, dock.axis) / (span(first, dock.axis) + span(second, dock.axis)) };
}

/** Incomplete presets use only the explicitly opened panes; never start extra reads. */
export function arrangeDock(ids: string[], preset: Exclude<WorkspacePreset, 'single'>): Dock | null {
  if (!ids.length) return null;
  if (ids.length === 1) return leaf(ids[0]!);
  if (preset === 'grid' && ids.length > 8) {
    const rows = Math.ceil(ids.length / 4), perRow = Math.ceil(ids.length / rows);
    return { kind: 'split', axis: 'vertical', ratio: 1 / rows, first: arrangeDock(ids.slice(0, perRow), 'columns')!, second: arrangeDock(ids.slice(perRow), 'grid')! };
  }
  if (preset === 'grid' && ids.length > 4) {
    const columns = Math.ceil(ids.length / 2);
    return split('vertical', arrangeDock(ids.slice(0, columns), 'columns')!, arrangeDock(ids.slice(columns), 'columns')!);
  }
  if (preset === 'grid' && ids.length > 2) {
    return split('horizontal', arrangeDock(ids.slice(0, 2), 'rows')!, arrangeDock(ids.slice(2), 'rows')!);
  }
  if (preset === 'left-stack' && ids.length > 2) return split('horizontal', leaf(ids[0]!), arrangeDock(ids.slice(1), 'rows')!);
  const axis = preset === 'rows' ? 'vertical' : 'horizontal';
  return { kind: 'split', axis, ratio: 1 / ids.length, first: leaf(ids[0]!), second: arrangeDock(ids.slice(1), preset)! };
}

/** Project a tree to stable sibling hosts, not nested React parents. */
export function projectDock(dock: Dock | null, width: number, height: number, gap = 10, minimums?: Map<string, { width: number; height: number }>) {
  const panes = new Map<string, PaneRect>(), empty = new Map<string, PaneRect>(), dividers: DividerRect[] = [];
  function minimum(node: Dock): { width: number; height: number } {
    if (node.kind !== 'split') return (node.kind === 'pane' ? minimums?.get(node.id) : undefined) ?? paneMinimum();
    const first = minimum(node.first), second = minimum(node.second);
    return node.axis === 'horizontal' ? { width: first.width + second.width + gap, height: Math.max(first.height, second.height) }
      : { width: Math.max(first.width, second.width), height: first.height + second.height + gap };
  }
  function visit(node: Dock | null, rect: PaneRect, path: string) {
    if (!node) return;
    if (node.kind === 'pane') { panes.set(node.id, rect); return; }
    if (node.kind === 'empty') { empty.set(node.id, rect); return; }
    const horizontal = node.axis === 'horizontal';
    const size = horizontal ? rect.width : rect.height;
    const space = Math.min(gap, size);
    const dimension = horizontal ? 'width' : 'height';
    const firstMinimum = minimum(node.first)[dimension], secondMinimum = minimum(node.second)[dimension];
    // Bounds follow subtree pixel requirements, not a 25–75% split. A row of
    // twelve panes legitimately starts below 10%. When too small, distribute
    // the shortage proportionally; the view can switch to its compact mode.
    const available = Math.max(1, size - space);
    const fitted = firstMinimum / (firstMinimum + secondMinimum);
    const minRatio = Math.min(fitted, firstMinimum / available);
    const maxRatio = Math.max(fitted, 1 - secondMinimum / available);
    const ratio = Math.max(minRatio, Math.min(maxRatio, node.ratio)), first = (size - space) * ratio;
    dividers.push({ ...rect, path, axis: node.axis, ratio, minRatio, maxRatio, parent: rect,
      ...(horizontal ? { x: rect.x + first, width: space } : { y: rect.y + first, height: space }) });
    visit(node.first, { ...rect, ...(horizontal ? { width: first } : { height: first }) }, path + '0');
    visit(node.second, { ...rect, ...(horizontal ? { x: rect.x + first + space, width: size - first - space }
      : { y: rect.y + first + space, height: size - first - space }) }, path + '1');
  }
  visit(dock, { x: 0, y: 0, width: Math.max(0, width), height: Math.max(0, height) }, '');
  return { panes, empty, dividers };
}

export function resizeDock(dock: Dock | null, path: string, ratio: number): Dock | null {
  if (!dock || dock.kind !== 'split' || !Number.isFinite(ratio)) return dock;
  if (!path) return { ...dock, ratio: Math.max(.001, Math.min(.999, ratio)) };
  return path[0] === '0' ? { ...dock, first: resizeDock(dock.first, path.slice(1), ratio)! }
    : path[0] === '1' ? { ...dock, second: resizeDock(dock.second, path.slice(1), ratio)! } : dock;
}

/** Enforce usable pixel minimums while retaining a reachable header after resize/zoom. */
export function fitFloating(rect: FloatingPane, width: number, height: number, pane?: Pick<Pane, 'kind'>): FloatingPane {
  const valid = clampFloating(rect);
  const minimum = paneMinimum(pane, true);
  return clampFloating({ ...valid, width: Math.max(valid.width, Math.min(1, minimum.width / Math.max(1, width))),
    height: Math.max(valid.height, Math.min(1, minimum.height / Math.max(1, height))) });
}
export function dockPaneIds(dock: Dock | null): string[] {
  return !dock || dock.kind === 'empty' ? [] : dock.kind === 'pane' ? [dock.id] : [...dockPaneIds(dock.first), ...dockPaneIds(dock.second)];
}
export function withinPaneBudget(panes: Pane[]): boolean {
  const sessions = panes.filter(isSessionPane).length;
  return sessions <= MAX_DOCKED_SESSIONS + MAX_FLOATING_SESSIONS && panes.length - sessions <= MAX_RESOURCE_PANES;
}
/** Shared by mutations, drag previews and UI affordances. Count identities, not
 * total hosts: a note cannot consume a session's docked or floating allowance. */
export function canPlaceWorkspacePane(layout: SessionWorkspace, id: string, floating: boolean): boolean {
  const pane = layout.panes.find(item => item.id === id);
  if (!pane || !withinPaneBudget(layout.panes)) return false;
  const ids = new Set(floating ? layout.floating.map(item => item.id) : dockPaneIds(layout.dock));
  const sessions = layout.panes.filter(item => item.id !== id && ids.has(item.id) && isSessionPane(item)).length;
  return sessions + (isSessionPane(pane) ? 1 : 0) <= (floating ? MAX_FLOATING_SESSIONS : MAX_DOCKED_SESSIONS);
}
export function withinWorkspaceBudget(layout: SessionWorkspace): boolean {
  const floated = new Set(layout.floating.map(item => item.id));
  return withinPaneBudget(layout.panes)
    && layout.panes.filter(item => isSessionPane(item) && floated.has(item.id)).length <= MAX_FLOATING_SESSIONS
    && layout.panes.filter(item => isSessionPane(item) && !floated.has(item.id)).length <= MAX_DOCKED_SESSIONS;
}
export function presetWorkspace(panes: Pane[], preset: WorkspacePreset): SessionWorkspace {
  const count = preset === 'grid' && panes.length >= 4 && panes.length <= MAX_DOCKED_PANES ? panes.length : { single: 1, columns: 2, rows: 2, grid: 4, 'left-stack': 3 }[preset];
  if (panes.length !== count || new Set(panes.map(pane => pane.id)).size !== count
    || new Set(panes.map(paneKey)).size !== count || panes.some(pane => !validPane(pane))
    || !withinPaneBudget(panes) || panes.filter(isSessionPane).length > MAX_DOCKED_SESSIONS) throw new Error('Preset requires distinct bound panes');
  const nodes = panes.map(pane => leaf(pane.id));
  const dock = preset === 'single' ? nodes[0]! : preset === 'columns' ? split('horizontal', nodes[0]!, nodes[1]!)
    : preset === 'rows' ? split('vertical', nodes[0]!, nodes[1]!)
      : preset === 'left-stack' ? split('horizontal', nodes[0]!, split('vertical', nodes[1]!, nodes[2]!))
        : arrangeDock(panes.map(pane => pane.id), 'grid');
  return { version: panes.every(isSessionPane) ? 1 : 2, panes: panes.map(pane => ({ ...pane })), dock, floating: [], active: panes[0]!.id };
}
/** Pure layout operation. It neither selects/creates a session nor starts reads. */
export function openDashboardPane(layout: SessionWorkspace, id: string, width: number, height: number): SessionWorkspace {
  return openResourcePane(layout, { id, kind: 'dashboard', resourceId: 'overview' }, width, height);
}
export function openResourcePane(layout: SessionWorkspace, pane: DashboardPane | NotebookPane | TaskboardPane | DrawingPane | MediaPane | WebsitePane | ResearchPane | TerminalPane | BrowserPane | MetricCardPane | ReportPane | FilePane | ModeratorPane | DockerPane | SubagentsPane, width: number, height: number): SessionWorkspace {
  const existing = layout.panes.find(item => paneKey(item) === paneKey(pane));
  if (existing) {
    const floating = layout.floating.find(item => item.id === existing.id);
    return { ...layout, active: existing.id, floating: floating ? [...layout.floating.filter(item => item.id !== existing.id), floating] : layout.floating };
  }
  const id = pane.id;
  if (!validPane(pane) || layout.panes.some(item => item.id === id) || layout.panes.length >= MAX_WORKSPACE_PANES) return layout;
  const next: SessionWorkspace = { ...layout, version: 2, panes: [...layout.panes, pane] };
  if (canPlaceWorkspacePane(next, id, false)) return insertWorkspacePane(next, id, width, height, 'grid');
  if (!canPlaceWorkspacePane(next, id, true)) return layout;
  const offset = .06 + (layout.floating.length % 5) * .035;
  return floatWorkspacePane(next, id, { x: offset, y: offset, width: .55, height: .8 });
}
const SUBAGENT_COMPANION_FLOAT_RECT = { x: 0.6, y: 0.06, width: 0.37, height: 0.76 } as const;

/** Floats (or falls back to docking) the singleton sub-agent companion
 * without stealing focus from an active composer. */
export function dockSubagentCompanionPane(
  layout: SessionWorkspace,
  parentSessionKey: string,
  id: string,
  width: number,
  height: number,
): SessionWorkspace {
  const parentPane = layout.panes.find(item => isSessionPane(item) && item.sessionKey === parentSessionKey);
  const existing = layout.panes.find(item => item.kind === 'subagents');
  if (existing) {
    const preservedActive = layout.active ?? parentPane?.id ?? existing.id;
    const alreadyFloating = layout.floating.find(item => item.id === existing.id);
    if (alreadyFloating) {
      const topAlready = layout.floating[layout.floating.length - 1]?.id === existing.id;
      return topAlready && layout.active === preservedActive
        ? layout
        : {
            ...layout,
            active: preservedActive,
            floating: [...layout.floating.filter(item => item.id !== existing.id), alreadyFloating],
          };
    }
    if (canPlaceWorkspacePane(layout, existing.id, true)) {
      const floated = floatWorkspacePane(layout, existing.id, SUBAGENT_COMPANION_FLOAT_RECT);
      return { ...floated, active: preservedActive };
    }
    return layout;
  }
  const pane: SubagentsPane = { id, kind: 'subagents', resourceId: 'follow' };
  if (!validPane(pane) || layout.panes.some(item => item.id === id) || layout.panes.length >= MAX_WORKSPACE_PANES) return layout;
  const withPane: SessionWorkspace = { ...layout, version: 2, panes: [...layout.panes, pane] };
  const preservedActive = layout.active ?? parentPane?.id ?? id;
  if (canPlaceWorkspacePane(withPane, id, true)) {
    const floated = floatWorkspacePane(withPane, id, SUBAGENT_COMPANION_FLOAT_RECT);
    return { ...floated, active: preservedActive };
  }
  const vw = Math.max(width, 640);
  const vh = Math.max(height, 480);
  if (canPlaceWorkspacePane(withPane, id, false)) {
    if (parentPane && dockPaneIds(layout.dock).includes(parentPane.id)) {
      for (const side of ['right', 'bottom'] as const) {
        const candidate = placeWorkspacePane(withPane, id, { target: parentPane.id, side });
        if (candidate !== withPane && dockFitsWorkspace(candidate, vw, vh)) {
          return { ...candidate, active: preservedActive };
        }
      }
    }
    const inserted = insertWorkspacePane(withPane, id, vw, vh, 'columns');
    if (inserted !== withPane) return { ...inserted, active: preservedActive };
  }
  return layout;
}
/** Ordinary navigation docks into the workspace by default and cascades into
 * floating only when docked session capacity is full. Never evict a host. */
export function selectWorkspaceSession(layout: SessionWorkspace, sessionKey: string, _previousKey: string | undefined, id: string, width: number, height: number): SessionWorkspace {
  if (!validPane({ id, sessionKey })) return layout;
  const existing = layout.panes.find(pane => isSessionPane(pane) && pane.sessionKey === sessionKey);
  if (existing) {
    const floating = layout.floating.find(pane => pane.id === existing.id);
    return { ...layout, active: existing.id, floating: floating ? [...layout.floating.filter(pane => pane.id !== existing.id), floating] : layout.floating };
  }
  if (layout.panes.length >= MAX_WORKSPACE_PANES || layout.panes.some(pane => pane.id === id)) return layout;
  const next = { ...layout, panes: [...layout.panes, { id, sessionKey }] };
  if (canPlaceWorkspacePane(next, id, false)) return insertWorkspacePane(next, id, width, height, 'grid');
  if (!canPlaceWorkspacePane(next, id, true)) return layout;
  const offset = .06 + (layout.floating.length % 5) * .035;
  return floatWorkspacePane(next, id, { x: offset, y: offset, width: .55, height: .8 });
}
function remove(dock: Dock | null, id: string): Dock | null {
  if (!dock) return null;
  if (dock.kind === 'empty') return dock;
  if (dock.kind === 'pane') return dock.id === id ? null : dock;
  const first = remove(dock.first, id), second = remove(dock.second, id);
  return !first ? second : !second ? first : { ...dock, first, second };
}
function replace(dock: Dock, id: string, replacement: Dock): Dock {
  if (dock.kind !== 'split') return dock.id === id ? replacement : dock;
  return { ...dock, first: replace(dock.first, id, replacement), second: replace(dock.second, id, replacement) };
}
function vacancy(layout: SessionWorkspace, id: string): Dock {
  const used = new Set([...layout.panes.map(pane => pane.id), ...projectDock(layout.dock, 0, 0).empty.keys()]);
  let name = `vacancy:${id}`, suffix = 0;
  while (used.has(name)) name = `vacancy:${id}:${++suffix}`;
  return { kind: 'empty', id: name };
}
/** Transactional placement: never unmount/rebind a session while moving its host. */
export function placeWorkspacePane(layout: SessionWorkspace, id: string, drop: DockDrop): SessionWorkspace {
  const result = placeWorkspacePaneInTree(layout, id, drop);
  if (result === layout) return layout;
  if (!result.panes.some(pane => (pane.id === id || pane.id === drop.target) && pane.dockFrame)) return result;
  return { ...result, panes: result.panes.map(pane => {
    if ((pane.id !== id && pane.id !== drop.target) || !pane.dockFrame) return pane;
    const { dockFrame, ...rest } = pane; return rest;
  }) };
}
function placeWorkspacePaneInTree(layout: SessionWorkspace, id: string, drop: DockDrop): SessionWorkspace {
  const ids = dockPaneIds(layout.dock);
  const empty = projectDock(layout.dock, 0, 0).empty;
  if (!layout.panes.some(pane => pane.id === id) || drop.target === id
    || (drop.target !== null && !ids.includes(drop.target) && !empty.has(drop.target))) return layout;
  if (drop.target && empty.has(drop.target) && layout.dock) {
    if (!canPlaceWorkspacePane(layout, id, false)) return layout;
    const vacated = ids.includes(id) ? replace(layout.dock, id, vacancy(layout, id)) : layout.dock;
    return { ...layout, dock: replace(vacated, drop.target, leaf(id)), floating: layout.floating.filter(pane => pane.id !== id), active: id };
  }
  if (drop.side === 'center') {
    if (!layout.dock || !drop.target || !ids.includes(id)) return layout;
    const swap = (node: Dock): Dock => node.kind === 'pane'
      ? leaf(node.id === id ? drop.target! : node.id === drop.target ? id : node.id)
      : node.kind === 'empty' ? node : { ...node, first: swap(node.first), second: swap(node.second) };
    return { ...layout, dock: swap(layout.dock), active: id };
  }
  if (!canPlaceWorkspacePane(layout, id, false)) return layout;
  if (drop.slack && drop.target && layout.dock && (drop.side === 'bottom' || drop.side === 'right')) {
    const { ratio, retained } = drop.slack;
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) return layout;
    // Keep the source cell vacant so moving a docked pane cannot change the
    // target's geometry between preview and release.
    const remaining = ids.includes(id) ? replace(layout.dock, id, vacancy(layout, id)) : layout.dock;
    if (!remaining) return layout;
    return { ...layout, active: id, floating: layout.floating.filter(pane => pane.id !== id),
      dock: replace(remaining, drop.target, { kind: 'split', axis: drop.side === 'bottom' ? 'vertical' : 'horizontal', ratio, first: leaf(drop.target), second: leaf(id) }),
      panes: layout.panes.map(pane => {
        if (pane.id === drop.target) return { ...pane, dockSize: retained };
        if (pane.id !== id) return pane;
        const { dockSize: _, ...rest } = pane;
        return rest;
      }) };
  }
  // Edge movement must not accumulate vacant slots on every drag.
  const compact = (node: Dock | null): Dock | null => !node || node.kind === 'empty' ? null : node.kind === 'pane' ? node : (() => {
    const first = compact(node.first), second = compact(node.second);
    return !first ? second : !second ? first : { ...node, first, second };
  })();
  const remaining = compact(remove(layout.dock, id));
  const axis = drop.side === 'left' || drop.side === 'right' ? 'horizontal' : 'vertical';
  const pair = (target: Dock) => drop.side === 'left' || drop.side === 'top' ? split(axis, leaf(id), target) : split(axis, target, leaf(id));
  const dock = !remaining ? pair(vacancy(layout, id)) : drop.target ? replace(remaining, drop.target, pair(leaf(drop.target))) : pair(remaining);
  return { ...layout, dock, floating: layout.floating.filter(pane => pane.id !== id), active: id };
}

/** Non-pointer entry points preserve a hand-arranged tree whenever a usable
 * split exists. Only fall back to the selected preset when it cannot fit. */
export function insertWorkspacePane(layout: SessionWorkspace, id: string, width: number, height: number, fallback: Exclude<WorkspacePreset, 'single'> = 'grid'): SessionWorkspace {
  const ids = dockPaneIds(layout.dock);
  if (ids.includes(id) || !canPlaceWorkspacePane(layout, id, false)) return layout;
  const vw = Number.isFinite(width) && width > 0 ? width : 1440;
  const vh = Number.isFinite(height) && height > 0 ? height : 900;
  if (!ids.length) return { ...layout, dock: leaf(id), floating: layout.floating.filter(pane => pane.id !== id), active: id };
  const minimums = new Map(layout.panes.map(pane => [pane.id, paneMinimum(pane)]));
  const treeProjection = projectDock(layout.dock, vw, vh, 10, minimums);
  const vacancies = [...treeProjection.empty].sort((a, b) => b[1].width * b[1].height - a[1].width * a[1].height);
  for (const [vacancyId] of vacancies) {
    const filled = placeWorkspacePane(layout, id, { target: vacancyId, side: 'center' });
    if (filled !== layout && dockFitsWorkspace(filled, vw, vh)) return filled;
  }
  const sourceMinimum = paneMinimum(layout.panes.find(pane => pane.id === id));
  const hasFreeFrames = layout.panes.some(pane => pane.id !== id && pane.dockFrame);
  if (hasFreeFrames) {
    const geometry = projectWorkspace(layout, vw, vh);
    const neighbours = [...geometry.panes].filter(([key]) => key !== id).map(([, rect]) => rect);
    const preferred = { width: Math.max(MIN_PANE_WIDTH, sourceMinimum.width), height: Math.max(MIN_PANE_HEIGHT, sourceMinimum.height) };
    const gap = freeDockAreas(neighbours, vw, vh, preferred)[0] ?? freeDockAreas(neighbours, vw, vh, sourceMinimum)[0];
    if (gap) {
      const dock = remove(layout.dock, id);
      const proposed: SessionWorkspace = { ...layout, dock: dock ? split('horizontal', dock, leaf(id)) : leaf(id), floating: layout.floating.filter(item => item.id !== id), active: id };
      return setDockFrame(proposed, id, gap, vw, vh);
    }
  }
  const base: SessionWorkspace = hasFreeFrames ? { ...layout, panes: layout.panes.map(pane => { if (!pane.dockFrame) return pane; const { dockFrame: _, ...rest } = pane; return rest; }) } : layout;
  const projected = [...projectWorkspace(base, vw, vh).panes];
  const order = new Map(projected.map(([key], idx) => [key, idx]));
  const targets = projected.sort((a, b) => {
    const areaA = a[1].width * a[1].height, areaB = b[1].width * b[1].height;
    if (Math.abs(areaB - areaA) > Math.max(areaA, areaB) * .02) return areaB - areaA;
    if (base.active === a[0] && base.active !== b[0]) return -1;
    if (base.active === b[0] && base.active !== a[0]) return 1;
    return (order.get(b[0]) ?? 0) - (order.get(a[0]) ?? 0);
  });
  for (const [target, rect] of targets) {
    const halfW = (rect.width - 10) / 2, halfH = (rect.height - 10) / 2;
    const preferVertical = halfW < 320 && halfH >= Math.max(MIN_PANE_HEIGHT, sourceMinimum.height);
    const sides: DockSide[] = preferVertical ? ['bottom', 'right']
      : rect.width / MIN_PANE_WIDTH >= rect.height / MIN_PANE_HEIGHT ? ['right', 'bottom'] : ['bottom', 'right'];
    for (const side of sides) {
      const next = placeWorkspacePane(base, id, { target, side });
      if (dockFitsWorkspace(next, vw, vh)) return next;
    }
  }
  const cleanPanes = base.panes.map(pane => {
    if (!pane.dockFrame && !pane.dockSize) return pane;
    const { dockFrame: _f, dockSize: _s, ...rest } = pane;
    return rest;
  });
  const retiled: SessionWorkspace = { ...base, panes: cleanPanes, dock: arrangeDock([...ids, id], fallback), floating: base.floating.filter(pane => pane.id !== id), active: id };
  if (fallback !== 'grid' && !dockFitsWorkspace(retiled, vw, vh)) return { ...retiled, dock: arrangeDock([...ids, id], 'grid') };
  return retiled;
}

/** Outer rim splits the workspace; pane edges split locally; centers swap docked panes. */
export function findDockDrop(panes: ReadonlyMap<string, PaneRect>, source: string, x: number, y: number, width: number, height: number, swap: boolean, empty: ReadonlyMap<string, PaneRect> = new Map()): DockDrop | undefined {
  if (x < 0 || y < 0 || x > width || y > height) return undefined;
  for (const [id, rect] of empty) if (x >= rect.x && y >= rect.y && x <= rect.x + rect.width && y <= rect.y + rect.height) return { target: id, side: 'center' };
  const nearest = (distances: [DockSide, number][]) => distances.sort((a, b) => a[1] - b[1])[0]!;
  const rim = nearest([['left', x], ['right', width - x], ['top', y], ['bottom', height - y]]);
  if (rim[1] <= 28) return { target: null, side: rim[0] };
  for (const [id, rect] of panes) {
    if (id === source || x < rect.x || y < rect.y || x > rect.x + rect.width || y > rect.y + rect.height) continue;
    const edge = nearest([['left', (x - rect.x) / Math.min(64, rect.width * .24)], ['right', (rect.x + rect.width - x) / Math.min(64, rect.width * .24)],
      ['top', (y - rect.y) / Math.min(64, rect.height * .24)], ['bottom', (rect.y + rect.height - y) / Math.min(64, rect.height * .24)]]);
    return edge[1] <= 1 ? { target: id, side: edge[0] } : swap ? { target: id, side: 'center' } : undefined;
  }
  return undefined;
}
/** A resized pane owns a larger cell than its visible bounds. Materialize that
 * unused area only on drop; no extra hosts, placeholders or persisted ghosts. */
export function findWorkspaceDrop(layout: SessionWorkspace, source: string, x: number, y: number, width: number, height: number): DockDrop | undefined {
  if (![x, y, width, height].every(Number.isFinite)) return undefined;
  const geometry = projectDock(layout.dock, width, height, 10, new Map(layout.panes.map(pane => [pane.id, paneMinimum(pane)])));
  const sourceMinimum = paneMinimum(layout.panes.find(pane => pane.id === source));
  if (layout.panes.some(pane => pane.dockFrame)) return findDockDrop(projectWorkspace(layout, width, height).panes, source, x, y, width, height, dockPaneIds(layout.dock).includes(source), geometry.empty);
  for (const pane of layout.panes) {
    const cell = geometry.panes.get(pane.id);
    if (!cell || pane.id === source || !pane.dockSize || x < cell.x || y < cell.y || x > cell.x + cell.width || y > cell.y + cell.height) continue;
    const shown = fitDockPane(cell, pane.dockSize, paneMinimum(pane)), gap = 10;
    if (y >= shown.y + shown.height && cell.height - shown.height - gap >= sourceMinimum.height) {
      return { target: pane.id, side: 'bottom', slack: { ratio: shown.height / (cell.height - gap), retained: { width: shown.width / cell.width, height: 1 } } };
    }
    if (x >= shown.x + shown.width && cell.width - shown.width - gap >= sourceMinimum.width) {
      return { target: pane.id, side: 'right', slack: { ratio: shown.width / (cell.width - gap), retained: { width: 1, height: shown.height / cell.height } } };
    }
  }
  return findDockDrop(geometry.panes, source, x, y, width, height, dockPaneIds(layout.dock).includes(source), geometry.empty);
}
/** Sidebar drops are previews until committed; opening a card never replaces an
 * existing editor. Already-open sessions reuse their stable host. */
export function previewSessionCardDrop(layout: SessionWorkspace, sessionKey: string, newId: string,
  x: number, y: number, width: number, height: number) {
  return previewResourceDrop(layout, { id: newId, sessionKey }, x, y, width, height);
}

/** The same geometry/capacity rules apply to notes and session cards. A drag
 * preview never adds a resource or changes its identity until release. */
export function previewResourceDrop(layout: SessionWorkspace, resource: Pane,
  x: number, y: number, width: number, height: number) {
  const sessionKey = paneKey(resource), newId = resource.id;
  const existing = layout.panes.find(pane => paneKey(pane) === sessionKey);
  const id = existing?.id ?? newId;
  const base = existing ? layout : { ...layout, version: 2 as const, panes: [...layout.panes, resource] };
  const minimum = paneMinimum(resource, true);
  if (layout.panes.some(pane => pane.dockFrame) && [x, y, width, height].every(Number.isFinite) && width >= minimum.width && height >= minimum.height) {
    const geometry = projectWorkspace(layout, width, height);
    const neighbours = [...geometry.panes].filter(([key]) => key !== id).map(([, rect]) => rect);
    const gap = availableDockArea(neighbours, x, y, width, height, paneMinimum(resource));
    // Free placement fills actual empty space only. A resized card must not
    // turn every subsequent sidebar drop into a docked overlay: occupied
    // targets retain the same float/swap/edge rules as an untouched layout.
    if (gap) {
      const rect = gap;
      const blocked = !validPane(resource) || !canPlaceWorkspacePane(base, id, false) || (!existing && layout.panes.some(pane => pane.id === id)) || x < 0 || y < 0 || x > width || y > height;
      let proposed = base;
      if (!blocked) {
        // Preserve every existing frame before extending the compatibility tree.
        for (const [key, frame] of geometry.panes) proposed = setDockFrame(proposed, key, frame, width, height);
        const dock = remove(proposed.dock, id);
        proposed = { ...proposed, dock: dock ? split('horizontal', dock, leaf(id)) : leaf(id), floating: proposed.floating.filter(item => item.id !== id), active: id };
        proposed = setDockFrame(proposed, id, rect, width, height);
      }
      return { id, sessionKey, rect, free: true, drop: undefined, floating: undefined, blocked, layout: blocked ? layout : proposed };
    }
  }
  const drop = findWorkspaceDrop(base, id, x, y, width, height);
  const oldFloat = layout.floating.find(pane => pane.id === id);
  const floating = fitFloating({ id, width: oldFloat?.width ?? .55, height: oldFloat?.height ?? .7,
    x: x / Math.max(1, width) - (oldFloat?.width ?? .55) / 2, y: (y - 18) / Math.max(1, height) }, width, height, resource);
  const proposed = drop ? placeWorkspacePane(base, id, drop) : floatWorkspacePane(base, id, floating);
  const projected = projectWorkspace(proposed, width, height);
  const rect = drop ? projected.panes.get(id) ?? { x: 0, y: 0, width, height }
    : { x: floating.x * width, y: floating.y * height, width: floating.width * width, height: floating.height * height };
  const blocked = !validPane(resource) || (!existing && (layout.panes.length >= MAX_WORKSPACE_PANES || layout.panes.some(pane => pane.id === newId)))
    || ![x, y, width, height].every(Number.isFinite) || width < minimum.width || height < minimum.height
    || x < 0 || y < 0 || x > width || y > height
    || (drop ? proposed === base || !dockFitsWorkspace(proposed, width, height)
      : !canPlaceWorkspacePane(base, id, true));
  return { id, sessionKey, rect, drop, floating: drop ? undefined : floating, blocked, layout: blocked ? layout : proposed };
}

/** Relative-to-workspace geometry; a renderer must also enforce pixel minimums
 * and keyboard-accessible movement after viewport/zoom changes. */
export function clampFloating(rect: FloatingPane): FloatingPane {
  const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
  const width = Math.max(.001, Math.min(1, finite(rect.width, .45))), height = Math.max(.16, Math.min(1, finite(rect.height, .65)));
  return { id: rect.id, width, height, x: Math.max(0, Math.min(1 - width, finite(rect.x, 0))), y: Math.max(0, Math.min(1 - height, finite(rect.y, 0))) };
}
export function floatWorkspacePane(layout: SessionWorkspace, id: string, rect = { x: .1, y: .1, width: .45, height: .65 }): SessionWorkspace {
  if (!canPlaceWorkspacePane(layout, id, true)) return layout;
  return { ...layout, dock: dockPaneIds(layout.dock).includes(id) ? remove(layout.dock, id) : layout.dock, floating: [...layout.floating.filter(pane => pane.id !== id), clampFloating({ ...rect, id })], active: id };
}
export function dockWorkspacePane(layout: SessionWorkspace, id: string, target: string | null, side: 'left' | 'right' | 'top' | 'bottom'): SessionWorkspace {
  if (!layout.floating.some(pane => pane.id === id) || !canPlaceWorkspacePane(layout, id, false)
    || (layout.dock && (!target || !dockPaneIds(layout.dock).includes(target)))) return layout;
  const axis = side === 'left' || side === 'right' ? 'horizontal' : 'vertical';
  const dock = !layout.dock ? leaf(id) : replace(layout.dock, target!, side === 'left' || side === 'top'
    ? split(axis, leaf(id), leaf(target!)) : split(axis, leaf(target!), leaf(id)));
  return { ...layout, dock, floating: layout.floating.filter(pane => pane.id !== id), active: id };
}
export function closeWorkspacePane(layout: SessionWorkspace, id: string): SessionWorkspace {
  const panes = layout.panes.filter(pane => pane.id !== id);
  return { ...layout, panes, dock: remove(layout.dock, id), floating: layout.floating.filter(pane => pane.id !== id), active: layout.active === id ? panes[0]?.id ?? null : layout.active };
}
/** Explicit revocation applies equally to chat and session-note panes. A missing
 * row or unavailable transport is not a revocation; callers supply directory proof. */
export function pruneWorkspaceSessions(layout: SessionWorkspace, dismissed: ReadonlySet<string>, invalidNodes: ReadonlySet<string>): SessionWorkspace {
  let current = layout;
  for (const pane of layout.panes) {
    const key = paneSessionKey(pane);
    if (key !== undefined && (dismissed.has(key) || invalidNodes.has(key.split(':')[0]!))) current = closeWorkspacePane(current, pane.id);
  }
  return current;
}
/** Exit the workspace panel Preview without deleting notes or named layouts. */
export function closePreviewPanes(layout: SessionWorkspace): SessionWorkspace {
  let current = layout;
  for (const pane of layout.panes) if (!isSessionPane(pane)) current = closeWorkspacePane(current, pane.id);
  return current;
}
/** Persisted layout is untrusted, contains no message bodies, and is not an
 * authorization source. Restoration requires the current accessible sessions. */
export function restoreWorkspace(value: unknown, allowed: ReadonlySet<string>): SessionWorkspace | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as SessionWorkspace;
  if (![1, 2].includes(candidate.version) || !Array.isArray(candidate.panes) || candidate.panes.length > MAX_WORKSPACE_PANES || !Array.isArray(candidate.floating) || candidate.floating.length > MAX_FLOATING_PANES) return undefined;
  if (candidate.panes.some(pane => !pane || typeof pane.id !== 'string' || !pane.id || pane.id.length > 128
    || !validPane(pane) || (!isSessionPane(pane) && candidate.version !== 2) || (paneSessionKey(pane) !== undefined && !allowed.has(paneSessionKey(pane)!)))) return undefined;
  const ids = new Set(candidate.panes.map(pane => pane.id));
  if (ids.size !== candidate.panes.length || new Set(candidate.panes.map(paneKey)).size !== ids.size) return undefined;
  const seen = new Set<string>(), vacancies = new Set<string>();
  function validDock(node: Dock | null, depth: number): boolean {
    if (node === null) return depth === 0;
    if (!node || typeof node !== 'object' || depth > MAX_DOCK_DEPTH) return false;
    if (node.kind === 'empty') {
      if (typeof node.id !== 'string' || !node.id.startsWith('vacancy:') || node.id.length > 200 || ids.has(node.id) || vacancies.has(node.id) || vacancies.size >= MAX_DOCK_VACANCIES) return false;
      vacancies.add(node.id); return true;
    }
    if (node.kind === 'pane') {
      if (!ids.has(node.id) || seen.has(node.id)) return false;
      seen.add(node.id); return true;
    }
    return node.kind === 'split' && ['horizontal', 'vertical'].includes(node.axis) && Number.isFinite(node.ratio)
      && node.ratio > 0 && node.ratio < 1 && validDock(node.first, depth + 1) && validDock(node.second, depth + 1);
  }
  if (!validDock(candidate.dock, 0) || seen.size > MAX_DOCKED_PANES) return undefined;
  for (const pane of candidate.floating) {
    if (!pane || !ids.has(pane.id) || seen.has(pane.id) || ![pane.x, pane.y, pane.width, pane.height].every(Number.isFinite)) return undefined;
    seen.add(pane.id);
  }
  if (seen.size !== ids.size || (candidate.active !== null && !ids.has(candidate.active)) || !withinWorkspaceBudget(candidate)) return undefined;
  const cleanDock = (node: Dock | null): Dock | null => !node ? null : node.kind === 'pane' ? leaf(node.id) : node.kind === 'empty' ? { kind: 'empty', id: node.id }
    : { kind: 'split', axis: node.axis, ratio: node.ratio, first: cleanDock(node.first)!, second: cleanDock(node.second)! };
  return { version: candidate.version, panes: candidate.panes.map(pane => {
    const base = { id: pane.id, ...(pane.fileLinks ? { fileLinks: [...pane.fileLinks] } : {}), ...(pane.dockFrame ? { dockFrame: { ...pane.dockFrame } } : {}), ...(pane.dockSize ? { dockSize: { width: pane.dockSize.width, height: pane.dockSize.height } } : {}) };
    return isSessionPane(pane) ? { ...base, sessionKey: pane.sessionKey } : pane.kind === 'notebook'
      ? { ...base, kind: 'notebook' as const, target: pane.target, resourceId: pane.resourceId }
      : pane.kind === 'moderator' ? { ...base, kind: 'moderator' as const, resourceId: 'control' as const }
      : pane.kind === 'docker' ? { ...base, kind: 'docker' as const, resourceId: 'manager' as const }
      : pane.kind === 'subagents' ? { ...base, kind: 'subagents' as const, resourceId: 'follow' as const }
      : pane.kind === 'media' ? { ...base, kind: 'media' as const, resourceId: 'library' as const }
      : pane.kind === 'research' ? { ...base, kind: 'research' as const, resourceId: 'search' as const }
      : pane.kind === 'terminal' ? { ...base, kind: 'terminal' as const, resourceId: 'catalog' as const }
      : pane.kind === 'browser' ? { ...base, kind: 'browser' as const, resourceId: pane.resourceId }
      : pane.kind === 'file-browser' || pane.kind === 'file-editor' || pane.kind === 'image-viewer' || pane.kind === 'git-tree' || pane.kind === 'issue-source' ? { ...base, kind: pane.kind, resourceId: pane.resourceId }
      : pane.kind === 'taskboard' || pane.kind === 'statuscard' || pane.kind === 'drawing' || pane.kind === 'native-drawio' || pane.kind === 'website' || pane.kind === 'metric-card' || pane.kind === 'report' ? { ...base, kind: pane.kind, resourceId: pane.resourceId }
      : { ...base, kind: 'dashboard' as const, resourceId: 'overview' as const };
  }), dock: cleanDock(candidate.dock),
    floating: candidate.floating.map(clampFloating), active: candidate.active };
}
