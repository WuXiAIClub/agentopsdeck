import { layoutFingerprint, parseSavedLayouts, type SavedLayout } from './saved-layouts.js';
import { emptyWorkspace, paneKey, type SessionWorkspace } from './workspace-layout.js';

/** Current arrangement is separate from named presets. Only identities/geometry,
 * never messages or session metadata, are persisted per authenticated user. */
export function currentLayoutKey(scope: string | undefined) {
  return scope ? `agentopsdeck.current-layout.v2:${scope}` : undefined;
}
export function legacyCurrentLayoutKey(scope: string | undefined) { return scope ? `agentopsdeck.current-layout.v1:${scope}` : undefined; }
export function layoutSnapshot(workspace: SessionWorkspace, collapsed: ReadonlySet<string>): SavedLayout {
  const floating = new Set(workspace.panes.filter(pane => workspace.floating.some(item => item.id === pane.id)).map(paneKey));
  return { id: 'current', name: 'Current', workspace, collapsedKeys: [...collapsed].filter(key => floating.has(key)) };
}
export function parseCurrentLayout(raw: string | null): SavedLayout | undefined {
  if (!raw || raw.length > 65_536) return undefined;
  try {
    const value = JSON.parse(raw);
    if (value?.id !== 'current' || value?.name !== 'Current') return undefined;
    // Named and current empty canvases now share the same strict validator.
    const parsed = parseSavedLayouts(JSON.stringify([value]))[0];
    return parsed ? layoutSnapshot(parsed.workspace.panes.length ? parsed.workspace : emptyWorkspace(), new Set(parsed.collapsedKeys)) : undefined;
  } catch { return undefined; }
}

export function osDesktopLayoutKey(scope: string | undefined) {
  return scope ? `agentopsdeck.os-desktop-layout.v1:${scope}` : undefined;
}
export function readOsDesktopLayout(scope: string | undefined): SavedLayout | undefined {
  const key = osDesktopLayoutKey(scope);
  if (!key || typeof localStorage === 'undefined') return undefined;
  try {
    return parseCurrentLayout(localStorage.getItem(key));
  } catch {
    return undefined;
  }
}
export function writeOsDesktopLayout(scope: string | undefined, workspace: SessionWorkspace, collapsed: ReadonlySet<string>): void {
  const key = osDesktopLayoutKey(scope);
  if (!key || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(layoutSnapshot(workspace, collapsed)));
  } catch {
    // Ignore storage quota errors
  }
}

export function areCurrentLayoutsEquivalent(aRaw: string, bRaw: string): boolean {
  if (aRaw === bRaw) return true;
  const a = parseCurrentLayout(aRaw);
  const b = parseCurrentLayout(bRaw);
  if (!a || !b) return false;
  return layoutFingerprint(a.workspace, new Set(a.collapsedKeys)) === layoutFingerprint(b.workspace, new Set(b.collapsedKeys));
}

export function reconcileCurrentLayoutConflict(input: {
  local: string;
  remote: string;
  base?: string | null | undefined;
  initialBoot: boolean;
}): string | null {
  const localParsed = parseCurrentLayout(input.local);
  const remoteParsed = parseCurrentLayout(input.remote);
  if (!localParsed || !remoteParsed) return null;
  if (areCurrentLayoutsEquivalent(input.local, input.remote)) return input.local;
  if (localParsed.workspace.panes.length === 0 && remoteParsed.workspace.panes.length > 0) {
    return input.remote;
  }
  if (input.initialBoot && localParsed.workspace.panes.length > 0) {
    return input.local;
  }
  return null;
}
