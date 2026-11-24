import { observedSavepoint } from '../storage/observed-savepoint.js';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { validBoardUuid } from '@agentopsdeck/shared';
import { validBoardCapabilityInput, type BoardCapabilityInput, type WorkspaceBoardCapabilities } from './workspace-board-capabilities.js';
import { validBoardToolCredential } from '../tools/workspace-board-cli.js';

export type HubBoardBindingInput = { requestId: string; sessionId: string; grant: BoardCapabilityInput };
export type HubBoardBinding = { requestId: string; boardId: string; sessionId: string; capabilityId: string;
  state: 'prepared' | 'installed' | 'uncertain' | 'revoked' | 'expired' | 'unavailable'; expiresAt: number; createdAt: number };
type Stored = HubBoardBinding & { owner: string; connection: string; authority: number; endpoint: string; fingerprint: string };
type Vault = { read: (id: string) => string | undefined; write: (id: string, token: string) => void; remove: (id: string) => void };
export function validHubBoardBindingInput(value: unknown): value is HubBoardBindingInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 3 && validBoardUuid(v.requestId) && typeof v.sessionId === 'string' && v.sessionId.length <= 2048 && validBoardCapabilityInput(v.grant);
}
export function parseBoardAgentEndpoint(value: string | undefined) {
  if (value === undefined) return;
  if (!validBoardToolCredential({ endpoint: value, token: 'aod_board_' + 'a'.repeat(43), expiresAt: Date.now() + 60_000 })) throw new Error('Invalid private board endpoint configuration');
  return value;
}

/** The browser sees metadata, not capability credentials. Capability issuance,
 * vault storage and intent are in ONE SQLite transaction. A lost HTTP response
 * is reconciled against this intent, never by issuing a second capability. */
