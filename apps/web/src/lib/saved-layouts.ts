import { closeWorkspacePane, isSessionPane, paneKey, paneSessionKey, validPane, withinWorkspaceBudget, MAX_DOCKED_PANES, MAX_FLOATING_PANES, MAX_WORKSPACE_PANES, MAX_DOCK_DEPTH, MAX_DOCK_VACANCIES, type Dock, type SessionWorkspace } from './workspace-layout.js';

export type SavedLayout = { id: string; name: string; workspace: SessionWorkspace; collapsedKeys: string[] };
export function savedLayoutKey(scope: string | undefined) { return scope ? `agentopsdeck.saved-layouts.v2:${scope}` : undefined; }
export function legacySavedLayoutKey(scope: string | undefined) { return scope ? `agentopsdeck.saved-layouts.v1:${scope}` : undefined; }
/** Compare arrangement, not transient focus, float stacking or mounted host IDs. */
export function layoutFingerprint(workspace: SessionWorkspace, collapsed: ReadonlySet<string>): string {
  const keys = new Map(workspace.panes.map(pane => [pane.id, paneKey(pane)]));
  const floating = new Set(workspace.floating.map(pane => pane.id));
  const rect = (value: { x: number; y: number; width: number; height: number } | undefined) => value ? [value.x, value.y, value.width, value.height] : null;
  const dock = (node: Dock | null): unknown => !node ? null : node.kind === 'empty' ? ['empty'] : node.kind === 'pane' ? ['pane', keys.get(node.id)] : [node.axis, node.ratio, dock(node.first), dock(node.second)];
  return JSON.stringify({
    panes: workspace.panes.map(pane => [paneKey(pane), floating.has(pane.id) ? null : rect(pane.dockFrame),
      floating.has(pane.id) || pane.dockFrame || !pane.dockSize ? null : [pane.dockSize.width, pane.dockSize.height]])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    fileLinks: workspace.panes.filter(p => p.fileLinks?.length).map(p => [paneKey(p), [...p.fileLinks!].sort()]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    dock: dock(workspace.dock),
    floating: workspace.floating.map(pane => [keys.get(pane.id), rect(pane)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    collapsed: workspace.panes.filter(pane => floating.has(pane.id) && collapsed.has(paneKey(pane))).map(paneKey).sort(),
  });
}
/** Undo only our latest snapshot write. Never erase a later edit from another tab/device. */
export function undoSavedLayoutUpdate(items: SavedLayout[], before: SavedLayout, written: SavedLayout): SavedLayout[] | null {
  const current = items.find(item => item.id === written.id);
  if (!current || JSON.stringify([current.workspace, current.collapsedKeys]) !== JSON.stringify([written.workspace, written.collapsedKeys])) return null;
  return items.map(item => item.id === before.id ? { ...item, workspace: structuredClone(before.workspace), collapsedKeys: [...before.collapsedKeys] } : item);
}
/** Replace only the chosen snapshot; preserve its identity/name and detach live geometry. */
export function updateSavedLayout(items: SavedLayout[], id: string, workspace: SessionWorkspace, collapsed: ReadonlySet<string>) {
  if (!validWorkspace(workspace)) return items;
  const keys = new Set(workspace.panes.map(paneKey));
  return items.map(item => item.id === id ? { ...item, workspace: structuredClone(workspace), collapsedKeys: [...collapsed].filter(key => keys.has(key)) } : item);
}
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096;
/** Browser storage is untrusted. Bound recursion and reject duplicate/missing
 * hosts before projecting a layout, including geometry and active identity. */
export function validWorkspace(value: unknown): value is SessionWorkspace {
  if (!value || typeof value !== 'object') return false;
  const v = value as SessionWorkspace;
  if (![1, 2].includes(v.version) || !Array.isArray(v.panes) || v.panes.length > MAX_WORKSPACE_PANES || !Array.isArray(v.floating) || v.floating.length > MAX_FLOATING_PANES) return false;
  if (!v.panes.length) return v.dock === null && !v.floating.length && v.active === null;
  if (v.panes.some(pane => !validPane(pane) || (v.version === 1 && !isSessionPane(pane)))) return false;
  const ids = new Set(v.panes.map(pane => pane.id));
  if (ids.size !== v.panes.length || new Set(v.panes.map(paneKey)).size !== v.panes.length || (v.active !== null && !ids.has(v.active))) return false;
  const placed = new Set<string>();
  const empty = new Set<string>();
  function place(id: string) { if (!ids.has(id) || placed.has(id)) return false; placed.add(id); return true; }
  function dock(node: Dock | null, depth: number): boolean {
    if (node === null) return depth === 0;
    if (!node || depth > MAX_DOCK_DEPTH) return false;
    if (node.kind === 'empty') {
      if (!text(node.id) || !node.id.startsWith('vacancy:') || ids.has(node.id) || empty.has(node.id) || empty.size >= MAX_DOCK_VACANCIES) return false;
      empty.add(node.id); return true;
    }
    if (node.kind === 'pane') return place(node.id);
    return node.kind === 'split' && ['horizontal', 'vertical'].includes(node.axis) && Number.isFinite(node.ratio) && node.ratio > 0 && node.ratio < 1 && dock(node.first, depth + 1) && dock(node.second, depth + 1);
  }
  if (!dock(v.dock, 0) || placed.size > MAX_DOCKED_PANES) return false;
  for (const pane of v.floating) {
    if (!pane || !place(pane.id) || ![pane.x, pane.y, pane.width, pane.height].every(n => Number.isFinite(n) && n >= 0 && n <= 1) || !pane.width || !pane.height) return false;
  }
  return placed.size === ids.size && withinWorkspaceBudget(v);
}
/** Move by stable identity, retaining all snapshots and concurrent metadata. */
export function reorderSavedLayouts(items: SavedLayout[], source: string, target: string): SavedLayout[] {
  const from = items.findIndex(item => item.id === source), to = items.findIndex(item => item.id === target);
  if (from < 0 || to < 0 || from === to) return items;
  const next = [...items];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}
export function parseSavedLayouts(raw: string | null): SavedLayout[] {
  try {
    const data: unknown = JSON.parse(raw ?? 'null');
    if (!Array.isArray(data)) return [];
    const seen = new Set<string>();
    return data.slice(0, 50).filter((entry): entry is SavedLayout => {
      if (!entry || !text(entry.id) || seen.has(entry.id) || !text(entry.name) || entry.name.length > 80 || !validWorkspace(entry.workspace) || !Array.isArray(entry.collapsedKeys) || entry.collapsedKeys.length > MAX_WORKSPACE_PANES || !entry.collapsedKeys.every(text)) return false;
      seen.add(entry.id); return true;
    });
  } catch { return []; }
}

/** Existing sessions keep their host IDs, hence drafts/controllers and DOM. */
export function restoreSavedLayout(saved: SavedLayout, available: ReadonlySet<string>, current: SessionWorkspace) {
  let workspace = structuredClone(saved.workspace);
  const unavailable = (pane: SessionWorkspace['panes'][number]) => paneSessionKey(pane) !== undefined && !available.has(paneSessionKey(pane)!);
  const missing = workspace.panes.filter(unavailable).length;
  if (missing > 0 && missing === workspace.panes.length) return { workspace: null, missing };
  for (const pane of [...workspace.panes]) if (unavailable(pane)) workspace = closeWorkspacePane(workspace, pane.id);
  const ids = new Map(workspace.panes.map(pane => [pane.id, current.panes.find(existing => paneKey(existing) === paneKey(pane))?.id ?? `restored:${crypto.randomUUID()}`]));
  const dock = (node: Dock | null): Dock | null => !node ? null : node.kind === 'pane' ? { ...node, id: ids.get(node.id)! } : node.kind === 'empty' ? node : { ...node, first: dock(node.first)!, second: dock(node.second)! };
  return { missing, workspace: { ...workspace, panes: workspace.panes.map(pane => ({ ...pane, id: ids.get(pane.id)! })), dock: dock(workspace.dock), floating: workspace.floating.map(pane => ({ ...pane, id: ids.get(pane.id)! })), active: workspace.active ? ids.get(workspace.active) ?? null : null } };
}

export function savedLayoutItemSignature(item: SavedLayout): string {
  return JSON.stringify([item.name, layoutFingerprint(item.workspace, new Set(item.collapsedKeys))]);
}

function parseExactSavedLayoutsArray(raw: string): SavedLayout[] | null {
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data) || data.length > 50) return null;
    const parsed = parseSavedLayouts(raw);
    return parsed.length === data.length ? parsed : null;
  } catch {
    return null;
  }
}

