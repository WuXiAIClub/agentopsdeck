import type { DatabaseSync } from 'node:sqlite';

export type LayoutKind = 'current' | 'saved';
export type LayoutDocument = { revision: number; content: string | null };
export function validLayoutWrite(value: unknown, kind: LayoutKind): value is LayoutDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as LayoutDocument;
  if (Object.keys(v).some(key => key !== 'revision' && key !== 'content') || !Number.isSafeInteger(v.revision) || v.revision < 0 || v.revision >= Number.MAX_SAFE_INTEGER
    || typeof v.content !== 'string' || Buffer.byteLength(v.content) > (kind === 'current' ? 65_536 : 1_048_576)) return false;
  try {
    const parsed = JSON.parse(v.content);
    const entries = kind === 'saved' ? parsed : [parsed];
    if (!Array.isArray(entries) || entries.length > 50) return false;
    const ids = new Set<string>();
    for (const item of entries) {
      if (!item || typeof item !== 'object' || Object.keys(item).some(key => !['id', 'name', 'workspace', 'collapsedKeys'].includes(key))
        || typeof item.id !== 'string' || !item.id || item.id.length > 4096 || ids.has(item.id)
        || typeof item.name !== 'string' || !item.name || item.name.length > 80
        || !item.workspace || ![1, 2].includes(item.workspace.version) || !Array.isArray(item.workspace.panes) || item.workspace.panes.length > 32
        || !Array.isArray(item.workspace.floating) || item.workspace.floating.length > 20
        || !Array.isArray(item.collapsedKeys) || item.collapsedKeys.length > 32 || !item.collapsedKeys.every((key: unknown) => typeof key === 'string' && key.length <= 4096)) return false;
      ids.add(item.id);
    }
    if (kind === 'current' && (parsed.id !== 'current' || parsed.name !== 'Current')) return false;
    // Opaque, versioned presentation data. Never execute/fetch its contents or
    // infer resource permissions from it; clients validate geometry on restore.
    const pending: [unknown, number][] = [[parsed, 0]]; let count = 0;
    while (pending.length) {
      const [node, depth] = pending.pop()!;
      if (++count > 100_000 || depth > 72) return false;
      if (node && typeof node === 'object') for (const [key, child] of Object.entries(node)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) return false;
        pending.push([child, depth + 1]);
      }
    }
    return true;
  } catch { return false; }
}
/** Separate from session organization: editing a group never conflicts with
 * moving a pane. Two fixed records per user, no unbounded revision log. */
export class WorkspaceLayouts {
  constructor(private readonly db: DatabaseSync) {
    db.exec('CREATE TABLE IF NOT EXISTS hub_workspace_layouts (user_id TEXT NOT NULL, kind TEXT NOT NULL, revision INTEGER NOT NULL, content TEXT NOT NULL, PRIMARY KEY(user_id, kind))');
  }
  get(user: string, kind: LayoutKind): LayoutDocument {
    return this.db.prepare('SELECT revision, content FROM hub_workspace_layouts WHERE user_id = ? AND kind = ?').get(user, kind) as LayoutDocument | undefined ?? { revision: 0, content: null };
  }
  save(user: string, kind: LayoutKind, value: LayoutDocument): LayoutDocument | undefined {
    if (!validLayoutWrite(value, kind)) throw Error('Invalid layout');
    const existing = this.get(user, kind);
    if (existing.content === value.content) return existing; // Reconcile lost replies, no second revision.
    const result = value.revision === 0
      ? this.db.prepare('INSERT INTO hub_workspace_layouts VALUES (?, ?, 1, ?) ON CONFLICT DO NOTHING').run(user, kind, value.content)
      : this.db.prepare('UPDATE hub_workspace_layouts SET content = ?, revision = revision + 1 WHERE user_id = ? AND kind = ? AND revision = ?').run(value.content, user, kind, value.revision);
    return result.changes === 1 ? this.get(user, kind) : undefined;
  }
}
