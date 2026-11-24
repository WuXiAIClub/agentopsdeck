import { observedSavepoint } from '../storage/observed-savepoint.js';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { validBoardId, validBoardUuid, validBoardWrite, type BoardContent, type BoardWrite } from '@agentopsdeck/shared';
import { createHash } from 'node:crypto';
import { parseBoardFile, serializeBoardFile, type BoardFileSnapshot } from '../connector/workspace-board-file-format.js';
import type { WorkspaceBoards } from './workspace-boards.js';
import { ChangeSignal } from '../utils/change-signal.js';

export type FileBoardBinding = {
  bindingId: string; userId: string; resourceId: string; sessionId: string;
  connectionId: string; authority: number; state: 'prepared' | 'active' | 'revoked';
  sourceHash: string | null; problem: string | null; createdAt: number;
};
export type FileBoardIntent = Pick<FileBoardBinding, 'bindingId' | 'userId' | 'resourceId' | 'sessionId' | 'connectionId' | 'authority'>;
export type FileBoardApplyResult = 'updated' | 'unchanged' | 'retained' | 'denied' | 'invalid' | 'limit';
/** Browser DTO intentionally omits connection authority, owner and hashes. */
export function publicFileBoardBinding(row: Pick<FileBoardBinding, 'bindingId' | 'resourceId' | 'sessionId' | 'state' | 'problem'>) {
  const { bindingId, resourceId, sessionId, state, problem } = row;
  return { bindingId, resourceId, sessionId, state, problem };
}
const columns = `binding_id AS bindingId, user_id AS userId, resource_id AS resourceId,
  session_id AS sessionId, connection_id AS connectionId, authority, state,
  source_hash AS sourceHash, problem, created_at AS createdAt`;

/** Whole-board delegation is NEW opt-in state. No widening of task capabilities.
 * No credentials stored in the Agent's file. Caller injects a current connection
 * + session authorization check, not a cached boolean from the binding request. */
