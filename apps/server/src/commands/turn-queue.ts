import { existsSync, readFileSync, statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { OriginalTransactionWrite } from '../auth/application-transaction-gate.js';
import type { CommandQueueObservation, QueuedMessagePage } from '@agentopsdeck/shared';
import type { ExecutionGrantAuthority, ExecutionGrantTarget } from '../connector/execution-grants.js';
import { observedTransaction } from '../storage/observed-transaction.js';
import { requireConnectionReady } from '../storage/connection-recovery.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { StorageAdmissionDeferred } from '../storage/work-admission.js';
import { observedSavepoint } from '../storage/observed-savepoint.js';

export type TurnState = 'queued' | 'dispatching' | 'outcome_unknown' | 'blocked';
export class SessionDeletionConflict extends Error {
  constructor(message = 'Session deletion is accepted or unresolved') { super(message); }
}
export class TurnAuthorizationError extends Error {
  constructor() { super('Queued request blocked: execution authorization is no longer valid; not sent'); }
}
export type QueuedTurn<T> = { id: string; sessionKey: string; createdAt: number; state: TurnState; payload: T };
export type TurnQueueMetadata = Omit<QueuedTurn<never>, 'payload'> & {
  sequence: string; version: string; bytes: number;
};
export type TurnAdmission = { runtime: string; id: string; sessionKey: string; actorId?: string; mirror: boolean };
export type TurnQueueCommit = (db: DatabaseSync, admission?: TurnAdmission) => void;
export type TurnStorageAdmission = (bytes: number, write: () => void) => void;
export type AsyncTurnStorageAdmission = (bytes: number, write: () => Promise<void>) => Promise<void>;
type Row = { id: string; session_key: string; created_at: number; state: TurnState; payload: string };

// One Connector-owned queue table, shared by runtime adapters. This stores only
// pending work; receipts retain admission identity after a turn leaves the queue.
// No timer or runtime dispatch belongs in the persistence layer.
export class TurnQueue {
  private admissionListeners = new Set<(runtime: string) => void>();

  // Includes blocked/unknown entries. Maintenance must not discard them or
  // materialize private prompts/attachments just to decide whether to wait.
  maintenanceCount(runtime?: string): number {
    const row = runtime === undefined
      ? this.db.prepare('SELECT count(*) AS count FROM connector_turns').get()
      : this.db.prepare('SELECT count(*) AS count FROM connector_turns WHERE runtime = ?').get(runtime);
    return (row as { count: number }).count;
  }

  onAdmission(listener: (runtime: string) => void) {
    this.admissionListeners.add(listener);
    return () => { this.admissionListeners.delete(listener); };
  }

  sessionPage(runtime: string, after = '', limit = 16) {
    return (this.db.prepare(`SELECT t.session_key FROM connector_turns t WHERE runtime = ? AND session_key > ?
      AND sequence = (SELECT min(sequence) FROM connector_turns h WHERE h.runtime = t.runtime AND h.session_key = t.session_key)
      AND state != 'blocked' ORDER BY session_key LIMIT ?`)
      .all(runtime, after, Math.max(1, Math.min(limit, 64))) as { session_key: string }[]).map((row) => row.session_key);
  }

  constructor(private readonly db: DatabaseSync, private readonly maxRows = 10_000,
    private readonly maxBytes = 32 * 1024 * 1024,
    private readonly sessionAvailable: (sessionKey: string) => boolean = () => true,
    private readonly sessionStartAvailable: (sessionKey: string) => boolean = () => true,
    private readonly storageAdmission?: TurnStorageAdmission,
    private readonly asyncStorageAdmission?: AsyncTurnStorageAdmission,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {
    db.exec(`CREATE TABLE IF NOT EXISTS connector_turns (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, runtime TEXT NOT NULL, id TEXT NOT NULL,
      session_key TEXT NOT NULL, created_at INTEGER NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL,
      UNIQUE(runtime, id)
    );
    CREATE INDEX IF NOT EXISTS connector_turn_order ON connector_turns(runtime, session_key, sequence);
    CREATE INDEX IF NOT EXISTS connector_turn_actor_order ON connector_turns
      (runtime, session_key, json_extract(payload, '$.actorId'), sequence);
    CREATE INDEX IF NOT EXISTS connector_turn_execution_usage ON connector_turns
      (json_extract(payload, '$.executionGrant.id'), state, runtime, session_key);
    CREATE TABLE IF NOT EXISTS connector_turn_imports (runtime TEXT PRIMARY KEY, source TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS connector_turn_usage (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), rows INTEGER NOT NULL, bytes INTEGER NOT NULL);
    -- Guard the scalar aggregates, not just their INSERT: OR IGNORE alone
    -- still measures every retained payload on each ordinary restart.
    INSERT OR IGNORE INTO connector_turn_usage SELECT 1,
      (SELECT count(*) FROM connector_turns),
      (SELECT coalesce(sum(length(cast(payload AS BLOB)) + length(cast(session_key AS BLOB)) + 512), 0) FROM connector_turns)
      WHERE NOT EXISTS (SELECT 1 FROM connector_turn_usage WHERE singleton = 1);
    CREATE TRIGGER IF NOT EXISTS connector_turn_insert AFTER INSERT ON connector_turns BEGIN
      UPDATE connector_turn_usage SET rows = rows + 1, bytes = bytes + length(cast(new.payload AS BLOB)) + length(cast(new.session_key AS BLOB)) + 512 WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS connector_turn_delete AFTER DELETE ON connector_turns BEGIN
      UPDATE connector_turn_usage SET rows = rows - 1, bytes = bytes - length(cast(old.payload AS BLOB)) - length(cast(old.session_key AS BLOB)) - 512 WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS connector_turn_update AFTER UPDATE OF payload ON connector_turns BEGIN
      UPDATE connector_turn_usage SET bytes = bytes + length(cast(new.payload AS BLOB)) - length(cast(old.payload AS BLOB)) WHERE singleton = 1;
    END`);
    const columns = db.prepare('PRAGMA table_info(connector_turns)').all() as { name: string }[];
    if (!columns.some(column => column.name === 'revision')) db.exec('ALTER TABLE connector_turns ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
  }

  // Pending admission/preparation only. Unknown/blocked turns cannot be
  // revived by renewal; already-dispatched work has left this queue and does
  // not require a permanent lease. Never materialize message/attachment data.
  usesExecutionGrant(target: ExecutionGrantTarget, grant: ExecutionGrantAuthority) {
    return !!this.db.prepare(`SELECT 1 FROM connector_turns
      WHERE json_extract(payload, '$.executionGrant.id') = ? AND state IN ('queued', 'dispatching')
        AND runtime = ? AND session_key = ? AND json_extract(payload, '$.actorId') = ?
        AND json_extract(payload, '$.executionGrant.actorId') = ?
        AND json_extract(payload, '$.executionGrant.issuerTokenId') = ? LIMIT 1`)
      .get(grant.id, target.runtime, target.sessionKey, grant.actorId, grant.actorId, grant.issuerTokenId);
  }

  list<T>(runtime: string, sessionKey?: string, limit = -1): QueuedTurn<T>[] {
    const rows = sessionKey === undefined
      ? this.db.prepare('SELECT * FROM connector_turns WHERE runtime = ? ORDER BY sequence').all(runtime)
      : this.db.prepare('SELECT * FROM connector_turns WHERE runtime = ? AND session_key = ? ORDER BY sequence LIMIT ?').all(runtime, sessionKey, limit);
    return (rows as Row[]).map((row) => ({ id: row.id, sessionKey: row.session_key, createdAt: row.created_at, state: row.state, payload: JSON.parse(row.payload) as T }));
  }

  /** Complete startup inventory, including blocked and unknown rows. Do not
   * select payload before measuring it, or use the 16-row dispatch prefix. */
  bootstrapPage(runtime: string, after = '0', limit = 64, sessionKey?: string): TurnQueueMetadata[] {
    if (!/^(0|[1-9][0-9]{0,18})$/.test(after) || BigInt(after) > 9223372036854775807n
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw Error('connector_storage_unavailable');
    const rows = this.db.prepare(`SELECT CAST(sequence AS TEXT) AS sequence, id, session_key AS sessionKey,
      created_at AS createdAt, state, sequence || ':' || revision AS version,
      typeof(payload) AS type, length(CAST(payload AS BLOB)) AS bytes
      FROM connector_turns WHERE runtime = ? AND connector_turns.sequence > CAST(? AS INTEGER)
      ${sessionKey === undefined ? '' : 'AND session_key = ?'}
      ORDER BY connector_turns.sequence LIMIT ?`)
      .all(...(sessionKey === undefined ? [runtime, after, limit] : [runtime, after, sessionKey, limit]));
    return rows.map(row => {
      if (row.type !== 'text' || !Number.isSafeInteger(row.bytes) || Number(row.bytes) < 1
        || Number(row.bytes) > this.maxBytes) throw Error('connector_storage_unavailable');
      const { type: _type, ...metadata } = row;
      return metadata as TurnQueueMetadata;
    });
  }

  /** Read a measured, versioned body ONCE. Worker chunks use a single bounded
   * private buffer, not repeated substr(CAST(payload AS BLOB)) full-row copies. */
  bootstrapBody(runtime: string, sessionKey: string, id: string, version: string): Buffer {
    return observedSavepoint(this.db, 'turn-bootstrap-body', () => {
      const size = this.db.prepare(`SELECT typeof(payload) AS type, length(CAST(payload AS BLOB)) AS bytes
        FROM connector_turns WHERE runtime = ? AND session_key = ? AND id = ? AND sequence || ':' || revision = ?`)
        .get(runtime, sessionKey, id, version);
      if (!size || size.type !== 'text' || !Number.isSafeInteger(size.bytes) || Number(size.bytes) < 1
        || Number(size.bytes) > this.maxBytes) throw Error('connector_storage_unavailable');
      const row = this.db.prepare(`SELECT CAST(payload AS BLOB) AS body FROM connector_turns
        WHERE runtime = ? AND session_key = ? AND id = ? AND sequence || ':' || revision = ?`).get(runtime, sessionKey, id, version);
      if (!row || !(row.body instanceof Uint8Array) || row.body.length !== size.bytes) throw Error('connector_storage_unavailable');
      return Buffer.from(row.body);
    });
  }

  /** Owner-side dispatch snapshot. Check stored bytes/types BEFORE selecting
   * or parsing bodies; corruption must not turn a bounded IPC into a huge load.
   * The gate and read share the original connection/snapshot, never an observer. */
  dispatchPrefix<T>(runtime: string, sessionKey: string): QueuedTurn<T>[] {
    return observedSavepoint(this.db, 'turn-dispatch-snapshot', () => {
      const sizes = this.db.prepare(`SELECT typeof(payload) AS type, length(CAST(payload AS BLOB)) AS bytes
        FROM connector_turns WHERE runtime = ? AND session_key = ? ORDER BY sequence LIMIT 16`).all(runtime, sessionKey);
      let total = 0, count = 0;
      for (const row of sizes) {
        if (row.type !== 'text' || !Number.isSafeInteger(row.bytes) || Number(row.bytes) < 1
          || Number(row.bytes) > this.maxBytes) {
          throw new Error('connector_storage_unavailable');
        }
        // waitingBatch admits a large first row on its own. A legal retained
        // message must not become permanently undispatchable at an IPC limit.
        // Still measure before reading and never batch a second row past 1MiB.
        if (count && total + Number(row.bytes) > 1024 * 1024) break;
        total += Number(row.bytes); count++;
      }
      return this.list<T>(runtime, sessionKey, count);
    });
  }

  /** Capture original native-turn authority before admission removes queue rows.
   * Never load prompts/attachments or infer authority from a later HTTP caller. */
  interactionOwner(runtime: string, sessionKey: string, members: string[]): string | undefined {
    if (!members.length || members.length > 256 || new Set(members).size !== members.length) return;
    let owner: string | undefined;
    const query = this.db.prepare(`SELECT json_extract(payload, '$.actorId') AS owner,
      json_type(payload, '$.executionGrant') AS delegated FROM connector_turns WHERE runtime = ? AND session_key = ? AND id = ?`);
    for (const id of members) {
      const row = query.get(runtime, sessionKey, id) as { owner: unknown; delegated: string | null } | undefined;
      if (!row || row.delegated && row.delegated !== 'null' || typeof row.owner !== 'string' || !row.owner
        || owner && owner !== row.owner) return;
      owner = row.owner;
    }
    return owner;
  }

  sessions(runtime: string) {
    return (this.db.prepare('SELECT DISTINCT session_key FROM connector_turns WHERE runtime = ?').all(runtime) as { session_key: string }[]).map((row) => row.session_key);
  }
  // Queue management reads metadata only, not attachment paths or message bodies.
  summaryPage(runtime: string, sessionKey: string, actorId: string, manage = false, after = 0): QueuedMessagePage {
    const rows = this.db.prepare(`SELECT sequence, revision, id, state, created_at FROM connector_turns
      WHERE runtime = ? AND session_key = ? AND sequence > ? ${manage ? '' : "AND json_extract(payload, '$.actorId') = ?"}
      ORDER BY sequence LIMIT 65`).all(runtime, sessionKey, after, ...(manage ? [] : [actorId])) as Array<{ sequence: number; revision: number; id: string; state: TurnState; created_at: number }>;
    const page = rows.slice(0, 64);
    return { items: page.map((row) => ({ id: row.id, state: row.state, createdAt: row.created_at, version: `${row.sequence}:${row.revision}` })),
      nextCursor: rows.length > 64 ? String(page.at(-1)!.sequence) : null };
  }
  ownedEntry(runtime: string, sessionKey: string, id: string, actorId: string, manage = false) {
    return this.db.prepare(`SELECT state FROM connector_turns WHERE runtime = ? AND session_key = ? AND id = ?
      AND (? OR json_extract(payload, '$.actorId') = ?)`).get(runtime, sessionKey, id, Number(manage), actorId) as { state: TurnState } | undefined;
  }
  // Opaque per-row version. The never-reused sequence also prevents stale
  // actions from matching a removed/reinserted ID (the ABA problem).
  version(runtime: string, sessionKey: string, id: string) {
    return (this.db.prepare("SELECT sequence || ':' || revision AS version FROM connector_turns WHERE runtime = ? AND session_key = ? AND id = ?")
      .get(runtime, sessionKey, id) as { version: string } | undefined)?.version;
  }
  commandState(runtime: string, sessionKey: string, id: string, actorId: string): CommandQueueObservation {
    const row = this.db.prepare(`SELECT state, created_at, sequence || ':' || revision AS version FROM connector_turns WHERE runtime = ? AND session_key = ? AND id = ?
      AND json_extract(payload, '$.actorId') = ?`).get(runtime, sessionKey, id, actorId) as { state: TurnState; created_at: number; version: string } | undefined;
    return row ? { presence: 'present', state: row.state, createdAt: row.created_at, version: row.version } : { presence: 'absent' };
  }
  headId(runtime: string, sessionKey: string): string | undefined {
    const row = this.db.prepare('SELECT id FROM connector_turns WHERE runtime = ? AND session_key = ? ORDER BY sequence LIMIT 1')
      .get(runtime, sessionKey) as { id: string } | undefined;
    return row?.id;
  }
  head<T>(runtime: string, sessionKey: string): QueuedTurn<T> | undefined {
    const row = this.db.prepare('SELECT * FROM connector_turns WHERE runtime = ? AND session_key = ? ORDER BY sequence LIMIT 1').get(runtime, sessionKey) as Row | undefined;
    return row ? { id: row.id, sessionKey: row.session_key, createdAt: row.created_at, state: row.state, payload: JSON.parse(row.payload) as T } : undefined;
  }
  hasPending(runtime: string, sessionKey: string) {
    return !!this.db.prepare('SELECT 1 FROM connector_turns WHERE runtime = ? AND session_key = ? LIMIT 1').get(runtime, sessionKey);
  }

  /** Claim an exact FIFO prefix in one transaction. No member remains editable
   * once any of the batch may be handed to the native runtime. */
  startBatch(runtime: string, sessionKey: string, ids: string[]) {
    if (!ids.length || new Set(ids).size !== ids.length) return false;
    let changed = false;
    const claim = () => {
      if (!this.sessionAvailable(sessionKey) || !this.sessionStartAvailable(sessionKey)) return;
      const rows = this.db.prepare('SELECT id,state FROM connector_turns WHERE runtime = ? AND session_key = ? ORDER BY sequence LIMIT ?')
        .all(runtime, sessionKey, ids.length) as { id: string; state: TurnState }[];
      if (rows.length !== ids.length || rows.some((row, i) => row.id !== ids[i] || row.state !== 'queued')) return;
      const update = this.db.prepare("UPDATE connector_turns SET state = 'dispatching', revision = revision + 1 WHERE runtime = ? AND id = ?");
      for (const id of ids) update.run(runtime, id);
      changed = true;
    };
    // Hermes execution intent and queue claim share the owning database's
    // transaction. A nested savepoint still rolls back a partial batch on error.
    observedTransaction(this.db, 'turn-queue-change', claim, undefined, true);
    return changed;
  }

  hasCommand(runtime: string, id: string) {
    return !!this.db.prepare('SELECT 1 FROM connector_turns WHERE runtime = ? AND id = ?').get(runtime, id);
  }

  startBatchInTransaction(db: DatabaseSync, runtime: string, sessionKey: string, ids: string[]) {
    if (db !== this.db || !db.isTransaction) throw new Error('Queue claim requires its owning transaction');
    return this.startBatch(runtime, sessionKey, ids);
  }

  /** Control operations share the message-start barriers, but must not claim
   * or manufacture a user message. Check the whole queue, including unknown
   * and blocked entries, in the journal's owning transaction. */
  canStartControlInTransaction(db: DatabaseSync, runtime: string, sessionKey: string) {
    if (db !== this.db || !db.isTransaction) throw new Error('Control admission requires its owning transaction');
    return this.sessionAvailable(sessionKey) && this.sessionStartAvailable(sessionKey)
      && !this.hasPending(runtime, sessionKey);
  }

  /** Recheck automated admission after native send inserted its own row, in
   * that SAME transaction. No other queued/unknown work may be overtaken. */
  canAdmitAutomationInTransaction(db: DatabaseSync, runtime: string, sessionKey: string, id: string) {
    if (db !== this.db || !db.isTransaction) throw new Error('Automation admission requires its owning transaction');
    const rows = this.db.prepare('SELECT id,state FROM connector_turns WHERE runtime=? AND session_key=? LIMIT 2')
      .all(runtime, sessionKey) as { id: string; state: string }[];
    return this.sessionAvailable(sessionKey) && this.sessionStartAvailable(sessionKey)
      && rows.length === 1 && rows[0]!.id === id && rows[0]!.state === 'queued';
  }

  settleClaimedBatchInTransaction(db: DatabaseSync, runtime: string, sessionKey: string, ids: string[], outcome: 'accepted' | 'unknown') {
    if (db !== this.db || !db.isTransaction) throw new Error('Queue settlement requires its owning transaction');
    const statement = outcome === 'accepted'
      ? this.db.prepare("DELETE FROM connector_turns WHERE runtime = ? AND session_key = ? AND id = ? AND state IN ('dispatching', 'outcome_unknown')")
      : this.db.prepare("UPDATE connector_turns SET state = 'outcome_unknown', revision = revision + 1 WHERE runtime = ? AND session_key = ? AND id = ? AND state = 'dispatching'");
    for (const id of ids) statement.run(runtime, sessionKey, id);
  }

  hasDispatchPending(runtime: string, sessionKey: string) {
    return !!this.db.prepare("SELECT 1 FROM connector_turns WHERE runtime = ? AND session_key = ? AND state IN ('dispatching', 'outcome_unknown') LIMIT 1")
      .get(runtime, sessionKey);
  }

  enqueue<T>(runtime: string, turn: Omit<QueuedTurn<T>, 'state'> & { state?: TurnState }, commitReceipt?: TurnQueueCommit) {
    // An async-only physical owner cannot silently become an unreserved write.
    // Refuse before serialization or any authority/receipt participant starts.
    if (!this.storageAdmission && this.asyncStorageAdmission) throw new StorageAdmissionDeferred('async-admission-required');
    const { snapshot, encoded, bytes } = this.prepareAdmission(turn);
    const write = () => this.commitAdmission(runtime, snapshot, encoded, commitReceipt);
    if (this.storageAdmission) this.storageAdmission(bytes, write); else write();
    this.notifyAdmission(runtime);
  }

  /** Only space admission waits. Queue and receipt retain the same owner and
   * atomic synchronous transaction. Failure after commit cannot undo admission
   * or permit replay; the original receipt is the durable recovery authority. */
  async enqueueAsync<T>(runtime: string, turn: Omit<QueuedTurn<T>, 'state'> & { state?: TurnState },
    commitReceipt?: TurnQueueCommit, check: () => void = () => {}, transactionWrite?: OriginalTransactionWrite) {
    const trace = this.diagnostics.start('turn-queue-admission');
    let failed = true, committed = false, entered = false, active = true;
    let step = 1;
    const warning = setTimeout(() => trace.reportPending({ pending: 1, step, unknown: Number(committed) }), 30_000);
    warning.unref();
    const at = performance.now(); let releasedAt = at;
    try {
      if (this.db.isTransaction) throw new Error('Queue admission requires its owning database boundary');
      check();
      const { snapshot, encoded, bytes } = this.prepareAdmission(turn);
      const write = () => {
        if (!active) throw new Error('Queue admission ended');
        if (entered) throw new Error('Queue admission writer already attempted');
        entered = true;
        trace.add('queueMs', performance.now() - at);
        check();
        step = 2;
        const bodyAt = performance.now();
        try {
          this.commitAdmission(runtime, snapshot, encoded, commitReceipt);
          committed = true; trace.add('changed', 1);
        } finally { step = 3; releasedAt = performance.now(); trace.add('bodyMs', releasedAt - bodyAt); }
      };
      if (this.asyncStorageAdmission) await this.asyncStorageAdmission(bytes, async () => {
        if (transactionWrite) await transactionWrite(write); else write();
      });
      else {
        const original = () => { if (this.storageAdmission) this.storageAdmission(bytes, write); else write(); };
        if (transactionWrite) await transactionWrite(original); else original();
      }
      if (!committed) throw new Error('Queue admission writer was not committed');
      check();
      requireConnectionReady(this.db);
      if (!this.db.isOpen) throw new Error('Storage connection closed');
      failed = false;
    } catch (error) {
      if (committed) trace.add('unknown', 1);
      if (error instanceof StorageAdmissionDeferred) trace.add('deferred', 1);
      throw error;
    } finally {
      active = false;
      clearTimeout(warning);
      // The accepted receipt/queue are authoritative even if the physical
      // ledger's release reply was lost. Wake the ordinary fenced worker, not
      // a second admission; otherwise an idle worker would strand durable work.
      if (committed) {
        try { this.notifyAdmission(runtime); }
        catch { failed = true; trace.add('unknown', 1); }
      }
      if (!entered) trace.add('queueMs', performance.now() - at);
      else trace.add('releaseMs', performance.now() - releasedAt);
      trace.finish(failed);
    }
  }

  private prepareAdmission<T>(turn: Omit<QueuedTurn<T>, 'state'> & { state?: TurnState }) {
    // Serialize once: the reservation and committed row must describe the same
    // bytes even when a caller supplies a stateful toJSON implementation.
    const encoded = JSON.stringify(turn.payload);
    if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 1024 * 1024) throw new Error('Queued turn payload exceeds limit');
    const snapshot = { ...turn, payload: JSON.parse(encoded) as T };
    const bytes = (Buffer.byteLength(encoded) + Buffer.byteLength(snapshot.sessionKey) + 1024) * 4 + 65536;
    // This is only NEW work. ACKs, revocation and recovery retain their existing
    // settlement path under pressure; admission is not a filesystem hard quota.
    return { snapshot, encoded, bytes };
  }

  private commitAdmission<T>(runtime: string, snapshot: Omit<QueuedTurn<T>, 'state'> & { state?: TurnState },
    encoded: string, commitReceipt?: TurnQueueCommit) {
    this.transaction(check => {
      if (!this.sessionAvailable(snapshot.sessionKey)) throw new SessionDeletionConflict();
      this.insert(runtime, snapshot, false, encoded);
      const payload = snapshot.payload as { actorId?: unknown; deliveryMode?: unknown } | null;
      check(commitReceipt?.(this.db, { runtime, id: snapshot.id, sessionKey: snapshot.sessionKey,
        ...(typeof payload?.actorId === 'string' ? { actorId: payload.actorId } : {}), mirror: payload?.deliveryMode === 'mirror' }));
    });
  }

  private notifyAdmission(runtime: string) {
    // Nothing can observe or dispatch the admission until both queue and
    // receipt commit. A rejected receipt rolls back queue usage as well.
    // A failing observer must not suppress later worker wakeups after commit.
    let failure: unknown;
    let failed = false;
    const trace = this.diagnostics.start('turn-queue-notify');
    try {
      for (const listener of this.admissionListeners) {
        try { listener(runtime); trace.add('changed', 1); }
        catch (error) { if (!failed) failure = error; failed = true; trace.add('unknown', 1); }
      }
      if (failed) throw failure;
    } finally {
      trace.finish(failed);
    }
  }

  // Atomic FIFO admission: an uncertain older turn blocks only this session.
  start(runtime: string, sessionKey: string, id: string) {
    let changed = false;
    const update = () => {
      if (!this.sessionAvailable(sessionKey) || !this.sessionStartAvailable(sessionKey)) return;
      changed = this.db.prepare(`UPDATE connector_turns SET state = 'dispatching', revision = revision + 1 WHERE runtime = ? AND session_key = ? AND id = ? AND state = 'queued'
      AND sequence = (SELECT min(sequence) FROM connector_turns WHERE runtime = ? AND session_key = ?)`)
      .run(runtime, sessionKey, id, runtime, sessionKey).changes === 1;
    };
    // An execution.begin callback can already own this exact database's
    // transaction; do not commit or roll back that caller's larger unit.
    if (this.db.isTransaction) update(); else this.transaction(update);
    return changed;
  }
  defer(runtime: string, id: string) { this.transition(runtime, id, 'queued'); }
  uncertain(runtime: string, id: string) { this.transition(runtime, id, 'outcome_unknown'); }
  block(runtime: string, id: string) {
    return this.db.prepare("UPDATE connector_turns SET state = 'blocked', revision = revision + 1 WHERE runtime = ? AND id = ? AND state IN ('queued', 'dispatching')")
      .run(runtime, id).changes === 1;
  }
  /** Reject only the observed queued head, with its current authority checked
   * under the SAME write transaction. Never downgrade dispatched/unknown work
   * or let an old observation select a replacement head (including ID reuse).
   * The participant is owner-local and must be synchronous; not an RPC hook. */
  blockQueuedHead(runtime: string, sessionKey: string, id: string, expectedVersion: string,
    reject: () => boolean): boolean {
    let changed = false;
    this.transaction(check => {
      const head = this.head<unknown>(runtime, sessionKey);
      if (head?.id !== id || head.state !== 'queued' || this.version(runtime, sessionKey, id) !== expectedVersion) return;
      const denied = reject(); check(denied);
      if (denied !== true) return;
      changed = this.blockInTransaction(this.db, runtime, sessionKey, id);
    });
    return changed;
  }
  blockInTransaction(db: DatabaseSync, runtime: string, sessionKey: string, id: string) {
    if (db !== this.db || !db.isTransaction) throw new Error('Queue block requires its owning transaction');
    return this.db.prepare("UPDATE connector_turns SET state = 'blocked', revision = revision + 1 WHERE runtime = ? AND session_key = ? AND id = ? AND state IN ('queued', 'dispatching')")
      .run(runtime, sessionKey, id).changes === 1;
  }
  complete(runtime: string, id: string) { this.db.prepare('DELETE FROM connector_turns WHERE runtime = ? AND id = ?').run(runtime, id); }
  completeInTransaction(db: DatabaseSync, runtime: string, id: string) {
    if (db !== this.db || !db.isTransaction) throw new Error('Queue ACK requires its owning transaction');
    this.complete(runtime, id);
  }
  cancel<T = unknown>(runtime: string, sessionKey: string, id: string, expectedVersion?: string, commitReceipt?: TurnQueueCommit,
    beforeDelete?: (db: DatabaseSync, payload: T) => void) {
    let changed = false;
    this.transaction(check => {
      if (beforeDelete) {
        const row = this.db.prepare(`SELECT payload FROM connector_turns WHERE runtime = ? AND session_key = ? AND id = ? AND state IN ('queued', 'blocked')
          AND (? IS NULL OR sequence || ':' || revision = ?)`)
          .get(runtime, sessionKey, id, expectedVersion ?? null, expectedVersion ?? null) as { payload: string } | undefined;
        if (!row) return;
        check(beforeDelete(this.db, JSON.parse(row.payload) as T));
      }
      changed = this.db.prepare(`DELETE FROM connector_turns WHERE runtime = ? AND session_key = ? AND id = ? AND state IN ('queued', 'blocked')
        AND (? IS NULL OR sequence || ':' || revision = ?)`)
        .run(runtime, sessionKey, id, expectedVersion ?? null, expectedVersion ?? null).changes === 1;
      if (changed) check(commitReceipt?.(this.db));
    });
    if (changed) this.notifyAdmission(runtime);
    return changed;
  }
  edit<T>(runtime: string, sessionKey: string, id: string, update: (payload: T) => T, expectedVersion?: string, commitReceipt?: TurnQueueCommit) {
    let changed = false;
    this.transaction(check => {
      if (!this.sessionAvailable(sessionKey)) return;
      const row = this.db.prepare(`SELECT payload, sequence, revision FROM connector_turns WHERE runtime = ? AND session_key = ? AND id = ? AND state = 'queued'
        AND (? IS NULL OR sequence || ':' || revision = ?)`)
        .get(runtime, sessionKey, id, expectedVersion ?? null, expectedVersion ?? null) as { payload: string; sequence: number; revision: number } | undefined;
      if (!row) return;
      const updated = update(JSON.parse(row.payload) as T);
      check(updated);
      const payload = JSON.stringify(updated);
      const { bytes } = this.db.prepare('SELECT bytes FROM connector_turn_usage WHERE singleton = 1').get() as { bytes: number };
      if (typeof payload !== 'string' || Buffer.byteLength(payload) > 1024 * 1024
        || bytes + Buffer.byteLength(payload) - Buffer.byteLength(row.payload) > this.maxBytes) throw new Error('Turn queue capacity reached');
      changed = this.db.prepare("UPDATE connector_turns SET payload = ?, revision = revision + 1 WHERE sequence = ? AND revision = ? AND state = 'queued'")
        .run(payload, row.sequence, row.revision).changes === 1;
      if (changed) check(commitReceipt?.(this.db));
    });
    return changed;
  }
  recoverInterrupted(runtime: string) {
    this.db.prepare("UPDATE connector_turns SET state = 'outcome_unknown', revision = revision + 1 WHERE runtime = ? AND state = 'dispatching'").run(runtime);
  }

  // One transaction, fail closed on malformed/oversized data, never edit or
  // unlink the legacy file. A committed import is not repeated after restart.
  importLegacy<T>(runtime: string, file: string | undefined, decode: (sessionKey: string, entry: unknown) => QueuedTurn<T>) {
    if (!file || this.db.prepare('SELECT 1 FROM connector_turn_imports WHERE runtime = ?').get(runtime)) return;
    const turns: QueuedTurn<T>[] = [];
    if (existsSync(file)) {
      if (statSync(file).size > this.maxBytes) throw new Error('Legacy queue exceeds import limit');
      let parsed: unknown;
      try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error('Legacy queue is not valid JSON'); }
      if (!isRecord(parsed) || !isRecord(parsed.queues)) throw new Error('Invalid legacy queue document');
      for (const [sessionKey, entries] of Object.entries(parsed.queues)) {
        if (!Array.isArray(entries)) throw new Error('Invalid legacy queue entries');
        for (const entry of entries) {
          if (turns.length >= this.maxRows) throw new Error('Legacy queue exceeds row limit');
          turns.push(decode(sessionKey, entry));
        }
      }
    }
    this.transaction(() => {
      for (const turn of turns) this.insert(runtime, turn, true);
      this.db.prepare('INSERT INTO connector_turn_imports VALUES (?, ?)').run(runtime, file);
    });
  }

  private insert<T>(runtime: string, turn: Omit<QueuedTurn<T>, 'state'> & { state?: TurnState }, legacy = false, encoded?: string) {
    if (!runtime || runtime.length > 64 || !turn.id || Buffer.byteLength(turn.id) > 512
      || !turn.sessionKey || Buffer.byteLength(turn.sessionKey) > 4096 || !Number.isFinite(turn.createdAt)
      || !['queued', 'dispatching', 'outcome_unknown', 'blocked'].includes(turn.state ?? 'queued')) throw new Error('Invalid queued turn');
    const payload = encoded ?? JSON.stringify(turn.payload);
    if (typeof payload !== 'string' || Buffer.byteLength(payload) > (legacy ? this.maxBytes : 1024 * 1024)) throw new Error('Queued turn payload exceeds limit');
    const size = this.db.prepare('SELECT rows, bytes FROM connector_turn_usage WHERE singleton = 1').get() as { rows: number; bytes: number };
    if (size.rows >= this.maxRows || size.bytes + Buffer.byteLength(payload) + Buffer.byteLength(turn.sessionKey) + 512 > this.maxBytes) throw new Error('Turn queue capacity reached');
    this.db.prepare('INSERT INTO connector_turns (runtime,id,session_key,created_at,state,payload) VALUES (?,?,?,?,?,?)')
      .run(runtime, turn.id, turn.sessionKey, turn.createdAt, turn.state ?? 'queued', payload);
  }
  private transition(runtime: string, id: string, state: TurnState) {
    this.db.prepare("UPDATE connector_turns SET state = ?, revision = revision + 1 WHERE runtime = ? AND id = ? AND state = 'dispatching'").run(state, runtime, id);
  }
  private transaction(work: (checkParticipant: (value: unknown) => void) => void) {
    observedTransaction(this.db, 'turn-queue-change', (_commit, check) => work(check));
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
