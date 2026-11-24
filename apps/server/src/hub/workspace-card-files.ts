import { observedSavepoint } from '../storage/observed-savepoint.js';
import { createHash, randomUUID } from 'node:crypto';
import { WorkspaceNativeFileLocks } from './workspace-native-file-locks.js';
import type { DatabaseSync } from 'node:sqlite';
import { parseWorkspaceFileCardResource, validWorkspaceFileCardWrite, validBoardUuid, workspaceFileCardContent,
  type WorkspaceFileCard, type WorkspaceFileCardWrite } from '@agentopsdeck/shared';
import { cardFileCodec, parseCardFile, serializeCardFile } from '../connector/workspace-file-card-format.js';
import type { WorkspaceFileSnapshot } from '../connector/workspace-file-codec.js';
import { ChangeSignal } from '../utils/change-signal.js';
import type { FileBoardBinding, FileBoardIntent, FileBoardApplyResult } from './workspace-board-files.js';

/** All methods are synchronous and use the SAME Hub database transaction.
 * Implementations must fence ordinary native saves while a binding is claimed.
 * This is not a second JSON document store: get/import address the native card. */
export interface WorkspaceCardFileProjection {
  get(user: string, resource: string): (WorkspaceFileCard & { revision: number }) | undefined;
  claim(user: string, resource: string, bindingId: string): boolean;
  release(user: string, resource: string, bindingId: string): void;
  importFile(user: string, resource: string, bindingId: string, input: WorkspaceFileCardWrite): 'saved' | 'conflict' | 'limit';
  archiveUpgrade?(user: string, resource: string, bindingId: string, apply: boolean): (WorkspaceFileCard & { revision: number }) | undefined;
  cancelArchiveUpgrade?(user: string, resource: string, bindingId: string): void;
}
const columns = `binding_id AS bindingId, user_id AS userId, resource_id AS resourceId,
  session_id AS sessionId, connection_id AS connectionId, authority, state,
  source_hash AS sourceHash, problem, created_at AS createdAt`;
type Receipt = { mutationId: string; expectedHash: string; state: 'saved' | 'conflict' | 'uncertain'; fingerprint: string };
export class ArchiveUpgradeConflict extends Error {}

/** Durable opt-in delegation; filenames and native ownership are never supplied
 * by Agent content. Prepared bindings lock the native editor until inspected or
 * explicitly revoked; unknown writes never authorize a retry. */
