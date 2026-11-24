import type { DatabaseSync } from 'node:sqlite';
import { validSessionTags, type WorkspacePreferences } from '@agentopsdeck/shared';
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
function parse(input: unknown): WorkspacePreferences {
  const invalid = () => { throw new Error('Invalid workspace preferences'); };
  if (!record(input) || !keys(input, ['revision', 'groups', 'sessions', 'ungroupedCollapsed'])
    || (input.ungroupedCollapsed !== undefined && typeof input.ungroupedCollapsed !== 'boolean')) return invalid();
  if (typeof input.revision !== 'number' || !Number.isSafeInteger(input.revision) || input.revision < 0 || input.revision >= Number.MAX_SAFE_INTEGER
    || !Array.isArray(input.groups) || input.groups.length > 100 || !record(input.sessions) || Object.keys(input.sessions).length > 5000) return invalid();
  const groups: WorkspacePreferences['groups'] = [];
  const ids = new Set<string>();
  for (const group of input.groups) {
    if (!record(group) || !keys(group, ['id', 'name', 'collapsed']) || typeof group.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(group.id)
      || ids.has(group.id) || typeof group.name !== 'string' || !group.name.trim() || group.name.trim().length > 80
      || (group.collapsed !== undefined && typeof group.collapsed !== 'boolean')) return invalid();
    ids.add(group.id);
    groups.push({ id: group.id, name: group.name.trim(), ...(typeof group.collapsed === 'boolean' ? { collapsed: group.collapsed } : {}) });
  }
  const sessions: WorkspacePreferences['sessions'] = {};
  for (const [key, style] of Object.entries(input.sessions)) {
    if (!key || key.length > 1024 || ['__proto__', 'constructor', 'prototype'].includes(key) || !record(style) || !keys(style, ['color', 'groupId', 'order', 'tags'])
      || (style.tags !== undefined && !validSessionTags(style.tags))
      || (style.color !== undefined && (typeof style.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(style.color)))
      || (style.groupId !== undefined && (typeof style.groupId !== 'string' || !ids.has(style.groupId)))
      || (style.order !== undefined && (typeof style.order !== 'number' || !Number.isInteger(style.order) || style.order < 0 || style.order > 1_000_000))) return invalid();
    sessions[key] = { ...style };
  }
  return { revision: input.revision, groups, sessions, ...(typeof input.ungroupedCollapsed === 'boolean' ? { ungroupedCollapsed: input.ungroupedCollapsed } : {}) };
}
export const workspacePreferencesSchema = {
  parse,
  safeParse(input: unknown): { success: true; data: WorkspacePreferences } | { success: false } {
    try { return { success: true, data: parse(input) }; } catch { return { success: false }; }
  },
};

export class WorkspacePreferencesStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS hub_workspace_preferences (
      user_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, document TEXT NOT NULL
    )`);
  }
  get(userId: string): WorkspacePreferences {
    const row = this.db.prepare('SELECT revision, document FROM hub_workspace_preferences WHERE user_id = ?').get(userId) as { revision: number; document: string } | undefined;
    return row ? { ...JSON.parse(row.document), revision: row.revision } : { revision: 0, groups: [], sessions: {} };
  }
  save(userId: string, input: unknown): WorkspacePreferences | undefined {
    const value = workspacePreferencesSchema.parse(input);
    const document = JSON.stringify({ groups: value.groups, sessions: value.sessions, ungroupedCollapsed: value.ungroupedCollapsed });
    // Both creation and edits use a single conditional write. A stale tab cannot
    // overwrite another tab; callers must reload, never automatically replay.
    const result = value.revision === 0
      ? this.db.prepare('INSERT INTO hub_workspace_preferences (user_id, revision, document) VALUES (?, 1, ?) ON CONFLICT(user_id) DO NOTHING').run(userId, document)
      : this.db.prepare('UPDATE hub_workspace_preferences SET revision = revision + 1, document = ? WHERE user_id = ? AND revision = ?').run(document, userId, value.revision);
    return result.changes === 1 ? this.get(userId) : undefined;
  }
}
