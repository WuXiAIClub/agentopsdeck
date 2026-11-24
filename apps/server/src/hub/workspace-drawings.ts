import { observedSavepoint } from '../storage/observed-savepoint.js';
import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { DRAWING_MAX_DOCUMENTS, drawingContent, emptyDrawing, validDrawingId, validDrawingWrite, type DrawingDocument, type DrawingWrite, type DrawingSummary } from '@agentopsdeck/shared';
import { WorkspaceNativeFileLocks } from './workspace-native-file-locks.js';
type SaveResult = { status: 'saved'; document: DrawingDocument } | { status: 'conflict' | 'mutation-reused' | 'limit' | 'file-managed' };
/** User-owned data, never implicitly exposed by Connector or board grants. */
export class WorkspaceDrawings {
  private readonly fileLocks: WorkspaceNativeFileLocks;
  constructor(private readonly db: DatabaseSync) {
    this.fileLocks = new WorkspaceNativeFileLocks(db);
    db.exec(`CREATE TABLE IF NOT EXISTS hub_workspace_drawings (
      user_id TEXT NOT NULL, resource_id TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
      revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(user_id, resource_id));
      CREATE TABLE IF NOT EXISTS hub_workspace_drawing_receipts (
      user_id TEXT NOT NULL, resource_id TEXT NOT NULL, mutation_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, revision INTEGER NOT NULL, result TEXT NOT NULL,
      PRIMARY KEY(user_id, resource_id, mutation_id));`);
  }
  get(userId: string, resourceId: string): DrawingDocument {
    if (!validDrawingId(resourceId)) throw Error('Invalid drawing ID');
    const row = this.db.prepare('SELECT content, revision, updated_at AS updatedAt FROM hub_workspace_drawings WHERE user_id = ? AND resource_id = ?')
      .get(userId, resourceId) as { content: string; revision: number; updatedAt: number } | undefined;
    return row ? { ...JSON.parse(row.content), resourceId, revision: row.revision, updatedAt: row.updatedAt }
      : { ...emptyDrawing(), resourceId, revision: 0, updatedAt: null };
  }
  revisions(userId: string): { resourceId: string; revision: number }[] {
    return this.db.prepare('SELECT resource_id AS resourceId, revision FROM hub_workspace_drawings WHERE user_id = ? ORDER BY resource_id')
      .all(userId) as { resourceId: string; revision: number }[];
  }
  list(userId: string): DrawingSummary[] {
    const rows = this.db.prepare('SELECT resource_id AS resourceId, title, revision, updated_at AS updatedAt FROM hub_workspace_drawings WHERE user_id = ? ORDER BY updated_at DESC, resource_id')
      .all(userId) as DrawingSummary[];
    return rows.map(({ resourceId, title, revision, updatedAt }) => ({ resourceId, title, revision, updatedAt }));
  }
  save(userId: string, resourceId: string, input: DrawingWrite, bindingId?: string): SaveResult {
    if (!validDrawingId(resourceId) || !validDrawingWrite(input)) throw Error('Invalid drawing');
    if (!this.fileLocks.allows(userId, 'drawing', resourceId, bindingId)) return { status: 'file-managed' };
    const content = drawingContent(input);
    const fingerprint = createHash('sha256').update(JSON.stringify({ ...content, revision: input.revision })).digest('hex');
    return observedSavepoint(this.db, 'workspace-drawing-change', () => {
      const receipt = this.db.prepare('SELECT fingerprint, result FROM hub_workspace_drawing_receipts WHERE user_id = ? AND resource_id = ? AND mutation_id = ?')
        .get(userId, resourceId, input.mutationId) as { fingerprint: string; result: string } | undefined;
      const row = this.db.prepare('SELECT revision FROM hub_workspace_drawings WHERE user_id = ? AND resource_id = ?').get(userId, resourceId) as { revision: number } | undefined;
      let result: SaveResult;
      if (receipt) result = receipt.fingerprint === fingerprint ? { status: 'saved', document: JSON.parse(receipt.result) } : { status: 'mutation-reused' };
      else if ((row?.revision ?? 0) !== input.revision) result = { status: 'conflict' };
      else if (!row && (this.db.prepare('SELECT COUNT(*) AS count FROM hub_workspace_drawings WHERE user_id = ?').get(userId) as { count: number }).count >= DRAWING_MAX_DOCUMENTS) result = { status: 'limit' };
      else {
        const document: DrawingDocument = { ...content, resourceId, revision: input.revision + 1, updatedAt: Date.now() };
        this.db.prepare(`INSERT INTO hub_workspace_drawings VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, resource_id) DO UPDATE SET title = excluded.title, content = excluded.content, revision = excluded.revision, updated_at = excluded.updated_at`)
          .run(userId, resourceId, content.title, JSON.stringify(content), document.revision, document.updatedAt);
        this.db.prepare('INSERT INTO hub_workspace_drawing_receipts VALUES (?, ?, ?, ?, ?, ?)')
          .run(userId, resourceId, input.mutationId, fingerprint, document.revision, JSON.stringify(document));
        this.db.prepare('DELETE FROM hub_workspace_drawing_receipts WHERE user_id = ? AND resource_id = ? AND revision <= ?').run(userId, resourceId, document.revision - 8);
        result = { status: 'saved', document };
      }
      return result;
    });
  }
}
