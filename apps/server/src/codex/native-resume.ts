import { randomUUID } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { CodexExecution } from './executions.js';
import { observedTransaction } from '../storage/observed-transaction.js';
import type { PerformanceDiagnostics } from '../diagnostics/performance.js';

/** Original executor evidence, not a command body or a replayable job. */
export type NativeResumeExpected = Pick<CodexExecution, 'sessionKey' | 'commandId' | 'connectionId' | 'revision'> & { runId: string };
export type NativeResumeInput = {
  expected: NativeResumeExpected; nativeConnectionId: string; threadId: string; fingerprint: string;
  continuation: { headId: string; headVersion: string } | null;
};
export type NativeResumeReceipt = { sessionKey: string; intentId: string; nativeConnectionId: string };
type Intent = NativeResumeInput & NativeResumeReceipt & { state: 'prewrite' | 'dispatch_may_have_started' };
const fields = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const id = (v: unknown, limit: number): v is string => typeof v === 'string' && !!v.trim()
  && !/[\x00-\x1f\x7f]/.test(v) && Buffer.byteLength(JSON.stringify(v)) <= limit;
const key = (v: unknown): v is string => id(v, 4096) && v.startsWith('codex:') && v.length > 6;
const queueVersion = (v: unknown) => typeof v === 'string' && /^[1-9][0-9]{0,18}:(0|[1-9][0-9]{0,18})$/.test(v)
  && v.split(':').every(n => BigInt(n) <= 9223372036854775807n);
export function validNativeResumeInput(v: unknown): v is NativeResumeInput {
  return fields(v, ['expected', 'nativeConnectionId', 'threadId', 'fingerprint', 'continuation'])
    && fields(v.expected, ['sessionKey', 'commandId', 'connectionId', 'runId', 'revision'])
    && key(v.expected.sessionKey) && id(v.expected.commandId, 512) && id(v.expected.connectionId, 128)
    && id(v.expected.runId, 512) && Number.isSafeInteger(v.expected.revision) && (v.expected.revision as number) > 0
    && id(v.nativeConnectionId, 128) && id(v.threadId, 512) && typeof v.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(v.fingerprint)
    && (v.continuation === null || fields(v.continuation, ['headId', 'headVersion'])
      && id(v.continuation.headId, 512) && queueVersion(v.continuation.headVersion));
}
export function validNativeResumeReceipt(v: unknown): v is NativeResumeReceipt {
  return fields(v, ['sessionKey', 'intentId', 'nativeConnectionId']) && key(v.sessionKey) && id(v.nativeConnectionId, 128)
    && typeof v.intentId === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v.intentId);
}
const matches = (current: CodexExecution | undefined, expected: NativeResumeExpected) => !!current
  && current.sessionKey === expected.sessionKey && current.commandId === expected.commandId && current.connectionId === expected.connectionId
  && current.runId === expected.runId && current.revision === expected.revision;

/** A restarted owned run is not idle, but its persisted native terminal can
 * still be loaded for reconciliation. This grants neither a turn nor replay.
 * Other unknown reasons, preparation and hard fences remain non-recoverable. */
export const nativeResumeEligible = (current: CodexExecution & { fenced?: boolean }) => !current.fenced && !current.preparation
  && ((!current.reason && ['completed', 'failed', 'interrupted'].includes(current.phase))
    || current.phase === 'unknown' && current.reason === 'restarted');

// Register before Connector's startup migrations/default-user INSERT: an
// existing additive fence is already active when its new owner opens the DB.
export function registerNativeResumeWriter(db: DatabaseSync) {
  db.function('agentopsdeck_codex_native_resume_epoch', { deterministic: true }, () => 1);
}

/** One bounded unresolved intent per ORIGINAL execution row. No TTL, eviction,
 * native call, content copy or replay. Prewrite is never dispatch authority.
 * Only a known begin ACK allows the original executor to write to native.
 * Unknown begin/native ACK survives restart and blocks admission/maintenance.
 */