export function areSavedLayoutsEquivalent(aRaw: string, bRaw: string): boolean {
  if (aRaw === bRaw) return true;
  const a = parseExactSavedLayoutsArray(aRaw);
  const b = parseExactSavedLayoutsArray(bRaw);
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]!.id !== b[i]!.id || savedLayoutItemSignature(a[i]!) !== savedLayoutItemSignature(b[i]!)) {
      return false;
    }
  }
  return true;
}

export function mergeSavedLayouts(input: {
  local: string;
  remote: string;
  base?: string | null | undefined;
  initialBoot?: boolean | undefined;
}): string | null {
  const local = parseExactSavedLayoutsArray(input.local);
  const remote = parseExactSavedLayoutsArray(input.remote);
  if (!local || !remote) return null;
  if (areSavedLayoutsEquivalent(input.local, input.remote)) return input.local;

  const localMap = new Map(local.map(item => [item.id, item]));
  const remoteMap = new Map(remote.map(item => [item.id, item]));

  if (!input.base) {
    const merged: SavedLayout[] = [];
    for (const rItem of remote) {
      const lItem = localMap.get(rItem.id);
      if (!lItem) {
        merged.push(rItem);
      } else if (savedLayoutItemSignature(lItem) === savedLayoutItemSignature(rItem)) {
        merged.push(rItem);
      } else if (input.initialBoot) {
        merged.push(rItem);
      } else {
        return null;
      }
    }
    for (const lItem of local) {
      if (!remoteMap.has(lItem.id) && merged.length < 50) {
        merged.push(lItem);
      }
    }
    return JSON.stringify(merged);
  }

  const base = parseExactSavedLayoutsArray(input.base);
  if (!base) return null;
  const baseMap = new Map(base.map(item => [item.id, item]));
  const resolved = new Map<string, SavedLayout>();
  const allIds = new Set<string>([
    ...base.map(item => item.id),
    ...remote.map(item => item.id),
    ...local.map(item => item.id),
  ]);

  for (const id of allIds) {
    const bItem = baseMap.get(id);
    const lItem = localMap.get(id);
    const rItem = remoteMap.get(id);
    const bSig = bItem ? savedLayoutItemSignature(bItem) : undefined;
    const lSig = lItem ? savedLayoutItemSignature(lItem) : undefined;
    const rSig = rItem ? savedLayoutItemSignature(rItem) : undefined;

    if (!bItem) {
      if (lItem && rItem) {
        if (lSig === rSig) resolved.set(id, lItem);
        else return null;
      } else if (lItem) {
        resolved.set(id, lItem);
      } else if (rItem) {
        resolved.set(id, rItem);
      }
      continue;
    }

    if (!lItem && !rItem) continue;
    if (!lItem && rItem) {
      if (rSig === bSig) continue;
      return null;
    }
    if (lItem && !rItem) {
      if (lSig === bSig) continue;
      return null;
    }
    if (lItem && rItem) {
      if (lSig === rSig) resolved.set(id, lItem);
      else if (lSig === bSig) resolved.set(id, rItem);
      else if (rSig === bSig) resolved.set(id, lItem);
      else return null;
    }
  }

  const baseCommonOrder = base.map(item => item.id).filter(id => resolved.has(id));
  const remoteCommonOrder = remote.map(item => item.id).filter(id => baseMap.has(id) && resolved.has(id));
  const localCommonOrder = local.map(item => item.id).filter(id => baseMap.has(id) && resolved.has(id));
  const remoteKeptOrder =
    remoteCommonOrder.length === baseCommonOrder.length &&
    remoteCommonOrder.every((id, idx) => id === baseCommonOrder[idx]);
  const localReordered =
    localCommonOrder.length === baseCommonOrder.length &&
    localCommonOrder.some((id, idx) => id !== baseCommonOrder[idx]);

  const primaryOrder = remoteKeptOrder && localReordered ? local : remote;
  const secondaryOrder = remoteKeptOrder && localReordered ? remote : local;

  const merged: SavedLayout[] = [];
  const placed = new Set<string>();
  for (const item of primaryOrder) {
    const entry = resolved.get(item.id);
    if (entry && !placed.has(item.id) && merged.length < 50) {
      merged.push(entry);
      placed.add(item.id);
    }
  }
  for (const item of secondaryOrder) {
    const entry = resolved.get(item.id);
    if (entry && !placed.has(item.id) && merged.length < 50) {
      merged.push(entry);
      placed.add(item.id);
    }
  }
  return JSON.stringify(merged);
}
