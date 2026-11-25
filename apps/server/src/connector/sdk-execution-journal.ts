import type { DatabaseSync } from 'node:sqlite';
import { observedSavepoint } from '../storage/observed-savepoint.js';
import { synchronousSqliteValue } from '../auth/synchronous-sqlite-value.js';
import { AuthPersistenceError } from '../auth/private-store.js';
import { sessionRuntimeId } from '@agentopsdeck/shared';
import type { TurnQueue } from '../commands/turn-queue.js';
import type { CodexBatch } from '../codex/queued-batch.js';
import { validSdkModel } from './sdk-models.js';
import { validateSdkMetricSample, type SdkMetrics } from './sdk-metrics.js';
import type { NativeTokenUsageStore } from './native-token-usage.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';

export type SdkAgentId = 'claude-code' | 'ghcp' | 'antigravity';
export type SdkDeletion = { id: string; key: string; nativeSessionId: string; phase: 'pending' | 'unknown' | 'deleted'; createdAt: number };
export type SdkNativeState = 'allocated' | 'starting' | 'ready' | 'unknown';
export type SdkSession = { key: string; nativeSessionId: string; title: string; createdAt: number; nativeState: SdkNativeState; model?: string; metrics?: SdkMetrics };
export type SdkExecutionPhase = 'dispatching' | 'running' | 'settling' | 'completed' | 'failed' | 'interrupted' | 'unknown';
export type SdkTerminalOutcome = 'completed' | 'failed' | 'interrupted';
export type SdkExecutionRef = { id: string; key: string; epoch: string };
export type SdkExecution = SdkExecutionRef & {
  nativeSessionId: string; nativeRequestId?: string; members: string[];
  nativeMode: 'create' | 'resume';
  model?: string;
  batch?: CodexBatch;
  phase: SdkExecutionPhase; outcome?: SdkTerminalOutcome; stopRequested: boolean;
  createdAt: number; updatedAt: number;
} & ({ kind?: 'message'; control?: never } | { kind: 'compact'; control: { actorId: string; completionEventId?: string } });
export type SdkCompactResult = { nativeRequestId: string; completionEventId: string; outcome: SdkTerminalOutcome };
export type SdkCompactRef = SdkExecutionRef & { nativeSessionId: string };
export type SdkCompactSettlement = SdkCompactRef & { completionEventId: string; historyPersisted: boolean; nativeQuiescent: boolean };
export type SdkJournalSnapshot = {
  session: SdkSession | null; execution: SdkExecution | null; deletion: SdkDeletion | null;
  canStart: boolean; unresolved: boolean;
};
export const SDK_JOURNAL_SNAPSHOT_BYTES = 131_072;
type CompactPolicy = {
  /** Store ownership/maintenance, not HTTP authorization. */
  available: () => boolean;
  beforeBegin: () => void;
};
type ExecutionRow = { data: string };
const terminal = (phase: SdkExecutionPhase) => ['completed', 'failed', 'interrupted'].includes(phase);
const validId = (id: string) => typeof id === 'string' && id.length > 0 && id.length <= 512 && !/[\x00-\x1f\x7f]/.test(id);

/** Connector-owned intent, not a second queue and not native history storage.
 * Persist the allocated native identity, execution epoch and queue membership
 * before any SDK side effect. Raw prompts, tools and credentials do not belong
 * here. No recovery method invokes a provider or replays an uncertain command.
 * Runtime configuration and the authorized routing layer govern admission. */
export class SdkExecutionJournal {
  /** Keep the original callback identity and original SQL owner. A deferred
   * check cannot become permission or hide its continuation from rollback. */
  checkAuthority<Args extends unknown[] = []>(authorize: (...args: Args) => void, receiver?: unknown, args?: Args): void {
    if (synchronousSqliteValue(this.db, authorize, receiver, args) !== undefined) throw new AuthPersistenceError();
  }

  checkPermission<Args extends unknown[]>(authorize: (...args: Args) => boolean, args: Args, receiver?: unknown): boolean {
    return synchronousSqliteValue(this.db, authorize, receiver, args) === true;
  }

