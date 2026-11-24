import type { DatabaseSync } from 'node:sqlite';
import type { ChatMessage } from '@agentopsdeck/shared';
import { createHash } from 'node:crypto';
import type { CodexBatch } from '../codex/queued-batch.js';
import type { TurnQueue } from '../commands/turn-queue.js';
import { observedSavepoint } from '../storage/observed-savepoint.js';
import { synchronousSqliteValue } from '../auth/synchronous-sqlite-value.js';
import { hermesHistory, hermesUnconfirmedTools, type HermesHistoryRow } from './history.js';

export type HermesSession = { key: string; stored: string; title: string; started: boolean; messages: ChatMessage[];
  /** Native identity already allocated, independently of first prompt. Missing
   * on legacy records: preserve their original attachment behavior. */
  nativeAllocated?: true };
export type HermesExecution = { id: string; key: string; live: string; epoch: string;
  phase: 'starting' | 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown';
  members: string[]; batch?: CodexBatch; row?: number; at: number; updated: number };
export type HermesHistorySnapshot = { key: string; digest: string; stored: string; title: string; started: boolean; unknown: boolean;
  nativeAllocated?: true };
export type HermesLifecycleSnapshot = { key: string; digest: string; title: string | null;
  execution: HermesExecution | null; deletion: 'pending' | 'accepted' | null };
export type HermesHistoryPage = { key: string; digest: string; messages: ChatMessage[];
  large: { index: number; bytes: number } | null; next: number | null };
export type HermesHistoryPart = { key: string; digest: string; index: number; offset: number;
  data: string; total: number; next: number | null };
export type HermesToolObservation = { toolId: string; phase: 'call' | 'result'; name?: string; at: number };

/** Same SQLite transaction as queue/receipts. Local IDs are never native run IDs.
 * Recovery deliberately freezes unresolved work instead of replaying tools. */
