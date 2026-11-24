import { observedSavepoint } from '../storage/observed-savepoint.js';
import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { copyBoardTask, validBoardId, validBoardWrite, summarizeBoard, type BoardDocument, type BoardWrite, type BoardSummary } from '@agentopsdeck/shared';
import { WorkspaceNativeFileLocks } from './workspace-native-file-locks.js';

export type BoardSaveResult = { status: 'saved'; document: BoardDocument } | { status: 'conflict' | 'mutation-reused' | 'limit' | 'file-managed' };
/** Separate from private notes: future Agent capabilities can target this table
 * without gaining notebook access. CAS + receipts commit in one savepoint. */
export class WorkspaceBoards {
  private readonly fileLocks: WorkspaceNativeFileLocks;
  constructor(private readonly db: DatabaseSync) {
    this.fileLocks = new WorkspaceNativeFileLocks(db);
    db.exec(`CREATE TABLE IF NOT EXISTS hub_workspace_boards (
      user_id TEXT NOT NULL, resource_id TEXT NOT NULL, content TEXT NOT NULL,
      revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(user_id, resource_id));
      CREATE TABLE IF NOT EXISTS hub_workspace_board_receipts (
      user_id TEXT NOT NULL, resource_id TEXT NOT NULL, mutation_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, revision INTEGER NOT NULL, result TEXT NOT NULL,
      PRIMARY KEY(user_id, resource_id, mutation_id));
      CREATE TABLE IF NOT EXISTS hub_workspace_board_file_bindings (
        binding_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, resource_id TEXT NOT NULL,
        session_id TEXT NOT NULL, connection_id TEXT NOT NULL, authority INTEGER NOT NULL,
        state TEXT NOT NULL, source_hash TEXT, problem TEXT, created_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS hub_workspace_board_file_active
        ON hub_workspace_board_file_bindings(user_id, resource_id) WHERE state != 'revoked';
      CREATE TABLE IF NOT EXISTS hub_workspace_board_file_versions (
        user_id TEXT NOT NULL, resource_id TEXT NOT NULL, revision INTEGER NOT NULL,
        PRIMARY KEY(user_id, resource_id));
      CREATE TABLE IF NOT EXISTS hub_workspace_board_file_cancellations (
        binding_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, resource_id TEXT NOT NULL);`);
  }
  get(userId: string, resourceId: string): BoardDocument {
    if (!validBoardId(resourceId)) throw new Error('Invalid board ID');
    const row = this.db.prepare('SELECT content, revision, updated_at AS updatedAt FROM hub_workspace_boards WHERE user_id = ? AND resource_id = ?')
      .get(userId, resourceId) as { content: string; revision: number; updatedAt: number } | undefined;
    return row ? { ...JSON.parse(row.content), resourceId, revision: row.revision, updatedAt: row.updatedAt }
      : { resourceId, title: 'Task board', tasks: [], revision: 0, updatedAt: null };
  }
  summary(userId: string, resourceId: string): BoardSummary {
    return summarizeBoard(this.get(userId, resourceId));
  }
  revisions(userId: string): { resourceId: string; revision: number }[] {
    // Metadata only; bounded by the 64-board write quota. The committed board
    // rows are the authority, so a rollback/retry cannot publish a phantom event.
    const rows = this.db.prepare('SELECT resource_id AS resourceId, revision FROM hub_workspace_boards WHERE user_id = ? ORDER BY resource_id')
      .all(userId) as { resourceId: string; revision: number }[];
    return rows.map(({ resourceId, revision }) => ({ resourceId, revision }));
  }
  list(userId: string): BoardSummary[] {
    // Bounded by the same 64-board/user write limit. Do not return task bodies.
    const ids = this.db.prepare('SELECT resource_id AS id FROM hub_workspace_boards WHERE user_id = ? ORDER BY updated_at DESC, resource_id')
      .all(userId) as { id: string }[];
    if (!ids.some(row => row.id === 'default')) ids.unshift({ id: 'default' });
    return ids.map(row => this.summary(userId, row.id));
  }
  save(userId: string, resourceId: string, input: BoardWrite): BoardSaveResult {
    if (this.fileManaged(userId, resourceId)) return { status: 'file-managed' };
    return this.write(userId, resourceId, input);
  }
  fileManaged(userId: string, resourceId: string): boolean {
    if (this.fileLocks.managed(userId, 'taskboard', resourceId)) return true;
    return !!this.db.prepare("SELECT 1 FROM hub_workspace_board_file_bindings WHERE user_id = ? AND resource_id = ? AND state != 'revoked'")
      .get(userId, resourceId);
  }
  /** Internal projection write; the binding coordinator revalidates connection
   * authority in the SAME synchronous transaction. Never expose this ID as a
   * public alternative to a user's write permission. */
  importFile(userId: string, resourceId: string, bindingId: string, input: BoardWrite): BoardSaveResult {
    const row = this.db.prepare("SELECT 1 FROM hub_workspace_board_file_bindings WHERE binding_id = ? AND user_id = ? AND resource_id = ? AND state = 'active'")
      .get(bindingId, userId, resourceId);
    return row || this.fileLocks.allows(userId, 'taskboard', resourceId, bindingId) ? this.write(userId, resourceId, input) : { status: 'file-managed' };
  }
  private write(userId: string, resourceId: string, input: BoardWrite): BoardSaveResult {
    if (!validBoardId(resourceId) || !validBoardWrite(input)) throw new Error('Invalid board');
    const content = { title: input.title, tasks: input.tasks.map(copyBoardTask) };
    const fingerprint = createHash('sha256').update(JSON.stringify({ revision: input.revision, ...content })).digest('hex');
    return observedSavepoint(this.db, 'workspace-board-change', () => {
      const receipt = this.db.prepare('SELECT fingerprint, result FROM hub_workspace_board_receipts WHERE user_id = ? AND resource_id = ? AND mutation_id = ?')
        .get(userId, resourceId, input.mutationId) as { fingerprint: string; result: string } | undefined;
      let result: BoardSaveResult;
      if (receipt) result = receipt.fingerprint === fingerprint ? { status: 'saved', document: JSON.parse(receipt.result) } : { status: 'mutation-reused' };
      else if (this.get(userId, resourceId).revision !== input.revision) result = { status: 'conflict' };
      else if (!input.revision && (this.db.prepare('SELECT COUNT(*) AS count FROM hub_workspace_boards WHERE user_id = ?').get(userId) as { count: number }).count >= 64) result = { status: 'limit' };
      else {
        const document: BoardDocument = { ...content, resourceId, revision: input.revision + 1, updatedAt: Date.now() };
        this.db.prepare(`INSERT INTO hub_workspace_boards VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(user_id, resource_id) DO UPDATE SET content = excluded.content, revision = excluded.revision, updated_at = excluded.updated_at`)
          .run(userId, resourceId, JSON.stringify(content), document.revision, document.updatedAt);
        this.db.prepare('INSERT INTO hub_workspace_board_receipts VALUES (?, ?, ?, ?, ?, ?)')
          .run(userId, resourceId, input.mutationId, fingerprint, document.revision, JSON.stringify(document));
        // Bounded retry snapshots, NOT the future Agent security audit ledger.
        this.db.prepare('DELETE FROM hub_workspace_board_receipts WHERE user_id = ? AND resource_id = ? AND revision <= ?')
          .run(userId, resourceId, document.revision - 8);
        result = { status: 'saved', document };
      }
      return result;
    });
  }
}
