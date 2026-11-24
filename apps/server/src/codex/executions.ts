import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { types } from 'node:util';
import { validBoardUuid } from '@agentopsdeck/shared';
import type { ConnectorEventLog } from '../connector/event-log.js';
import type { CommandExecutionSink } from '../commands/receipts.js';
import type { CodexBatch } from './queued-batch.js';
import type { ChatMessage } from '@agentopsdeck/shared';
import { normalizeTurnContext, validTurnContextProof, type TurnContextProof } from './turn-context.js';
import { registerNativeHistoryWriter, requireNativeHistoryWriter, type NativeHistoryCheckpoint } from './native-history.js';
import { initializeStoppedCodexRecovery, hasStoppedCodexRecovery, validStoppedCodexRuns, type StoppedCodexRun } from './stopped-recovery.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { markConnectionCleanupFault, requireConnectionReady, retireConnectionForAsyncWork } from '../storage/connection-recovery.js';
import { addSqlFailure } from '../storage/sql-failure-diagnostics.js';
import { withSynchronousParticipants } from '../storage/synchronous-participant.js';
import { CodexNativeResumes, nativeResumeEligible } from './native-resume.js';
import { CodexOwnedThreadLoads } from './owned-thread-load.js';

type WorkBoundary = { escaped: boolean };
// A void callback type still accepts async functions. Inspect every external
// transaction participant, not just the outer wrapper that may discard returns.
function requireSynchronousResult(value: unknown, boundary: WorkBoundary) {
  if (boundary.escaped) throw new Error('Execution transaction work must be synchronous');
  boundary.escaped = types.isPromise(value);
  if (!boundary.escaped && value !== null && (typeof value === 'object' || typeof value === 'function')) {
    boundary.escaped = true; // A throwing getter also leaves an uncertain owner.
    boundary.escaped = typeof (value as { then?: unknown }).then === 'function';
  }
  if (!boundary.escaped) return;
  // Do not call an arbitrary thenable. Native promises (even with hidden then)
  // are observed without granting their continuation SQL authority or replay.
  try { void Promise.prototype.then.call(value, () => {}, () => {}); } catch { /* Not a native Promise. */ }
  throw new Error('Execution transaction work must be synchronous');
}

export type CodexExecutionPhase = 'starting' | 'running' | 'unknown' | 'completed' | 'failed' | 'interrupted';
type Observation = { runId: string; phase: Exclude<CodexExecutionPhase, 'starting' | 'unknown'>; at: number };
export type CodexExecution = {
  sessionKey: string; commandId: string; connectionId: string; runId?: string;
  phase: CodexExecutionPhase; sync: 'current' | 'syncing' | 'error';
  revision: number; startedAt: number; updatedAt: number; completedAt?: number;
  preparation?: 'active' | 'ready';
  pendingCommandTools?: string[];
  batch?: CodexBatch;
  nativeHistory?: NativeHistoryCheckpoint;
  reason?: 'restarted' | 'send_unknown' | 'preparation_unknown' | 'identity_conflict' | 'evidence_overflow';
};
type Fact = CodexExecution & { pending: Observation[]; fenced?: boolean };
export type CodexDispatchFailureExpected = Pick<CodexExecution, 'commandId' | 'connectionId' | 'revision'> | null;
export type CodexDispatchFailureOutcome = 'blocked' | 'outcome_unknown';
const terminal = (phase: CodexExecutionPhase) => ['completed', 'failed', 'interrupted'].includes(phase);
const maintenanceTerminal = `NOT EXISTS (SELECT 1 FROM connector_codex_native_resume AS resume
    WHERE resume.session_key = connector_codex_executions.session_key)
  AND coalesce(json_extract(fact, '$.fenced'), 0) = 0
  AND json_extract(fact, '$.preparation') IS NULL
  AND coalesce(length(json_extract(fact, '$.runId')), 0) > 0
  AND coalesce(json_extract(fact, '$.phase'), '') IN ('completed', 'failed', 'interrupted')`;
const validId = (value: unknown, limit: number): value is string => typeof value === 'string' && !!value.trim()
  && !/[\u0000-\u001f\u007f]/.test(value) && Buffer.byteLength(JSON.stringify(value)) <= limit;

/** Current facts, not a second command queue or transcript. Reserve 8 KiB per
 * session (16 MiB total) so ACK/terminal metadata cannot exhaust admission's
 * quota. No expiry/eviction of unresolved execution or command identity.
 */
