import type { DatabaseSync } from 'node:sqlite';
import type { ConnectorEventLog } from '../connector/event-log.js';
import type { GatewayReply } from './gateway-reply.js';
import type { CommandExecutionSink } from '../commands/receipts.js';
import { observedTransaction } from '../storage/observed-transaction.js';
import { synchronousParticipantInspector } from '../storage/synchronous-participant.js';

export type OpenClawExecutionPhase = 'starting' | 'running' | 'waiting' | 'unknown' | 'completed' | 'failed';
export type OpenClawRunObservation = { runId: string; phase: Exclude<OpenClawExecutionPhase, 'starting'>; gatewayConnectionId?: string | undefined; reply?: GatewayReply; replyOnly?: true };
export type OpenClawExecution = {
  sessionKey: string;
  commandId: string;
  origin: 'gateway' | 'cli';
  runId?: string;
  gatewayConnectionId?: string;
  revision?: number;
  // A session history read is independent of whether its last run is over.
  // This generation survives successor admission; it is not a second queue.
  historySync?: { revision: number; state: 'pending' | 'error' | 'current' };
  phase: OpenClawExecutionPhase;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  reason?: 'send_unknown' | 'restarted' | 'run_unbound' | 'ack_conflict' | 'terminal_conflict' | 'evidence_overflow' | 'unowned_run';
};
type Evidence = OpenClawRunObservation & { at: number; conflict?: boolean };
type Fact = OpenClawExecution & { pending: Evidence[]; fenced?: boolean };
type Commit = (db: DatabaseSync) => void;
type CheckParticipant = (value: unknown) => void;
type GatewayEvidenceSink = {
  syncExecutionInTransaction(db: DatabaseSync, execution: OpenClawExecution, reply?: GatewayReply): void;
  observeFinalInTransaction(db: DatabaseSync, sessionKey: string, event: OpenClawRunObservation): void;
  recoverGatewayInTransaction(db: DatabaseSync): void;
};
const terminal = (phase: OpenClawExecutionPhase) => phase === 'completed' || phase === 'failed';
const validId = (value: unknown, bytes: number): value is string => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= bytes;

