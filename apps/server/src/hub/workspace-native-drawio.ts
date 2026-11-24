import { observedSavepoint } from '../storage/observed-savepoint.js';
import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { NATIVE_DRAWIO_MAX_DOCUMENTS, emptyNativeDrawio, nativeDrawioContent, validDrawingId, validNativeDrawioWrite,
  type NativeDrawioDocument, type NativeDrawioWrite, type NativeDrawioSummary } from '@agentopsdeck/shared';
import { WorkspaceNativeFileLocks } from './workspace-native-file-locks.js';
type Result = { status: 'saved'; document: NativeDrawioDocument } | { status: 'conflict' | 'mutation-reused' | 'limit' | 'file-managed' };
/** Separate native format; no conversions, Connector access, or external resource resolution. */
export class WorkspaceNativeDrawio {
  private readonly fileLocks: WorkspaceNativeFileLocks;
  constructor(private readonly db: DatabaseSync) {
    this.fileLocks = new WorkspaceNativeFileLocks(db);
    db.exec(`CREATE TABLE IF NOT EXISTS hub_workspace_native_drawio (
      user_id TEXT NOT NULL, resource_id TEXT NOT NULL, title TEXT NOT NULL, xml TEXT NOT NULL,
      revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(user_id, resource_id));
      CREATE TABLE IF NOT EXISTS hub_workspace_native_drawio_receipts (
      user_id TEXT NOT NULL, resource_id TEXT NOT NULL, mutation_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(user_id, resource_id, mutation_id));`);
  }
  get(userId: string, resourceId: string): NativeDrawioDocument {
    if (!validDrawingId(resourceId)) throw Error('Invalid native drawing');
    const row = this.db.prepare('SELECT title, xml, revision, updated_at AS updatedAt FROM hub_workspace_native_drawio WHERE user_id = ? AND resource_id = ?')
      .get(userId, resourceId) as { title: string; xml: string; revision: number; updatedAt: number } | undefined;
    return { ...emptyNativeDrawio(), resourceId, revision: 0, updatedAt: null, ...row };
  }
  revisions(userId: string): { resourceId: string; revision: number }[] {
    return this.db.prepare('SELECT resource_id AS resourceId, revision FROM hub_workspace_native_drawio WHERE user_id = ? ORDER BY resource_id')
      .all(userId) as { resourceId: string; revision: number }[];
  }
  list(userId: string): NativeDrawioSummary[] {
    return this.db.prepare('SELECT resource_id AS resourceId, title, revision, updated_at AS updatedAt FROM hub_workspace_native_drawio WHERE user_id = ? ORDER BY updated_at DESC, resource_id')
      .all(userId) as NativeDrawioSummary[];
  }
  save(userId: string, resourceId: string, input: NativeDrawioWrite, bindingId?: string): Result {
    if (!validDrawingId(resourceId) || !validNativeDrawioWrite(input)) throw Error('Invalid native drawing');
    if (!this.fileLocks.allows(userId, 'native-drawio', resourceId, bindingId)) return { status: 'file-managed' };
    const content = nativeDrawioContent(input);
    const fingerprint = createHash('sha256').update(JSON.stringify({ ...content, revision: input.revision })).digest('hex');
    return observedSavepoint(this.db, 'workspace-native-drawio-change', () => {
      const receipt = this.db.prepare('SELECT fingerprint, revision, updated_at AS updatedAt FROM hub_workspace_native_drawio_receipts WHERE user_id = ? AND resource_id = ? AND mutation_id = ?')
        .get(userId, resourceId, input.mutationId) as { fingerprint: string; revision: number; updatedAt: number } | undefined;
      const row = this.db.prepare('SELECT revision FROM hub_workspace_native_drawio WHERE user_id = ? AND resource_id = ?').get(userId, resourceId) as { revision: number } | undefined;
      let result: Result;
      // Reconstruct the identical receipt from the fingerprint-verified request, without storing 8 XML copies.
      if (receipt) result = receipt.fingerprint === fingerprint ? { status: 'saved', document: { ...content, resourceId, revision: receipt.revision, updatedAt: receipt.updatedAt } } : { status: 'mutation-reused' };
      else if ((row?.revision ?? 0) !== input.revision) result = { status: 'conflict' };
      else if (!row && (this.db.prepare('SELECT COUNT(*) AS n FROM hub_workspace_native_drawio WHERE user_id = ?').get(userId) as { n: number }).n >= NATIVE_DRAWIO_MAX_DOCUMENTS) result = { status: 'limit' };
      else {
        const document: NativeDrawioDocument = { ...content, resourceId, revision: input.revision + 1, updatedAt: Date.now() };
        this.db.prepare(`INSERT INTO hub_workspace_native_drawio VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, resource_id) DO UPDATE SET title = excluded.title, xml = excluded.xml, revision = excluded.revision, updated_at = excluded.updated_at`)
          .run(userId, resourceId, content.title, content.xml, document.revision, document.updatedAt);
        this.db.prepare('INSERT INTO hub_workspace_native_drawio_receipts VALUES (?, ?, ?, ?, ?, ?)')
          .run(userId, resourceId, input.mutationId, fingerprint, document.revision, document.updatedAt);
        this.db.prepare('DELETE FROM hub_workspace_native_drawio_receipts WHERE user_id = ? AND resource_id = ? AND revision <= ?').run(userId, resourceId, document.revision - 8);
        result = { status: 'saved', document };
      }
      return result;
    });
  }
}
