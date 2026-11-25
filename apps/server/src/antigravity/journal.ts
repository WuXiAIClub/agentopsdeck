import type { DatabaseSync } from 'node:sqlite';
import { AuthPersistenceError } from '../auth/private-store.js';
import { synchronousSqliteValue } from '../auth/synchronous-sqlite-value.js';
import type { CodexBatch } from '../codex/queued-batch.js';
import type { TurnQueue } from '../commands/turn-queue.js';
import { performanceDiagnostics, type PerformanceDiagnostics } from '../diagnostics/performance.js';
import { observedSavepoint } from '../storage/observed-savepoint.js';
import type {
  AntigravityExecutionIdentity,
  AntigravityExecutionJournal as AntigravityExecutionJournalPort,
  AntigravityExecutionOutcome,
  AntigravityExecutionResult,
} from './owned-execution.js';

export const ANTIGRAVITY_JOURNAL_SNAPSHOT_BYTES = 131_072;
export type AntigravityNativeState = 'allocated' | 'starting' | 'ready' | 'unknown';
export type AntigravitySession = {
  key: string;
  nativeSessionId: string | null;
  title: string;
  createdAt: number;
  nativeState: AntigravityNativeState;
};
export type AntigravityExecutionPhase = 'starting' | 'running' | AntigravityExecutionOutcome;
export type AntigravityExecution = {
  id: string;
  key: string;
  ownerEpoch: string;
  nativeMode: 'create' | 'resume';
  nativeSessionId?: string;
  members: string[];
  batch?: CodexBatch;
  phase: AntigravityExecutionPhase;
  stopRequested: boolean;
  createdAt: number;
  updatedAt: number;
};
export type AntigravityDeletion = {
  id: string;
  key: string;
  nativeSessionId: string | null;
  phase: 'pending' | 'deleted' | 'unknown';
  createdAt: number;
};
export type AntigravityJournalSnapshot = {
  session: AntigravitySession | null;
  execution: AntigravityExecution | null;
  deletion: AntigravityDeletion | null;
  canStart: boolean;
  unresolved: boolean;
};
type DataRow = { data: string };

const failure = () => Error('Antigravity execution journal identity or state could not be verified');
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
const validKey = (value: unknown): value is string => validId(value)
  && value.startsWith('antigravity:') && value !== 'antigravity:';
const terminal = (phase: AntigravityExecutionPhase): phase is 'completed' | 'cancelled' | 'failed' =>
  phase === 'completed' || phase === 'cancelled' || phase === 'failed';

export class AntigravityJournal implements AntigravityExecutionJournalPort {
  checkAuthority<Args extends unknown[] = []>(authorize: (...args: Args) => void, receiver?: unknown, args?: Args): void {
    if (synchronousSqliteValue(this.db, authorize, receiver, args) !== undefined) throw new AuthPersistenceError();
  }

  checkPermission<Args extends unknown[]>(authorize: (...args: Args) => boolean, args: Args, receiver?: unknown): boolean {
    return synchronousSqliteValue(this.db, authorize, receiver, args) === true;
  }