export class CodexExecutions {
  readonly nativeResumes: CodexNativeResumes;
  readonly ownedThreadLoads: CodexOwnedThreadLoads;
  // Cache statements, never facts: each call still reads the owning connection's
  // current transaction. Keep recovery paging bounded and callbacks synchronous.
  private readonly readFact: StatementSync;
  private readonly writeFact: StatementSync;
  private readonly scanFacts: StatementSync;
  private readonly hasContext: StatementSync;
  private readonly readContext: StatementSync;
  // Power-of-two sizes cap this cache at eight connection-owned statements.
  // Results are never retained; small/tail batches avoid 128-slot binding cost.
  private readonly contextBatches = new Map<number, StatementSync>();
  constructor(private readonly db: DatabaseSync, private readonly journal?: Pick<ConnectorEventLog, 'appendInTransaction' | 'changes'>,
    private readonly maxRows = 2048, private readonly now = Date.now,
    private readonly sessionAvailable: (sessionKey: string) => boolean = () => true,
    private readonly commandEvidence?: CommandExecutionSink,
    private readonly deletionAccepted: (sessionKey: string) => boolean = () => false,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 2048) throw new Error('Invalid Codex execution capacity');
    registerNativeHistoryWriter(db);
    db.exec(`CREATE TABLE IF NOT EXISTS connector_codex_executions (
      session_key TEXT PRIMARY KEY, fact TEXT NOT NULL CHECK(length(CAST(fact AS BLOB)) <= 8192)
    );
    CREATE INDEX IF NOT EXISTS connector_codex_sync ON connector_codex_executions(session_key)
      WHERE json_extract(fact, '$.phase') IN ('completed', 'failed', 'interrupted')
        AND json_extract(fact, '$.sync') <> 'current';
    CREATE INDEX IF NOT EXISTS connector_codex_running ON connector_codex_executions(json_extract(fact, '$.connectionId'), session_key)
      WHERE json_extract(fact, '$.phase') = 'running' AND json_extract(fact, '$.runId') IS NOT NULL;
    CREATE INDEX IF NOT EXISTS connector_codex_restarted ON connector_codex_executions(session_key)
      WHERE json_extract(fact, '$.phase') = 'unknown' AND json_extract(fact, '$.reason') = 'restarted'
        AND json_extract(fact, '$.runId') IS NOT NULL;
    CREATE INDEX IF NOT EXISTS connector_codex_native_blocked ON connector_codex_executions(session_key)
      WHERE json_extract(fact, '$.nativeHistory.state') = 'blocked';`);
    db.exec(`CREATE TABLE IF NOT EXISTS connector_codex_batch_history (
      session_key TEXT NOT NULL, run_id TEXT NOT NULL, metadata TEXT NOT NULL CHECK(length(CAST(metadata AS BLOB)) <= 8192),
      PRIMARY KEY(session_key, run_id)
    )`);
    initializeStoppedCodexRecovery(db);
    this.nativeResumes = new CodexNativeResumes(db, key => this.read(key), deletionAccepted,
      (sessionKey, take) => this.change(sessionKey, fact => {
        const expected = take();
        if (!expected) return;
        if (!fact || fact.commandId !== expected.commandId || fact.runId !== expected.runId
          || fact.connectionId !== expected.connectionId || !nativeResumeEligible(fact)) throw Error('Native resume execution changed');
        // Same original fact/write/evidence/journal transaction, not a second
        // writer. Preserve stronger fences and idempotent Goal invalidation.
        if (!fact.fenced && !(fact.sync === 'syncing' && fact.nativeHistory?.state === 'blocked'
          && fact.nativeHistory.reason === 'changed')) {
          fact.nativeHistory = { ...(fact.nativeHistory ?? { turnId: fact.runId!,
            fingerprint: '0'.repeat(64), connectionId: fact.connectionId }), state: 'blocked', reason: 'changed' };
          fact.sync = 'syncing';
        }
        return fact;
      }), diagnostics);
    this.ownedThreadLoads = new CodexOwnedThreadLoads(db, key => this.read(key), deletionAccepted,
      () => this.nativeResumes.writerFence());
    db.exec(`CREATE TABLE IF NOT EXISTS connector_codex_board_tools (
      thread_id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version = 1)
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS connector_codex_turn_context (
      session_key TEXT NOT NULL, command_id TEXT NOT NULL, run_id TEXT,
      hash TEXT NOT NULL CHECK(length(hash) = 64), original_length INTEGER NOT NULL,
      PRIMARY KEY(session_key, command_id)
    );
    CREATE INDEX IF NOT EXISTS connector_codex_context_run ON connector_codex_turn_context(session_key, run_id);`);
    this.readFact = db.prepare('SELECT fact FROM connector_codex_executions WHERE session_key = ?');
    this.writeFact = db.prepare(`INSERT INTO connector_codex_executions VALUES (?, ?)
      ON CONFLICT(session_key) DO UPDATE SET fact = excluded.fact`);
    this.scanFacts = db.prepare('SELECT session_key, fact FROM connector_codex_executions WHERE session_key > ? ORDER BY session_key LIMIT 64');
    this.hasContext = db.prepare('SELECT 1 FROM connector_codex_turn_context WHERE session_key = ? LIMIT 1');
    // Keep command_id in the UNION key: distinct proofs with equal hashes and
    // lengths remain ambiguous. The OR form can scan every proof in a session.
    // Two run matches already prove ambiguity; bound that branch before UNION.
    this.readContext = db.prepare(`SELECT command_id AS commandId, hash, original_length AS originalLength
      FROM connector_codex_turn_context WHERE session_key = ? AND command_id = ?
      UNION SELECT commandId, hash, originalLength FROM (
        SELECT command_id AS commandId, hash, original_length AS originalLength
        FROM connector_codex_turn_context INDEXED BY connector_codex_context_run WHERE session_key = ? AND run_id = ? LIMIT 2
      ) LIMIT 2`);
  }

  normalizeTurnContext(message: ChatMessage): ChatMessage {
    if (message.role !== 'user') return message;
    return normalizeTurnContext(message, this.turnContextProof(message.sessionKey, message.id, message.turnId));
  }

  /** Identity-only evidence for the original display consumer. Never authority
   * to dispatch. LIMIT 2 retains ambiguity even when distinct rows hash equally. */
  turnContextProof(sessionKey: string, id: string, turnId?: string): TurnContextProof | undefined {
    const rows = this.readContext.all(sessionKey, id, sessionKey, turnId ?? '') as TurnContextProof[];
    return rows.length === 1 ? { hash: rows[0]!.hash, originalLength: rows[0]!.originalLength } : undefined;
  }

  normalizeTurnContexts(sessionKey: string, messages: ChatMessage[]): ChatMessage[] {
    // Ordinary sessions pay one indexed existence check, not one SQL read per
    // historical user message. File-enabled sessions query bounded ID batches.
    const trace = this.diagnostics.start('codex-context-normalize'), at = performance.now();
    let failed = true;
    try {
      if (!this.hasContext.get(sessionKey)) {
        trace.add('records', 0); trace.add('changed', 0); failed = false; return messages;
      }
      const result = [...messages];
      const users = messages.map((message, index) => ({ message, index })).filter(({ message }) => message.role === 'user');
      let changed = 0;
      for (let offset = 0; offset < users.length; offset += 128) {
        const batch = users.slice(offset, offset + 128);
        let size = 1;
        while (size < batch.length) size *= 2;
        let query = this.contextBatches.get(size);
        if (!query) {
          const placeholders = Array<string>(size).fill('?').join(',');
          query = this.db.prepare(`SELECT command_id AS commandId, run_id AS runId, hash, original_length AS originalLength
            FROM connector_codex_turn_context WHERE session_key = ? AND command_id IN (${placeholders})
            UNION SELECT command_id AS commandId, run_id AS runId, hash, original_length AS originalLength
            FROM connector_codex_turn_context INDEXED BY connector_codex_context_run WHERE session_key = ? AND run_id IN (${placeholders})`);
          this.contextBatches.set(size, query);
        }
        // NULL cannot match a stored identity. Empty strings are real identities,
        // including the existing missing-run lookup convention, not padding.
        const commandsInput = Array<string | null>(size).fill(null), runsInput = Array<string | null>(size).fill(null);
        batch.forEach(({ message }, index) => { commandsInput[index] = message.id; runsInput[index] = message.turnId ?? ''; });
        type ProofRow = TurnContextProof & { commandId: string; runId: string | null };
        const rows = query.all(sessionKey, ...commandsInput, sessionKey, ...runsInput) as ProofRow[];
        trace.add('records', rows.length);
        // Batch-local identity indexes, never a proof/result cache. A null value
        // means multiple distinct rows: do not normalize ambiguous evidence.
        const commands = new Map<string, ProofRow | null>(), runs = new Map<string, ProofRow | null>();
        const indexProof = (index: Map<string, ProofRow | null>, key: string, row: ProofRow) => {
          index.set(key, index.has(key) ? null : row);
        };
        for (const row of rows) {
          indexProof(commands, row.commandId, row);
          if (row.runId !== null) indexProof(runs, row.runId, row);
        }
        for (const { message, index } of batch) {
          if (message.sessionKey !== sessionKey) continue;
          const command = commands.get(message.id), run = message.turnId === undefined ? undefined : runs.get(message.turnId);
          if (command === null || run === null || (command && run && command !== run)) continue;
          const proof = command ?? run;
          if (proof) {
            result[index] = normalizeTurnContext(message, proof);
            if (result[index] !== message) changed++;
          }
        }
      }
      trace.add('changed', changed); failed = false; return result;
    } finally { trace.add('bodyMs', performance.now() - at); trace.finish(failed); }
  }

  canEnrollBoardTools(reservations = 0): boolean {
    return Number.isSafeInteger(reservations) && reservations >= 0
      && Number((this.db.prepare('SELECT count(*) AS n FROM connector_codex_board_tools').get() as { n: number }).n) + reservations < this.maxRows;
  }
  enrollBoardTools(threadId: string): void {
    if (!validBoardUuid(threadId)) throw new Error('Invalid task tool thread');
    if (this.hasBoardTools(threadId)) return;
    if (!this.canEnrollBoardTools()) throw new Error('Task tool thread capacity reached');
    this.db.prepare('INSERT INTO connector_codex_board_tools(thread_id, version) VALUES (?, 1)').run(threadId);
  }
  hasBoardTools(threadId: string): boolean {
    return validBoardUuid(threadId) && !!this.db.prepare('SELECT 1 FROM connector_codex_board_tools WHERE thread_id = ? AND version = 1').get(threadId);
  }

  cleanupRecovered(sessionKey: string, runId: string): boolean {
    const fact = this.read(sessionKey);
    return !!fact?.runId && hasStoppedCodexRecovery(this.db, { ...fact, runId: fact.runId }, runId);
  }

  maintenanceRecoveryRuns(): StoppedCodexRun[] | undefined {
    const runs = this.db.prepare(`SELECT session_key AS sessionKey,
      json_extract(fact, '$.commandId') AS commandId, json_extract(fact, '$.connectionId') AS connectionId,
      json_extract(fact, '$.runId') AS runId, json_extract(fact, '$.revision') AS revision
      FROM connector_codex_executions WHERE ${maintenanceTerminal}
      AND json_extract(fact, '$.phase') = 'interrupted' AND json_extract(fact, '$.reason') IS NULL
      AND (json_extract(fact, '$.sync') IN ('syncing', 'error') OR (json_extract(fact, '$.sync') = 'current' AND json_extract(fact, '$.nativeHistory.state') = 'blocked' AND json_extract(fact, '$.nativeHistory.reason') = 'cleanup-unconfirmed')) ORDER BY session_key LIMIT 65`).all();
    return validStoppedCodexRuns(runs) ? runs : undefined;
  }

  batchForRun(sessionKey: string, runId: string): CodexBatch | undefined {
    const row = this.db.prepare('SELECT metadata FROM connector_codex_batch_history WHERE session_key = ? AND run_id = ?')
      .get(sessionKey, runId) as { metadata: string } | undefined;
    return row ? JSON.parse(row.metadata) as CodexBatch : undefined;
  }

  get(sessionKey: string): CodexExecution | undefined {
    const fact = this.read(sessionKey);
    if (!fact) return;
    const { pending: _pending, fenced: _fenced, ...result } = fact;
    return result;
  }

  // This opt-in is only for a queued user message after a fresh native proof.
  // It never makes a blocked goal generally idle/compactable/maintenance-ready.
  canStart(sessionKey: string, blockedGoalInput = false) {
    if (this.deletionAccepted(sessionKey) || this.nativeResumes.pending(sessionKey)) return false;
    const fact = this.read(sessionKey);
    return !fact || (!fact.fenced && !!fact.runId && terminal(fact.phase) && fact.sync === 'current'
      && (!fact.nativeHistory || fact.nativeHistory.state === 'verified'
        || blockedGoalInput && fact.nativeHistory.reason === 'goal-blocked'));
  }

  maintenancePending(options: { historyRecovery?: boolean } = {}): number {
    // Unknown outcomes and terminal-but-unsynced history are not idle proof.
    // SQL reads metadata only; do not deserialize queued batch content.
    return (this.db.prepare(`SELECT session_key FROM connector_codex_executions
      WHERE NOT (${maintenanceTerminal}
        AND NOT (coalesce(json_extract(fact, '$.nativeHistory.state'), '') = 'blocked'
          AND coalesce(json_extract(fact, '$.nativeHistory.reason'), '') = 'cleanup-unconfirmed')
        AND (coalesce(json_extract(fact, '$.sync'), '') = 'current'
          OR (? = 1 AND coalesce(json_extract(fact, '$.sync'), '') IN ('syncing', 'error'))))`).all(options.historyRecovery ? 1 : 0) as { session_key: string }[])
      .filter(row => !this.isDeletedTerminal(row.session_key)).length;
  }

  /** An acknowledged native archive retires the projection, not the execution
   * fact. Its history need not be rehydrated after restart. Neither a missing
   * projection nor an uncertain deletion is archive evidence. Native-loaded
   * threads/terminals are still inspected independently for maintenance.
   */
  isDeletedTerminal(sessionKey: string): boolean {
    if (!this.deletionAccepted(sessionKey)) return false;
    return !!this.db.prepare(`SELECT 1 FROM connector_codex_executions WHERE session_key = ?
      AND ${maintenanceTerminal} AND json_extract(fact, '$.reason') IS NULL`).get(sessionKey);
  }

  maintenanceHistorySessions(): string[] {
    // Bounded by the execution table's capacity. Only metadata leaves SQLite;
    // a durable terminal is recoverable history, never permission to start work.
    return (this.db.prepare(`SELECT session_key FROM connector_codex_executions
      WHERE ${maintenanceTerminal} AND json_extract(fact, '$.sync') IN ('syncing', 'error')
      ORDER BY session_key`).all() as { session_key: string }[])
      .map(row => row.session_key).filter(key => !this.isDeletedTerminal(key));
  }

  canChangeSettings(sessionKey: string) {
    if (this.deletionAccepted(sessionKey) || this.nativeResumes.pending(sessionKey)) return false;
    const fact = this.read(sessionKey);
    return !fact || (!fact.fenced && !fact.preparation && !!fact.runId && (fact.phase === 'running' || terminal(fact.phase)));
  }

  sessionPage(after: string, limit: number) {
    return (this.db.prepare('SELECT session_key FROM connector_codex_executions WHERE session_key > ? ORDER BY session_key LIMIT ?')
      .all(after, Math.max(1, Math.min(64, limit))) as { session_key: string }[]).map((row) => row.session_key);
  }

  recoveryPage(after: string, limit: number, connectionId?: string) {
    const size = Math.max(1, Math.min(64, limit));
    const query = this.db.prepare(`SELECT session_key FROM connector_codex_executions WHERE session_key > ?
      AND json_extract(fact, '$.phase') IN ('completed', 'failed', 'interrupted')
      AND json_extract(fact, '$.sync') <> 'current'
      UNION SELECT session_key FROM connector_codex_executions WHERE session_key > ?
      AND json_extract(fact, '$.nativeHistory.state') = 'blocked'
      UNION SELECT session_key FROM connector_codex_executions WHERE session_key > ?
      AND json_extract(fact, '$.phase') = 'running' AND json_extract(fact, '$.runId') IS NOT NULL
      AND json_extract(fact, '$.connectionId') = ?
      UNION SELECT session_key FROM connector_codex_executions WHERE session_key > ?
      AND json_extract(fact, '$.phase') = 'unknown' AND json_extract(fact, '$.reason') = 'restarted'
      AND json_extract(fact, '$.runId') IS NOT NULL
      AND json_extract(fact, '$.fenced') IS NOT 1 AND json_extract(fact, '$.preparation') IS NULL
      ORDER BY session_key LIMIT ?`);
    const result: string[] = [];
    // Keep indexed, bounded pages. Continue past archived rows so they cannot
    // starve later live work, without scanning all facts on every worker tick.
    for (;;) {
      const rows = query.all(after, after, after, connectionId ?? null, after, size) as { session_key: string }[];
      result.push(...rows.map(row => row.session_key).filter(key => !this.isDeletedTerminal(key)));
      if (rows.length < size || result.length >= size) return result.slice(0, size);
      after = rows.at(-1)!.session_key;
    }
  }

  begin(sessionKey: string, commandId: string, connectionId: string, preparing = false, batch?: CodexBatch, blockedGoalInput = false, context?: TurnContextProof,
    admit?: (db: DatabaseSync) => void, predecessor?: CodexDispatchFailureExpected) {
    if (!validId(sessionKey, 4096) || !validId(commandId, 512) || !validId(connectionId, 128)) throw new Error('Invalid Codex execution identity');
    if (context && (preparing || !validTurnContextProof(context))) throw new Error('Invalid Codex turn context proof');
    if (batch && (batch.members.length < 2 || batch.members.length > 16 || batch.members[0]?.id !== commandId
      || new Set(batch.members.map(member => member.id)).size !== batch.members.length
      || batch.members.some(member => !validId(member.id, 512) || !Number.isFinite(member.createdAt)
        || !Number.isSafeInteger(member.imageCount) || member.imageCount < 0)
      || !batch.separator || Buffer.byteLength(JSON.stringify({sessionKey,commandId,connectionId,batch})) > 4800)) {
      throw new Error('Invalid Codex batch identity');
    }
    return this.change(sessionKey, (before) => {
      if (!this.sessionAvailable(sessionKey)) return;
      // Async scheduler observations may span worker turns. Bind the original
      // native/history proof to this exact predecessor INSIDE admission's
      // transaction, including an observed absence. Never clear a newer head.
      if (predecessor !== undefined && (predecessor === null ? !!before : !before
        || before.commandId !== predecessor.commandId || before.connectionId !== predecessor.connectionId
        || before.revision !== predecessor.revision)) return;
      if (!preparing && before?.commandId === commandId && before.connectionId === connectionId
        && before.phase === 'starting' && before.preparation === 'ready' && !before.fenced) {
        if (JSON.stringify(before.batch) !== JSON.stringify(batch)) return;
        delete before.preparation;
        return before;
      }
      if (before && (before.commandId === commandId || !this.canStart(sessionKey, blockedGoalInput && !preparing)
        || before.nativeHistory && before.nativeHistory.connectionId !== connectionId)) return;
      if (!before && (this.db.prepare('SELECT count(*) AS n FROM connector_codex_executions').get() as { n: number }).n >= this.maxRows) {
        throw new Error('Codex execution capacity reached');
      }
      const at = this.now();
      return { sessionKey, commandId, connectionId, phase: 'starting', sync: 'current', revision: 0, startedAt: at, updatedAt: at, pending: [],
        ...(batch ? { batch } : {}),
        ...(preparing ? { preparation: 'active' as const } : {}) };
    }, db => {
      // The fixed dispatch domain claims the original FIFO queue in this same
      // transaction. A failed claim must roll back fact, context and evidence.
      // Enforce the existing synchronous participant contract even when there
      // is no board context; no Promise may escape the owning SQL transaction.
      const admitted: unknown = admit?.(db);
      if (!context) return admitted;
      // Fail before native dispatch, transactionally with admission. Retain
      // old proofs across restart/unlink: they still describe native history.
      if ((db.prepare('SELECT count(*) AS n FROM connector_codex_turn_context').get() as { n: number }).n >= 65_536) {
        throw new Error('Codex turn context proof capacity reached');
      }
      db.prepare('INSERT INTO connector_codex_turn_context(session_key, command_id, hash, original_length) VALUES (?, ?, ?, ?)')
        .run(sessionKey, commandId, context.hash, context.originalLength);
      return admitted;
    });
  }

  finishPreparation(expected: Pick<CodexExecution, 'sessionKey' | 'commandId' | 'connectionId' | 'revision'>,
    commit?: (db: DatabaseSync) => void) {
    return this.change(expected.sessionKey, (fact) => {
      if (!fact || fact.fenced || fact.commandId !== expected.commandId || fact.connectionId !== expected.connectionId
        || fact.revision !== expected.revision || fact.phase !== 'starting' || fact.preparation !== 'active') return;
      fact.preparation = 'ready';
      return fact;
    }, commit);
  }

  acknowledge(sessionKey: string, commandId: string, connectionId: string, runId: unknown, commit: (db: DatabaseSync) => void) {
    if (!validId(runId, 512)) throw new Error('Invalid Codex native turn identity');
    let bound = false;
    this.change(sessionKey, (fact) => {
      if (!fact || fact.commandId !== commandId || fact.connectionId !== connectionId || fact.fenced || fact.preparation || fact.reason === 'restarted') return;
      if (fact.runId && fact.runId !== runId) return this.fence(fact, 'identity_conflict');
      if (!fact.runId) {
        if (fact.pending.some((event) => event.runId !== runId && !terminal(event.phase))) return this.fence(fact, 'identity_conflict');
        fact.runId = runId;
        fact.phase = 'running'; delete fact.reason;
        const early = fact.pending.find((event) => event.runId === runId);
        if (early) this.apply(fact, early);
        fact.pending = [];
      }
      bound = true;
      return fact;
    }, (db) => {
      if (!bound) return;
      const fact = this.read(sessionKey)!;
      db.prepare('UPDATE connector_codex_turn_context SET run_id = ? WHERE session_key = ? AND command_id = ?')
        .run(runId as string, sessionKey, commandId);
      if (fact.batch) {
        const previous = this.batchForRun(sessionKey, runId as string);
        if (previous && JSON.stringify(previous) !== JSON.stringify(fact.batch)) throw new Error('Codex batch run identity conflict');
        if (!previous) db.prepare('INSERT INTO connector_codex_batch_history VALUES (?, ?, ?)')
          .run(sessionKey, runId as string, JSON.stringify(fact.batch));
      }
      return commit(db);
    });
    return bound;
  }

  observe(sessionKey: string, connectionId: string, runId: string, phase: Observation['phase'], expected?: Pick<CodexExecution, 'commandId' | 'revision'>) {
    if (!validId(runId, 512) || !['running', 'completed', 'failed', 'interrupted'].includes(phase)) return false;
    return this.change(sessionKey, (fact) => {
      if (!fact || fact.fenced || fact.preparation || fact.reason === 'restarted' || fact.connectionId !== connectionId) return;
      // A read is evidence only for the acknowledged execution captured when
      // it began; it cannot bind an ACK or settle a newer lifecycle generation.
      if (expected && (fact.commandId !== expected.commandId || fact.revision !== expected.revision || fact.phase !== 'running' || fact.runId !== runId)) return;
      const event = { runId, phase, at: this.now() };
      if (fact.runId) {
        if (fact.runId !== runId) return;
        return this.apply(fact, event);
      }
      // Notifications may precede the RPC ACK. Keep bounded evidence, but do
      // not assign a native identity to the command until its ACK binds it.
      const previous = fact.pending.find((item) => item.runId === runId);
      if (previous) { if (!terminal(previous.phase)) Object.assign(previous, event); }
      else {
        if (fact.pending.length >= 4) return this.fence(fact, 'evidence_overflow');
        fact.pending.push(event);
      }
      return fact;
    });
  }

  uncertain(sessionKey: string, commandId: string) {
    return this.change(sessionKey, (fact) => {
      if (!fact || fact.commandId !== commandId || fact.runId || terminal(fact.phase) || fact.fenced || fact.reason === 'restarted') return;
      fact.phase = 'unknown'; fact.reason = fact.preparation ? 'preparation_unknown' : 'send_unknown';
      return fact;
    });
  }

  /** The failure receipt and its exact queue participant share the original
   * execution transaction, including authorization refusal before a claim.
   * Never overwrite ACK/terminal/restarted facts or a replacement execution. */
  settleDispatchFailure(sessionKey: string, commandId: string, expected: CodexDispatchFailureExpected,
    authorizationFailure: boolean,
    commit: (db: DatabaseSync, outcome: CodexDispatchFailureOutcome, fact?: CodexExecution) => void): CodexDispatchFailureOutcome | null {
    let outcome: CodexDispatchFailureOutcome | null = null, current: Fact | undefined, missingAccepted = false;
    const accepted = this.change(sessionKey, fact => {
      if (expected === null ? !!fact : !fact || fact.commandId !== expected.commandId
        || fact.connectionId !== expected.connectionId || fact.revision !== expected.revision) return;
      const owns = fact?.commandId === commandId;
      if (owns && (fact.runId || terminal(fact.phase) || fact.fenced || fact.reason === 'restarted')) return;
      if (!owns && !authorizationFailure) return;
      current = fact;
      outcome = authorizationFailure && (!owns || !fact.preparation) ? 'blocked' : 'outcome_unknown';
      if (owns && outcome === 'outcome_unknown') {
        fact.phase = 'unknown'; fact.reason = fact.preparation ? 'preparation_unknown' : 'send_unknown';
      }
      missingAccepted = !fact;
      return fact;
    }, db => commit(db, outcome!, current), () => missingAccepted);
    return accepted ? outcome : null;
  }

  observeCommandTool(sessionKey: string, connectionId: string, runId: string, itemId: string, completed = false) {
    if (!validId(itemId, 512) || itemId.trim() !== itemId) return false;
    return this.change(sessionKey, fact => {
      if (!fact || fact.fenced || fact.preparation || fact.connectionId !== connectionId || fact.runId !== runId
        || (fact.phase !== 'running' && !terminal(fact.phase))) return;
      const pending = new Set(fact.pendingCommandTools ?? []);
      // Native command notifications can follow turn/completed. Keep their
      // exact run binding without reopening the terminal execution. A newly
      // observed command invalidates an earlier empty-terminal snapshot.
      if (!completed && terminal(fact.phase) && !pending.has(itemId)) fact.sync = 'syncing';
      // Retain terminal-run identities until the next execution: interrupted
      // history may omit them, and a completion event is not a drain proof.
      if (completed && !terminal(fact.phase)) pending.delete(itemId);
      else if (!completed) pending.add(itemId);
      const items = [...pending];
      if (Buffer.byteLength(JSON.stringify(items)) > 2048) return this.fence(fact, 'evidence_overflow');
      if (items.length) fact.pendingCommandTools = items; else delete fact.pendingCommandTools;
      return fact;
    });
  }

  settleHistory(expected: Pick<CodexExecution, 'sessionKey' | 'commandId' | 'runId'>
    & Partial<Pick<CodexExecution, 'revision' | 'connectionId'>>, sync: 'current' | 'error') {
    return this.change(expected.sessionKey, (fact) => {
      if (this.nativeResumes.pending(expected.sessionKey) || !fact || fact.fenced || fact.commandId !== expected.commandId || !expected.runId) return;
      if (!terminal(fact.phase) || fact.runId !== expected.runId) return;
      if (expected.revision !== undefined && fact.revision !== expected.revision
        || expected.connectionId !== undefined && fact.connectionId !== expected.connectionId) return;
      fact.sync = sync;
      return fact;
    });
  }

  /** CAS: an old history read cannot clear a newer execution/protection fact. */
  settleNativeHistory(expected: CodexExecution, checkpoint: NativeHistoryCheckpoint) {
    if (!validId(checkpoint.turnId, 512) || !validId(checkpoint.connectionId, 128)
      || !/^[a-f0-9]{64}$/.test(checkpoint.fingerprint)) return false;
    return this.change(expected.sessionKey, fact => {
      if (this.nativeResumes.pending(expected.sessionKey) || !fact || fact.fenced || fact.preparation || !terminal(fact.phase)
        || fact.commandId !== expected.commandId || fact.runId !== expected.runId || !fact.runId
        || fact.connectionId !== expected.connectionId || fact.revision !== expected.revision) return;
      fact.sync = 'current'; fact.nativeHistory = checkpoint;
      return fact;
    });
  }

  invalidateNativeHistory(sessionKey: string, reason: NativeHistoryCheckpoint['reason'] = 'changed', readableSuccessorTurnId?: string) {
    return this.change(sessionKey, fact => {
      if (!fact || fact.fenced || !terminal(fact.phase) || !fact.runId) return;
      // Item updates from an already-known protected native head do not make
      // the owned terminal unreadable. Never preserve a VERIFIED checkpoint,
      // a new/unknown turn or a lifecycle/Goal notification this way.
      if (readableSuccessorTurnId && readableSuccessorTurnId !== fact.runId && fact.sync === 'current'
        && fact.nativeHistory?.state === 'blocked' && fact.nativeHistory.turnId === readableSuccessorTurnId) return;
      // Successor tool deltas can arrive continuously in long Goals. Once
      // this exact checkpoint is already invalid, do not rewrite its revision
      // and journal for every delta. Native activity still invalidates the
      // independent dispatch proof; this is NOT an execution release/cache.
      if (fact.sync === 'syncing' && fact.nativeHistory?.state === 'blocked'
        && fact.nativeHistory.reason === reason) return;
      fact.nativeHistory = { ...(fact.nativeHistory ?? { turnId: fact.runId,
        fingerprint: '0'.repeat(64), connectionId: fact.connectionId }), state: 'blocked', reason };
      fact.sync = 'syncing';
      return fact;
    });
  }

  recoverTerminal(expected: CodexExecution, runId: string, phase: 'completed' | 'failed' | 'interrupted') {
    if (!validId(runId, 512) || !terminal(phase)) return false;
    return this.change(expected.sessionKey, (fact) => {
      if (!fact || fact.fenced || fact.preparation || fact.phase !== 'unknown' || fact.reason !== 'restarted'
        || fact.commandId !== expected.commandId || fact.connectionId !== expected.connectionId
        || fact.revision !== expected.revision || fact.runId !== runId || expected.runId !== runId) return;
      return this.apply(fact, { runId, phase, at: this.now() });
    });
  }

  /** A replaced native process lost its lease, not its acknowledged run identity.
   * Only schedule read-only recovery; never settle or replay uncertain sends. */
  disconnectAcknowledged(sessionKey: string, connectionId: string) {
    return this.change(sessionKey, fact => {
      if (!fact || fact.fenced || fact.preparation || fact.phase !== 'running'
        || !fact.runId || fact.connectionId !== connectionId) return;
      fact.phase = 'unknown'; fact.reason = 'restarted'; fact.pending = [];
      return fact;
    });
  }

  recoverInterrupted() {
    // Owner has already acquired the SQLite runtime lock. No native RPC or
    // recovered command may be issued based on the previous process's lease.
    requireConnectionReady(this.db);
    const trace = this.diagnostics.start('codex-execution-recovery');
    const boundary: WorkBoundary = { escaped: false };
    let step = 1; // BEGIN=1, body=2, COMMIT=3.
    let failed = true, began = false, beginConfirmed = false, commitAttempted = false, at = performance.now();
    let changed = false;
    try {
      if (this.db.isTransaction) throw new Error('Execution recovery requires its owning transaction');
      try { began = true; this.db.exec('BEGIN IMMEDIATE'); beginConfirmed = true; } finally { trace.add('beginMs', performance.now() - at); }
      at = performance.now();
      try {
        step = 2;
        this.nativeResumes.recoverPrewritesInTransaction();
        let after = '';
        for (;;) {
          const rows = this.scanFacts.all(after) as { session_key: string; fact: string }[];
          if (!rows.length) break;
          trace.add('records', rows.length);
          for (const row of rows) {
            const fact = JSON.parse(row.fact) as Fact;
            if (fact.fenced || fact.reason === 'restarted' || this.isDeletedTerminal(row.session_key)) continue;
            if (terminal(fact.phase)) {
              // The terminal is durable; its reply projection is not. A fresh
              // owner must hydrate history before advertising sync or dispatch.
              if (fact.nativeHistory) {
                if (fact.sync === 'syncing' && fact.nativeHistory.reason === 'restarted' && fact.nativeHistory.state === 'blocked') continue;
                fact.nativeHistory = { ...fact.nativeHistory, state: 'blocked', reason: 'restarted' };
              }
              else if (fact.sync !== 'current') continue;
              fact.sync = 'syncing';
            } else {
              fact.phase = 'unknown'; fact.reason = 'restarted'; fact.pending = [];
            }
            fact.updatedAt = this.now(); fact.revision++; this.write(fact, boundary); changed = true;
            this.recordEvidence(fact, boundary);
          }
          after = rows.at(-1)!.session_key;
        }
      } finally { trace.add('bodyMs', performance.now() - at); }
      at = performance.now();
      try { step = 3; commitAttempted = true; this.db.exec('COMMIT'); trace.add('settled', 1); }
      finally { trace.add('commitMs', performance.now() - at); }
      failed = false;
    } catch (error) {
      trace.add('step', step); addSqlFailure(trace, error);
      let unknown = boundary.escaped || commitAttempted || (began && !beginConfirmed);
      if (began && this.db.isTransaction) {
        at = performance.now();
        try { this.db.exec('ROLLBACK'); } catch (rollbackError) {
          addSqlFailure(trace, rollbackError, 'rollbackErrorCode');
          markConnectionCleanupFault(this.db, false); trace.add('rollbackFailed', 1); unknown = true;
        }
        finally { trace.add('rollbackMs', performance.now() - at); }
      }
      if (unknown) trace.add('unknown', 1);
      throw error;
    } finally {
      if (boundary.escaped) retireConnectionForAsyncWork(this.db);
      trace.add('changed', Number(changed)); trace.finish(failed);
    }
    if (changed) this.journal?.changes.notify();
  }

  private apply(fact: Fact, event: Observation) {
    if (terminal(fact.phase)) return fact; // repeated/late events cannot reopen it
    fact.phase = event.phase; delete fact.reason;
    if (terminal(event.phase)) { fact.completedAt = event.at; fact.sync = 'syncing'; }
    return fact;
  }

  private fence(fact: Fact, reason: 'identity_conflict' | 'evidence_overflow') {
    fact.fenced = true; fact.reason = reason; fact.phase = 'unknown'; fact.pending = [];
    delete fact.completedAt;
    return fact;
  }

  private read(sessionKey: string) {
    const row = this.readFact.get(sessionKey) as { fact: string } | undefined;
    return row ? JSON.parse(row.fact) as Fact : undefined;
  }

  private change(sessionKey: string, update: (fact: Fact | undefined) => Fact | undefined, commit?: (db: DatabaseSync) => void,
    acceptMissing?: () => boolean) {
    requireConnectionReady(this.db);
    let changed = false, accepted = false;
    const trace = this.diagnostics.start('codex-execution-change');
    const boundary: WorkBoundary = { escaped: false };
    let step = 1; // BEGIN=1, body=2, COMMIT=3.
    let failed = true, began = false, beginConfirmed = false, commitAttempted = false, at = performance.now();
    try {
      if (this.db.isTransaction) throw new Error('Execution change requires its owning transaction');
      try { began = true; this.db.exec('BEGIN IMMEDIATE'); beginConfirmed = true; } finally { trace.add('beginMs', performance.now() - at); }
      at = performance.now();
      let after: Fact | undefined;
      try {
        step = 2;
        withSynchronousParticipants(this.db, value => requireSynchronousResult(value, boundary), () => {
          const before = this.read(sessionKey), body = JSON.stringify(before), revision = before?.revision ?? 0;
          after = update(before);
          if (after && JSON.stringify(after) !== body) {
            after.revision = revision + 1; after.updatedAt = this.now(); this.write(after, boundary); changed = true;
          }
          // Only a proven preclaim refusal may commit queue work with no
          // execution. All other callers retain the original no-fact no-op.
          const missingAccepted = !before && !after && acceptMissing?.() === true;
          if (after || missingAccepted) requireSynchronousResult(commit?.(this.db), boundary);
          if (after) this.recordEvidence(after, boundary);
          accepted = !!after || missingAccepted;
          requireSynchronousResult(undefined, boundary);
        });
      } finally { trace.add('bodyMs', performance.now() - at); }
      at = performance.now();
      try { step = 3; commitAttempted = true; this.db.exec('COMMIT'); trace.add('settled', 1); }
      finally { trace.add('commitMs', performance.now() - at); }
      failed = false;
    } catch (error) {
      trace.add('step', step); addSqlFailure(trace, error);
      let unknown = boundary.escaped || commitAttempted || (began && !beginConfirmed);
      if (began && this.db.isTransaction) {
        at = performance.now();
        try { this.db.exec('ROLLBACK'); } catch (rollbackError) {
          addSqlFailure(trace, rollbackError, 'rollbackErrorCode');
          markConnectionCleanupFault(this.db, false); trace.add('rollbackFailed', 1); unknown = true;
        }
        finally { trace.add('rollbackMs', performance.now() - at); }
      }
      if (unknown) trace.add('unknown', 1);
      throw error;
    } finally {
      if (boundary.escaped) retireConnectionForAsyncWork(this.db);
      trace.add('changed', Number(changed)); trace.finish(failed);
    }
    if (changed) this.journal?.changes.notify();
    return accepted;
  }

  private write(fact: Fact, boundary: WorkBoundary) {
    if (fact.nativeHistory) requireNativeHistoryWriter(this.db);
    this.writeFact.run(fact.sessionKey, JSON.stringify(fact));
    requireSynchronousResult(this.journal?.appendInTransaction(this.db, { id: '', type: 'run.updated', ts: fact.updatedAt,
      sessionKey: fact.sessionKey, payload: { invalidation: true, executionRevision: fact.revision } }), boundary);
  }

  private recordEvidence(fact: Fact, boundary: WorkBoundary) {
    for (const commandId of fact.batch?.members.map(member => member.id) ?? [fact.commandId]) {
      requireSynchronousResult(this.commandEvidence?.recordExecutionInTransaction(this.db, 'codex', { ...fact, commandId }), boundary);
    }
  }
}