  constructor(private readonly db: DatabaseSync, readonly runtime: SdkAgentId, private readonly now = Date.now,
    private readonly beforeCreate: () => void = () => {}, private readonly compactPolicy?: CompactPolicy,
    private readonly sessionAvailable: (key: string) => boolean = () => true, private readonly tokenUsage?: NativeTokenUsageStore,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics) {
    if (runtime !== 'claude-code' && runtime !== 'ghcp' && runtime !== 'antigravity') throw new Error('Unsupported SDK runtime');
    db.exec(`CREATE TABLE IF NOT EXISTS sdk_agent_sessions (
      runtime TEXT NOT NULL, session_key TEXT NOT NULL, native_session_id TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(runtime, session_key), UNIQUE(runtime, native_session_id)
    );
    CREATE TABLE IF NOT EXISTS sdk_agent_executions (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, runtime TEXT NOT NULL, id TEXT NOT NULL,
      session_key TEXT NOT NULL, phase TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(runtime, id)
    );
    CREATE INDEX IF NOT EXISTS sdk_agent_execution_session ON sdk_agent_executions(runtime, session_key, sequence);
    CREATE INDEX IF NOT EXISTS sdk_agent_execution_pending ON sdk_agent_executions(runtime, phase);
    CREATE TABLE IF NOT EXISTS sdk_agent_deletions (
      runtime TEXT NOT NULL, session_key TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(runtime, session_key)
    );
    CREATE TABLE IF NOT EXISTS sdk_agent_metric_events (
      runtime TEXT NOT NULL, session_key TEXT NOT NULL, event_id TEXT NOT NULL,
      PRIMARY KEY(runtime, session_key, event_id)
    );`);
  }

  create(session: Omit<SdkSession, 'nativeState'>, commit?: (db: DatabaseSync) => void) {
    if (sessionRuntimeId(session.key) !== this.runtime || session.key === `${this.runtime}:`
      || !validId(session.key) || !validId(session.nativeSessionId) || typeof session.title !== 'string'
      || session.title.length > 512 || !Number.isSafeInteger(session.createdAt) || session.createdAt < 0) {
      throw new Error('Invalid SDK session identity');
    }
    // Construct fields explicitly: never persist unexpected caller payloads.
    const data: SdkSession = { key: session.key, nativeSessionId: session.nativeSessionId,
      title: session.title, createdAt: session.createdAt, nativeState: 'allocated' };
    this.atomic(check => {
      // Owning stores install their old-writer fence in this same transaction.
      // A rejected/duplicate create must not leave a partial schema transition.
      check(this.beforeCreate());
      this.db.prepare('INSERT INTO sdk_agent_sessions VALUES (?, ?, ?, ?)')
        .run(this.runtime, data.key, data.nativeSessionId, JSON.stringify(data));
      // SDK identity allocation is local: unlike a native create RPC it can
      // commit atomically with its receipt, including the old-writer fence.
      check(commit?.(this.db));
    });
  }

  session(key: string): SdkSession | undefined {
    if (this.deletion(key)?.phase === 'deleted') return;
    const row = this.db.prepare('SELECT data FROM sdk_agent_sessions WHERE runtime = ? AND session_key = ?')
      .get(this.runtime, key) as ExecutionRow | undefined;
    if (!row) return;
    const session = JSON.parse(row.data) as SdkSession;
    // Pre-integration journals did not persist materialization proof. Never
    // infer resume safety from a title, allocated UUID, ACK, or old terminal.
    if (!['allocated', 'starting', 'ready', 'unknown'].includes(session.nativeState)) session.nativeState = 'unknown';
    return session;
  }