  constructor(
    private readonly db: DatabaseSync,
    private readonly now = Date.now,
    private readonly beforeCreate: () => void = () => {},
    private readonly sessionAvailable: (key: string) => boolean = () => true,
    private readonly diagnostics: PerformanceDiagnostics = performanceDiagnostics,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS antigravity_sessions (
      session_key TEXT PRIMARY KEY,
      native_session_id TEXT UNIQUE,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS antigravity_executions (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      session_key TEXT NOT NULL,
      phase TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS antigravity_execution_session ON antigravity_executions(session_key, sequence);
    CREATE INDEX IF NOT EXISTS antigravity_execution_pending ON antigravity_executions(phase);
    CREATE TABLE IF NOT EXISTS antigravity_deletions (
      session_key TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );`);
  }

  create(session: { key: string; title: string; createdAt: number }, commit?: (db: DatabaseSync) => void): AntigravitySession {
    if (!validKey(session.key) || typeof session.title !== 'string' || session.title.length > 512
      || !Number.isSafeInteger(session.createdAt) || session.createdAt < 0) throw failure();
    const record: AntigravitySession = {
      key: session.key,
      nativeSessionId: null,
      title: session.title,
      createdAt: session.createdAt,
      nativeState: 'allocated',
    };
    return this.atomic(check => {
      check(this.beforeCreate());
      this.db.prepare('INSERT INTO antigravity_sessions(session_key, native_session_id, data) VALUES (?, NULL, ?)')
        .run(record.key, JSON.stringify(record));
      check(commit?.(this.db));
      return record;
    });
  }

  session(key: string): AntigravitySession | undefined {
    if (!validKey(key) || this.deletion(key)?.phase === 'deleted') return;
    const row = this.db.prepare('SELECT native_session_id, data FROM antigravity_sessions WHERE session_key = ?')
      .get(key) as { native_session_id: string | null; data: string } | undefined;
    if (!row) return;
    const session = JSON.parse(row.data) as AntigravitySession;
    const validState = ['allocated', 'starting', 'ready', 'unknown'].includes(session.nativeState);
    const validBinding = row.native_session_id === null
      ? session.nativeSessionId === null && (session.nativeState === 'allocated' || session.nativeState === 'starting' || session.nativeState === 'unknown')
      : validId(row.native_session_id) && session.nativeSessionId === row.native_session_id && session.nativeState !== 'allocated';
    if (!validState || !validBinding) {
      return { ...session, nativeSessionId: validId(row.native_session_id) ? row.native_session_id : null, nativeState: 'unknown' };
    }
    return session;
  }

  sessionKeys(after?: string, limit = 200): string[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200
      || after !== undefined && !validKey(after)) throw failure();
    const rows = this.db.prepare(`SELECT session_key FROM antigravity_sessions
      WHERE session_key > ? ORDER BY session_key LIMIT ?`)
      .all(after ?? '', limit) as { session_key: string }[];
    return rows.map(row => row.session_key);
  }

  current(key: string): AntigravityExecution | undefined {
    if (!validKey(key)) return;
    const row = this.db.prepare('SELECT data FROM antigravity_executions WHERE session_key = ? ORDER BY sequence DESC LIMIT 1')
      .get(key) as DataRow | undefined;
    return row && JSON.parse(row.data) as AntigravityExecution;
  }

  deletion(key: string): AntigravityDeletion | undefined {
    if (!validKey(key)) return;
    const row = this.db.prepare('SELECT data FROM antigravity_deletions WHERE session_key = ?')
      .get(key) as DataRow | undefined;
    return row && JSON.parse(row.data) as AntigravityDeletion;
  }

  canStart(key: string): boolean {
    if (!validKey(key) || !this.sessionAvailable(key) || this.deletion(key)) return false;
    const session = this.session(key);
    if (!session) return false;
    if (session.nativeState === 'allocated' && session.nativeSessionId !== null) return false;
    if (session.nativeState === 'ready' && !validId(session.nativeSessionId)) return false;
    if (session.nativeState !== 'allocated' && session.nativeState !== 'ready') return false;
    const execution = this.current(key);
    return !execution || terminal(execution.phase);
  }

  hasUnresolved(key: string): boolean {
    if (!validKey(key)) return true;
    const deletion = this.deletion(key);
    if (deletion) return deletion.phase !== 'deleted';
    const session = this.session(key);
    if (session && session.nativeState !== 'allocated' && session.nativeState !== 'ready') return true;
    const execution = this.current(key);
    return !!execution && !terminal(execution.phase);
  }

  readSnapshot(key: string): AntigravityJournalSnapshot {
    if (!validKey(key)) throw Error('connector_storage_unavailable');
    return this.atomic(() => {
      let total = 0;
      for (const query of [
        'SELECT %SIZE% FROM antigravity_sessions WHERE session_key = ?',
        'SELECT %SIZE% FROM antigravity_executions WHERE session_key = ? ORDER BY sequence DESC LIMIT 1',
        'SELECT %SIZE% FROM antigravity_deletions WHERE session_key = ?',
      ]) {
        const row = this.db.prepare(query.replace('%SIZE%', `CASE WHEN typeof(data) = 'text'
          AND length(CAST(data AS BLOB)) <= ${ANTIGRAVITY_JOURNAL_SNAPSHOT_BYTES}
          THEN length(CAST(data AS BLOB)) ELSE -1 END AS bytes`)).get(key) as { bytes: number } | undefined;
        if (row && (!Number.isSafeInteger(row.bytes) || row.bytes < 0 || (total += row.bytes) > ANTIGRAVITY_JOURNAL_SNAPSHOT_BYTES)) {
          throw Error('connector_storage_unavailable');
        }
      }
      return {
        session: this.session(key) ?? null,
        execution: this.current(key) ?? null,
        deletion: this.deletion(key) ?? null,
        canStart: this.canStart(key),
        unresolved: this.hasUnresolved(key),
      };
    });
  }

  begin(
    identity: AntigravityExecutionIdentity,
    members: string[],
    turns: TurnQueue,
    batch?: CodexBatch,
    authorize?: () => boolean,
  ): AntigravityExecution | undefined {
    if (!validKey(identity.key) || !validId(identity.executionId) || !validId(identity.ownerEpoch)
      || !members.length || members.length > 16 || new Set(members).size !== members.length
      || members.some(id => !validId(id))) throw failure();
    if (batch && (!/^\n\n\[Queued message boundary [a-f0-9-]{36}\]\n\n$/.test(batch.separator)
      || batch.members.length !== members.length || batch.members.some((member, index) => member.id !== members[index]
        || !Number.isSafeInteger(member.createdAt) || member.createdAt < 0
        || !Number.isSafeInteger(member.imageCount) || member.imageCount < 0))) throw failure();
    return this.atomic(check => {
      if (authorize) {
        const authorized = authorize();
        check(authorized);
        if (authorized !== true) return;
      }
      if (!this.canStart(identity.key) || !turns.startBatchInTransaction(this.db, 'antigravity', identity.key, members)) return;
      const now = this.now(), session = this.session(identity.key)!;
      const nativeMode = session.nativeState === 'allocated' ? 'create' : 'resume';
      if (nativeMode === 'create' && session.nativeSessionId !== null) return;
      if (nativeMode === 'resume' && !validId(session.nativeSessionId)) return;
      const execution: AntigravityExecution = {
        id: identity.executionId,
        key: identity.key,
        ownerEpoch: identity.ownerEpoch,
        nativeMode,
        ...(session.nativeSessionId ? { nativeSessionId: session.nativeSessionId } : {}),
        members: [...members],
        ...(batch ? {
          batch: {
            separator: batch.separator,
            members: batch.members.map(({ id, createdAt, imageCount }) => ({ id, createdAt, imageCount })),
          },
        } : {}),
        phase: 'starting',
        stopRequested: false,
        createdAt: now,
        updatedAt: now,
      };
      this.db.prepare('INSERT INTO antigravity_executions(id, session_key, phase, data) VALUES (?, ?, ?, ?)')
        .run(execution.id, execution.key, execution.phase, JSON.stringify(execution));
      this.saveSession({ ...session, nativeState: 'starting' });
      return execution;
    });
  }

  assertBinding(identity: AntigravityExecutionIdentity, nativeSessionId: string): void {
    if (!validKey(identity.key) || !validId(identity.executionId) || !validId(identity.ownerEpoch)
      || !validId(nativeSessionId) || !this.sessionAvailable(identity.key) || this.deletion(identity.key)) throw failure();
    const execution = this.match(identity), session = this.session(identity.key);
    if (!execution || !session || session.nativeState !== 'starting'
      || session.nativeSessionId !== nativeSessionId || execution.nativeSessionId !== nativeSessionId
      || execution.phase !== 'starting' && execution.phase !== 'running') throw failure();
  }

  async bindAndPersistIntent(identity: AntigravityExecutionIdentity, nativeSessionId: string): Promise<void> {
    this.bindAndPersistIntentSync(identity, nativeSessionId);
  }

  bindAndPersistIntentSync(identity: AntigravityExecutionIdentity, nativeSessionId: string, turns?: TurnQueue): void {
    if (!validKey(identity.key) || !validId(identity.executionId) || !validId(identity.ownerEpoch)
      || !validId(nativeSessionId)) throw failure();
    this.atomic(() => {
      if (!this.sessionAvailable(identity.key) || this.deletion(identity.key)) throw failure();
      const execution = this.match(identity), session = this.session(identity.key);
      if (!execution || !session || session.nativeState !== 'starting') throw failure();
      if (execution.phase !== 'starting' || execution.stopRequested) throw failure();
      if (execution.nativeMode === 'create') {
        if (session.nativeSessionId !== null || execution.nativeSessionId !== undefined) throw failure();
      } else if (session.nativeSessionId !== nativeSessionId || execution.nativeSessionId !== nativeSessionId) {
        throw failure();
      }
      this.saveSession({ ...session, nativeSessionId, nativeState: 'starting' });
      this.saveExecution({ ...execution, nativeSessionId, phase: 'running' });
      turns?.settleClaimedBatchInTransaction(this.db, 'antigravity', execution.key, execution.members, 'accepted');
    });
  }

  requestStop(identity: AntigravityExecutionIdentity): boolean {
    if (!validKey(identity.key) || !validId(identity.executionId) || !validId(identity.ownerEpoch)) throw failure();
    return this.atomic(() => {
      const execution = this.match(identity);
      if (!execution || execution.phase !== 'starting' && execution.phase !== 'running') return false;
      if (execution.stopRequested) return true;
      this.saveExecution({ ...execution, stopRequested: true });
      return true;
    });
  }

  async settle(identity: AntigravityExecutionIdentity, result: AntigravityExecutionResult): Promise<void> {
    this.settleSync(identity, result);
  }

  settleSync(identity: AntigravityExecutionIdentity, result: AntigravityExecutionResult, turns?: TurnQueue): void {
    if (!validKey(identity.key) || !validId(identity.executionId) || !validId(identity.ownerEpoch)
      || !result || !['completed', 'cancelled', 'failed', 'unknown'].includes(result.outcome)
      || result.nativeSessionId !== undefined && !validId(result.nativeSessionId)) throw failure();
    this.atomic(() => {
      const execution = this.match(identity), session = this.session(identity.key);
      if (!execution || !session) throw failure();
      if (execution.phase === result.outcome) {
        if (result.outcome !== 'unknown' && (!validId(result.nativeSessionId)
          || execution.nativeSessionId !== result.nativeSessionId
          || session.nativeSessionId !== result.nativeSessionId)) throw failure();
        if (result.outcome === 'unknown' && result.nativeSessionId !== undefined
          && execution.nativeSessionId !== undefined && execution.nativeSessionId !== result.nativeSessionId) throw failure();
        return;
      }
      if (terminal(execution.phase) || execution.phase === 'unknown') throw failure();
      if (result.outcome === 'unknown') {
        if (result.nativeSessionId !== undefined && execution.nativeSessionId !== undefined
          && execution.nativeSessionId !== result.nativeSessionId) throw failure();
        if (session.nativeSessionId !== null && execution.nativeSessionId !== session.nativeSessionId) throw failure();
        this.saveExecution({ ...execution, phase: 'unknown' });
        this.saveSession({ ...session, nativeState: 'unknown' });
        if (turns && execution.phase === 'starting') {
          turns.settleClaimedBatchInTransaction(this.db, 'antigravity', execution.key, execution.members, 'unknown');
        }
        return;
      }
      if (!this.sessionAvailable(identity.key) || this.deletion(identity.key)
        || execution.phase !== 'running' || session.nativeState !== 'starting'
        || !validId(result.nativeSessionId) || execution.nativeSessionId !== result.nativeSessionId
        || session.nativeSessionId !== result.nativeSessionId) throw failure();
      this.saveExecution({ ...execution, phase: result.outcome });
      this.saveSession({ ...session, nativeState: 'ready' });
    });
  }

  markUnknown(identity: AntigravityExecutionIdentity, turns?: TurnQueue): boolean {
    if (!validKey(identity.key) || !validId(identity.executionId) || !validId(identity.ownerEpoch)) return false;
    return this.atomic(() => {
      const execution = this.match(identity);
      if (!execution || terminal(execution.phase)) return false;
      if (execution.phase !== 'unknown') {
        const wasStarting = execution.phase === 'starting';
        this.saveExecution({ ...execution, phase: 'unknown' });
        if (turns && wasStarting) {
          turns.settleClaimedBatchInTransaction(this.db, 'antigravity', execution.key, execution.members, 'unknown');
        }
      }
      const session = this.session(identity.key);
      if (session && session.nativeState !== 'unknown') this.saveSession({ ...session, nativeState: 'unknown' });
      return true;
    });
  }

  recover(turns?: TurnQueue): void {
    this.atomic(() => {
      this.db.prepare(`UPDATE antigravity_deletions SET data = json_set(data, '$.phase', 'unknown')
        WHERE json_extract(data, '$.phase') = 'pending'`).run();
      const rows = this.db.prepare("SELECT data FROM antigravity_executions WHERE phase NOT IN ('completed', 'cancelled', 'failed', 'unknown')")
        .all() as DataRow[];
      for (const row of rows) {
        const execution = JSON.parse(row.data) as AntigravityExecution;
        this.markUnknown({ key: execution.key, executionId: execution.id, ownerEpoch: execution.ownerEpoch }, turns);
      }
      const sessions = this.db.prepare("SELECT session_key FROM antigravity_sessions WHERE json_extract(data, '$.nativeState') = 'starting'")
        .all() as { session_key: string }[];
      for (const { session_key } of sessions) {
        const session = this.session(session_key);
        if (session && session.nativeState !== 'unknown') this.saveSession({ ...session, nativeState: 'unknown' });
      }
    });
  }

  pendingCount(): number {
    const executions = (this.db.prepare("SELECT count(*) AS total FROM antigravity_executions WHERE phase NOT IN ('completed', 'cancelled', 'failed')")
      .get() as { total: number }).total;
    const sessions = (this.db.prepare(`SELECT count(*) AS total FROM antigravity_sessions s
      WHERE coalesce(json_extract(s.data, '$.nativeState'), 'unknown') NOT IN ('allocated', 'ready')
      AND NOT EXISTS (SELECT 1 FROM antigravity_executions e WHERE e.session_key = s.session_key
        AND e.phase NOT IN ('completed', 'cancelled', 'failed'))`).get() as { total: number }).total;
    const deletions = (this.db.prepare(`SELECT count(*) AS total FROM antigravity_deletions
      WHERE json_extract(data, '$.phase') != 'deleted'`).get() as { total: number }).total;
    return executions + sessions + deletions;
  }

  beginDeletion(key: string, id: string): AntigravityDeletion {
    if (!validKey(key) || !validId(id)) throw failure();
    return this.atomic(() => {
      if (!this.canStart(key)) throw failure();
      const session = this.session(key)!;
      const deletion: AntigravityDeletion = {
        id,
        key,
        nativeSessionId: session.nativeSessionId,
        phase: 'pending',
        createdAt: this.now(),
      };
      this.db.prepare('INSERT INTO antigravity_deletions(session_key, data) VALUES (?, ?)')
        .run(key, JSON.stringify(deletion));
      return deletion;
    });
  }

  settleDeletion(ref: AntigravityDeletion, accepted: boolean, commit: (db: DatabaseSync) => void = () => {}): void {
    if (!ref || !validKey(ref.key) || !validId(ref.id)) throw failure();
    this.atomic(check => {
      const current = this.deletion(ref.key);
      if (!current || current.id !== ref.id || current.nativeSessionId !== ref.nativeSessionId || current.phase !== 'pending') {
        throw failure();
      }
      this.db.prepare('UPDATE antigravity_deletions SET data = ? WHERE session_key = ?')
        .run(JSON.stringify({ ...current, phase: accepted ? 'deleted' : 'unknown' }), ref.key);
      check(commit(this.db));
    });
  }

  private match(identity: AntigravityExecutionIdentity): AntigravityExecution | undefined {
    const execution = this.current(identity.key);
    return execution?.id === identity.executionId && execution.ownerEpoch === identity.ownerEpoch ? execution : undefined;
  }

  private saveExecution(execution: AntigravityExecution): void {
    const next = { ...execution, updatedAt: this.now() };
    this.db.prepare('UPDATE antigravity_executions SET phase = ?, data = ? WHERE id = ?')
      .run(next.phase, JSON.stringify(next), next.id);
  }

  private saveSession(session: AntigravitySession): void {
    this.db.prepare('UPDATE antigravity_sessions SET native_session_id = ?, data = ? WHERE session_key = ?')
      .run(session.nativeSessionId, JSON.stringify(session), session.key);
  }

  private atomic<T>(work: (checkParticipant: (value: unknown) => void) => T extends PromiseLike<unknown> ? never : T): T {
    return observedSavepoint(this.db, 'sdk-execution-change', work, this.diagnostics);
  }
}
