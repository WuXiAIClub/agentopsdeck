import { observedSavepoint } from '../storage/observed-savepoint.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { BOARD_STATUSES, validBoardId, validBoardUuid, validBoardWrite, type BoardStatus } from '@agentopsdeck/shared';
import type { WorkspaceBoards } from './workspace-boards.js';
import { selectBoardRead, validBoardAgentRead, type BoardAgentRead, type BoardAgentSnapshot } from './workspace-board-read.js';

export const BOARD_CAPABILITY_PREFIX = 'aod_board_';
export const BOARD_CAPABILITY_TTL_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 90 * BOARD_CAPABILITY_TTL_MS;
type Field = 'status' | 'detail';
export type BoardCapabilityInput = { taskIds: string[]; fields: Field[]; expiresAt: number };
export type BoardCapability = BoardCapabilityInput & { id: string; resourceId: string; createdAt: number; revokedAt: number | null };
type StoredCapability = BoardCapability & { userId: string };
type CapabilityRow = Omit<StoredCapability, 'taskIds' | 'fields'> & { taskIds: string; fields: string };
export type BoardTaskPatch = { id: string; status?: BoardStatus; detail?: string };
export type BoardAgentWrite = { revision: number; mutationId: string; tasks: BoardTaskPatch[] };
export type BoardAgentResult = { status: 'saved'; revision: number; mutationId: string }
  | { status: 'denied' | 'invalid' | 'conflict' | 'mutation-reused' | 'limit' };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const unique = (v: unknown, max: number): v is unknown[] => Array.isArray(v) && v.length > 0 && v.length <= max && new Set(v).size === v.length;
export function validBoardCapabilityInput(v: unknown): v is BoardCapabilityInput {
  return object(v) && Object.keys(v).length === 3 && unique(v.taskIds, 200) && v.taskIds.every(validBoardUuid)
    && unique(v.fields, 2) && v.fields.every(f => f === 'status' || f === 'detail') && Number.isSafeInteger(v.expiresAt);
}
export function validBoardAgentWrite(v: unknown): v is BoardAgentWrite {
  return object(v) && Object.keys(v).length === 3 && validBoardUuid(v.mutationId)
    && Number.isSafeInteger(v.revision) && (v.revision as number) >= 1 && (v.revision as number) < Number.MAX_SAFE_INTEGER
    && Array.isArray(v.tasks) && v.tasks.length > 0 && v.tasks.length <= 200
    && new Set(v.tasks.map(t => object(t) ? t.id : undefined)).size === v.tasks.length
    && v.tasks.every(t => object(t) && validBoardUuid(t.id) && Object.keys(t).length >= 2
      && Object.keys(t).every(k => ['id', 'status', 'detail'].includes(k))
      && (!('status' in t) || BOARD_STATUSES.includes(t.status as BoardStatus))
      && (!('detail' in t) || (typeof t.detail === 'string' && t.detail.length <= 4000)));
}

/** Machine credentials never become human principals. Permission, CAS, board write,
 * retry receipt and content-free audit are synchronous within one savepoint. */