  /** Bounded local discovery. Never enumerate another runtime or load native
   * histories while rebuilding the session directory after a restart. */
  sessionKeys(after?: string, limit = 200): string[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200
      || after !== undefined && (!validId(after) || sessionRuntimeId(after) !== this.runtime)) {
      throw new Error('Invalid SDK session directory cursor');
    }
    const rows = this.db.prepare(`SELECT session_key FROM sdk_agent_sessions
      WHERE runtime = ? AND session_key > ? ORDER BY session_key LIMIT ?`)
      .all(this.runtime, after ?? '', limit) as { session_key: string }[];
    return rows.map(row => row.session_key);
  }

  current(key: string): SdkExecution | undefined {
    const row = this.db.prepare('SELECT data FROM sdk_agent_executions WHERE runtime = ? AND session_key = ? ORDER BY sequence DESC LIMIT 1')
      .get(this.runtime, key) as ExecutionRow | undefined;
    return row && JSON.parse(row.data) as SdkExecution;
  }

  /** One original savepoint, including policy reads. Check stored byte sizes
   * before loading/parsing JSON; corrupt or oversized records are never
   * truncated, rewritten, or interpreted as a safe empty journal. */
  readSnapshot(key: string): SdkJournalSnapshot {
    if (!validId(key) || key === `${this.runtime}:` || sessionRuntimeId(key) !== this.runtime) {
      throw new Error('connector_storage_unavailable');
    }
    return this.atomic(() => {
      let total = 0;
      for (const query of [
        'SELECT %SIZE% FROM sdk_agent_sessions WHERE runtime = ? AND session_key = ?',
        'SELECT %SIZE% FROM sdk_agent_executions WHERE runtime = ? AND session_key = ? ORDER BY sequence DESC LIMIT 1',
        'SELECT %SIZE% FROM sdk_agent_deletions WHERE runtime = ? AND session_key = ?',
      ]) {
        const row = this.db.prepare(query.replace('%SIZE%', `CASE WHEN typeof(data) = 'text'
          AND length(CAST(data AS BLOB)) <= ${SDK_JOURNAL_SNAPSHOT_BYTES}
          THEN length(CAST(data AS BLOB)) ELSE -1 END AS bytes`)).get(this.runtime, key) as { bytes: number } | undefined;
        if (row && (!Number.isSafeInteger(row.bytes) || row.bytes < 0 || (total += row.bytes) > SDK_JOURNAL_SNAPSHOT_BYTES)) {
          throw new Error('connector_storage_unavailable');
        }
      }
      return { session: this.session(key) ?? null, execution: this.current(key) ?? null,
        deletion: this.deletion(key) ?? null, canStart: this.canStart(key), unresolved: this.hasUnresolved(key) };
    });
  }

  canStart(key: string): boolean {
    if (!this.sessionAvailable(key)) return false;
    if (this.deletion(key)) return false;
    const session = this.session(key);
    if (!session || !['allocated', 'ready'].includes(session.nativeState)) return false;
    const execution = this.current(key);
    return !execution || terminal(execution.phase);
  }

  /** Pure local settings and receipt commit together. No native RPC to retry. */
  updateModel(key: string, model: string | null, commit: () => void) {
    if (model !== null && !validSdkModel(model)) throw new Error('Invalid SDK model');
    return this.atomic(check => {
      if (!this.canStart(key)) throw new Error('SDK session is not idle');
      const session = this.session(key)!;
      if (model === null) delete session.model;
      else session.model = model;
      if (session.metrics) delete session.metrics.context;
      this.saveSession(session);
      check(commit());
      return session;
    });
  }

  hasUnresolved(key: string): boolean {
    const deletion = this.deletion(key);
    if (deletion) return deletion.phase !== 'deleted';
    const session = this.session(key);
    if (session && !['allocated', 'ready'].includes(session.nativeState)) return true;
    const execution = this.current(key);
    return !!execution && !terminal(execution.phase);
  }

  begin(ref: SdkExecutionRef, members: string[], turns: TurnQueue, batch?: CodexBatch,
    authorize?: () => boolean): SdkExecution | undefined {
    if (!validId(ref.id) || !validId(ref.epoch) || !members.length || members.length > 16
      || new Set(members).size !== members.length || members.some(id => !validId(id))) throw new Error('Invalid SDK execution intent');
    if (batch && (!/^\n\n\[Queued message boundary [a-f0-9-]{36}\]\n\n$/.test(batch.separator)
      || batch.members.length !== members.length || batch.members.some((member, i) => member.id !== members[i]
        || !Number.isSafeInteger(member.createdAt) || member.createdAt < 0
        || !Number.isSafeInteger(member.imageCount) || member.imageCount < 0))) throw new Error('Invalid SDK batch identity');
    return this.atomic(check => {
      if (authorize) {
        const authorized = authorize(); check(authorized);
        if (authorized !== true) return;
      }
      if (!this.canStart(ref.key) || !turns.startBatchInTransaction(this.db, this.runtime, ref.key, members)) return;
      const now = this.now(), session = this.session(ref.key)!;
      const execution: SdkExecution = { kind: 'message', id: ref.id, key: ref.key, epoch: ref.epoch,
        nativeSessionId: session.nativeSessionId, nativeMode: session.nativeState === 'allocated' ? 'create' : 'resume',
        members: [...members], phase: 'dispatching', ...(session.model ? { model: session.model } : {}),
        ...(batch ? { batch: { separator: batch.separator, members: batch.members.map(({ id, createdAt, imageCount }) => ({ id, createdAt, imageCount })) } } : {}),
        stopRequested: false, createdAt: now, updatedAt: now };
      // INSERT, never upsert: an execution identity cannot be reused for a new turn.
      this.db.prepare('INSERT INTO sdk_agent_executions(runtime, id, session_key, phase, data) VALUES (?, ?, ?, ?, ?)')
        .run(this.runtime, execution.id, execution.key, execution.phase, JSON.stringify(execution));
      this.saveSession({ ...session, nativeState: 'starting', metrics: {
        ...session.metrics, ...(session.nativeState === 'allocated' ? { compactionCount: 0 } : {}),
        executionId: execution.id, sequence: 0,
      } });
      return execution;
    });
  }

  /** Internal control intent only. The command layer must authenticate the
   * owner and commit its actor-scoped receipt here. No worker may start until
   * this method returns. Legacy message begin still rejects empty members. */
  beginCompact(ref: SdkExecutionRef, actorId: string, turns: TurnQueue,
    commit: (db: DatabaseSync) => void): SdkExecution | undefined {
    if (!validId(ref.id) || !validId(ref.epoch) || !validId(actorId) || typeof commit !== 'function') {
      throw new Error('Invalid SDK compact intent');
    }
    return this.atomic(check => {
      if (!this.compactPolicy?.available() || !this.canStart(ref.key)
        || this.session(ref.key)?.nativeState !== 'ready'
        || !turns.canStartControlInTransaction(this.db, this.runtime, ref.key)) return;
      check(this.compactPolicy.beforeBegin());
      const session = this.session(ref.key)!, now = this.now();
      const execution: SdkExecution = { kind: 'compact', id: ref.id, key: ref.key, epoch: ref.epoch,
        nativeSessionId: session.nativeSessionId, nativeMode: 'resume', members: [],
        ...(session.model ? { model: session.model } : {}), control: { actorId },
        phase: 'dispatching', stopRequested: false, createdAt: now, updatedAt: now };
      this.db.prepare('INSERT INTO sdk_agent_executions(runtime, id, session_key, phase, data) VALUES (?, ?, ?, ?, ?)')
        .run(this.runtime, execution.id, execution.key, execution.phase, JSON.stringify(execution));
      this.saveSession({ ...session, nativeState: 'starting', metrics: {
        ...session.metrics, executionId: execution.id, sequence: 0,
      } });
      check(commit(this.db)); // Receipt/fresh authorization failure rolls back the fence and intent too.
      return execution;
    });
  }

  /** Only a runtime-specific correlated completion is accepted here. For
   * success this event is the persisted manual-compaction boundary. For
   * failure/stop the adapter must supply a durable terminal event, not invent
   * a success boundary from an RPC return. No ordinary user/idle is required. */
  observeCompactTerminal(ref: SdkCompactRef, result: SdkCompactResult): boolean {
    if (!validId(result.nativeRequestId) || !validId(result.completionEventId) || !terminal(result.outcome)) {
      throw new Error('Invalid SDK compact completion');
    }
    return this.atomic(() => {
      const execution = this.match(ref);
      if (!execution || execution.kind !== 'compact' || execution.nativeSessionId !== ref.nativeSessionId
        || !['dispatching', 'running'].includes(execution.phase)
        || result.outcome === 'interrupted' && !execution.stopRequested) return false;
      this.save({ ...execution, nativeRequestId: result.nativeRequestId, phase: 'settling', outcome: result.outcome,
        control: { actorId: execution.control.actorId, completionEventId: result.completionEventId } });
      // Commit the observed boundary and its metrics together. A concurrent
      // wake/settlement must not make the metric write lose its active phase.
      if (result.outcome === 'completed') this.recordMetrics(execution,
        { sequence: 1, eventId: result.completionEventId, compacted: true });
      return true;
    });
  }

  requestCompactStop(ref: SdkCompactRef): boolean {
    return this.atomic(() => {
      const execution = this.match(ref);
      if (!execution || execution.kind !== 'compact' || execution.nativeSessionId !== ref.nativeSessionId
        || !['dispatching', 'running'].includes(execution.phase) || execution.stopRequested) return false;
      this.save({ ...execution, stopRequested: true });
      return true;
    });
  }

  confirmCompactSettled(proof: SdkCompactSettlement): boolean {
    return this.atomic(() => {
      const execution = this.match(proof);
      if (!execution || execution.kind !== 'compact' || execution.nativeSessionId !== proof.nativeSessionId
        || !execution.control.completionEventId || execution.control.completionEventId !== proof.completionEventId
        || proof.historyPersisted !== true || proof.nativeQuiescent !== true) return false;
      return this.finishSettlement(execution);
    });
  }

  /** Observations never acknowledge/settle a command or change run timestamps.
   * Exact current execution, epoch AND native identity are required. */
  recordMetrics(ref: SdkExecutionRef & { nativeSessionId: string }, value: unknown): boolean {
    const sample = validateSdkMetricSample(value);
    if (sample.reconciledCalls && this.runtime !== 'claude-code') throw new Error('Invalid SDK metric runtime');
    return this.atomic(() => {
      const execution = this.match(ref), session = this.session(ref.key);
      if (!execution || !session || this.deletion(ref.key) || ref.nativeSessionId !== execution.nativeSessionId
        || session.nativeSessionId !== ref.nativeSessionId || !['dispatching', 'running', 'settling'].includes(execution.phase)
        || session.metrics?.executionId !== execution.id || sample.sequence <= (session.metrics.sequence ?? 0)) return false;
      const inserted = this.db.prepare('INSERT OR IGNORE INTO sdk_agent_metric_events VALUES (?, ?, ?)')
        .run(this.runtime, ref.key, sample.eventId);
      if (!inserted.changes) return false;
      const metrics: SdkMetrics = { ...session.metrics, sequence: sample.sequence };
      if (sample.context) metrics.context = sample.context;
      // Never retain a pre-compaction context if native omits its new size.
      else if (sample.compacted) metrics.context = { used: null, basis: 'post-compaction' };
      if (sample.usage) {
        metrics.usage = sample.usage;
        // Reconciled calls are observed together in one result, not at each
        // SQLite insert. A minute boundary must not split that observation.
        const observedAt = this.now();
        if (sample.reconciledCalls) {
          for (const call of sample.reconciledCalls) this.tokenUsage?.record(this.runtime, ref.key, `call:${call.id}`, call, call.model, observedAt);
        } else this.tokenUsage?.record(this.runtime, ref.key, sample.eventId, sample.usage, sample.model, observedAt);
      }
      if (sample.compacted && metrics.compactionCount !== undefined) metrics.compactionCount++;
      this.saveSession({ ...session, metrics });
      return true;
    });
  }

  acknowledge(ref: SdkExecutionRef, nativeRequestId: string, turns: TurnQueue): boolean {
    if (!validId(nativeRequestId)) throw new Error('Invalid SDK admission identity');
    return this.atomic(() => {
      const execution = this.match(ref);
      if (!execution || execution.kind === 'compact' || execution.phase !== 'dispatching' && execution.phase !== 'running') return false;
      if (execution.nativeRequestId && execution.nativeRequestId !== nativeRequestId) return false;
      if (execution.phase === 'running') return true;
      this.save({ ...execution, nativeRequestId, phase: 'running' });
      turns.settleClaimedBatchInTransaction(this.db, this.runtime, execution.key, execution.members, 'accepted');
      return true;
    });
  }

  requestStop(ref: SdkExecutionRef): boolean {
    const execution = this.match(ref);
    if (!execution || execution.kind === 'compact' || execution.phase !== 'running' || execution.stopRequested) return false;
    this.save({ ...execution, stopRequested: true });
    return true; // A stop request is not evidence of native termination.
  }

  observeTerminal(ref: SdkExecutionRef, outcome: SdkTerminalOutcome, turns: TurnQueue): boolean {
    if (!terminal(outcome)) throw new Error('Invalid SDK terminal outcome');
    return this.atomic(() => {
      const execution = this.match(ref);
      if (!execution || execution.kind === 'compact' || execution.phase !== 'dispatching' && execution.phase !== 'running') return false;
      if (outcome === 'interrupted' && !execution.stopRequested) return false;
      this.save({ ...execution, phase: 'settling', outcome });
      // A correlated terminal proves admission even if it arrived before ACK.
      if (execution.phase === 'dispatching') turns.settleClaimedBatchInTransaction(this.db, this.runtime, execution.key, execution.members, 'accepted');
      return true;
    });
  }

  /** Caller must independently confirm durable history AND native quiescence.
   * An SDK per-model-iteration turn_end is not sufficient evidence. */
  confirmSettled(ref: SdkExecutionRef): boolean {
    return this.atomic(() => {
      const execution = this.match(ref);
      return !!execution && execution.kind !== 'compact' && this.finishSettlement(execution);
    });
  }

  private finishSettlement(execution: SdkExecution): boolean {
    const session = this.session(execution.key);
    if (execution.phase !== 'settling' || !execution.outcome || !session
      || session.nativeState !== 'starting' || session.nativeSessionId !== execution.nativeSessionId) return false;
    this.save({ ...execution, phase: execution.outcome });
    this.saveSession({ ...session, nativeState: 'ready' });
    return true;
  }

  markUnknown(ref: SdkExecutionRef, turns: TurnQueue): boolean {
    return this.atomic(() => {
      const execution = this.match(ref);
      if (!execution || terminal(execution.phase)) return false;
      this.save({ ...execution, phase: 'unknown' });
      const session = this.session(ref.key);
      if (session) this.saveSession({ ...session, nativeState: 'unknown' });
      if (execution.kind !== 'compact') turns.settleClaimedBatchInTransaction(this.db, this.runtime, execution.key, execution.members, 'unknown');
      return true;
    });
  }

  recover(turns: TurnQueue) {
    this.db.prepare(`UPDATE sdk_agent_deletions SET data = json_set(data, '$.phase', 'unknown')
      WHERE runtime = ? AND json_extract(data, '$.phase') = 'pending'`).run(this.runtime);
    const rows = this.db.prepare("SELECT data FROM sdk_agent_executions WHERE runtime = ? AND phase NOT IN ('completed', 'failed', 'interrupted')")
      .all(this.runtime) as ExecutionRow[];
    // Neither an old ACK nor a terminal awaiting history proves safe restart.
    // Keep completed records unchanged; freeze everything unresolved.
    for (const row of rows) this.markUnknown(JSON.parse(row.data) as SdkExecution, turns);
  }

  pendingCount(): number {
    const executions = (this.db.prepare("SELECT count(*) AS total FROM sdk_agent_executions WHERE runtime = ? AND phase NOT IN ('completed', 'failed', 'interrupted')")
      .get(this.runtime) as { total: number }).total;
    // Also fence pre-integration/unknown session records with no unresolved
    // execution. Do not double-count ordinary in-flight materialization.
    const sessions = (this.db.prepare(`SELECT count(*) AS total FROM sdk_agent_sessions s
      WHERE s.runtime = ? AND coalesce(json_extract(s.data, '$.nativeState'), 'unknown') NOT IN ('allocated', 'ready')
      AND NOT EXISTS (SELECT 1 FROM sdk_agent_executions e WHERE e.runtime = s.runtime AND e.session_key = s.session_key
        AND e.phase NOT IN ('completed', 'failed', 'interrupted'))`).get(this.runtime) as { total: number }).total;
    const deletions = (this.db.prepare(`SELECT count(*) AS total FROM sdk_agent_deletions
      WHERE runtime = ? AND json_extract(data, '$.phase') != 'deleted'`).get(this.runtime) as { total: number }).total;
    return executions + sessions + deletions;
  }

  deletion(key: string): SdkDeletion | undefined {
    const row = this.db.prepare('SELECT data FROM sdk_agent_deletions WHERE runtime = ? AND session_key = ?')
      .get(this.runtime, key) as ExecutionRow | undefined;
    return row && JSON.parse(row.data) as SdkDeletion;
  }

  beginDeletion(key: string, id: string): SdkDeletion {
    return this.atomic(() => {
      if (!validId(id) || !this.canStart(key)) throw new Error('SDK deletion is not admissible');
      const session = this.session(key)!;
      const deletion: SdkDeletion = { id, key, nativeSessionId: session.nativeSessionId, phase: 'pending', createdAt: this.now() };
      this.db.prepare('INSERT INTO sdk_agent_deletions VALUES (?, ?, ?)').run(this.runtime, key, JSON.stringify(deletion));
      return deletion;
    });
  }

  settleDeletion(ref: SdkDeletion, accepted: boolean, commit: (db: DatabaseSync) => void = () => {}) {
    this.atomic(check => {
      const current = this.deletion(ref.key);
      if (!current || current.id !== ref.id || current.nativeSessionId !== ref.nativeSessionId || current.phase !== 'pending') {
        throw new Error('SDK deletion identity changed');
      }
      this.db.prepare('UPDATE sdk_agent_deletions SET data = ? WHERE runtime = ? AND session_key = ?')
        .run(JSON.stringify({ ...current, phase: accepted ? 'deleted' : 'unknown' }), this.runtime, ref.key);
      check(commit(this.db)); // Receipt and tombstone share the owning store transaction.
    });
  }

  private match(ref: SdkExecutionRef & { nativeSessionId?: string }): SdkExecution | undefined {
    const execution = this.current(ref.key);
    return execution?.id === ref.id && execution.epoch === ref.epoch
      && (ref.nativeSessionId === undefined || execution.nativeSessionId === ref.nativeSessionId) ? execution : undefined;
  }
  private save(execution: SdkExecution) {
    this.db.prepare('UPDATE sdk_agent_executions SET phase = ?, data = ? WHERE runtime = ? AND id = ?')
      .run(execution.phase, JSON.stringify({ ...execution, updatedAt: this.now() }), this.runtime, execution.id);
  }
  private saveSession(session: SdkSession) {
    this.db.prepare('UPDATE sdk_agent_sessions SET data = ? WHERE runtime = ? AND session_key = ?')
      .run(JSON.stringify(session), this.runtime, session.key);
  }
  private atomic<T>(fn: (checkParticipant: (value: unknown) => void) => T extends PromiseLike<unknown> ? never : T): T {
    return observedSavepoint(this.db, 'sdk-execution-change', fn, this.diagnostics);
  }
}
