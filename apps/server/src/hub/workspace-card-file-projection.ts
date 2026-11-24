import { observedSavepoint } from '../storage/observed-savepoint.js';
import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_HUB_NOTEBOOK_LAYOUT, validHubNotebookLayout, parseWorkspaceFileCardResource, validBoardId, validBoardUuid,
  validWorkspaceFileCardWrite, workspaceFileCardContent, drawingContent, nativeDrawioContent,
  type WorkspaceFileCard, type WorkspaceFileCardWrite } from '@agentopsdeck/shared';
import type { WorkspaceCardFileProjection } from './workspace-card-files.js';
import type { WorkspaceBoards } from './workspace-boards.js';
import type { WorkspaceCards } from './workspace-cards.js';
import type { WorkspaceDrawings } from './workspace-drawings.js';
import type { WorkspaceNativeDrawio } from './workspace-native-drawio.js';
import type { SessionNotebooks } from './session-notebooks.js';
import type { WorkspaceCardConfigurations } from './workspace-card-configurations.js';
import { WorkspaceNativeFileLocks, type NativeFileResource } from './workspace-native-file-locks.js';

export type FileNotebookRef = { textId: string; layoutId: string; fallbackTitle: string };
export type NativeFileProjectionDependencies = {
  boards: WorkspaceBoards; cards: WorkspaceCards; drawings: WorkspaceDrawings;
  nativeDrawio: WorkspaceNativeDrawio; notebooks: SessionNotebooks; configurations: WorkspaceCardConfigurations;
  /** Resolve Hub session IDs through current ownership. Never accept a raw DB
   * notebook key from an HTTP request or an Agent file. Called on every access. */
  sessionNotebook: (user: string, sessionId: string) => FileNotebookRef | undefined;
};

