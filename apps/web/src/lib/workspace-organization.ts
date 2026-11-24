import type { WorkspacePreferences } from '@agentopsdeck/shared';

export function moveWorkspaceSession(value: WorkspacePreferences, key: string, groupId?: string, beforeKey?: string) {
  if (beforeKey === key) return value;
  if (groupId && !value.groups.some(group => group.id === groupId)) return value;
  const next = structuredClone(value);
  const ordered = Object.keys(next.sessions).filter(id => id !== key && next.sessions[id]?.groupId === groupId)
    .sort((a, b) => (next.sessions[a]?.order ?? 1_000_000) - (next.sessions[b]?.order ?? 1_000_000));
  const index = beforeKey ? ordered.indexOf(beforeKey) : -1;
  ordered.splice(index < 0 ? ordered.length : index, 0, key);
  next.sessions[key] = { ...next.sessions[key] };
  delete next.sessions[key]!.groupId;
  if (groupId) next.sessions[key]!.groupId = groupId;
  ordered.forEach((id, order) => { next.sessions[id] = { ...next.sessions[id], order }; });
  return next;
}

/** Flat-view ordering must not change group membership. */
export function reorderWorkspaceSession(value: WorkspacePreferences, key: string, beforeKey?: string) {
  if (key === beforeKey) return value;
  const next = structuredClone(value);
  const ordered = Object.keys(next.sessions).filter(id => id !== key)
    .sort((a, b) => (next.sessions[a]?.order ?? 1_000_000) - (next.sessions[b]?.order ?? 1_000_000));
  const index = beforeKey ? ordered.indexOf(beforeKey) : -1;
  ordered.splice(index < 0 ? ordered.length : index, 0, key);
  ordered.forEach((id, order) => { next.sessions[id] = { ...next.sessions[id], order }; });
  return next;
}

export function removeWorkspaceGroup(value: WorkspacePreferences, id: string) {
  const next = structuredClone(value);
  next.groups = next.groups.filter(group => group.id !== id);
  for (const style of Object.values(next.sessions)) if (style.groupId === id) { delete style.groupId; delete style.order; }
  return next;
}

export function moveWorkspaceGroup(value: WorkspacePreferences, id: string, beforeId?: string) {
  if (id === beforeId || !value.groups.some(group => group.id === id)
    || (beforeId && !value.groups.some(group => group.id === beforeId))) return value;
  const next = structuredClone(value);
  const [group] = next.groups.splice(next.groups.findIndex(group => group.id === id), 1);
  next.groups.splice(beforeId ? next.groups.findIndex(group => group.id === beforeId) : next.groups.length, 0, group!);
  return next;
}