export class CodexNativeResumes {
  private readonly pendingStatement: StatementSync;
  constructor(private readonly db: DatabaseSync, private readonly execution: (key: string) => (CodexExecution & { fenced?: boolean }) | undefined,
    private readonly deleted: (key: string) => boolean,
    private readonly settleAcknowledged: (sessionKey: string, take: () => NativeResumeExpected | undefined) => boolean,
    private readonly diagnostics?: PerformanceDiagnostics) {
    registerNativeResumeWriter(db);
    db.exec(`CREATE TABLE IF NOT EXISTS connector_codex_native_resume (
      session_key TEXT PRIMARY KEY NOT NULL REFERENCES connector_codex_executions(session_key),
      record TEXT NOT NULL CHECK(length(CAST(record AS BLOB)) <= 8192)
    )`);
    this.pendingStatement = db.prepare('SELECT 1 FROM connector_codex_native_resume WHERE session_key = ?');
  }
  pending(sessionKey: string): boolean {
    return !!this.pendingStatement.get(sessionKey);
  }
  private read(receipt: NativeResumeReceipt): Intent | undefined {
    if (!validNativeResumeReceipt(receipt)) throw Error('Invalid native resume receipt');
    const row = this.db.prepare('SELECT record FROM connector_codex_native_resume WHERE session_key = ?')
      .get(receipt.sessionKey) as { record: string } | undefined;
    if (!row) return;
    const v = JSON.parse(row.record) as Intent;
    const { intentId, sessionKey, state, ...input } = v;
    if (!validNativeResumeInput(input) || !validNativeResumeReceipt({ intentId, sessionKey, nativeConnectionId: v.nativeConnectionId })
      || input.expected.sessionKey !== sessionKey || !['prewrite', 'dispatch_may_have_started'].includes(state)) {
      throw Error('Invalid persisted native resume intent');
    }
    return v.intentId === receipt.intentId && v.nativeConnectionId === receipt.nativeConnectionId ? v : undefined;
  }
  writerFence() {
    for (const table of ['connector_codex_executions', 'connector_users', 'connector_codex_native_resume']) {
      if (!this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table)) continue;
      for (const operation of table === 'connector_users' ? ['INSERT'] : ['INSERT', 'UPDATE', 'DELETE']) {
        const name = `codex_native_resume_${table}_${operation.toLowerCase()}`;
        const sql = `CREATE TRIGGER ${name} BEFORE ${operation} ON ${table}
          WHEN agentopsdeck_codex_native_resume_epoch() IS NOT 1
          BEGIN SELECT RAISE(ABORT, 'Incompatible native resume writer; use a compatible release'); END`;
        const old = this.db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?").get(name) as { sql: string } | undefined;
        if (old && old.sql.replace(/\s+/g, ' ').trim() !== sql.replace(/\s+/g, ' ').trim()) throw Error('Native resume writer guard changed');
        if (!old) this.db.exec(sql);
      }
    }
  }
  prepare(input: NativeResumeInput, authorized: (input: NativeResumeInput) => boolean): NativeResumeReceipt | null {
    if (!validNativeResumeInput(input)) throw Error('Invalid native resume intent');
    return observedTransaction(this.db, 'codex-native-resume', (_commit, inspect) => {
      const current = this.execution(input.expected.sessionKey);
      if (!matches(current, input.expected) || !nativeResumeEligible(current!) || this.deleted(current!.sessionKey)
        || this.pending(current!.sessionKey)) return null;
      const allowed = authorized(input); inspect(allowed);
      if (allowed !== true) return null;
      this.writerFence();
      const receipt = { sessionKey: current!.sessionKey, intentId: randomUUID(), nativeConnectionId: input.nativeConnectionId };
      this.db.prepare('INSERT INTO connector_codex_native_resume VALUES (?, ?)')
        .run(receipt.sessionKey, JSON.stringify({ ...input, ...receipt, state: 'prewrite' } satisfies Intent));
      return receipt;
    }, this.diagnostics);
  }
  begin(receipt: NativeResumeReceipt, authorized: (input: NativeResumeInput) => boolean): boolean {
    return observedTransaction(this.db, 'codex-native-resume', (_commit, inspect) => {
      const intent = this.read(receipt);
      const current = this.execution(receipt.sessionKey);
      if (!intent || intent.state !== 'prewrite' || !matches(current, intent.expected) || !nativeResumeEligible(current!)
        || this.deleted(receipt.sessionKey)) return false;
      const allowed = authorized(intent); inspect(allowed);
      if (allowed !== true) return false;
      intent.state = 'dispatch_may_have_started';
      this.db.prepare('UPDATE connector_codex_native_resume SET record = ? WHERE session_key = ?').run(JSON.stringify(intent), receipt.sessionKey);
      return true;
    }, this.diagnostics);
  }
  /** Exact original receipt only. not_dispatched requires proof the original
   * write callback was never reached. A timeout/error after possible dispatch
   * or a replacement task cannot establish either settlement outcome. */
  finish(receipt: NativeResumeReceipt, outcome: 'acknowledged' | 'not_dispatched'): boolean {
    if (!['acknowledged', 'not_dispatched'].includes(outcome)) throw Error('Invalid native resume outcome');
    // The original execution transaction atomically invalidates its old idle
    // proof before removing the intent. A known resume ACK is NOT a fresh drain
    // proof; admission must not reopen between ACK and history reconciliation.
    if (outcome === 'acknowledged') return this.settleAcknowledged(receipt.sessionKey, () => {
      const intent = this.read(receipt);
      if (!intent || intent.state !== 'dispatch_may_have_started') return;
      this.db.prepare('DELETE FROM connector_codex_native_resume WHERE session_key = ?').run(receipt.sessionKey);
      return intent.expected;
    });
    return observedTransaction(this.db, 'codex-native-resume', () => {
      const intent = this.read(receipt);
      if (!intent) return false;
      this.db.prepare('DELETE FROM connector_codex_native_resume WHERE session_key = ?').run(receipt.sessionKey);
      return true;
    }, this.diagnostics);
  }
  recoverPrewritesInTransaction() {
    // Only original startup, before any native writer is started. A durable
    // prewrite cannot have obtained begin ACK; dispatched records NEVER clear.
    if (!this.db.isTransaction) throw Error('Native resume recovery requires its original startup transaction');
    return Number(this.db.prepare(
      "DELETE FROM connector_codex_native_resume WHERE json_extract(record, '$.state') = 'prewrite'").run().changes);
  }
}
