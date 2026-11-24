import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_HUB_NOTEBOOK_LAYOUT, validHubNotebookLayout } from '@agentopsdeck/shared';

export type NativeFileResource = { kind: string; id: string; facet?: 'title' };
/** Metadata-only fences shared by ordinary native stores and file projection.
 * The binding coordinator calls claim/release inside its synchronous savepoint. */
export class WorkspaceNativeFileLocks {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS hub_workspace_native_file_locks (
      user_id TEXT NOT NULL, kind TEXT NOT NULL, resource_id TEXT NOT NULL,
      binding_id TEXT NOT NULL, facet TEXT NOT NULL, PRIMARY KEY(user_id,kind,resource_id));`);
    db.exec(`CREATE TABLE IF NOT EXISTS hub_notebook_bound_moves (
      user_id TEXT NOT NULL, resource_id TEXT NOT NULL, request_id TEXT NOT NULL,
      binding_id TEXT NOT NULL, file_resource TEXT NOT NULL, input TEXT NOT NULL,
      payload TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(user_id,resource_id,request_id));
      CREATE UNIQUE INDEX IF NOT EXISTS hub_notebook_bound_move_pending
      ON hub_notebook_bound_moves(user_id,resource_id) WHERE state='pending';`);
  }
  binding(user: string, kind: string, id: string): string | undefined {
    return (this.db.prepare('SELECT binding_id AS id FROM hub_workspace_native_file_locks WHERE user_id=? AND kind=? AND resource_id=?')
      .get(user, kind, id) as { id: string } | undefined)?.id;
  }
  moving(user: string, resource: string) {
    return !!this.db.prepare("SELECT 1 FROM hub_notebook_bound_moves WHERE user_id=? AND resource_id=? AND state='pending'").get(user, resource);
  }
  permitsWrite(user: string, binding: string, mutation: string) {
    const row = this.db.prepare("SELECT request_id AS id FROM hub_notebook_bound_moves WHERE user_id=? AND binding_id=? AND state='pending'")
      .get(user, binding) as { id: string } | undefined;
    return !row || row.id === mutation;
  }
  managed(user: string, kind: string, id: string) {
    return !!this.db.prepare('SELECT 1 FROM hub_workspace_native_file_locks WHERE user_id=? AND kind=? AND resource_id=?').get(user, kind, id);
  }
  claim(user: string, binding: string, resources: NativeFileResource[]): boolean {
    if (resources.some(r => this.managed(user, r.kind, r.id) || r.kind === 'notebook' && this.moving(user, r.id))) return false;
    for (const r of resources) this.db.prepare('INSERT INTO hub_workspace_native_file_locks VALUES (?,?,?,?,?)').run(user, r.kind, r.id, binding, r.facet ?? 'all');
    return true;
  }
  release(user: string, binding: string) { this.db.prepare('DELETE FROM hub_workspace_native_file_locks WHERE user_id=? AND binding_id=?').run(user, binding); }
  allows(user: string, kind: string, id: string, binding?: string, titleText?: { current: string; next: string }) {
    const row = this.db.prepare('SELECT binding_id AS bindingId, facet FROM hub_workspace_native_file_locks WHERE user_id=? AND kind=? AND resource_id=?')
      .get(user, kind, id) as { bindingId: string; facet: string } | undefined;
    if (!row) return !binding && !(kind === 'notebook' && this.moving(user, id));
    if (binding) {
      if (row.bindingId !== binding) return false;
      return !!this.db.prepare("SELECT 1 FROM hub_workspace_card_file_bindings WHERE user_id=? AND binding_id=? AND state='active'").get(user, binding);
    }
    // Moving/resizing a bound notebook is not a file content change. Only its
    // delegated title is locked; malformed layouts never pass this exception.
    if (row.facet === 'title' && titleText) {
      try {
        const current = titleText.current === '' ? DEFAULT_HUB_NOTEBOOK_LAYOUT : JSON.parse(titleText.current);
        const next: unknown = JSON.parse(titleText.next);
        return validHubNotebookLayout(current) && validHubNotebookLayout(next) && next.title === current.title;
      } catch { return false; }
    }
    return false;
  }
}