export class WorkspaceCardFiles {
  readonly changes = new ChangeSignal();
  private readonly moveLocks: WorkspaceNativeFileLocks;
  constructor(private readonly db: DatabaseSync, readonly projection: WorkspaceCardFileProjection,
    private readonly authorized: (binding: FileBoardIntent) => boolean) {
    this.moveLocks = new WorkspaceNativeFileLocks(db);
    db.exec(`CREATE TABLE IF NOT EXISTS hub_workspace_card_file_bindings (
      binding_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, resource_id TEXT NOT NULL,
      session_id TEXT NOT NULL, connection_id TEXT NOT NULL, authority INTEGER NOT NULL,
      state TEXT NOT NULL, source_hash TEXT, problem TEXT, created_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS hub_workspace_card_file_current
        ON hub_workspace_card_file_bindings(user_id,resource_id) WHERE state != 'revoked';
      CREATE TABLE IF NOT EXISTS hub_workspace_card_file_versions (
        user_id TEXT NOT NULL, resource_id TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(user_id,resource_id));
      CREATE TABLE IF NOT EXISTS hub_workspace_card_file_cancellations (
        binding_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, resource_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS hub_workspace_card_file_writes (
        user_id TEXT NOT NULL, binding_id TEXT NOT NULL, mutation_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, expected_hash TEXT NOT NULL, state TEXT NOT NULL,
        PRIMARY KEY(user_id,binding_id,mutation_id));
      CREATE TABLE IF NOT EXISTS hub_workspace_card_file_archive_upgrades (
        user_id TEXT NOT NULL, binding_id TEXT NOT NULL, mutation_id TEXT NOT NULL,
        input TEXT NOT NULL, PRIMARY KEY(user_id,binding_id));`);
  }
  private atomic<T>(fn: () => T extends PromiseLike<unknown> ? never : T): T {
    return observedSavepoint(this.db, 'workspace-card-file-change', fn);
  }
  private changed(row: Pick<FileBoardBinding, 'userId' | 'resourceId'>) {
    this.db.prepare(`INSERT INTO hub_workspace_card_file_versions VALUES (?, ?, 1)
      ON CONFLICT(user_id,resource_id) DO UPDATE SET revision=revision+1`).run(row.userId, row.resourceId);
    this.changes.notify();
  }
  revisions(user: string) {
    return this.db.prepare('SELECT resource_id AS resourceId, revision FROM hub_workspace_card_file_versions WHERE user_id=? ORDER BY resource_id')
      .all(user) as { resourceId: string; revision: number }[];
  }
  get(user: string, id: string): FileBoardBinding | undefined {
    return this.db.prepare(`SELECT ${columns} FROM hub_workspace_card_file_bindings WHERE user_id=? AND binding_id=?`).get(user, id) as FileBoardBinding | undefined;
  }
  current(user: string, resource: string): FileBoardBinding | undefined {
    return this.db.prepare(`SELECT ${columns} FROM hub_workspace_card_file_bindings WHERE user_id=? AND resource_id=? AND state!='revoked'`).get(user, resource) as FileBoardBinding | undefined;
  }
  active() { return this.db.prepare(`SELECT ${columns} FROM hub_workspace_card_file_bindings WHERE state='active' ORDER BY created_at`).all() as FileBoardBinding[]; }
  cancelAbsent(user: string, resource: string, id: string): boolean {
    if (!validBoardUuid(id) || !parseWorkspaceFileCardResource(resource) || !user || user.length > 160) return false;
    return this.atomic(() => {
      if (this.db.prepare('SELECT 1 FROM hub_workspace_card_file_bindings WHERE binding_id=?').get(id)) return false;
      const existing = this.db.prepare('SELECT user_id AS userId, resource_id AS resourceId FROM hub_workspace_card_file_cancellations WHERE binding_id=?')
        .get(id) as { userId: string; resourceId: string } | undefined;
      if (existing) return existing.userId === user && existing.resourceId === resource;
      if ((this.db.prepare('SELECT COUNT(*) AS n FROM hub_workspace_card_file_cancellations WHERE user_id=?').get(user) as { n: number }).n >= 256) return false;
      this.db.prepare('INSERT INTO hub_workspace_card_file_cancellations VALUES (?,?,?)').run(id, user, resource); return true;
    });
  }
  prepare(intent: FileBoardIntent, revision: number): FileBoardBinding | undefined {
    const ref = parseWorkspaceFileCardResource(intent.resourceId);
    if (!ref || !validBoardUuid(intent.bindingId) || !intent.userId || intent.userId.length > 160
      || !intent.sessionId || intent.sessionId.length > 1024 || !intent.connectionId || intent.connectionId.length > 160
      || !Number.isSafeInteger(intent.authority) || intent.authority < 0 || !Number.isSafeInteger(revision) || revision < 0) return;
    return this.atomic(() => {
      if (!this.authorized(intent) || this.db.prepare('SELECT 1 FROM hub_workspace_card_file_cancellations WHERE binding_id=?').get(intent.bindingId)) return;
      const existing = this.get(intent.userId, intent.bindingId);
      if (existing) return existing.resourceId === intent.resourceId && existing.sessionId === intent.sessionId
        && existing.connectionId === intent.connectionId && existing.authority === intent.authority ? existing : undefined;
      if (this.db.prepare('SELECT 1 FROM hub_workspace_card_file_bindings WHERE binding_id=?').get(intent.bindingId) || this.current(intent.userId, intent.resourceId)) return;
      const document = this.projection.get(intent.userId, intent.resourceId);
      if (!document || document.kind !== ref.kind || document.revision !== revision) return;
      if ((this.db.prepare('SELECT COUNT(*) AS n FROM hub_workspace_card_file_bindings WHERE user_id=?').get(intent.userId) as { n: number }).n >= 256
        || (this.db.prepare("SELECT COUNT(*) AS n FROM hub_workspace_card_file_bindings WHERE state!='revoked'").get() as { n: number }).n >= 64) return;
      if (!this.projection.claim(intent.userId, intent.resourceId, intent.bindingId)) return;
      this.db.prepare('INSERT INTO hub_workspace_card_file_bindings VALUES (?,?,?,?,?,?,?,NULL,NULL,?)')
        .run(intent.bindingId, intent.userId, intent.resourceId, intent.sessionId, intent.connectionId, intent.authority, 'prepared', Date.now());
      this.changed(intent); return this.get(intent.userId, intent.bindingId);
    });
  }
  activate(user: string, id: string): boolean {
    return this.atomic(() => {
      const row = this.get(user, id);
      if (!row || row.state === 'revoked' || !this.authorized(row)) return false;
      if (row.state !== 'active') {
        this.db.prepare("UPDATE hub_workspace_card_file_bindings SET state='active' WHERE binding_id=?").run(id); this.changed(row);
      }
      return true;
    });
  }
  revoke(user: string, id: string): boolean {
    return this.atomic(() => {
      const row = this.get(user, id); if (!row) return false;
      if (row.state !== 'revoked') {
        this.db.prepare("UPDATE hub_workspace_card_file_bindings SET state='revoked' WHERE binding_id=?").run(id);
        this.projection.release(user, row.resourceId, id); this.changed(row);
      }
      return true;
    });
  }
  apply(user: string, id: string, snapshot: WorkspaceFileSnapshot<WorkspaceFileCard>): FileBoardApplyResult {
    return this.atomic(() => {
      const row = this.get(user, id);
      if (!row || row.state !== 'active' || !this.authorized(row)) return 'denied';
      if (!snapshot || !['ready', 'missing', 'invalid', 'too-large', 'unsafe', 'unavailable'].includes(snapshot.state)) return 'invalid';
      if (snapshot.state !== 'ready') {
        if (row.problem !== snapshot.state) this.changed(row);
        this.db.prepare('UPDATE hub_workspace_card_file_bindings SET problem=? WHERE binding_id=?').run(snapshot.state, id); return 'retained';
      }
      const ref = parseWorkspaceFileCardResource(row.resourceId)!;
      let parsed: ReturnType<typeof parseCardFile>;
      try { parsed = cardFileCodec(ref.kind).parse(Buffer.from(serializeCardFile(snapshot.value.content))); } catch { return 'invalid'; }
      if (!parsed || parsed.hash !== snapshot.value.hash) return 'invalid';
      if (parsed.hash === row.sourceHash) {
        if (row.problem) { this.db.prepare('UPDATE hub_workspace_card_file_bindings SET problem=NULL WHERE binding_id=?').run(id); this.changed(row); }
        return 'unchanged';
      }
      const document = this.projection.get(user, row.resourceId);
      if (!document || document.kind !== ref.kind) return 'denied';
      // A legacy Agent that rewrites only title/text must not clear an archive
      // or silently change the delegated scope. Keep the last valid projection.
      if (document.kind === 'notebook' && parsed.content.kind === 'notebook'
        && (document.content.archive !== undefined) !== (parsed.content.content.archive !== undefined)) {
        this.db.prepare("UPDATE hub_workspace_card_file_bindings SET problem='invalid' WHERE binding_id=?").run(id);
        this.changed(row); return 'retained';
      }
      const current = parseCardFile(Buffer.from(serializeCardFile(workspaceFileCardContent(document))))!;
      if (current.hash !== parsed.hash) {
        const result = this.projection.importFile(user, row.resourceId, id, { ...parsed.content, revision: document.revision, mutationId: randomUUID() });
        if (result === 'limit') return 'limit';
        if (result !== 'saved') throw new Error('Card file projection conflict');
      }
      this.db.prepare('UPDATE hub_workspace_card_file_bindings SET source_hash=?, problem=NULL WHERE binding_id=?').run(parsed.hash, id);
      this.changed(row); return current.hash === parsed.hash ? 'unchanged' : 'updated';
    });
  }
  writeReceipt(user: string, id: string, mutation: string): Receipt | undefined {
    const binding = this.get(user, id); if (!binding || !this.authorized(binding)) return;
    return this.db.prepare(`SELECT mutation_id AS mutationId, expected_hash AS expectedHash, state, fingerprint
      FROM hub_workspace_card_file_writes WHERE user_id=? AND binding_id=? AND mutation_id=?`).get(user, id, mutation) as Receipt | undefined;
  }
  archiveUpgradePlan(user: string, id: string, mutationId: string, revision: number): WorkspaceFileCardWrite | undefined {
    const binding = this.get(user, id);
    if (!binding || binding.state !== 'active' || !this.authorized(binding) || !validBoardUuid(mutationId)) return;
    const old = this.db.prepare('SELECT mutation_id AS mutationId,input FROM hub_workspace_card_file_archive_upgrades WHERE user_id=? AND binding_id=?')
      .get(user, id) as { mutationId: string; input: string } | undefined;
    if (old) {
      const input = JSON.parse(old.input) as WorkspaceFileCardWrite;
      if (old.mutationId === mutationId) return input.revision === revision + 1 ? input : undefined;
      // A confirmed file CAS conflict can be followed by a fresh, separately
      // consented upgrade. Unknown or successful intents can never be replaced.
      if (this.writeReceipt(user, id, old.mutationId)?.state !== 'conflict') return;
    }
    const current = this.projection.get(user, binding.resourceId);
    if (!current || current.revision !== revision || current.kind !== 'notebook' || current.content.archive !== undefined) return;
    const document = this.projection.archiveUpgrade?.(user, binding.resourceId, id, false);
    return document ? { ...document, mutationId } : undefined;
  }
  admitArchiveUpgrade<T>(user: string, id: string, input: WorkspaceFileCardWrite, prepare: () => T extends PromiseLike<unknown> ? never : T): T {
    return this.atomic<T>(() => {
      const binding = this.get(user, id);
      if (!binding || binding.state !== 'active' || !this.authorized(binding) || binding.problem
        || this.db.prepare("SELECT 1 FROM hub_workspace_card_file_writes WHERE user_id=? AND binding_id=? AND state='uncertain'").get(user, id)
        || !this.moveLocks.permitsWrite(user, id, input.mutationId)) throw new ArchiveUpgradeConflict('Archive upgrade unavailable');
      const plan = this.archiveUpgradePlan(user, id, input.mutationId, input.revision - 1);
      if (!plan || JSON.stringify(plan) !== JSON.stringify(input)) throw new ArchiveUpgradeConflict('Archive changed before delegation');
      const next = this.projection.archiveUpgrade?.(user, binding.resourceId, id, true);
      if (!next || next.revision !== input.revision) throw new ArchiveUpgradeConflict('Archive destination conflict');
      this.db.prepare(`INSERT INTO hub_workspace_card_file_archive_upgrades VALUES (?,?,?,?)
        ON CONFLICT(user_id,binding_id) DO UPDATE SET mutation_id=excluded.mutation_id,input=excluded.input`)
        .run(user, id, input.mutationId, JSON.stringify(input));
      const result = observedSavepoint(this.db, 'archive-upgrade-prepare', prepare);
      if (!result || !(result as { fresh?: boolean }).fresh) throw new ArchiveUpgradeConflict('Archive upgrade intent conflict');
      // The nested boundary rejects escaped async work before inspecting fresh.
      return result as T extends PromiseLike<unknown> ? never : T;
    });
  }
  prepareWrite(user: string, id: string, input: WorkspaceFileCardWrite) {
    if (!validWorkspaceFileCardWrite(input)) return;
    const binding = this.get(user, id);
    if (!binding || binding.state !== 'active' || !this.authorized(binding) || parseWorkspaceFileCardResource(binding.resourceId)?.kind !== input.kind) return;
    const fingerprint = createHash('sha256').update(JSON.stringify([input.revision, serializeCardFile(workspaceFileCardContent(input))])).digest('hex');
    const existing = this.writeReceipt(user, id, input.mutationId);
    if (existing) return existing.fingerprint === fingerprint ? { ...existing, fresh: false } : undefined;
    if (!this.moveLocks.permitsWrite(user, id, input.mutationId)) return;
    const document = this.projection.get(user, binding.resourceId);
    if (document?.kind === 'notebook' && input.kind === 'notebook'
      && (document.content.archive !== undefined) !== (input.content.archive !== undefined)) return;
    let baseline = document && workspaceFileCardContent(document);
    if (baseline?.kind === 'notebook' && this.db.prepare('SELECT 1 FROM hub_workspace_card_file_archive_upgrades WHERE user_id=? AND binding_id=? AND mutation_id=?')
      .get(user, id, input.mutationId)) baseline = { kind: 'notebook', content: { title: baseline.content.title, text: baseline.content.text } };
    if (!document || document.revision !== input.revision || binding.problem || !binding.sourceHash || !baseline
      || parseCardFile(Buffer.from(serializeCardFile(baseline)))?.hash !== binding.sourceHash) return;
    if ((this.db.prepare('SELECT COUNT(*) AS n FROM hub_workspace_card_file_writes WHERE user_id=? AND binding_id=?').get(user, id) as { n: number }).n >= 1024) return;
    this.db.prepare('INSERT INTO hub_workspace_card_file_writes VALUES (?,?,?,?,?,?)').run(user, id, input.mutationId, fingerprint, binding.sourceHash, 'uncertain');
    return { mutationId: input.mutationId, expectedHash: binding.sourceHash, state: 'uncertain' as const, fingerprint, fresh: true };
  }
  finishWrite(user: string, id: string, mutation: string, state: Receipt['state']) {
    const binding = this.get(user, id); if (!binding || !this.authorized(binding)) return;
    this.atomic(() => {
      this.db.prepare('UPDATE hub_workspace_card_file_writes SET state=? WHERE user_id=? AND binding_id=? AND mutation_id=?').run(state, user, id, mutation);
      if (state === 'conflict' && this.db.prepare('SELECT 1 FROM hub_workspace_card_file_archive_upgrades WHERE user_id=? AND binding_id=? AND mutation_id=?').get(user, id, mutation)) {
        this.projection.cancelArchiveUpgrade?.(user, binding.resourceId, id);
        this.changed(binding);
      }
    });
  }
}
