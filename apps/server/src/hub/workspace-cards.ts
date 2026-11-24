import { observedSavepoint } from '../storage/observed-savepoint.js';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { validBoardUuid, validCardWrite, type CardDocument, type CardSummary, type CardWrite } from '@agentopsdeck/shared';
import { WorkspaceNativeFileLocks } from './workspace-native-file-locks.js';

export class WorkspaceCards {
  private readonly fileLocks: WorkspaceNativeFileLocks;
  constructor(private readonly db: DatabaseSync) {
    this.fileLocks = new WorkspaceNativeFileLocks(db);
    db.exec(`CREATE TABLE IF NOT EXISTS hub_workspace_cards (user_id TEXT NOT NULL, resource_id TEXT NOT NULL, content TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(user_id, resource_id));
      CREATE TABLE IF NOT EXISTS hub_workspace_card_receipts (user_id TEXT NOT NULL, resource_id TEXT NOT NULL, mutation_id TEXT NOT NULL, fingerprint TEXT NOT NULL, revision INTEGER NOT NULL, result TEXT NOT NULL, PRIMARY KEY(user_id,resource_id,mutation_id));`);
  }
  get(user: string, id: string): CardDocument | undefined {
    if (!validBoardUuid(id)) throw Error('Invalid card ID');
    const row = this.db.prepare('SELECT content, revision, updated_at AS updatedAt FROM hub_workspace_cards WHERE user_id=? AND resource_id=?').get(user, id) as { content: string; revision: number; updatedAt: number } | undefined;
    return row ? { ...JSON.parse(row.content), resourceId: id, revision: row.revision, updatedAt: row.updatedAt } : undefined;
  }
  list(user: string): CardSummary[] {
    const rows = this.db.prepare("SELECT resource_id AS resourceId, json_extract(content, '$.title') AS title, json_extract(content, '$.tone') AS tone, revision, updated_at AS updatedAt FROM hub_workspace_cards WHERE user_id=? ORDER BY updated_at DESC,resource_id").all(user);
    return rows as CardSummary[];
  }
  revisions(user: string) { return this.db.prepare('SELECT resource_id AS resourceId, revision FROM hub_workspace_cards WHERE user_id=? ORDER BY resource_id').all(user) as { resourceId: string; revision: number }[]; }
  save(user: string, id: string, input: CardWrite, bindingId?: string): { status: 'saved'; document: CardDocument } | { status: 'conflict' | 'mutation-reused' | 'limit' | 'file-managed' } {
    if (!validBoardUuid(id) || !validCardWrite(input)) throw Error('Invalid card');
    if (!this.fileLocks.allows(user, 'metric-card', id, bindingId)) return { status: 'file-managed' };
    const { mutationId, revision, title, value, detail, tone, progress } = input, content = { title, value, detail, tone, progress };
    const fingerprint = createHash('sha256').update(JSON.stringify({ revision, ...content })).digest('hex');
    return observedSavepoint(this.db, 'workspace-card-change', () => {
      const receipt = this.db.prepare('SELECT fingerprint,result FROM hub_workspace_card_receipts WHERE user_id=? AND resource_id=? AND mutation_id=?').get(user, id, mutationId) as { fingerprint: string; result: string } | undefined;
      let result: ReturnType<WorkspaceCards['save']>;
      if (receipt) result = receipt.fingerprint === fingerprint ? { status: 'saved', document: JSON.parse(receipt.result) } : { status: 'mutation-reused' };
      else if ((this.get(user, id)?.revision ?? 0) !== revision) result = { status: 'conflict' };
      else if (!revision && (this.db.prepare('SELECT COUNT(*) AS count FROM hub_workspace_cards WHERE user_id=?').get(user) as { count: number }).count >= 64) result = { status: 'limit' };
      else {
        const document: CardDocument = { ...content, resourceId: id, revision: revision + 1, updatedAt: Date.now() };
        this.db.prepare('INSERT INTO hub_workspace_cards VALUES (?,?,?,?,?) ON CONFLICT(user_id,resource_id) DO UPDATE SET content=excluded.content, revision=excluded.revision, updated_at=excluded.updated_at').run(user, id, JSON.stringify(content), document.revision, document.updatedAt);
        this.db.prepare('INSERT INTO hub_workspace_card_receipts VALUES (?,?,?,?,?,?)').run(user, id, mutationId, fingerprint, document.revision, JSON.stringify(document));
        this.db.prepare('DELETE FROM hub_workspace_card_receipts WHERE user_id=? AND resource_id=? AND revision<=?').run(user, id, document.revision - 8);
        result = { status: 'saved', document };
      }
      return result;
    });
  }
}
