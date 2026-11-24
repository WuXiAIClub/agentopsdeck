import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { validBoardUuid } from '@agentopsdeck/shared';
import { observedSavepoint } from '../storage/observed-savepoint.js';
import type { WorkspaceFileCodec } from './workspace-file-codec.js';
import type { FileWriteOutcome } from './workspace-file-write.js';

export type WorkspaceFileBinding = {
  id: string; owner: string; sessionKey: string; fingerprint: string; state: 'prepared' | 'installed' | 'revoked';
};
export type WorkspaceInstallIntent<T> = { id: string; sessionKey: string; content: T };
export type WorkspaceWriteIntent<T> = { mutationId: string; expectedHash: string; content: T };
export class FileBoardError extends Error {
  constructor(readonly status: 403 | 404 | 409 | 429 | 503) { super('File panel unavailable'); }
}
const validKey = (key: unknown): key is string => typeof key === 'string' && /^(codex|hermes|claude-code|ghcp):[^\s\u0000-\u001f]{1,512}$/.test(key);
const validOwner = (owner: string) => /^[A-Za-z0-9:_-]{1,160}$/.test(owner);
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const retentionLimit = 64 * 1024 * 1024;
type Installation = { existing: true; row: WorkspaceFileBinding } | { existing: false; text: string; fingerprint: string };
type WriteAdmission = { existing: true; receipt: { mutationId: string; state: FileWriteOutcome } }
  | { existing: false; text: string; fingerprint: string; reservedBytes: number };

/** The original metadata authority, with no filesystem effects or subscriptions.
 * Preparation and final admission are synchronous transactions on the same owner.
 * Inspection never grants a later effect; the caller must reserve again after I/O.
 */