export class NativeWorkspaceCardFileProjection implements WorkspaceCardFileProjection {
  private readonly locks: WorkspaceNativeFileLocks;
  constructor(private readonly db: DatabaseSync, private readonly stores: NativeFileProjectionDependencies) {
    this.locks = new WorkspaceNativeFileLocks(db);
    db.exec(`CREATE TABLE IF NOT EXISTS hub_workspace_reports (user_id TEXT NOT NULL, resource_id TEXT NOT NULL,
      revision INTEGER NOT NULL, PRIMARY KEY(user_id,resource_id));
      CREATE TABLE IF NOT EXISTS hub_workspace_report_receipts (user_id TEXT NOT NULL, resource_id TEXT NOT NULL,
      mutation_id TEXT NOT NULL, fingerprint TEXT NOT NULL, revision INTEGER NOT NULL,
      PRIMARY KEY(user_id,resource_id,mutation_id));`);
  }
  revisions(user: string) {
    return this.db.prepare('SELECT resource_id AS resourceId,revision FROM hub_workspace_reports WHERE user_id=? ORDER BY resource_id')
      .all(user) as { resourceId: string; revision: number }[];
  }
  /** Reports reuse private notebook content, with atomic title/text and durable
   * local mutation receipts. File-bound reports must use the file writer. */
  saveReport(user: string, id: string, input: WorkspaceFileCardWrite): 'saved' | 'conflict' | 'limit' {
    if (input.kind !== 'report' || !validBoardUuid(id) || !validWorkspaceFileCardWrite(input)) return 'conflict';
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    return observedSavepoint(this.db, 'workspace-report-change', () => {
      const old = this.db.prepare('SELECT fingerprint FROM hub_workspace_report_receipts WHERE user_id=? AND resource_id=? AND mutation_id=?')
        .get(user, id, input.mutationId) as { fingerprint: string } | undefined;
      let result: 'saved' | 'conflict' | 'limit';
      if (old) result = old.fingerprint === fingerprint ? 'saved' : 'conflict';
      else {
        result = this.importFile(user, JSON.stringify(['report', id]), '', input);
        if (result === 'saved') {
          const revision = this.get(user, JSON.stringify(['report', id]))!.revision;
          this.db.prepare('INSERT INTO hub_workspace_report_receipts VALUES (?,?,?,?,?)').run(user, id, input.mutationId, fingerprint, revision);
          this.db.prepare(`DELETE FROM hub_workspace_report_receipts WHERE user_id=? AND resource_id=? AND mutation_id NOT IN
            (SELECT mutation_id FROM hub_workspace_report_receipts WHERE user_id=? AND resource_id=? ORDER BY rowid DESC LIMIT 8)`).run(user, id, user, id);
        }
      }
      return result;
    });
  }
  private note(user: string, kind: string, id: string): FileNotebookRef | undefined {
    if (kind === 'report') return validBoardUuid(id) ? {
      textId: JSON.stringify(['workspace-report', 1, id]), layoutId: JSON.stringify(['workspace-report-layout', 1, id]), fallbackTitle: 'Report',
    } : undefined;
    if (id.startsWith('session:')) return this.stores.sessionNotebook(user, id.slice(8));
    if (!id.startsWith('hub:') || !validBoardId(id.slice(4))) return;
    const key = id.slice(4);
    return { textId: JSON.stringify(key === 'default' ? ['hub-notebook', 1] : ['hub-notebook', 1, key]),
      layoutId: JSON.stringify(['hub-notebook-layout', 1, key]), fallbackTitle: 'Notebook' };
  }
  /** Original owner-only resolver for compound notebook transactions. The
   * caller must compare submitted CAS resources to these original keys. */
  notebookRef(user: string, resource: string): FileNotebookRef | undefined {
    const ref = parseWorkspaceFileCardResource(resource);
    return ref?.kind === 'notebook' ? this.note(user, ref.kind, ref.id) : undefined;
  }
  private noteLayout(user: string, ref: FileNotebookRef) {
    const document = this.stores.notebooks.get(user, ref.layoutId);
    if (!document.revision) return { document, content: { ...DEFAULT_HUB_NOTEBOOK_LAYOUT } };
    try { const content: unknown = JSON.parse(document.text); return validHubNotebookLayout(content) ? { document, content } : undefined; }
    catch { return; }
  }
  get(user: string, resource: string, view?: 'hot'): (WorkspaceFileCard & { revision: number }) | undefined {
    const ref = parseWorkspaceFileCardResource(resource); if (!ref) return;
    const { kind, id } = ref;
    if (kind === 'notebook' || kind === 'report') {
      const note = this.note(user, kind, id); if (!note) return;
      const text = this.stores.notebooks.get(user, note.textId), layout = this.noteLayout(user, note); if (!layout) return;
      if (kind === 'notebook' && view !== 'hot' && this.locks.managed(user, 'notebook-archive', note.textId)) {
        const archive = this.stores.notebooks.getArchive(user, note.textId);
        return { kind, content: { title: layout.content.title || note.fallbackTitle, text: text.text, archive: archive.text },
          revision: text.revision + layout.document.revision + archive.revision };
      }
      return { kind, content: { title: layout.content.title || note.fallbackTitle, text: text.text }, revision: text.revision + layout.document.revision
        + (kind === 'notebook' ? this.stores.notebooks.archiveRevision(user, note.textId) : 0) };
    }
    if (kind === 'taskboard' || kind === 'statuscard') {
      if (!validBoardId(id)) return;
      const { title, tasks, revision } = this.stores.boards.get(user, id); return { kind, content: { title, tasks }, revision };
    }
    if (kind === 'drawing' || kind === 'native-drawio' ? !validBoardId(id) : !validBoardUuid(id)) return;
    switch (kind) {
      case 'metric-card': {
        const document = this.stores.cards.get(user, id); if (!document) return;
        const { title, value, detail, tone, progress, revision } = document; return { kind, content: { title, value, detail, tone, progress }, revision };
      }
      case 'drawing': { const document = this.stores.drawings.get(user, id); return { kind, content: drawingContent(document), revision: document.revision }; }
      case 'native-drawio': { const document = this.stores.nativeDrawio.get(user, id); return { kind, content: nativeDrawioContent(document), revision: document.revision }; }
      default: {
        const document = this.stores.configurations.get(user, kind, id);
        return document ? { ...workspaceFileCardContent(document), revision: document.revision } : undefined;
      }
    }
  }
  claim(user: string, resource: string, binding: string, includeArchive = true): boolean {
    const ref = parseWorkspaceFileCardResource(resource); if (!ref || !this.get(user, resource)) return false;
    const { kind, id } = ref;
    let resources: NativeFileResource[];
    if (kind === 'notebook' || kind === 'report') {
      const note = this.note(user, kind, id); if (!note) return false;
      resources = [{ kind: 'notebook', id: note.textId }, { kind: 'notebook', id: note.layoutId, facet: 'title' }];
      // Existing bindings retain their old scope. Only an explicit NEW whole
      // notebook association delegates its archive; shared-content migration
      // must not quietly expand its separate authority.
      if (kind === 'notebook' && includeArchive) resources.push({ kind: 'notebook-archive', id: note.textId });
    } else {
      if ((kind === 'taskboard' || kind === 'statuscard') && this.stores.boards.fileManaged(user, id)) return false;
      resources = [{ kind: kind === 'statuscard' ? 'taskboard' : kind, id }];
    }
    if (resources.some(r => this.locks.managed(user, r.kind, r.id))) return false;
    this.advanceDestination(user, resource);
    if (kind === 'notebook' && includeArchive) {
      const note = this.note(user, kind, id)!;
      if (!this.stores.notebooks.saveArchive(user, this.stores.notebooks.getArchive(user, note.textId))) throw new Error('Archive destination conflict');
    }
    if (!this.locks.claim(user, binding, resources)) throw new Error('Card destination changed');
    return true;
  }
  archiveUpgrade(user: string, resource: string, binding: string, apply: boolean) {
    const ref = parseWorkspaceFileCardResource(resource), current = this.get(user, resource);
    if (ref?.kind !== 'notebook' || current?.kind !== 'notebook' || current.content.archive !== undefined) return;
    const note = this.note(user, 'notebook', ref.id);
    if (!note || this.locks.binding(user, 'notebook', note.textId) !== binding || this.locks.moving(user, note.textId)) return;
    const archive = this.stores.notebooks.getArchive(user, note.textId);
    const document = { ...current, content: { ...current.content, archive: archive.text }, revision: current.revision + 1 };
    if (apply) {
      if (!this.stores.notebooks.saveArchive(user, archive)
        || !this.locks.claim(user, binding, [{ kind: 'notebook-archive', id: note.textId }])) throw new Error('Archive delegation conflict');
    }
    return document;
  }
  cancelArchiveUpgrade(user: string, resource: string, binding: string) {
    const ref = parseWorkspaceFileCardResource(resource);
    if (ref?.kind !== 'notebook') return;
    const note = this.note(user, 'notebook', ref.id);
    if (!note || this.locks.binding(user, 'notebook-archive', note.textId) !== binding) return;
    this.db.prepare("DELETE FROM hub_workspace_native_file_locks WHERE user_id=? AND kind='notebook-archive' AND resource_id=? AND binding_id=?")
      .run(user, note.textId, binding);
    if (!this.stores.notebooks.saveArchive(user, this.stores.notebooks.getArchive(user, note.textId))) throw new Error('Archive destination conflict');
  }
  /** A v2 migration is owned by the content store's single SQL transaction.
   * Never claim a different connection, reuse a legacy binding or accept stale
   * native content. The normal writers already honor these exact native locks. */
  claimMigration(db: DatabaseSync, user: string, resource: string, epoch: string, expectedRevision: number) {
    if (db !== this.db || !db.isTransaction) throw new Error('Migration requires its owning transaction');
    const current = this.get(user, resource);
    if (!current || current.revision !== expectedRevision) throw new Error('Native revision conflict');
    if (!this.claim(user, resource, `v2:${epoch}`, false)) throw new Error('Native resource already managed');
    return current;
  }
  release(user: string, resource: string, binding: string) {
    // Revocation must remain possible after the session ownership resolver
    // stops exposing a private notebook. Use only the original owner's exact
    // persisted locks; do not resolve another session or return private text.
    const ref = parseWorkspaceFileCardResource(resource);
    const notebookLocks = ref && (ref.kind === 'notebook' || ref.kind === 'report')
      ? this.db.prepare("SELECT resource_id AS id FROM hub_workspace_native_file_locks WHERE user_id=? AND binding_id=? AND kind='notebook'")
        .all(user, binding) as { id: string }[] : undefined;
    const archiveLocks = this.db.prepare("SELECT resource_id AS id FROM hub_workspace_native_file_locks WHERE user_id=? AND binding_id=? AND kind='notebook-archive'")
      .all(user, binding) as { id: string }[];
    this.locks.release(user, binding);
    for (const { id } of archiveLocks) {
      if (!this.stores.notebooks.saveArchive(user, this.stores.notebooks.getArchive(user, id))) throw new Error('Archive destination conflict');
    }
    if (notebookLocks) {
      for (const { id } of notebookLocks) {
        if (!this.stores.notebooks.save(user, this.stores.notebooks.get(user, id))) throw new Error('Notebook destination conflict');
      }
      if (ref?.kind === 'report') {
        const document = this.get(user, resource);
        if (document) this.db.prepare('UPDATE hub_workspace_reports SET revision=? WHERE user_id=? AND resource_id=?').run(document.revision, user, ref.id);
      }
      return;
    }
    this.advanceDestination(user, resource);
  }
  /** Binding/unlink changes where native autosave goes, even if content is
   * identical. Advance native CAS inside the binding transaction so another
   * tab's old private draft cannot silently be written to a newly shared file
   * (or an old file retry become a local save). Never change the actual content. */
  private advanceDestination(user: string, resource: string) {
    const ref = parseWorkspaceFileCardResource(resource), document = this.get(user, resource);
    if (!ref || !document) throw new Error('Card destination unavailable');
    const { id } = ref, mutationId = randomUUID(), revision = document.revision;
    if (document.kind === 'notebook' || document.kind === 'report') {
      const note = this.note(user, document.kind, id)!;
      const layout = this.noteLayout(user, note)!;
      for (const input of [this.stores.notebooks.get(user, note.textId),
        { ...layout.document, text: JSON.stringify(layout.content) }]) {
        if (!this.stores.notebooks.save(user, input)) throw new Error('Notebook destination conflict');
      }
      if (document.kind === 'report') this.db.prepare(`INSERT INTO hub_workspace_reports VALUES (?,?,?)
        ON CONFLICT(user_id,resource_id) DO UPDATE SET revision=excluded.revision`).run(user, id, this.get(user, resource)!.revision);
      return;
    }
    let result: { status: string };
    switch (document.kind) {
      case 'taskboard': case 'statuscard': result = this.stores.boards.save(user, id, { ...document.content, revision, mutationId }); break;
      case 'metric-card': result = this.stores.cards.save(user, id, { ...document.content, revision, mutationId }); break;
      case 'drawing': result = this.stores.drawings.save(user, id, { ...document.content, revision, mutationId }); break;
      case 'native-drawio': result = this.stores.nativeDrawio.save(user, id, { ...document.content, revision, mutationId }); break;
      default: result = this.stores.configurations.save(user, id, { ...workspaceFileCardContent(document), revision, mutationId });
    }
    if (result.status !== 'saved') throw new Error('Card destination conflict');
  }
  importFile(user: string, resource: string, binding: string, input: WorkspaceFileCardWrite): 'saved' | 'conflict' | 'limit' {
    const ref = parseWorkspaceFileCardResource(resource), current = this.get(user, resource);
    if (!ref || !current || !validWorkspaceFileCardWrite(input) || ref.kind !== input.kind || input.revision !== current.revision) return 'conflict';
    const { id } = ref, { revision, mutationId } = input;
    let result: { status: string };
    switch (input.kind) {
      case 'taskboard': case 'statuscard': result = this.stores.boards.importFile(user, id, binding, { ...input.content, revision, mutationId }); break;
      case 'metric-card': result = this.stores.cards.save(user, id, { ...input.content, revision, mutationId }, binding); break;
      case 'drawing': result = this.stores.drawings.save(user, id, { ...input.content, revision, mutationId }, binding); break;
      case 'native-drawio': result = this.stores.nativeDrawio.save(user, id, { ...input.content, revision, mutationId }, binding); break;
      case 'notebook': case 'report': {
        const note = this.note(user, input.kind, id); if (!note) return 'conflict';
        const text = this.stores.notebooks.get(user, note.textId), layout = this.noteLayout(user, note); if (!layout) return 'conflict';
        const archive = input.kind === 'notebook' && input.content.archive !== undefined
          ? this.stores.notebooks.getArchive(user, note.textId) : undefined;
        if (input.kind === 'notebook' && (input.content.archive !== undefined) !== this.locks.managed(user, 'notebook-archive', note.textId)) return 'conflict';
        if (!this.locks.allows(user, 'notebook', note.textId, binding || undefined)
          || !this.locks.allows(user, 'notebook', note.layoutId, binding || undefined, { current: layout.document.text, next: JSON.stringify({ ...layout.content, title: input.content.title }) })) return 'conflict';
        if (input.kind === 'report' && !this.db.prepare('SELECT 1 FROM hub_workspace_reports WHERE user_id=? AND resource_id=?').get(user, id)
          && (this.db.prepare('SELECT COUNT(*) AS n FROM hub_workspace_reports WHERE user_id=?').get(user) as { n: number }).n >= 64) return 'limit';
        // The outer binding transaction rolls BOTH fields back on any failure.
        if (input.content.text !== text.text && !this.stores.notebooks.save(user, { ...text, text: input.content.text }, binding)) throw new Error('Notebook projection conflict');
        if (archive && input.kind === 'notebook' && input.content.archive !== archive.text
          && !this.stores.notebooks.saveArchive(user, { ...archive, text: input.content.archive! }, binding)) throw new Error('Notebook archive projection conflict');
        if (input.content.title !== (layout.content.title || note.fallbackTitle)
          && !this.stores.notebooks.save(user, { ...layout.document, text: JSON.stringify({ ...layout.content, title: input.content.title }) }, binding)) throw new Error('Notebook title projection conflict');
        if (input.kind === 'report') this.db.prepare(`INSERT INTO hub_workspace_reports VALUES (?,?,?)
          ON CONFLICT(user_id,resource_id) DO UPDATE SET revision=excluded.revision`).run(user, id, this.get(user, resource)!.revision);
        return 'saved';
      }
      default: result = this.stores.configurations.save(user, id, { ...workspaceFileCardContent(input), revision, mutationId }, binding);
    }
    return result.status === 'saved' ? 'saved' : result.status === 'limit' ? 'limit' : 'conflict';
  }
}