export class WorkspaceBoardFiles {
  readonly changes = new ChangeSignal();
  constructor(private readonly db: DatabaseSync, private readonly boards: WorkspaceBoards,
    private readonly authorized: (binding: FileBoardIntent) => boolean) {
    db.exec(`CREATE TABLE IF NOT EXISTS hub_workspace_file_writes (
      user_id TEXT NOT NULL, binding_id TEXT NOT NULL, mutation_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, expected_hash TEXT NOT NULL, state TEXT NOT NULL,
      PRIMARY KEY(user_id, binding_id, mutation_id));`);
  }
  writeReceipt(userId: string, bindingId: string, mutationId: string) {
    const binding = this.get(userId, bindingId);
    if (!binding || !this.authorized(binding)) return undefined;
    return this.db.prepare(`SELECT mutation_id AS mutationId, expected_hash AS expectedHash, state, fingerprint
      FROM hub_workspace_file_writes WHERE user_id = ? AND binding_id = ? AND mutation_id = ?`)
      .get(userId, bindingId, mutationId) as { mutationId: string; expectedHash: string; state: 'saved' | 'conflict' | 'uncertain'; fingerprint: string } | undefined;
  }
  prepareWrite(userId: string, bindingId: string, input: BoardWrite) {
    if (!validBoardWrite(input)) return undefined;
    const binding = this.get(userId, bindingId);
    if (!binding || binding.state !== 'active' || !this.authorized(binding)) return undefined;
    const fingerprint = createHash('sha256').update(JSON.stringify([input.revision, serializeBoardFile(input)])).digest('hex');
    const existing = this.writeReceipt(userId, bindingId, input.mutationId);
    if (existing) return existing.fingerprint === fingerprint ? { ...existing, fresh: false } : undefined;
    const document = this.boards.get(userId, binding.resourceId);
    if (!binding.sourceHash || binding.problem || document.revision !== input.revision
      || parseBoardFile(Buffer.from(serializeBoardFile(document)))?.hash !== binding.sourceHash) return undefined;
    if ((this.db.prepare('SELECT COUNT(*) AS n FROM hub_workspace_file_writes WHERE user_id = ? AND binding_id = ?')
      .get(userId, bindingId) as { n: number }).n >= 1024) return undefined;
    this.db.prepare('INSERT INTO hub_workspace_file_writes VALUES (?, ?, ?, ?, ?, ?)')
      .run(userId, bindingId, input.mutationId, fingerprint, binding.sourceHash, 'uncertain');
    return { mutationId: input.mutationId, expectedHash: binding.sourceHash, state: 'uncertain' as const, fingerprint, fresh: true };
  }
  finishWrite(userId: string, bindingId: string, mutationId: string, state: 'saved' | 'conflict' | 'uncertain') {
    const binding = this.get(userId, bindingId);
    if (!binding || !this.authorized(binding)) return;
    this.db.prepare('UPDATE hub_workspace_file_writes SET state = ? WHERE user_id = ? AND binding_id = ? AND mutation_id = ?')
      .run(state, userId, bindingId, mutationId);
  }
  revisions(userId: string): { resourceId: string; revision: number }[] {
    return this.db.prepare('SELECT resource_id AS resourceId, revision FROM hub_workspace_board_file_versions WHERE user_id = ? ORDER BY resource_id')
      .all(userId) as { resourceId: string; revision: number }[];
  }
  private changed(row: Pick<FileBoardBinding, 'userId' | 'resourceId'>) {
    this.db.prepare(`INSERT INTO hub_workspace_board_file_versions VALUES (?, ?, 1)
      ON CONFLICT(user_id, resource_id) DO UPDATE SET revision = revision + 1`).run(row.userId, row.resourceId);
  }
  private atomic<T>(operation: () => T extends PromiseLike<unknown> ? never : T): T {
    return observedSavepoint(this.db, 'workspace-board-file-change', operation);
  }
  get(userId: string, bindingId: string): FileBoardBinding | undefined {
    return this.db.prepare(`SELECT ${columns} FROM hub_workspace_board_file_bindings WHERE user_id = ? AND binding_id = ?`)
      .get(userId, bindingId) as FileBoardBinding | undefined;
  }
  current(userId: string, resourceId: string): FileBoardBinding | undefined {
    return this.db.prepare(`SELECT ${columns} FROM hub_workspace_board_file_bindings WHERE user_id = ? AND resource_id = ? AND state != 'revoked'`)
      .get(userId, resourceId) as FileBoardBinding | undefined;
  }
  /** Rebuild subscriptions at startup; bounded by prepare's global quota. */
  active(): FileBoardBinding[] {
    return this.db.prepare(`SELECT ${columns} FROM hub_workspace_board_file_bindings WHERE state = 'active' ORDER BY created_at`).all() as FileBoardBinding[];
  }
  /** Tombstone a request that may still be in preflight. Never unlock a board
   * just because an inspect returned 404: its earlier POST may still arrive. */
  cancelAbsent(userId: string, resourceId: string, bindingId: string): boolean {
    if (!validBoardUuid(bindingId) || !validBoardId(resourceId) || !userId || userId.length > 160) return false;
    return this.atomic(() => {
      if (this.db.prepare('SELECT 1 FROM hub_workspace_board_file_bindings WHERE binding_id = ?').get(bindingId)) return false;
      const previous = this.db.prepare('SELECT user_id, resource_id FROM hub_workspace_board_file_cancellations WHERE binding_id = ?')
        .get(bindingId) as { user_id: string; resource_id: string } | undefined;
      if (previous) return previous.user_id === userId && previous.resource_id === resourceId;
      if ((this.db.prepare('SELECT COUNT(*) AS n FROM hub_workspace_board_file_cancellations WHERE user_id = ?').get(userId) as { n: number }).n >= 256) return false;
      this.db.prepare('INSERT INTO hub_workspace_board_file_cancellations VALUES (?, ?, ?)').run(bindingId, userId, resourceId);
      return true;
    });
  }
  prepare(intent: FileBoardIntent, expectedBoardRevision: number): FileBoardBinding | undefined {
    if (!validBoardUuid(intent.bindingId) || !validBoardId(intent.resourceId) || !intent.userId || intent.userId.length > 160
      || !intent.connectionId || intent.connectionId.length > 160 || !intent.sessionId || intent.sessionId.length > 1024
      || !Number.isSafeInteger(intent.authority) || intent.authority < 0 || !Number.isSafeInteger(expectedBoardRevision) || expectedBoardRevision < 0) return;
    return this.atomic(() => {
      if (!this.authorized(intent)) return;
      if (this.db.prepare('SELECT 1 FROM hub_workspace_board_file_cancellations WHERE binding_id = ?').get(intent.bindingId)) return;
      const existing = this.get(intent.userId, intent.bindingId);
      if (existing) return existing.resourceId === intent.resourceId && existing.sessionId === intent.sessionId
        && existing.connectionId === intent.connectionId && existing.authority === intent.authority ? existing : undefined;
      if (this.db.prepare('SELECT 1 FROM hub_workspace_board_file_bindings WHERE binding_id = ?').get(intent.bindingId)
        || this.current(intent.userId, intent.resourceId) || this.boards.fileManaged(intent.userId, intent.resourceId)
        || this.boards.get(intent.userId, intent.resourceId).revision !== expectedBoardRevision) return;
      // Preserve tombstones. Do not silently evict an old receipt to admit writes.
      if ((this.db.prepare('SELECT COUNT(*) AS n FROM hub_workspace_board_file_bindings WHERE user_id = ?').get(intent.userId) as { n: number }).n >= 256
        || (this.db.prepare("SELECT COUNT(*) AS n FROM hub_workspace_board_file_bindings WHERE state != 'revoked'").get() as { n: number }).n >= 64) return;
      this.db.prepare('INSERT INTO hub_workspace_board_file_bindings VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)')
        .run(intent.bindingId, intent.userId, intent.resourceId, intent.sessionId, intent.connectionId, intent.authority, 'prepared', Date.now());
      this.changed(intent);
      return this.get(intent.userId, intent.bindingId);
    });
  }
  /** Installation is confirmed independently; a timeout is not confirmation. */
  activate(userId: string, bindingId: string): boolean {
    return this.atomic(() => {
      const row = this.get(userId, bindingId);
      if (!row || row.state === 'revoked' || !this.authorized(row)) return false;
      if (row.state !== 'active') this.changed(row);
      this.db.prepare("UPDATE hub_workspace_board_file_bindings SET state = 'active' WHERE binding_id = ?").run(bindingId);
      this.changes.notify();
      return true;
    });
  }
  revoke(userId: string, bindingId: string): boolean {
    // Revocation must still work when Connector is offline or permission lost.
    return this.atomic(() => {
      const row = this.get(userId, bindingId);
      if (!row) return false;
      if (row.state !== 'revoked') {
        this.db.prepare("UPDATE hub_workspace_board_file_bindings SET state = 'revoked' WHERE user_id = ? AND binding_id = ?")
          .run(userId, bindingId);
        this.changed(row); this.changes.notify();
      }
      return true;
    });
  }
  apply(userId: string, bindingId: string, snapshot: BoardFileSnapshot): FileBoardApplyResult {
    return this.atomic(() => {
      const row = this.get(userId, bindingId);
      if (!row || row.state !== 'active' || !this.authorized(row)) return 'denied';
      if (!snapshot || !['ready', 'missing', 'invalid', 'too-large', 'unsafe', 'unavailable'].includes(snapshot.state)) return 'invalid';
      if (snapshot.state !== 'ready') {
        // Last-good data in an error frame is advisory only. Never import it.
        if (row.problem !== snapshot.state) this.changed(row);
        this.db.prepare('UPDATE hub_workspace_board_file_bindings SET problem = ? WHERE binding_id = ?').run(snapshot.state, bindingId);
        return 'retained';
      }
      let content: BoardContent, hash: string;
      try {
        // Revalidate remote data and recompute its hash; don't trust a Connector
        // revision string to substitute for valid content or authorization.
        const parsed = parseBoardFile(Buffer.from(serializeBoardFile(snapshot.value.content)));
        if (!parsed || parsed.hash !== snapshot.value.hash) return 'invalid';
        ({ content, hash } = parsed);
      } catch { return 'invalid'; }
      if (hash === row.sourceHash) {
        if (row.problem) this.changed(row);
        if (row.problem) this.db.prepare('UPDATE hub_workspace_board_file_bindings SET problem = NULL WHERE binding_id = ?').run(bindingId);
        return 'unchanged';
      }
      const document = this.boards.get(userId, row.resourceId);
      const currentHash = parseBoardFile(Buffer.from(serializeBoardFile(document)))!.hash;
      if (hash !== currentHash) {
        const saved = this.boards.importFile(userId, row.resourceId, bindingId, { ...content, revision: document.revision, mutationId: randomUUID() });
        if (saved.status === 'limit') return 'limit';
        if (saved.status !== 'saved') throw new Error('Board projection conflict');
      }
      if (row.problem) this.changed(row);
      this.db.prepare('UPDATE hub_workspace_board_file_bindings SET source_hash = ?, problem = NULL WHERE binding_id = ?').run(hash, bindingId);
      return hash === currentHash ? 'unchanged' : 'updated';
    });
  }
}