export class WorkspaceFileMetadata<T> {
  private closed = false;
  private readonly bindingsTable: string;
  private readonly writesTable: string;
  constructor(private readonly db: DatabaseSync,
    private readonly authorized: (owner: string, sessionKey: string) => boolean,
    readonly codec: WorkspaceFileCodec<T>) {
    this.bindingsTable = codec.name === 'tasks.json' ? 'connector_workspace_board_files' : 'connector_workspace_card_files';
    this.writesTable = codec.name === 'tasks.json' ? 'connector_workspace_file_writes' : 'connector_workspace_card_file_writes';
    db.exec(`CREATE TABLE IF NOT EXISTS ${this.bindingsTable} (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, session_key TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ${this.bindingsTable}_session ON ${this.bindingsTable}(owner, session_key);
      CREATE TABLE IF NOT EXISTS ${this.writesTable} (
      binding_id TEXT NOT NULL, mutation_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      state TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(binding_id, mutation_id));`);
    if (codec.bindingType) db.exec('CREATE TABLE IF NOT EXISTS connector_workspace_card_file_kinds (binding_id TEXT PRIMARY KEY, kind TEXT NOT NULL);');
  }
  guard(owner: string, sessionKey: string): void {
    if (this.closed || !validOwner(owner) || !validKey(sessionKey) || !this.authorized(owner, sessionKey)) throw new FileBoardError(403);
  }
  private row(id: string): WorkspaceFileBinding | undefined {
    return this.db.prepare(`SELECT id, owner, session_key AS sessionKey, fingerprint, state FROM ${this.bindingsTable} WHERE id = ?`).get(id) as WorkspaceFileBinding | undefined;
  }
  owned(owner: string, id: string): WorkspaceFileBinding {
    if (!validBoardUuid(id)) throw new FileBoardError(404);
    const row = this.row(id);
    if (!row || row.owner !== owner) throw new FileBoardError(404);
    if (this.closed) throw new FileBoardError(503);
    if (row.state !== 'revoked') this.guard(owner, row.sessionKey);
    return row;
  }
  boundCodec(id: string): WorkspaceFileCodec<T> {
    if (!this.codec.bound) return this.codec;
    return this.codec.bound(this.boundKind(id)!);
  }
  boundKind(id: string): string | null {
    if (!this.codec.bound) return null;
    const row = this.db.prepare('SELECT kind FROM connector_workspace_card_file_kinds WHERE binding_id = ?').get(id) as { kind: string } | undefined;
    if (!row) throw new FileBoardError(409);
    return row.kind;
  }
  private checkBindingQuota(owner: string): void {
    let owned = 0, active = 0;
    for (const table of ['connector_workspace_board_files', 'connector_workspace_card_files']) {
      if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) continue;
      owned += (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE owner = ?`).get(owner) as { n: number }).n;
      active += (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE state != 'revoked'`).get() as { n: number }).n;
    }
    if (owned >= 256 || active >= 64) throw new FileBoardError(429);
  }
  installation(owner: string, input: WorkspaceInstallIntent<T>, reserve = false): Installation {
    const inspect = (): Installation => {
      this.guard(owner, input.sessionKey);
      if (!validBoardUuid(input.id) || !this.codec.valid(input.content)) throw new FileBoardError(409);
      const text = this.codec.serialize(input.content), hash = fingerprint([owner, input.sessionKey, text]);
      const existing = this.row(input.id);
      if (existing) {
        if (existing.owner === owner && existing.sessionKey === input.sessionKey && existing.state === 'revoked' && !existing.fingerprint) return { existing: true, row: existing };
        if (existing.owner !== owner || existing.fingerprint !== hash) throw new FileBoardError(409);
        return { existing: true, row: existing };
      }
      this.checkBindingQuota(owner);
      if (reserve) {
        this.db.prepare(`INSERT INTO ${this.bindingsTable} VALUES (?, ?, ?, ?, ?)`).run(input.id, owner, input.sessionKey, hash, 'prepared');
        if (this.codec.bindingType) this.db.prepare('INSERT INTO connector_workspace_card_file_kinds VALUES (?, ?)').run(input.id, this.codec.bindingType(input.content));
      }
      return { existing: false, text, fingerprint: hash };
    };
    return reserve ? observedSavepoint(this.db, 'workspace-file-prepare', inspect) : inspect();
  }
  installed(owner: string, id: string, hash: string): void {
    const row = this.owned(owner, id);
    if (row.fingerprint !== hash || row.state !== 'prepared') throw new FileBoardError(409);
    this.db.prepare(`UPDATE ${this.bindingsTable} SET state = 'installed' WHERE id = ? AND state = 'prepared'`).run(id);
  }
  receipt(owner: string, id: string, mutationId: string): { mutationId: string; state: FileWriteOutcome } {
    this.owned(owner, id);
    if (!validBoardUuid(mutationId)) throw new FileBoardError(404);
    const row = this.db.prepare(`SELECT state FROM ${this.writesTable} WHERE binding_id = ? AND mutation_id = ?`).get(id, mutationId) as { state: FileWriteOutcome } | undefined;
    if (!row) throw new FileBoardError(404);
    return { mutationId, state: row.state };
  }
  writeIntent(owner: string, id: string, input: WorkspaceWriteIntent<T>, retainedBytes?: number): WriteAdmission {
    const inspect = (): WriteAdmission => {
      const row = this.owned(owner, id), codec = this.boundCodec(id);
      if (row.state !== 'installed' || !validBoardUuid(input.mutationId) || !/^[a-f0-9]{64}$/.test(input.expectedHash)
        || !codec.valid(input.content)) throw new FileBoardError(409);
      const text = codec.serialize(input.content), hash = fingerprint([input.expectedHash, text]);
      const existing = this.db.prepare(`SELECT fingerprint FROM ${this.writesTable} WHERE binding_id = ? AND mutation_id = ?`).get(id, input.mutationId) as { fingerprint: string } | undefined;
      if (existing) {
        if (existing.fingerprint !== hash) throw new FileBoardError(409);
        return { existing: true, receipt: this.receipt(owner, id, input.mutationId) };
      }
      const count = (this.db.prepare(`SELECT COUNT(*) AS n FROM ${this.writesTable} WHERE binding_id = ?`).get(id) as { n: number }).n;
      const reservedBytes = this.codec.maxBytes + Buffer.byteLength(text);
      if (count >= 1024) throw new FileBoardError(429);
      if (retainedBytes !== undefined) {
        if (!Number.isSafeInteger(retainedBytes) || retainedBytes < 0 || retainedBytes + reservedBytes > retentionLimit) throw new FileBoardError(429);
        this.db.prepare(`INSERT INTO ${this.writesTable} VALUES (?, ?, ?, ?, ?)`).run(id, input.mutationId, hash, 'uncertain', reservedBytes);
      }
      return { existing: false, text, fingerprint: hash, reservedBytes };
    };
    return retainedBytes === undefined ? inspect() : observedSavepoint(this.db, 'workspace-file-write-prepare', inspect);
  }
  settleWrite(owner: string, id: string, mutationId: string, hash: string, state: FileWriteOutcome): void {
    // Settlement records the original effect even after revocation; it is not a
    // new execution permission. Bind it to the exact durable intent, not a key.
    const binding = this.row(id);
    const row = this.db.prepare(`SELECT fingerprint, state FROM ${this.writesTable} WHERE binding_id = ? AND mutation_id = ?`).get(id, mutationId) as { fingerprint: string; state: FileWriteOutcome } | undefined;
    if (!binding || binding.owner !== owner || !row || row.fingerprint !== hash
      || !['saved', 'conflict', 'uncertain'].includes(state) || row.state !== 'uncertain' && row.state !== state) throw new FileBoardError(409);
    this.db.prepare(`UPDATE ${this.writesTable} SET state = ? WHERE binding_id = ? AND mutation_id = ? AND state = 'uncertain'`).run(state, id, mutationId);
  }
  revoke(owner: string, id: string, sessionKey?: string): WorkspaceFileBinding {
    if (this.closed) throw new FileBoardError(503);
    if (!validOwner(owner) || !validBoardUuid(id)) throw new FileBoardError(404);
    return observedSavepoint(this.db, 'workspace-file-revoke', () => {
      let row = this.row(id);
      if (!row && sessionKey) {
        this.guard(owner, sessionKey);
        if ((this.db.prepare(`SELECT COUNT(*) AS n FROM ${this.bindingsTable} WHERE owner = ?`).get(owner) as { n: number }).n >= 256) throw new FileBoardError(429);
        this.db.prepare(`INSERT INTO ${this.bindingsTable} VALUES (?, ?, ?, ?, ?)`).run(id, owner, sessionKey, '', 'revoked');
        row = this.row(id);
      }
      if (!row || row.owner !== owner || sessionKey !== undefined && row.sessionKey !== sessionKey) throw new FileBoardError(404);
      this.db.prepare(`UPDATE ${this.bindingsTable} SET state = 'revoked' WHERE id = ?`).run(id);
      return { ...row, state: 'revoked' };
    });
  }
  reconcile(): string[] {
    if (this.closed) throw new FileBoardError(503);
    return observedSavepoint(this.db, 'workspace-file-reconcile', () => {
      const rows = this.db.prepare(`SELECT id, owner, session_key AS sessionKey, fingerprint, state FROM ${this.bindingsTable} WHERE state != 'revoked'`).all() as WorkspaceFileBinding[];
      const revoked: string[] = [];
      for (const row of rows) {
        if (this.authorized(row.owner, row.sessionKey)) continue;
        this.db.prepare(`UPDATE ${this.bindingsTable} SET state = 'revoked' WHERE id = ?`).run(row.id);
        revoked.push(row.id);
      }
      return revoked;
    });
  }
  filesForSession(owner: string, sessionKey: string): WorkspaceFileBinding[] {
    this.guard(owner, sessionKey);
    return this.db.prepare(`SELECT id, owner, session_key AS sessionKey, fingerprint, state FROM ${this.bindingsTable} WHERE owner = ? AND session_key = ? AND state = 'installed' ORDER BY id`).all(owner, sessionKey) as WorkspaceFileBinding[];
  }
  close(): void { this.closed = true; }
}