export class HermesJournal {
  checkPermission<Args extends unknown[]>(authorize: (...args: Args) => boolean, args: Args, receiver?: unknown): boolean {
    return synchronousSqliteValue(this.db, authorize, receiver, args) === true;
  }

  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS hermes_sessions (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS hermes_executions (id TEXT PRIMARY KEY, session_key TEXT NOT NULL,
        phase TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS hermes_execution_session ON hermes_executions(session_key);
      CREATE INDEX IF NOT EXISTS hermes_execution_row ON hermes_executions(session_key, json_extract(data, '$.row'));
      CREATE TABLE IF NOT EXISTS hermes_deletions (key TEXT PRIMARY KEY, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS hermes_interrupts (key TEXT PRIMARY KEY, receipt_id TEXT NOT NULL, data TEXT NOT NULL);`);
    // Additive upgrade: old callers still advance the fence through SQLite
    // triggers. A→B→A cannot resurrect an old read; hashing a long transcript
    // on every page is deliberately avoided.
    db.exec('CREATE TABLE IF NOT EXISTS hermes_history_revisions (key TEXT PRIMARY KEY, revision INTEGER NOT NULL)');
    for (const [table, column] of [['hermes_sessions', 'key'], ['hermes_executions', 'session_key'], ['hermes_deletions', 'key']]) {
      for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
        const refs = action === 'INSERT' ? ['NEW'] : action === 'DELETE' ? ['OLD'] : ['OLD', 'NEW'];
        db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_history_${action.toLowerCase()} AFTER ${action} ON ${table}
          BEGIN ${refs.map(ref => `INSERT INTO hermes_history_revisions VALUES (${ref}.${column}, 1)
            ON CONFLICT(key) DO UPDATE SET revision = revision + 1;`).join(' ')} END`);
      }
    }
  }
  sessions() { return (this.db.prepare('SELECT data FROM hermes_sessions ORDER BY key').all() as { data: string }[]).map(r => JSON.parse(r.data) as HermesSession); }
  sessionPage(after: string, limit: number): string[] {
    return (this.db.prepare('SELECT key FROM hermes_sessions WHERE key > ? ORDER BY key LIMIT ?')
      .all(after, limit) as { key: string }[]).map(row => row.key);
  }
  lifecyclePage(after: string, limit: number): string[] {
    return (this.db.prepare(`SELECT key FROM (SELECT key FROM hermes_sessions UNION
      SELECT key FROM hermes_deletions WHERE state = 'accepted') WHERE key > ? ORDER BY key LIMIT ?`)
      .all(after, limit) as { key: string }[]).map(row => row.key);
  }
  lifecycleSnapshot(key: string): HermesLifecycleSnapshot {
    const row = this.db.prepare("SELECT json_extract(data, '$.title') AS title FROM hermes_sessions WHERE key = ?")
      .get(key) as { title: string } | undefined;
    const deletion = this.deletion(key) ?? null;
    return { key, digest: this.historyDigest(key), title: deletion === 'accepted' ? null : row?.title ?? null,
      execution: row && deletion !== 'accepted' ? this.current(key) ?? null : null, deletion };
  }
  /** Upgrade repair stays in the original journal transaction. It never
   * changes execution identity or supplies permission to replay native work. */
  repairToolsPage(key: string, after: number, limit: number): number | null {
    return this.atomic(() => {
      if (this.deletion(key)) return null;
      const session = this.session(key); if (!session) return null;
      const rows = this.db.prepare('SELECT rowid AS cursor, data FROM hermes_executions WHERE session_key = ? AND rowid > ? ORDER BY rowid LIMIT ?')
        .all(key, after, limit) as { cursor: number; data: string }[];
      let repaired = session;
      for (const row of rows) {
        const execution = JSON.parse(row.data) as HermesExecution;
        if (execution.phase === 'starting' || execution.phase === 'running') continue;
        const results = hermesUnconfirmedTools(repaired, execution);
        if (results.length) repaired = { ...repaired, messages: [...repaired.messages, ...results] };
      }
      if (repaired !== session) this.save(repaired);
      return rows.length === limit ? rows.at(-1)!.cursor : null;
    });
  }
  session(key: string): HermesSession | undefined {
    const row = this.db.prepare('SELECT data FROM hermes_sessions WHERE key = ?').get(key) as { data: string } | undefined;
    return row && JSON.parse(row.data) as HermesSession;
  }
  save(session: HermesSession) {
    if (this.deletion(session.key)) throw new Error('Hermes session deletion is pending or accepted');
    this.db.prepare('INSERT INTO hermes_sessions VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data=excluded.data').run(session.key, JSON.stringify(session));
  }
  /** Native creation is not rollback-capable. Its original identity, receipt
   * and event must commit together; a failed commit never permits re-create. */
  create(session: HermesSession, commit: (db: DatabaseSync) => void) {
    return this.atomic(() => {
      if (this.session(session.key) || this.deletion(session.key)) throw Error('Hermes identity already exists');
      this.db.prepare('INSERT INTO hermes_sessions VALUES (?, ?)').run(session.key, JSON.stringify(session));
      commit(this.db);
    });
  }
  /** Optimistic evidence fence, not a native permission lease. No SQL transaction
   * survives native I/O; every write rechecks the original persisted state. */
  historySnapshot(key: string): HermesHistorySnapshot | null {
    const session = this.session(key);
    if (!session || this.deletion(key)) return null;
    const execution = this.current(key);
    return { key, stored: session.stored, title: session.title, started: session.started,
      ...(session.nativeAllocated === true ? { nativeAllocated: true as const } : {}),
      unknown: execution?.phase === 'unknown',
      digest: this.historyDigest(key) };
  }
  private historyDigest(key: string): string {
    const row = this.db.prepare('SELECT revision FROM hermes_history_revisions WHERE key = ?').get(key) as { revision: number } | undefined;
    return createHash('sha256').update(JSON.stringify([key, row?.revision ?? 0])).digest('hex');
  }
  /** Bounded public read fence; do not deserialize an entire long transcript
   * merely to authenticate a history page or state request. */
  readIdentity(key: string): { stored: string; digest: string } | null {
    if (this.deletion(key)) return null;
    const row = this.db.prepare("SELECT json_extract(data, '$.stored') AS stored FROM hermes_sessions WHERE key = ?")
      .get(key) as { stored: string } | undefined;
    return row ? { stored: row.stored, digest: this.historyDigest(key) } : null;
  }
  attachSnapshot(key: string, digest: string, stored: string): HermesHistorySnapshot | null {
    return this.atomic(() => {
      const snapshot = this.historySnapshot(key);
      if (!snapshot || snapshot.unknown || snapshot.digest !== digest
        || (snapshot.started || snapshot.nativeAllocated === true) && snapshot.stored !== stored) return null;
      this.save({ ...this.session(key)!, stored });
      return this.historySnapshot(key);
    });
  }
  commitHistory(key: string, digest: string, rows: HermesHistoryRow[]): HermesHistorySnapshot | null {
    return this.atomic(() => {
      const snapshot = this.historySnapshot(key);
      if (!snapshot || snapshot.unknown || snapshot.digest !== digest) return null;
      const session = this.session(key)!;
      const bindings = this.bindings(key, rows.flatMap(row => row.role === 'user' && row.row_id !== undefined ? [row.row_id] : []));
      this.save({ ...session, messages: hermesHistory(session, bindings, rows) });
      return this.historySnapshot(key);
    });
  }
  historyProjection(key: string, digest: string, offset: number, limit: number): HermesHistoryPage | null {
    return this.readHistoryProjection(key, digest, offset, limit, false);
  }
  lifecycleHistoryProjection(key: string, digest: string, offset: number, limit: number): HermesHistoryPage | null {
    return this.readHistoryProjection(key, digest, offset, limit, true);
  }
  private readHistoryProjection(key: string, digest: string, offset: number, limit: number, pending: boolean): HermesHistoryPage | null {
    const deletion = this.deletion(key);
    if (this.historyDigest(key) !== digest || deletion && (!pending || deletion === 'accepted')) return null;
    const total = this.db.prepare("SELECT json_array_length(data, '$.messages') AS count FROM hermes_sessions WHERE key = ?")
      .get(key) as { count: number } | undefined;
    if (!total || !Number.isSafeInteger(offset) || offset < 0 || offset > total.count
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 64) return null;
    // Page inside SQLite: do not materialize the entire long session as JS
    // objects on every IPC page. The original hot runtime reads it only once.
    const records = this.db.prepare("SELECT length(CAST(item.value AS BLOB)) AS bytes, CASE WHEN length(CAST(item.value AS BLOB)) <= 524288 THEN item.value ELSE NULL END AS data FROM hermes_sessions, json_each(hermes_sessions.data, '$.messages') AS item WHERE hermes_sessions.key = ? LIMIT ? OFFSET ?")
      .all(key, limit, offset) as { bytes: number; data: string | null }[];
    const messages: ChatMessage[] = []; let bytes = 0, large: HermesHistoryPage['large'] = null;
    for (const row of records) {
      if (row.bytes > 512 * 1024) {
        if (row.bytes > 64 * 1024 * 1024) throw new Error('Hermes history message exceeds projection budget');
        large = { index: offset + messages.length, bytes: row.bytes }; break;
      }
      if (bytes + row.bytes > 512 * 1024) break;
      messages.push(JSON.parse(row.data!) as ChatMessage); bytes += row.bytes;
    }
    const end = offset + messages.length + (large ? 1 : 0);
    return { key, digest, messages, large, next: end < total.count ? end : null };
  }
  historyMessagePart(key: string, digest: string, index: number, offset: number): HermesHistoryPart | null {
    return this.readHistoryMessagePart(key, digest, index, offset, false);
  }
  lifecycleHistoryMessagePart(key: string, digest: string, index: number, offset: number): HermesHistoryPart | null {
    return this.readHistoryMessagePart(key, digest, index, offset, true);
  }
  private readHistoryMessagePart(key: string, digest: string, index: number, offset: number, pending: boolean): HermesHistoryPart | null {
    const deletion = this.deletion(key);
    if (this.historyDigest(key) !== digest || deletion && (!pending || deletion === 'accepted')
      || !Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(offset) || offset < 0) return null;
    // Cut serialized JSON as bytes INSIDE SQLite. A UTF-8 code point may span
    // chunks: the consumer joins bytes before decoding, never trims text.
    // Node SQLite binds JS numbers as REAL (1 -> 1.0). Bind the internally
    // validated path as text rather than concatenating that SQL representation.
    const path = `$.messages[${index}]`;
    const row = this.db.prepare('SELECT length(CAST(json_extract(data, ?) AS BLOB)) AS total, substr(CAST(json_extract(data, ?) AS BLOB), ?, 262144) AS part FROM hermes_sessions WHERE key = ?')
      .get(path, path, offset + 1, key) as { total: number | null; part: Uint8Array | null } | undefined;
    if (!row?.part || row.total === null || row.total <= 512 * 1024 || row.total > 64 * 1024 * 1024 || offset >= row.total) return null;
    const end = offset + row.part.byteLength;
    return { key, digest, index, offset, data: Buffer.from(row.part).toString('base64'), total: row.total,
      next: end < row.total ? end : null };
  }
  historyMessages(key: string, digest: string): ChatMessage[] | null {
    if (this.historyDigest(key) !== digest || this.deletion(key)) return null;
    return this.session(key)?.messages ?? null;
  }
  deletion(key: string): 'pending' | 'accepted' | undefined {
    return (this.db.prepare('SELECT state FROM hermes_deletions WHERE key = ?').get(key) as { state: 'pending' | 'accepted' } | undefined)?.state;
  }
  deletedKeys() {
    return (this.db.prepare("SELECT key FROM hermes_deletions WHERE state = 'accepted'").all() as { key: string }[]).map(row => row.key);
  }
  beginDeletion(key: string) {
    this.db.prepare("INSERT INTO hermes_deletions VALUES (?, 'pending')").run(key);
  }
  finishDeletion(key: string, commit?: (db: DatabaseSync) => void) {
    this.atomic(() => {
      if (this.deletion(key) !== 'pending') throw new Error('Missing Hermes deletion intent');
      this.db.prepare("UPDATE hermes_deletions SET state = 'accepted' WHERE key = ?").run(key);
      this.db.prepare('DELETE FROM hermes_executions WHERE session_key = ?').run(key);
      this.db.prepare('DELETE FROM hermes_sessions WHERE key = ?').run(key);
      commit?.(this.db);
    });
  }
  executions(key: string): HermesExecution[] {
    return (this.db.prepare('SELECT data FROM hermes_executions WHERE session_key = ? ORDER BY rowid').all(key) as { data: string }[]).map(r => JSON.parse(r.data) as HermesExecution);
  }
  bindings(key: string, rows: number[]): Map<number, HermesExecution> {
    const ids = [...new Set(rows)];
    const result = new Map<number, HermesExecution>();
    // History may cover only the current lineage. Do not load and parse every
    // past execution (including prompt batches) on each history refresh.
    for (let offset = 0; offset < ids.length; offset += 400) {
      const chunk = ids.slice(offset, offset + 400);
      const records = this.db.prepare(`SELECT data FROM hermes_executions WHERE session_key = ?
        AND json_extract(data, '$.row') IN (${chunk.map(() => '?').join(',')}) ORDER BY rowid`).all(key, ...chunk) as { data: string }[];
      for (const record of records) { const execution = JSON.parse(record.data) as HermesExecution; result.set(execution.row!, execution); }
    }
    return result;
  }
  current(key: string): HermesExecution | undefined {
    const row = this.db.prepare('SELECT data FROM hermes_executions WHERE session_key = ? ORDER BY rowid DESC LIMIT 1').get(key) as { data: string } | undefined;
    return row && JSON.parse(row.data) as HermesExecution;
  }
  canStart(key: string) {
    const phase = this.current(key)?.phase;
    return !this.interruptPending(key) && (!phase || ['completed', 'failed', 'interrupted'].includes(phase));
  }
  interruptPending(key: string): boolean { return !!this.db.prepare('SELECT 1 FROM hermes_interrupts WHERE key = ?').get(key); }
  /** Called inside the original command claim transaction. Native interrupt is
   * session-scoped, so even an already terminal run cannot release successors
   * until its outstanding physical control has a durable original outcome. */
  claimInterrupt(expected: HermesExecution, receiptId: string): boolean {
    return this.atomic(() => {
      const current = this.current(expected.key);
      if (!this.sameExecution(current, expected) || current!.row !== expected.row || current!.phase !== 'running'
        || !this.session(expected.key) || this.deletion(expected.key) || this.interruptPending(expected.key)) return false;
      this.db.prepare('INSERT INTO hermes_interrupts VALUES (?, ?, ?)').run(expected.key, receiptId, JSON.stringify(expected));
      return true;
    });
  }
  interruptMatches(expected: HermesExecution, receiptId: string): boolean {
    const row = this.db.prepare('SELECT data FROM hermes_interrupts WHERE key = ? AND receipt_id = ?')
      .get(expected.key, receiptId) as { data: string } | undefined;
    if (!row) return false;
    const original = JSON.parse(row.data) as HermesExecution;
    return this.sameExecution(original, expected) && original.row === expected.row;
  }
  settleInterrupt(expected: HermesExecution, receiptId: string, commit: () => void): boolean {
    return this.atomic(() => {
      if (!this.interruptMatches(expected, receiptId)) return false;
      synchronousSqliteValue(this.db, commit);
      this.db.prepare('DELETE FROM hermes_interrupts WHERE key = ? AND receipt_id = ?').run(expected.key, receiptId);
      return true;
    });
  }
  maintenancePending(): number {
    // Include unresolved older executions as well as the latest per session.
    const executions = (this.db.prepare("SELECT count(*) AS count FROM hermes_executions WHERE phase NOT IN ('completed', 'failed', 'interrupted')")
      .get() as { count: number }).count;
    const deletions = (this.db.prepare("SELECT count(*) AS count FROM hermes_deletions WHERE state <> 'accepted'")
      .get() as { count: number }).count;
    const interrupts = (this.db.prepare('SELECT count(*) AS count FROM hermes_interrupts').get() as { count: number }).count;
    return executions + deletions + interrupts;
  }
  update(execution: HermesExecution) {
    this.db.prepare('INSERT INTO hermes_executions VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET phase=excluded.phase,data=excluded.data')
      .run(execution.id, execution.key, execution.phase, JSON.stringify(execution));
  }
  begin(execution: HermesExecution, turns: TurnQueue, authorize?: () => boolean) {
    return this.atomic(() => {
      if (authorize && !this.checkPermission(authorize, [])) return false;
      if (this.db.prepare('SELECT 1 FROM hermes_executions WHERE id = ?').get(execution.id)
        || !this.session(execution.key) || this.deletion(execution.key) || !this.canStart(execution.key)
        || !turns.startBatch('hermes', execution.key, execution.members)) return false;
      const session = this.session(execution.key)!;
      this.save({ ...session, started: true }); this.update(execution); return true;
    });
  }
  admitted(execution: HermesExecution, turns: TurnQueue) {
    return this.atomic(() => {
      const current = this.current(execution.key);
      if (!this.sameExecution(current, execution) || this.deletion(execution.key)
        || current!.phase !== 'starting' || execution.phase !== 'running'
        || !Number.isSafeInteger(execution.row) || execution.row! <= 0) return false;
      this.update(execution);
      for (const id of execution.members) turns.completeInTransaction(this.db, 'hermes', id);
      return true;
    });
  }
  unknown(execution: HermesExecution, turns: TurnQueue) {
    return this.atomic(() => {
      const current = this.current(execution.key);
      if (!this.sameExecution(current, execution) || !['starting', 'running', 'unknown'].includes(current!.phase)) return false;
      // Preserve the original row/batch, not an executor's stale pre-ACK copy.
      if (current!.phase !== 'unknown') this.update({ ...current!, phase: 'unknown', updated: Date.now() });
      for (const id of current!.members) if (turns.hasCommand('hermes', id)) turns.uncertain('hermes', id);
      const session = this.session(current!.key);
      if (session && !this.deletion(current!.key)) {
        const results = hermesUnconfirmedTools(session, current!);
        if (results.length) this.save({ ...session, messages: [...session.messages, ...results] });
      }
      return true;
    });
  }
  private sameExecution(current: HermesExecution | undefined, expected: HermesExecution): boolean {
    return !!current && ['id', 'key', 'live', 'epoch', 'at'].every(field =>
      current[field as keyof HermesExecution] === expected[field as keyof HermesExecution])
      && JSON.stringify(current.members) === JSON.stringify(expected.members)
      && JSON.stringify(current.batch) === JSON.stringify(expected.batch);
  }
  /** Native tool facts share the original execution transaction. No arbitrary
   * tool arguments/results or caller-built messages enter the journal. */
  observeTool(expected: HermesExecution, observation: HermesToolObservation): ChatMessage | null {
    return this.atomic(() => {
      const current = this.current(expected.key), session = this.session(expected.key);
      if (!session || this.deletion(expected.key) || !this.sameExecution(current, expected)
        || !['starting', 'running'].includes(current!.phase) || !['starting', 'running'].includes(expected.phase)) return null;
      const toolCallId = `${current!.id}:${observation.toolId}`;
      const id = `hermes-tool:${toolCallId}:${observation.phase}`;
      const previous = session.messages.find(message => message.id === id);
      if (previous) return previous;
      const call = session.messages.find(message => message.toolCallId === toolCallId && message.toolPhase === 'call');
      const name = observation.name ?? call?.toolName ?? 'tool';
      const message: ChatMessage = { id, sessionKey: expected.key, turnId: current!.id,
        role: 'tool', toolCallId, toolName: name, toolPhase: observation.phase,
        text: `Tool: ${name}\n${observation.phase === 'call' ? 'Started' : 'Completed'}`,
        status: observation.phase === 'call' ? 'sending' : 'sent', createdAt: observation.at };
      this.save({ ...session, messages: [...session.messages, message] });
      return message;
    });
  }
  /** A native terminal proof settles the ORIGINAL running row and history in
   * one transaction. It never recovers unknown, replays a prompt or dispatches. */
  settleTerminal(expected: HermesExecution, phase: 'completed' | 'failed' | 'interrupted', stored: string, rows: HermesHistoryRow[]): boolean {
    return this.atomic(() => {
      const current = this.current(expected.key), session = this.session(expected.key);
      if (!session || this.deletion(expected.key) || !this.sameExecution(current, expected)
        || current!.phase !== 'running' || expected.phase !== 'running' || !current!.row || current!.row !== expected.row
        || !rows.some(row => row.role === 'user' && row.row_id === current!.row)) return false;
      const tools = hermesUnconfirmedTools(session, current!);
      const anchored = { ...session, stored, messages: [...session.messages, ...tools] };
      const bindings = this.bindings(expected.key, rows.flatMap(row => row.role === 'user' && row.row_id !== undefined ? [row.row_id] : []));
      this.save({ ...anchored, messages: hermesHistory(anchored, bindings, rows) });
      this.update({ ...current!, phase, updated: Date.now() });
      return true;
    });
  }
  recoverPage(after: string, limit: number, turns: TurnQueue): string[] {
    return this.atomic(() => {
      const page = this.sessionPage(after, limit);
      for (const key of page) {
        const current = this.current(key);
        if (current && !this.canStart(key)) this.unknown(current, turns);
      }
      return page;
    });
  }
  recover(turns: TurnQueue) {
    let after = '';
    while (true) {
      const page = this.recoverPage(after, 64, turns);
      if (page.length < 64) return;
      after = page.at(-1)!;
    }
  }
  private atomic<T>(fn: () => T): T {
    return observedSavepoint(this.db, 'hermes-journal-change', () => fn() as T extends PromiseLike<unknown> ? never : T);
  }
}
