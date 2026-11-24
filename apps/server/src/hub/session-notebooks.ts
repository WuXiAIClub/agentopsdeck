import { observedTransaction } from '../storage/observed-transaction.js';
import { observedSavepoint } from '../storage/observed-savepoint.js';
import type { DatabaseSync } from 'node:sqlite';
import { NOTEBOOK_MAX_CHARS, NOTEBOOK_ARCHIVE_MAX_CHARS, type SessionNotebookDocument } from '@agentopsdeck/shared';
import { WorkspaceNativeFileLocks } from './workspace-native-file-locks.js';
import { moveNotebookText, validNotebookMove, NotebookMoveConflict, type NotebookMove } from './notebook-operations.js';

export type SessionNotebook = SessionNotebookDocument;
export const moveInput = (input: NotebookMove) => JSON.stringify([input.direction, input.hotRevision, input.coldRevision, input.ranges.map(r => [r.start, r.end, r.sha256])]);
type BoundMove = { bindingId: string; fileResource: string; input: string; state: 'pending' | 'conflict' | 'saved'; payload: string };
export function validNotebookInput(value: unknown, maxChars = NOTEBOOK_MAX_CHARS): value is { text: string; revision: number; resourceId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 3 && typeof v.resourceId === 'string' && v.resourceId.length <= 8192
    && typeof v.text === 'string' && v.text.length <= maxChars
    && typeof v.revision === 'number' && Number.isSafeInteger(v.revision) && v.revision >= 0 && v.revision < Number.MAX_SAFE_INTEGER;
}

