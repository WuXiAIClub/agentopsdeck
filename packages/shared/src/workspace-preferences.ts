/** Cosmetic, per-Hub-user organization. Never changes Connector ownership or grants. */
export type WorkspaceGroup = { id: string; name: string; collapsed?: boolean };
export type WorkspaceSessionStyle = { color?: string; groupId?: string; order?: number; tags?: string[] };
/** Labels are organization only, never a dynamic authorization policy. */
export function validSessionTags(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 8 && new Set(value).size === value.length
    && value.every(tag => typeof tag === 'string' && tag.length > 0 && tag.length <= 32
      && tag === tag.trim() && !/[\u0000-\u001f\u007f,，]/.test(tag));
}
export type WorkspacePreferences = {
  revision: number;
  ungroupedCollapsed?: boolean;
  groups: WorkspaceGroup[];
  sessions: Record<string, WorkspaceSessionStyle>;
};
