const listeners = new Set<() => void>();
let scope: string | undefined;
let snapshot = { enabled: false, persistent: true, unavailable: false };
const key = () => scope ? `agentopsdeck.workspace-sync-preview.v1:${scope}` : undefined;
const emit = () => listeners.forEach(listener => listener());
export const workspaceSyncPreference = () => snapshot;
export const subscribeWorkspaceSyncPreference = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function setWorkspaceSyncScope(next: string | undefined) {
  if (scope === next) return;
  scope = next;
  let enabled = false, persistent = true;
  try { const name = key(); enabled = !!name && window.localStorage.getItem(name) === 'on'; } catch { persistent = false; }
  snapshot = { enabled, persistent, unavailable: false }; emit();
}
export function setWorkspaceSyncEnabled(enabled: boolean) {
  let persistent = !!scope;
  try { const name = key(); if (name) window.localStorage.setItem(name, enabled ? 'on' : 'off'); } catch { persistent = false; }
  snapshot = { enabled: !!scope && enabled, persistent, unavailable: false }; emit();
}
export function markWorkspaceSyncUnavailable() {
  if (snapshot.unavailable) return;
  snapshot = { ...snapshot, unavailable: true }; emit();
}