// Current execution facts only: no second work queue, retries or
// transcript inference. The command identity is never treated as a Gateway
// run identity. Callers supply correlation evidence, not display summaries.
// Unresolved facts and terminal fences are never evicted to admit more work.
export class OpenClawExecutions {
  constructor(private readonly db: DatabaseSync, private readonly maxRows = 4096,
    private readonly maxBytes = 16 * 1024 * 1024, private readonly now = Date.now,
    private readonly journal?: Pick<ConnectorEventLog, 'appendInTransaction' | 'changes'>,
    private readonly sessionAvailable: (sessionKey: string) => boolean = () => true,
    private readonly gatewayEvidence?: GatewayEvidenceSink,
    private readonly commandEvidence?: CommandExecutionSink) {
    if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 100_000
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 64 * 1024 * 1024) throw new Error('Invalid execution limits');
    db.exec(`CREATE TABLE IF NOT EXISTS connector_openclaw_executions (
      session_key TEXT PRIMARY KEY, fact TEXT NOT NULL, bytes INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS connector_openclaw_execution_usage (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), rows INTEGER NOT NULL, bytes INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO connector_openclaw_execution_usage SELECT 1, count(*), coalesce(sum(bytes), 0) FROM connector_openclaw_executions;
    CREATE TRIGGER IF NOT EXISTS connector_openclaw_execution_insert AFTER INSERT ON connector_openclaw_executions BEGIN
      UPDATE connector_openclaw_execution_usage SET rows = rows + 1, bytes = bytes + new.bytes WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS connector_openclaw_execution_delete AFTER DELETE ON connector_openclaw_executions BEGIN
      UPDATE connector_openclaw_execution_usage SET rows = rows - 1, bytes = bytes - old.bytes WHERE singleton = 1;
    END;
    CREATE TRIGGER IF NOT EXISTS connector_openclaw_execution_update AFTER UPDATE ON connector_openclaw_executions BEGIN
      UPDATE connector_openclaw_execution_usage SET bytes = bytes + new.bytes - old.bytes WHERE singleton = 1;
    END;
    CREATE INDEX IF NOT EXISTS connector_openclaw_recovery ON connector_openclaw_executions
      (json_extract(fact, '$.gatewayConnectionId'), session_key)
      WHERE json_extract(fact, '$.phase') NOT IN ('completed', 'failed')
        AND json_extract(fact, '$.origin') = 'gateway'
        AND json_extract(fact, '$.fenced') IS NOT 1 AND json_extract(fact, '$.runId') IS NOT NULL;
    CREATE INDEX IF NOT EXISTS connector_openclaw_history_sync ON connector_openclaw_executions (session_key)
      WHERE json_extract(fact, '$.historySync.state') IN ('pending', 'error');`);
  }

  get(sessionKey: string): OpenClawExecution | undefined {
    const fact = this.read(sessionKey);
    if (!fact) return;
    const { pending: _pending, fenced: _fenced, ...execution } = fact;
    return execution;
  }

  // Local execution evidence only; absence does not prove native quiescence.
  canDelete(sessionKey: string) {
    const fact = this.read(sessionKey);
    return !fact || (!fact.fenced && terminal(fact.phase)
      && (!fact.historySync || fact.historySync.state === 'current'));
  }

  maintenancePending(): number {
    return (this.db.prepare(`SELECT count(*) AS count FROM connector_openclaw_executions
      WHERE NOT (coalesce(json_extract(fact, '$.fenced'), 0) = 0
        AND coalesce(json_extract(fact, '$.phase'), '') IN ('completed', 'failed')
        AND (json_extract(fact, '$.historySync') IS NULL OR coalesce(json_extract(fact, '$.historySync.state'), '') = 'current'))`)
      .get() as { count: number }).count;
  }

  canChangeSettings(sessionKey: string) {
    const fact = this.read(sessionKey);
    return !fact || (!fact.fenced && ['running', 'waiting', 'completed', 'failed'].includes(fact.phase));
  }

  recoveryPage(connectionId: string | undefined, after = '', limit = 16): string[] {
    if (!connectionId) return [];
    return (this.db.prepare(`SELECT session_key FROM connector_openclaw_executions
      WHERE json_extract(fact, '$.gatewayConnectionId') = ? AND session_key > ?
        AND json_extract(fact, '$.phase') NOT IN ('completed', 'failed')
        AND json_extract(fact, '$.reason') IS NOT 'restarted'
        AND json_extract(fact, '$.origin') = 'gateway'
        AND json_extract(fact, '$.fenced') IS NOT 1 AND json_extract(fact, '$.runId') IS NOT NULL
      ORDER BY session_key LIMIT ?`).all(connectionId, after, Math.max(1, Math.min(limit, 64))) as { session_key: string }[])
      .map((row) => row.session_key);
  }

  historyPage(after = '', limit = 16): string[] {
    return (this.db.prepare(`SELECT session_key FROM connector_openclaw_executions
      WHERE session_key > ? AND json_extract(fact, '$.historySync.state') IN ('pending', 'error')
      ORDER BY session_key LIMIT ?`).all(after, Math.max(1, Math.min(limit, 64))) as { session_key: string }[])
      .map((row) => row.session_key);
  }

  sessionPage(after = '', limit = 16): string[] {
    return (this.db.prepare(`SELECT session_key FROM connector_openclaw_executions
      WHERE session_key > ? ORDER BY session_key LIMIT ?`).all(after, Math.max(1, Math.min(limit, 64))) as { session_key: string }[])
      .map((row) => row.session_key);
  }

  setHistorySync(sessionKey: string, revision: number, state: 'current' | 'error') {
    return this.change(sessionKey, (fact) => {
      if (!fact?.historySync || fact.historySync.revision !== revision || fact.historySync.state === 'current') return;
      fact.historySync.state = state;
      return fact;
    });
  }

  recoveryCandidate(sessionKey: string, connectionId: string | undefined) {
    const fact = this.read(sessionKey);
    if (!connectionId || !fact || fact.fenced || fact.reason === 'restarted' || terminal(fact.phase) || fact.origin !== 'gateway'
      || fact.gatewayConnectionId !== connectionId || !fact.runId) return;
    return this.get(sessionKey);
  }

  bindGatewayConnection(sessionKey: string, commandId: string, connectionId: string) {
    if (!validId(connectionId, 512)) throw new Error('Invalid Gateway connection identity');
    return this.forCommand(sessionKey, commandId, (fact) => {
      if (fact.origin !== 'gateway') return;
      if (fact.gatewayConnectionId && fact.gatewayConnectionId !== connectionId) return this.fence(fact, 'ack_conflict');
      fact.gatewayConnectionId = connectionId;
      if (fact.pending.some((event) => event.gatewayConnectionId !== connectionId && (!terminal(event.phase) || event.conflict))) {
        return this.fence(fact, 'unowned_run');
      }
      fact.pending = fact.pending.filter((event) => event.gatewayConnectionId === connectionId);
      return fact;
    });
  }

  // Read-only recovery cannot override a newer observation, a different
  // command, or a conflict. Revision also detects state ABA within one ms.
  completeFromQuery(expected: OpenClawExecution) {
    return this.forCommand(expected.sessionKey, expected.commandId, (fact, check) => {
      if (fact.fenced || terminal(fact.phase) || fact.origin !== 'gateway' || !expected.gatewayConnectionId || !expected.runId
        || fact.gatewayConnectionId !== expected.gatewayConnectionId || fact.runId !== expected.runId
        || (fact.revision ?? 0) !== (expected.revision ?? 0)) return;
      return this.apply(fact, { runId: expected.runId, phase: 'completed', at: this.now() }, check);
    });
  }

  // This must commit before runtime invocation. Same-command calls never
  // grant permission to invoke again, including after terminal completion.
  begin(sessionKey: string, commandId: string, commit?: Commit, gatewayConnectionId?: string) {
    return this.change(sessionKey, previous => this.startingFact(sessionKey, commandId, gatewayConnectionId, previous), commit);
  }

  /** Fixed receipt-admission participant. No transaction or notification here:
   * the caller owns rollback and publishes only after its durable commit. */
  beginInTransaction(sessionKey: string, commandId: string, gatewayConnectionId: string) {
    if (!this.db.isTransaction) throw new Error('Execution admission requires its owning transaction');
    const check = synchronousParticipantInspector(this.db);
    if (!check) throw new Error('Execution admission requires a synchronous owner');
    return this.changeInTransaction(sessionKey, previous => this.startingFact(sessionKey, commandId, gatewayConnectionId, previous), check).accepted;
  }

  private startingFact(sessionKey: string, commandId: string, gatewayConnectionId: string | undefined, previous?: Fact): Fact | undefined {
    if (!validId(sessionKey, 4096) || !validId(commandId, 512)) throw new Error('Invalid execution identity');
    if (gatewayConnectionId !== undefined && !validId(gatewayConnectionId, 512)) throw new Error('Invalid Gateway connection identity');
    if (!this.sessionAvailable(sessionKey)) return;
    if (previous && (previous.commandId === commandId || !terminal(previous.phase))) return;
    const at = this.now();
    return { sessionKey, commandId, origin: 'gateway', phase: 'starting', startedAt: at, updatedAt: at, pending: [],
      ...(previous?.historySync ? { historySync: previous.historySync } : {}),
      ...(gatewayConnectionId ? { gatewayConnectionId } : {}) };
  }

  // Accepted delivery and queue removal can share this transaction. A missing
  // run ID records acceptance with unknown execution, never guessed running.
  acknowledge(sessionKey: string, commandId: string, runId: unknown, commit?: Commit) {
    return this.forCommand(sessionKey, commandId, (fact, check) => {
      if (fact.origin !== 'gateway') return;
      if (!validId(runId, 512)) {
        if (!fact.runId && !fact.fenced) { fact.phase = 'unknown'; fact.reason = 'run_unbound'; }
        return fact;
      }
      if (fact.runId && fact.runId !== runId) return this.fence(fact, 'ack_conflict');
      if (fact.runId) return fact; // duplicate ACK cannot reopen a terminal run
      fact.runId = runId;
      const early = fact.pending.find((event) => event.runId === runId && event.gatewayConnectionId === fact.gatewayConnectionId);
      const unowned = fact.pending.some((event) => event.runId !== runId && (!terminal(event.phase) || event.conflict));
      fact.pending = [];
      if (fact.fenced) return fact;
      if (unowned) return this.fence(fact, 'unowned_run');
      fact.phase = 'starting'; // acceptance is not a runtime started event
      delete fact.reason;
      return early ? this.apply(fact, early, check) : fact;
    }, commit);
  }

  observe(sessionKey: string, event: OpenClawRunObservation) {
    if (!validId(event.runId, 512) || !['running', 'waiting', 'unknown', 'completed', 'failed'].includes(event.phase)) return false;
    if (event.gatewayConnectionId !== undefined && !validId(event.gatewayConnectionId, 512)) return false;
    if (event.reply !== undefined && (event.phase !== 'completed' || !event.gatewayConnectionId
      || typeof event.reply.text !== 'string' || Buffer.byteLength(event.reply.text) > 1024 * 1024
      || !Number.isSafeInteger(event.reply.sequence) || event.reply.sequence < 0)) return false;
    if (event.replyOnly && !event.reply) return false;
    return this.change(sessionKey, (fact, check) => {
      if (!fact || fact.fenced || fact.reason === 'restarted') return;
      // CLI has no proven Gateway correlation. Active native evidence cannot
      // be dismissed merely because our own invocation used another transport.
      if (fact.origin === 'cli') return !terminal(event.phase)
        ? this.fence(fact, 'unowned_run') : undefined;
      // A reconnect is not proof that identical native run strings identify
      // the same execution. Missing source cannot complete a bound fact.
      if ((fact.gatewayConnectionId || fact.runId) && fact.gatewayConnectionId !== event.gatewayConnectionId) {
        return event.gatewayConnectionId && !terminal(event.phase) ? this.fence(fact, 'unowned_run') : undefined;
      }
      const observation = { runId: event.runId, phase: event.phase, gatewayConnectionId: event.gatewayConnectionId,
        ...(event.reply ? { reply: structuredClone(event.reply) } : {}), ...(event.replyOnly ? { replyOnly: true as const } : {}), at: this.now() };
      if (fact.runId) return fact.runId === event.runId ? this.apply(fact, observation, check)
        : !terminal(event.phase) ? this.fence(fact, 'unowned_run') : undefined;
      const previous = fact.pending.find((entry) => entry.runId === event.runId && entry.gatewayConnectionId === event.gatewayConnectionId);
      if (previous) {
        if (event.replyOnly) {
          if (previous.reply && JSON.stringify(previous.reply) !== JSON.stringify(event.reply)) previous.conflict = true;
          else previous.reply = structuredClone(event.reply!);
          return fact;
        }
        if (previous.replyOnly) { delete previous.replyOnly; Object.assign(previous, observation); return fact; }
        if (terminal(previous.phase)) {
          if (terminal(event.phase) && previous.phase !== event.phase) previous.conflict = true;
          if (previous.phase === 'completed' && event.reply) {
            if (previous.reply && JSON.stringify(previous.reply) !== JSON.stringify(event.reply)) previous.conflict = true;
            else previous.reply = structuredClone(event.reply);
          }
        } else if (previous.phase !== event.phase) Object.assign(previous, observation);
      } else if (fact.pending.length < 8) fact.pending.push(observation);
      else return this.fence(fact, 'evidence_overflow');
      return fact;
    }, undefined, db => this.gatewayEvidence?.observeFinalInTransaction(db, sessionKey, event));
  }

  // Only after a definitive Gateway rejection and fresh authorization. This
  // is an origin transition for the SAME dispatch, not a second admission.
  useCli(sessionKey: string, commandId: string) {
    return this.forCommand(sessionKey, commandId, (fact) => {
      if (fact.origin !== 'gateway' || fact.runId || fact.phase !== 'starting' || fact.fenced) return;
      if (fact.pending.some((event) => !terminal(event.phase) || event.conflict)) return;
      fact.origin = 'cli'; fact.pending = [];
      return fact;
    });
  }

  acknowledgeCli(sessionKey: string, commandId: string, commit?: Commit) {
    return this.forCommand(sessionKey, commandId, (fact) => {
      if (fact.origin !== 'cli') return;
      if (fact.phase === 'starting') fact.phase = 'running';
      return fact;
    }, commit);
  }

  finishCli(sessionKey: string, commandId: string, phase: 'completed' | 'failed', commit?: Commit) {
    return this.forCommand(sessionKey, commandId, (fact, check) => fact.origin === 'cli' && !fact.fenced && fact.phase !== phase
      ? this.apply(fact, { runId: '', phase, at: this.now() }, check) : undefined, commit);
  }

  uncertain(sessionKey: string, commandId: string, commit?: Commit) {
    return this.forCommand(sessionKey, commandId, (fact) => {
      // A late/lost ACK may follow a native terminal event. Preserve that
      // evidence, but still atomically protect its original unconsumed queue.
      if (terminal(fact.phase) || fact.fenced) return commit ? fact : undefined;
      fact.phase = 'unknown'; fact.reason = 'send_unknown';
      return fact;
    }, commit);
  }

  // Caller must have definitive evidence that this invocation was rejected
  // before any run started. A timeout/transport error is never such evidence.
  rejectBeforeRun(sessionKey: string, commandId: string, commit?: Commit) {
    return this.forCommand(sessionKey, commandId, (fact, check) => {
      if (fact.runId || fact.fenced || terminal(fact.phase)) return;
      return this.apply(fact, { runId: '', phase: 'failed', at: this.now() }, check);
    }, commit);
  }

  unownedActivity(sessionKey: string) {
    return this.change(sessionKey, (fact) => fact && !fact.fenced && fact.reason !== 'restarted' ? this.fence(fact, 'unowned_run') : undefined);
  }

  // Opening a read handle does not mutate facts. The sole runtime owner calls
  // this on startup; accepted runs survive queue deletion and process restart.
  recoverInterrupted() {
    let changed = false;
    observedTransaction(this.db, 'openclaw-execution-recovery', (_commit, check) => {
      check(this.gatewayEvidence?.recoverGatewayInTransaction(this.db));
      for (const row of this.db.prepare('SELECT fact FROM connector_openclaw_executions').all() as { fact: string }[]) {
        const fact = JSON.parse(row.fact) as Fact;
        const needsHistory = fact.historySync || (terminal(fact.phase) && fact.origin === 'gateway' && fact.runId);
        if (needsHistory) fact.historySync = { revision: (fact.historySync?.revision ?? 0) + 1, state: 'pending' };
        if (!terminal(fact.phase) && !fact.fenced) { fact.phase = 'unknown'; fact.reason = 'restarted'; }
        else if (!needsHistory) continue;
        fact.updatedAt = this.now();
        fact.revision = (fact.revision ?? 0) + 1;
        this.write(fact, check);
        check(this.gatewayEvidence?.syncExecutionInTransaction(this.db, fact));
        check(this.commandEvidence?.recordExecutionInTransaction(this.db, 'openclaw', fact));
        changed = true;
      }
    });
    if (changed) this.journal?.changes.notify();
  }

  private apply(fact: Fact, event: Evidence, check: CheckParticipant) {
    if (fact.fenced) return fact;
    if (event.conflict || (!event.replyOnly && terminal(fact.phase) && terminal(event.phase) && fact.phase !== event.phase)) return this.fence(fact, 'terminal_conflict');
    if (event.replyOnly) { check(this.gatewayEvidence?.syncExecutionInTransaction(this.db, fact, event.reply)); return fact; }
    if (terminal(fact.phase)) {
      if (fact.phase === 'completed' && event.reply) check(this.gatewayEvidence?.syncExecutionInTransaction(this.db, fact, event.reply));
      return fact;
    }
    if (fact.phase === event.phase && !fact.reason) return fact;
    fact.phase = event.phase;
    delete fact.reason;
    if (terminal(event.phase)) {
      fact.completedAt = Math.max(fact.startedAt, event.at);
      // CLI replies are projected by their dispatch path; a pre-run rejection
      // has no native transcript to fetch. Do not erase either with a read.
      if (fact.origin === 'gateway' && fact.runId) {
        fact.historySync = { revision: (fact.historySync?.revision ?? 0) + 1, state: 'pending' };
      }
    }
    if (event.reply) check(this.gatewayEvidence?.syncExecutionInTransaction(this.db, fact, event.reply));
    return fact;
  }

  private fence(fact: Fact, reason: 'ack_conflict' | 'terminal_conflict' | 'evidence_overflow' | 'unowned_run') {
    fact.phase = 'unknown'; fact.reason = reason; fact.fenced = true; fact.pending = [];
    delete fact.completedAt;
    return fact;
  }

  private forCommand(sessionKey: string, commandId: string, update: (fact: Fact, check: CheckParticipant) => Fact | undefined, commit?: Commit) {
    // Matching old IDs is not authority for a new owner to settle or replay a
    // restarted execution. Keep ACK commits and CLI callbacks behind this gate.
    return this.change(sessionKey, (fact, check) => fact?.commandId === commandId && fact.reason !== 'restarted' ? update(fact, check) : undefined, commit);
  }

  private change(sessionKey: string, update: (fact: Fact | undefined, check: CheckParticipant) => Fact | undefined, commit?: Commit, observe?: Commit) {
    let changed = false;
    let accepted = false;
    observedTransaction(this.db, 'openclaw-execution-change', (_commit, check) => {
      ({ changed, accepted } = this.changeInTransaction(sessionKey, update, check, commit, observe));
    });
    if (changed) this.journal?.changes.notify();
    return accepted;
  }

  private changeInTransaction(sessionKey: string, update: (fact: Fact | undefined, check: CheckParticipant) => Fact | undefined,
    check: CheckParticipant, commit?: Commit, observe?: Commit) {
    let changed = false;
    const before = this.read(sessionKey);
    const revision = before?.revision ?? 0;
    const body = JSON.stringify(before);
    const after = update(before, check);
    if (after && JSON.stringify(after) !== body) { after.updatedAt = this.now(); after.revision = revision + 1; this.write(after, check); changed = true; }
    if (after) check(this.gatewayEvidence?.syncExecutionInTransaction(this.db, after));
    if (after) check(commit?.(this.db));
    if (after) check(this.commandEvidence?.recordExecutionInTransaction(this.db, 'openclaw', after));
    check(observe?.(this.db));
    return { changed, accepted: !!after };
  }

  private read(sessionKey: string) {
    const row = this.db.prepare('SELECT fact FROM connector_openclaw_executions WHERE session_key = ?').get(sessionKey) as { fact: string } | undefined;
    return row ? JSON.parse(row.fact) as Fact : undefined;
  }

  private write(fact: Fact, check: CheckParticipant) {
    const body = JSON.stringify(fact);
    // Reserve lifecycle metadata independently of its current text length:
    // hitting the quota must not prevent an already-bound run from completing.
    const bytes = Buffer.byteLength(JSON.stringify({ sessionKey: fact.sessionKey, commandId: fact.commandId, startedAt: fact.startedAt }))
      + Buffer.byteLength(fact.sessionKey) + 512 + Buffer.byteLength(JSON.stringify(fact.pending)) + Buffer.byteLength(JSON.stringify(fact.runId ?? ''))
      + Buffer.byteLength(JSON.stringify(fact.gatewayConnectionId ?? ''));
    const previous = this.db.prepare('SELECT bytes FROM connector_openclaw_executions WHERE session_key = ?').get(fact.sessionKey) as { bytes: number } | undefined;
    const usage = this.db.prepare('SELECT rows, bytes FROM connector_openclaw_execution_usage WHERE singleton = 1').get() as { rows: number; bytes: number };
    if ((!previous && usage.rows >= this.maxRows) || usage.bytes - (previous?.bytes ?? 0) + bytes > this.maxBytes) throw new Error('Execution capacity reached');
    this.db.prepare(`INSERT INTO connector_openclaw_executions VALUES (?, ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET fact = excluded.fact, bytes = excluded.bytes`).run(fact.sessionKey, body, bytes);
    // No native identity or execution status in the event: snapshots read the
    // committed fact, even if a later in-memory projection callback is lost.
    check(this.journal?.appendInTransaction(this.db, { id: '', type: 'run.updated', ts: fact.updatedAt,
      sessionKey: fact.sessionKey, payload: { invalidation: true, executionRevision: fact.revision } }));
  }
}
