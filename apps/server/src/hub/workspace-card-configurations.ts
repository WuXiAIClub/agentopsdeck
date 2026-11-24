import { observedSavepoint } from '../storage/observed-savepoint.js';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { validBoardUuid, validWorkspaceFileCardWrite, workspaceFileCardContent, workspaceFileCardResource,
  type WorkspaceFileCard, type WorkspaceFileCardKind, type WorkspaceFileCardWrite } from '@agentopsdeck/shared';
import { WorkspaceNativeFileLocks } from './workspace-native-file-locks.js';

const configurationKinds = new Set<WorkspaceFileCardKind>(['website', 'browser', 'research', 'terminal', 'media', 'dashboard']);
export type WorkspaceCardConfiguration = WorkspaceFileCard & { revision: number; updatedAt: number };
/** Desired declarative settings only. No executor/transport is imported here.
 * Live service handles, command input and permissions never live in this store. */
export class WorkspaceCardConfigurations {
  private readonly locks: WorkspaceNativeFileLocks;
  constructor(private readonly db: DatabaseSync) {
    this.locks = new WorkspaceNativeFileLocks(db);
    db.exec(`CREATE TABLE IF NOT EXISTS hub_workspace_card_configurations (
      user_id TEXT NOT NULL, kind TEXT NOT NULL, resource_id TEXT NOT NULL, content TEXT NOT NULL,
      revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(user_id,kind,resource_id));
      CREATE TABLE IF NOT EXISTS hub_workspace_card_configuration_receipts (
        user_id TEXT NOT NULL, kind TEXT NOT NULL, resource_id TEXT NOT NULL, mutation_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(user_id,kind,resource_id,mutation_id));`);
  }
  get(user: string, kind: WorkspaceFileCardKind, id: string): WorkspaceCardConfiguration | undefined {
    if (!configurationKinds.has(kind) || !validBoardUuid(id)) return;
    const row = this.db.prepare('SELECT content,revision,updated_at AS updatedAt FROM hub_workspace_card_configurations WHERE user_id=? AND kind=? AND resource_id=?')
      .get(user, kind, id) as { content: string; revision: number; updatedAt: number } | undefined;
    return row ? { ...JSON.parse(row.content), revision: row.revision, updatedAt: row.updatedAt } : undefined;
  }
  revisions(user: string) {
    const rows = this.db.prepare('SELECT kind,resource_id AS resourceId,revision FROM hub_workspace_card_configurations WHERE user_id=? ORDER BY kind,resource_id')
      .all(user) as { kind: WorkspaceFileCardKind; resourceId: string; revision: number }[];
    return rows.map(row => ({ resourceId: workspaceFileCardResource(row.kind, row.resourceId), revision: row.revision }));
  }
  save(user: string, id: string, input: WorkspaceFileCardWrite, binding?: string):
    { status: 'saved'; document: WorkspaceCardConfiguration } | { status: 'conflict' | 'mutation-reused' | 'file-managed' | 'limit' } {
    if (!validWorkspaceFileCardWrite(input) || !configurationKinds.has(input.kind) || !validBoardUuid(id)) throw new Error('Invalid card configuration');
    if (!this.locks.allows(user, input.kind, id, binding)) return { status: 'file-managed' };
    const content = workspaceFileCardContent(input);
    const fingerprint = createHash('sha256').update(JSON.stringify([input.revision, content])).digest('hex');
    return observedSavepoint(this.db, 'workspace-card-configuration-change', () => {
      const receipt = this.db.prepare('SELECT fingerprint,revision,updated_at AS updatedAt FROM hub_workspace_card_configuration_receipts WHERE user_id=? AND kind=? AND resource_id=? AND mutation_id=?')
        .get(user, input.kind, id, input.mutationId) as { fingerprint: string; revision: number; updatedAt: number } | undefined;
      let result: ReturnType<WorkspaceCardConfigurations['save']>;
      if (receipt) result = receipt.fingerprint === fingerprint ? { status: 'saved', document: { ...content, revision: receipt.revision, updatedAt: receipt.updatedAt } } : { status: 'mutation-reused' };
      else if ((this.get(user, input.kind, id)?.revision ?? 0) !== input.revision) result = { status: 'conflict' };
      else if (!input.revision && (this.db.prepare('SELECT COUNT(*) AS n FROM hub_workspace_card_configurations WHERE user_id=?').get(user) as { n: number }).n >= 64) result = { status: 'limit' };
      else {
        const document = { ...content, revision: input.revision + 1, updatedAt: Date.now() };
        this.db.prepare(`INSERT INTO hub_workspace_card_configurations VALUES (?,?,?,?,?,?) ON CONFLICT(user_id,kind,resource_id)
          DO UPDATE SET content=excluded.content,revision=excluded.revision,updated_at=excluded.updated_at`).run(user, input.kind, id, JSON.stringify(content), document.revision, document.updatedAt);
        this.db.prepare('INSERT INTO hub_workspace_card_configuration_receipts VALUES (?,?,?,?,?,?,?)').run(user, input.kind, id, input.mutationId, fingerprint, document.revision, document.updatedAt);
        this.db.prepare('DELETE FROM hub_workspace_card_configuration_receipts WHERE user_id=? AND kind=? AND resource_id=? AND revision<=?').run(user, input.kind, id, document.revision - 8);
        result = { status: 'saved', document };
      }
      return result;
    });
  }
}