export class HubBoardBindings {
  constructor(private readonly db: DatabaseSync, private readonly caps: WorkspaceBoardCapabilities, private readonly vault: Vault,
    readonly enabled: boolean, private readonly currentAuthority: (connection: string, owner: string) => number | undefined) {
    db.exec(`CREATE TABLE IF NOT EXISTS hub_board_bindings (
      request_id TEXT PRIMARY KEY, owner TEXT NOT NULL, board_id TEXT NOT NULL, session_id TEXT NOT NULL,
      connection_id TEXT NOT NULL, authority INTEGER NOT NULL, endpoint TEXT NOT NULL, fingerprint TEXT NOT NULL,
      capability_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS hub_board_bindings_owner ON hub_board_bindings(owner, board_id, created_at);
      CREATE TABLE IF NOT EXISTS hub_board_binding_cancellations (
        owner TEXT NOT NULL, board_id TEXT NOT NULL, request_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(owner, board_id, request_id));`);
  }
  private columns = 'request_id AS requestId, owner, board_id AS boardId, session_id AS sessionId, connection_id AS connection, authority, endpoint, fingerprint, capability_id AS capabilityId, state, expires_at AS expiresAt, created_at AS createdAt';
  private stored(owner: string, boardId: string, id: string) {
    return this.db.prepare(`SELECT ${this.columns} FROM hub_board_bindings WHERE request_id = ? AND owner = ? AND board_id = ?`).get(id, owner, boardId) as Stored | undefined;
  }
  private public(row: Stored): HubBoardBinding {
    const { requestId, boardId, sessionId, capabilityId, expiresAt, createdAt } = row;
    const capability = this.caps.metadata(row.owner, boardId, capabilityId);
    const state = row.state === 'revoked' || capability?.revokedAt != null ? 'revoked'
      : expiresAt <= Date.now() ? 'expired'
      : !capability || !this.authorized(capabilityId) ? 'unavailable' : row.state;
    return { requestId, boardId, sessionId, capabilityId, state, expiresAt, createdAt };
  }
  private atomic<T>(fn: () => T extends PromiseLike<unknown> ? never : T): T {
    return observedSavepoint(this.db, 'workspace-board-binding-change', fn);
  }
  /** Called on EVERY agent operation, including idempotent receipt reads. A
   * changed/disabled/recreated connection never revives a previous grant. */
  authorized(capabilityId: string): boolean {
    const row = this.db.prepare(`SELECT ${this.columns} FROM hub_board_bindings WHERE capability_id = ?`).get(capabilityId) as Stored | undefined;
    return !row || this.enabled && row.state !== 'revoked' && row.expiresAt > Date.now() && this.currentAuthority(row.connection, row.owner) === row.authority;
  }
  prepare(owner: string, boardId: string, input: HubBoardBindingInput, connection: string, authority: number, endpoint: string): HubBoardBinding | undefined {
    if (!this.enabled || !validHubBoardBindingInput(input) || parseBoardAgentEndpoint(endpoint) !== endpoint || this.currentAuthority(connection, owner) !== authority) return;
    const fingerprint = createHash('sha256').update(JSON.stringify({ owner, boardId, sessionId: input.sessionId, connection, authority, endpoint,
      grant: { taskIds: [...input.grant.taskIds].sort(), fields: [...input.grant.fields].sort(), expiresAt: input.grant.expiresAt } })).digest('hex');
    return this.atomic(() => {
      if (this.db.prepare('SELECT 1 FROM hub_board_binding_cancellations WHERE owner = ? AND board_id = ? AND request_id = ?').get(owner, boardId, input.requestId)) return;
      const previous = this.stored(owner, boardId, input.requestId);
      if (previous) return previous.fingerprint === fingerprint && this.credential(owner, boardId, input.requestId) ? this.public(previous) : undefined;
      if (this.db.prepare('SELECT 1 FROM hub_board_bindings WHERE request_id = ?').get(input.requestId)) return;
      if ((this.db.prepare('SELECT count(*) AS n FROM hub_board_bindings WHERE owner = ?').get(owner) as { n: number }).n >= 1024) return;
      const issued = this.caps.issue(owner, boardId, input.grant);
      if (!issued) return;
      this.vault.write(input.requestId, issued.token);
      const row: Stored = { requestId: input.requestId, owner, boardId, sessionId: input.sessionId, connection, authority, endpoint, fingerprint,
        capabilityId: issued.capability.id, state: 'prepared', expiresAt: issued.capability.expiresAt, createdAt: issued.capability.createdAt };
      this.db.prepare('INSERT INTO hub_board_bindings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(row.requestId, owner, boardId, row.sessionId, connection, authority, endpoint, fingerprint, row.capabilityId, row.state, row.expiresAt, row.createdAt);
      return this.public(row);
    });
  }
  credential(owner: string, boardId: string, id: string) {
    const row = this.stored(owner, boardId, id);
    if (!row || !this.authorized(row.capabilityId)) return;
    const token = this.vault.read(id);
    if (!token || !this.caps.authorized(token)) return;
    return { endpoint: row.endpoint, token, expiresAt: row.expiresAt };
  }
  get(owner: string, boardId: string, id: string) { const row = this.stored(owner, boardId, id); return row && this.public(row); }
  list(owner: string, boardId: string) {
    return (this.db.prepare(`SELECT ${this.columns} FROM hub_board_bindings WHERE owner = ? AND board_id = ? ORDER BY created_at DESC LIMIT 256`).all(owner, boardId) as Stored[]).map(row => this.public(row));
  }
  outcome(owner: string, boardId: string, id: string, state: 'installed' | 'uncertain', preserveInstalled = false) {
    // Attempt timeouts are weaker than an already-confirmed installation. The
    // batch adapter opts into this SQL fence for delayed callbacks. A fresh
    // explicit remote lookup can still report absence using the default mode.
    this.db.prepare("UPDATE hub_board_bindings SET state = ? WHERE request_id = ? AND owner = ? AND board_id = ? AND state <> 'revoked' AND (? = 0 OR state <> 'installed' OR ? = 'installed')")
      .run(state, id, owner, boardId, preserveInstalled ? 1 : 0, state);
    return this.get(owner, boardId, id);
  }
  /** A lost POST may still be waiting for discovery, or may never have arrived.
   * Durable cancellation fences BOTH cases before the browser clears its UUID.
   * Do not expire these tombstones: a delayed request must never create a grant. */
  cancelIntent(owner: string, boardId: string, id: string): { cancelled: true; requestId: string; binding: HubBoardBinding | null } | undefined {
    if (!validBoardUuid(id)) return;
    return this.atomic(() => {
      const exists = this.db.prepare('SELECT 1 FROM hub_board_binding_cancellations WHERE owner = ? AND board_id = ? AND request_id = ?').get(owner, boardId, id);
      if (!exists) {
        if ((this.db.prepare('SELECT count(*) AS n FROM hub_board_binding_cancellations WHERE owner = ?').get(owner) as { n: number }).n >= 1024) return;
        this.db.prepare('INSERT INTO hub_board_binding_cancellations VALUES (?, ?, ?, ?)').run(owner, boardId, id, Date.now());
      }
      const row = this.stored(owner, boardId, id);
      if (row) {
        this.caps.revoke(owner, boardId, row.capabilityId);
        this.db.prepare("UPDATE hub_board_bindings SET state = 'revoked' WHERE request_id = ?").run(id);
        this.vault.remove(id);
      }
      return { cancelled: true, requestId: id, binding: this.get(owner, boardId, id) ?? null };
    });
  }
  revoke(owner: string, boardId: string, id: string) {
    return this.atomic(() => {
      const row = this.stored(owner, boardId, id); if (!row) return;
      this.caps.revoke(owner, boardId, row.capabilityId);
      this.db.prepare("UPDATE hub_board_bindings SET state = 'revoked' WHERE request_id = ?").run(id);
      this.vault.remove(id);
      return this.get(owner, boardId, id);
    });
  }
}