/** Hub-only personal data. An empty note is a versioned tombstone, not a DELETE. */
export class SessionNotebooks {
  private readonly fileLocks: WorkspaceNativeFileLocks;
  constructor(private readonly db: DatabaseSync) {
    this.fileLocks = new WorkspaceNativeFileLocks(db);
    db.exec(`CREATE TABLE IF NOT EXISTS hub_session_notebooks (
      user_id TEXT NOT NULL, resource_id TEXT NOT NULL, text TEXT NOT NULL,
      revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, resource_id)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS hub_notebook_archives (
      user_id TEXT NOT NULL, resource_id TEXT NOT NULL, text TEXT NOT NULL,
      revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, resource_id)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS hub_notebook_move_receipts (
      user_id TEXT NOT NULL, resource_id TEXT NOT NULL, request_id TEXT NOT NULL,
      input TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(user_id,resource_id,request_id)
    )`);
  }
  moveReceipt(user: string, resource: string, id: string) {
    const row = this.db.prepare('SELECT result FROM hub_notebook_move_receipts WHERE user_id=? AND resource_id=? AND request_id=?').get(user, resource, id) as { result: string } | undefined;
    return row ? JSON.parse(row.result) as { hotRevision: number; coldRevision: number; moved: number } : undefined;
  }
  fileBinding(user: string, resource: string) { return this.fileLocks.binding(user, 'notebook', resource); }
  archiveFileBinding(user: string, resource: string) { return this.fileLocks.binding(user, 'notebook-archive', resource); }
  boundMove(user: string, resource: string, id: string): BoundMove | undefined {
    return this.db.prepare(`SELECT binding_id AS bindingId,file_resource AS fileResource,input,payload,state
      FROM hub_notebook_bound_moves WHERE user_id=? AND resource_id=? AND request_id=?`).get(user, resource, id) as BoundMove | undefined;
  }
  plannedMove(user: string, resource: string, input: NotebookMove) {
    if (!validNotebookMove(input)) throw new NotebookMoveConflict('Invalid move');
    const hot = this.get(user, resource), cold = this.getArchive(user, resource);
    if (hot.revision !== input.hotRevision || cold.revision !== input.coldRevision) throw new NotebookMoveConflict('Notebook changed');
    const archive = input.direction === 'archive';
    const next = moveNotebookText(archive ? hot.text : cold.text, archive ? cold.text : hot.text, input.ranges, archive ? NOTEBOOK_ARCHIVE_MAX_CHARS : NOTEBOOK_MAX_CHARS);
    return { hotText: archive ? next.source : next.destination, coldText: archive ? next.destination : next.source, coldRevision: cold.revision, moved: next.moved };
  }
  /** Reservation and file write intent must share this DB/savepoint. No await
   * is allowed between revalidating snapshots and durable intent admission. */
  admitBoundMove<T>(user: string, resource: string, input: NotebookMove, bindingId: string, fileResource: string, prepare: () => T extends PromiseLike<unknown> ? never : T): T {
    return observedSavepoint<T>(this.db, 'notebook-bound-move', () => {
      const old = this.boundMove(user, resource, input.requestId);
      if (old && (old.input !== moveInput(input) || old.bindingId !== bindingId || old.fileResource !== fileResource || old.state !== 'pending')) throw new NotebookMoveConflict('Request ID already used');
      if (!old) {
        if (this.fileBinding(user, resource) !== bindingId || this.fileLocks.moving(user, resource)) throw new NotebookMoveConflict('Notebook move in progress');
        const count = this.db.prepare('SELECT COUNT(*) AS n FROM hub_notebook_bound_moves WHERE user_id=?').get(user) as { n: number };
        if (count.n >= 10_000) throw new NotebookMoveConflict('Receipt capacity reached');
        const payload = { ...this.plannedMove(user, resource, input), fileArchive: this.archiveFileBinding(user, resource) === bindingId };
        this.db.prepare('INSERT INTO hub_notebook_bound_moves VALUES (?,?,?,?,?,?,?,?)')
          .run(user, resource, input.requestId, bindingId, fileResource, moveInput(input), JSON.stringify(payload), 'pending');
      }
      const result = observedSavepoint(this.db, 'notebook-bound-prepare', prepare);
      if (!result || !old && !(result as { fresh?: boolean }).fresh) throw new NotebookMoveConflict('Notebook changed');
      // Preserve the generic synchronous contract across the inner boundary;
      // both helpers also enforce it at runtime for untyped callers.
      return result as T extends PromiseLike<unknown> ? never : T;
    });
  }
  finishBoundMove(user: string, resource: string, id: string) {
    return observedSavepoint(this.db, 'notebook-bound-finish', () => {
      const move = this.boundMove(user, resource, id);
      if (!move) throw new NotebookMoveConflict('Move not found');
      // Check the durable ORIGINAL file receipt, never a caller-supplied state.
      const receipt = this.db.prepare(`SELECT state FROM hub_workspace_card_file_writes WHERE user_id=? AND binding_id=? AND mutation_id=?`)
        .get(user, move.bindingId, id) as { state: string } | undefined;
      if (move.state === 'pending' && (receipt?.state === 'saved' || receipt?.state === 'conflict')) {
        this.db.prepare('UPDATE hub_notebook_bound_moves SET state=? WHERE user_id=? AND resource_id=? AND request_id=?')
          .run(receipt.state, user, resource, id);
        if (receipt.state === 'saved') {
          const payload = JSON.parse(move.payload) as ReturnType<SessionNotebooks['plannedMove']> & { fileArchive?: boolean };
          // Whole-note files already projected BOTH areas atomically. Never
          // replay the historical cold text over a later Agent edit on recovery.
          const cold = payload.fileArchive ? this.getArchive(user, resource)
            : this.saveArchive(user, { resourceId: resource, text: payload.coldText, revision: payload.coldRevision });
          if (!cold) throw new NotebookMoveConflict('Archive reservation changed');
          if (payload.fileArchive && cold.revision <= payload.coldRevision) throw new NotebookMoveConflict('Archive projection pending');
          const result = { hotRevision: this.get(user, resource).revision, coldRevision: cold.revision, moved: payload.moved };
          this.db.prepare('INSERT INTO hub_notebook_move_receipts VALUES (?,?,?,?,?)').run(user, resource, id, move.input, JSON.stringify(result));
        }
        this.db.prepare("UPDATE hub_notebook_bound_moves SET payload='' WHERE user_id=? AND resource_id=? AND request_id=?").run(user, resource, id);
      }
      return this.moveReceipt(user, resource, id);
    });
  }
  /** Both revisions and immutable receipt commit together. A bound native file
   * must use its projection coordinator; never delete its hot text locally.
   * Nested authority commands release only a savepoint, never the parent's
   * transaction; standalone callers retain their original immediate commit. */
  move(user: string, resource: string, input: NotebookMove) {
    if (!validNotebookMove(input)) throw new NotebookMoveConflict('Invalid move');
    return observedTransaction(this.db, 'notebook-move-change', () => {
      const canonical = moveInput(input);
      const old = this.db.prepare('SELECT input,result FROM hub_notebook_move_receipts WHERE user_id=? AND resource_id=? AND request_id=?').get(user, resource, input.requestId) as { input: string; result: string } | undefined;
      if (old) {
        if (old.input !== canonical) throw new NotebookMoveConflict('Request ID already used');
        return JSON.parse(old.result) as { hotRevision: number; coldRevision: number; moved: number };
      }
      if (this.fileLocks.managed(user, 'notebook', resource) || this.fileLocks.moving(user, resource)) throw new NotebookMoveConflict('Linked notebook requires coordinated file projection');
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM hub_notebook_move_receipts WHERE user_id=?').get(user) as { n: number };
      if (count.n >= 10_000) throw new NotebookMoveConflict('Receipt capacity reached');
      const hot = this.get(user, resource), cold = this.getArchive(user, resource);
      if (hot.revision !== input.hotRevision || cold.revision !== input.coldRevision) throw new NotebookMoveConflict('Notebook changed');
      const archive = input.direction === 'archive';
      const next = moveNotebookText(archive ? hot.text : cold.text, archive ? cold.text : hot.text, input.ranges, archive ? NOTEBOOK_ARCHIVE_MAX_CHARS : NOTEBOOK_MAX_CHARS);
      const savedHot = this.save(user, { ...hot, text: archive ? next.source : next.destination });
      const savedCold = this.saveArchive(user, { resourceId: resource, revision: cold.revision, text: archive ? next.destination : next.source });
      if (!savedHot || !savedCold) throw new NotebookMoveConflict('Notebook changed');
      const result = { hotRevision: savedHot.revision, coldRevision: savedCold.revision, moved: next.moved };
      this.db.prepare('INSERT INTO hub_notebook_move_receipts VALUES (?,?,?,?,?)').run(user, resource, input.requestId, canonical, JSON.stringify(result));
      return result;
    }, undefined, true);
  }
  search(user: string, resource: string, query: string, includeArchive = false) {
    return this.searchAreas(user, resource, query, includeArchive ? 'both' : 'hot');
  }
  searchAreas(user: string, resource: string, query: string, area: 'hot' | 'cold' | 'both') {
    if (!query.trim() || query.length > 200) throw Error('Invalid search');
    const results: { area: 'hot' | 'cold'; revision: number; start: number; end: number; text: string }[] = [];
    const hot = area !== 'cold' ? this.get(user, resource) : undefined, cold = area !== 'hot' ? this.getArchive(user, resource) : undefined;
    for (const [area, doc] of [['hot', hot], ['cold', cold]] as const) {
      if (!doc) continue;
      let start = 0;
      let bytes = 0;
      let count = 0;
      while (count++ < (hot && cold ? 10 : 20) && (start = doc.text.indexOf(query, start)) !== -1) {
        const row = { area, revision: doc.revision, start, end: start + query.length, text: doc.text.slice(Math.max(0, start - 32), start + query.length + 32) };
        bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
        if (bytes > (hot && cold ? 3750 : 7500)) break;
        results.push(row);
        start += query.length;
      }
    }
    return { hotRevision: hot?.revision ?? null, coldRevision: cold?.revision ?? null, results };
  }
  /** Same owner/resource proof as the hot note; file projection uses the exact
   * archive lock when the full notebook has been delegated. */
  getArchive(userId: string, resourceId: string): SessionNotebook {
    const row = this.db.prepare('SELECT text, revision, updated_at AS updatedAt FROM hub_notebook_archives WHERE user_id = ? AND resource_id = ?')
      .get(userId, resourceId) as Omit<SessionNotebook, 'resourceId'> | undefined;
    return { resourceId, ...(row ?? { text: '', revision: 0, updatedAt: null }) };
  }
  /** Hot projections still include the archive in their aggregate CAS, without
   * reading its text onto the SQL/RPC lane. Absence is revision zero, not a write. */
  archiveRevision(userId: string, resourceId: string): number {
    const row = this.db.prepare('SELECT revision FROM hub_notebook_archives WHERE user_id = ? AND resource_id = ?')
      .get(userId, resourceId) as { revision: number } | undefined;
    return row?.revision ?? 0;
  }
  saveArchive(userId: string, input: { resourceId: string; text: string; revision: number }, bindingId?: string): SessionNotebook | undefined {
    const value = { resourceId: input.resourceId, text: input.text, revision: input.revision };
    if (!validNotebookInput(value, NOTEBOOK_ARCHIVE_MAX_CHARS)) throw new Error('Invalid notebook archive');
    if (!this.fileLocks.allows(userId, 'notebook-archive', input.resourceId, bindingId)
      || !bindingId && this.fileLocks.moving(userId, input.resourceId)) return;
    const result = input.revision === 0
      ? this.db.prepare('INSERT INTO hub_notebook_archives VALUES (?, ?, ?, 1, ?) ON CONFLICT(user_id, resource_id) DO NOTHING')
        .run(userId, input.resourceId, input.text, Date.now())
      : this.db.prepare('UPDATE hub_notebook_archives SET text = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND resource_id = ? AND revision = ?')
        .run(input.text, Date.now(), userId, input.resourceId, input.revision);
    return result.changes === 1 ? this.getArchive(userId, input.resourceId) : undefined;
  }
  get(userId: string, resourceId: string): SessionNotebook {
    const row = this.db.prepare('SELECT text, revision, updated_at AS updatedAt FROM hub_session_notebooks WHERE user_id = ? AND resource_id = ?')
      .get(userId, resourceId) as Omit<SessionNotebook, 'resourceId'> | undefined;
    return { resourceId, ...(row ?? { text: '', revision: 0, updatedAt: null }) };
  }
  listPrefix(userId: string, prefix: string, after = ''): SessionNotebook[] {
    return this.db.prepare('SELECT resource_id AS resourceId, text, revision, updated_at AS updatedAt FROM hub_session_notebooks WHERE user_id = ? AND substr(resource_id, 1, ?) = ? AND resource_id > ? ORDER BY resource_id LIMIT 100')
      .all(userId, prefix.length, prefix, after) as SessionNotebook[];
  }
  save(userId: string, input: SessionNotebook | { resourceId: string; text: string; revision: number }, bindingId?: string): SessionNotebook | undefined {
    const value = { resourceId: input.resourceId, text: input.text, revision: input.revision };
    if (!validNotebookInput(value)) throw new Error('Invalid notebook');
    if (!this.fileLocks.allows(userId, 'notebook', value.resourceId, bindingId,
      { current: this.get(userId, value.resourceId).text, next: value.text })) return;
    const result = value.revision === 0
      ? this.db.prepare('INSERT INTO hub_session_notebooks VALUES (?, ?, ?, 1, ?) ON CONFLICT(user_id, resource_id) DO NOTHING')
        .run(userId, value.resourceId, value.text, Date.now())
      : this.db.prepare('UPDATE hub_session_notebooks SET text = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND resource_id = ? AND revision = ?')
        .run(value.text, Date.now(), userId, value.resourceId, value.revision);
    return result.changes === 1 ? this.get(userId, value.resourceId) : undefined;
  }
}