export class WorkspaceBoardCapabilities {
  constructor(private readonly db: DatabaseSync, private readonly boards: WorkspaceBoards, private readonly now = Date.now,
    private readonly bindingAuthorized: (id: string) => boolean = () => true) {
    db.exec(`CREATE TABLE IF NOT EXISTS hub_board_capabilities (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, resource_id TEXT NOT NULL,
      task_ids TEXT NOT NULL, fields TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);
      CREATE INDEX IF NOT EXISTS hub_board_capabilities_owner ON hub_board_capabilities(user_id, resource_id);
      CREATE TABLE IF NOT EXISTS hub_board_agent_receipts (
      capability_id TEXT NOT NULL, mutation_id TEXT NOT NULL, fingerprint TEXT NOT NULL, revision INTEGER NOT NULL,
      PRIMARY KEY(capability_id, mutation_id));
      CREATE TABLE IF NOT EXISTS hub_board_agent_audit (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, resource_id TEXT NOT NULL,
      capability_id TEXT NOT NULL, event TEXT NOT NULL, mutation_id TEXT, revision INTEGER, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS hub_board_agent_audit_owner ON hub_board_agent_audit(user_id, sequence);`);
  }
  private atomic<T>(fn: () => T extends PromiseLike<unknown> ? never : T): T {
    return observedSavepoint(this.db, 'workspace-board-capability-change', fn);
  }
  private audit(cap: StoredCapability, event: string, mutationId: string | null = null, revision: number | null = null) {
    this.db.prepare('INSERT INTO hub_board_agent_audit (user_id, resource_id, capability_id, event, mutation_id, revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(cap.userId, cap.resourceId, cap.id, event, mutationId, revision, this.now());
    this.db.prepare(`DELETE FROM hub_board_agent_audit WHERE user_id = ? AND (created_at < ? OR sequence IN
      (SELECT sequence FROM hub_board_agent_audit WHERE user_id = ? ORDER BY sequence DESC LIMIT -1 OFFSET 10000))`)
      .run(cap.userId, this.now() - RETENTION_MS, cap.userId);
  }
  private decode(row: CapabilityRow): StoredCapability { return { ...row, taskIds: JSON.parse(row.taskIds), fields: JSON.parse(row.fields) }; }
  private columns = 'id, user_id AS userId, resource_id AS resourceId, task_ids AS taskIds, fields, expires_at AS expiresAt, created_at AS createdAt, revoked_at AS revokedAt';
  private resolve(token: string): StoredCapability | undefined {
    if (!/^aod_board_[A-Za-z0-9_-]{43}$/.test(token)) return;
    const row = this.db.prepare(`SELECT ${this.columns} FROM hub_board_capabilities WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`)
      .get(hash(token), this.now()) as CapabilityRow | undefined;
    return row && this.bindingAuthorized(row.id) ? this.decode(row) : undefined;
  }
  authorized(token: string): boolean { return !!this.resolve(token); }
  issue(userId: string, resourceId: string, input: BoardCapabilityInput): { capability: BoardCapability; token: string } | undefined {
    if (!validBoardId(resourceId) || !validBoardCapabilityInput(input) || input.expiresAt <= this.now() || input.expiresAt > this.now() + BOARD_CAPABILITY_TTL_MS) return;
    return this.atomic(() => {
      // Never implicitly create a board or grant future task IDs.
      const board = this.boards.get(userId, resourceId);
      if (!board.revision || !input.taskIds.every(id => board.tasks.some(task => task.id === id))) return;
      this.db.prepare(`DELETE FROM hub_board_agent_receipts WHERE capability_id IN
        (SELECT id FROM hub_board_capabilities WHERE user_id = ? AND (expires_at < ? OR revoked_at < ?))`)
        .run(userId, this.now() - RETENTION_MS, this.now() - RETENTION_MS);
      this.db.prepare('DELETE FROM hub_board_capabilities WHERE user_id = ? AND (expires_at < ? OR revoked_at < ?)')
        .run(userId, this.now() - RETENTION_MS, this.now() - RETENTION_MS);
      if ((this.db.prepare('SELECT count(*) AS n FROM hub_board_capabilities WHERE user_id = ?').get(userId) as { n: number }).n >= 256) return;
      const capability: BoardCapability = { id: randomUUID(), resourceId, taskIds: [...input.taskIds].sort(), fields: [...input.fields].sort(),
        expiresAt: input.expiresAt, createdAt: this.now(), revokedAt: null };
      const token = BOARD_CAPABILITY_PREFIX + randomBytes(32).toString('base64url');
      this.db.prepare('INSERT INTO hub_board_capabilities VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)')
        .run(capability.id, hash(token), userId, resourceId, JSON.stringify(capability.taskIds), JSON.stringify(capability.fields), capability.expiresAt, capability.createdAt);
      this.audit({ ...capability, userId }, 'issued');
      return { capability, token };
    });
  }
  list(userId: string, resourceId: string): BoardCapability[] {
    return (this.db.prepare(`SELECT ${this.columns} FROM hub_board_capabilities WHERE user_id = ? AND resource_id = ? ORDER BY created_at DESC, id`)
      .all(userId, resourceId) as CapabilityRow[]).map(row => { const { userId: _, ...cap } = this.decode(row); return cap; });
  }
  metadata(userId: string, resourceId: string, id: string): BoardCapability | undefined {
    const row = this.db.prepare(`SELECT ${this.columns} FROM hub_board_capabilities WHERE id = ? AND user_id = ? AND resource_id = ?`).get(id, userId, resourceId) as CapabilityRow | undefined;
    if (!row) return;
    const { userId: _, ...capability } = this.decode(row); return capability;
  }
  revoke(userId: string, resourceId: string, id: string): boolean {
    return this.atomic(() => {
      const row = this.db.prepare(`SELECT ${this.columns} FROM hub_board_capabilities WHERE id = ? AND user_id = ? AND resource_id = ?`).get(id, userId, resourceId) as CapabilityRow | undefined;
      if (!row) return false;
      if (row.revokedAt === null) {
        this.db.prepare('UPDATE hub_board_capabilities SET revoked_at = ? WHERE id = ?').run(this.now(), id);
        this.audit(this.decode(row), 'revoked');
      }
      return true;
    });
  }
  events(userId: string, resourceId: string, before = Number.MAX_SAFE_INTEGER) {
    return this.db.prepare(`SELECT sequence, capability_id AS capabilityId, event, mutation_id AS mutationId, revision, created_at AS createdAt
      FROM hub_board_agent_audit WHERE user_id = ? AND resource_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT 100`).all(userId, resourceId, before);
  }
  read(token: string): BoardAgentSnapshot | undefined;
  read(token: string, query: BoardAgentRead): ReturnType<typeof selectBoardRead> | { error: 'invalid_read' } | undefined;
  read(token: string, query?: BoardAgentRead) {
    const cap = this.resolve(token);
    if (!cap) return;
    if (query && (!validBoardAgentRead(query) || query.status && !cap.fields.includes('status'))) return { error: 'invalid_read' as const };
    const board = this.boards.get(cap.userId, cap.resourceId);
    const snapshot = { resourceId: cap.resourceId, revision: board.revision, tasks: board.tasks.filter(task => cap.taskIds.includes(task.id)).map(task => ({
      id: task.id, title: task.title, ...(cap.fields.includes('status') ? { status: task.status } : {}), ...(cap.fields.includes('detail') ? { detail: task.detail } : {}),
    })) };
    return selectBoardRead(snapshot, query ?? {});
  }
  update(token: string, input: BoardAgentWrite): BoardAgentResult {
    return this.atomic(() => {
      const cap = this.resolve(token); // Before *any* receipt lookup, even for a successful replay.
      if (!cap) return { status: 'denied' };
      if (this.boards.fileManaged(cap.userId, cap.resourceId)) return { status: 'denied' };
      if (!validBoardAgentWrite(input)) return { status: 'invalid' };
      const outcome = (status: 'denied' | 'conflict' | 'mutation-reused' | 'limit'): BoardAgentResult => {
        this.audit(cap, status, input.mutationId); return { status };
      };
      if (!input.tasks.every(t => cap.taskIds.includes(t.id) && Object.keys(t).every(k => k === 'id' || cap.fields.includes(k as Field)))) return outcome('denied');
      const normalized = [...input.tasks].sort((a, b) => a.id.localeCompare(b.id)).map(t => ({ id: t.id,
        ...('status' in t ? { status: t.status } : {}), ...('detail' in t ? { detail: t.detail } : {}) }));
      const fingerprint = hash(JSON.stringify({ revision: input.revision, tasks: normalized }));
      const old = this.db.prepare('SELECT fingerprint, revision FROM hub_board_agent_receipts WHERE capability_id = ? AND mutation_id = ?')
        .get(cap.id, input.mutationId) as { fingerprint: string; revision: number } | undefined;
      if (old) return old.fingerprint === fingerprint ? { status: 'saved', revision: old.revision, mutationId: input.mutationId } : outcome('mutation-reused');
      const board = this.boards.get(cap.userId, cap.resourceId);
      if (board.revision !== input.revision) return outcome('conflict');
      if (!input.tasks.every(t => board.tasks.some(existing => existing.id === t.id))) return outcome('denied');
      if ((this.db.prepare('SELECT count(*) AS n FROM hub_board_agent_receipts WHERE capability_id = ?').get(cap.id) as { n: number }).n >= 1000) return outcome('limit');
      // The internal human-store receipt ID is never chosen by the machine; its
      // separate namespace cannot collide with an owner's in-flight save.
      const write = { title: board.title, tasks: board.tasks.map(t => ({ ...t, ...input.tasks.find(p => p.id === t.id) })), revision: board.revision, mutationId: randomUUID() };
      if (!validBoardWrite(write)) return { status: 'invalid' };
      const result = this.boards.save(cap.userId, cap.resourceId, write);
      if (result.status !== 'saved') throw new Error('Atomic board update failed');
      this.db.prepare('INSERT INTO hub_board_agent_receipts VALUES (?, ?, ?, ?)').run(cap.id, input.mutationId, fingerprint, result.document.revision);
      this.audit(cap, 'updated', input.mutationId, result.document.revision);
      return { status: 'saved', revision: result.document.revision, mutationId: input.mutationId };
    });
  }
}
