import type { DatabaseSync } from 'node:sqlite';
import { observedTransaction } from '../storage/observed-transaction.js';
import type { PerformanceDiagnostics } from '../diagnostics/performance.js';

/** Metadata only: never tool input, message text, or a native command to replay. */
export type StoppedCodexRun = {
  sessionKey: string;
  commandId: string;
  connectionId: string;
  runId: string;
  revision: number;
};
export type StoppedCodexProof = {
  nodeId: string;
  jobId: string;
  fenceId: string;
  backupId: string;
  verifiedAt: number;
};
const identity = (value: unknown, limit: number): value is string => typeof value === 'string' && !!value.trim()
  && !/[\x00-\x1f\x7f]/.test(value) && Buffer.byteLength(JSON.stringify(value)) <= limit;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const sameRun = (a: StoppedCodexRun, b: StoppedCodexRun) => a.sessionKey === b.sessionKey && a.commandId === b.commandId
  && a.connectionId === b.connectionId && a.runId === b.runId;
const failure = () => new Error('Stopped Codex recovery evidence does not match the persisted execution');

export function validStoppedCodexRun(value: unknown): value is StoppedCodexRun {
  return object(value) && Object.keys(value).length === 5
    && identity(value.sessionKey, 4096) && value.sessionKey.startsWith('codex:')
    && identity(value.commandId, 512) && identity(value.connectionId, 128) && identity(value.runId, 512)
    && count(value.revision) && value.revision > 0;
}
export function validStoppedCodexRuns(value: unknown): value is StoppedCodexRun[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 64 && value.every(validStoppedCodexRun)
    && new Set(value.map(run => run.sessionKey)).size === value.length && Buffer.byteLength(JSON.stringify(value)) <= 24 * 1024;
}
/** Journal encoding/HTTP can reorder fields (or rows). Compare exact bounded
 * identities, not JSON text. Revision remains part of the pre-stop fence.
 */
export function sameStoppedCodexRuns(first: unknown, second: unknown): boolean {
  if (!validStoppedCodexRuns(first) || !validStoppedCodexRuns(second) || first.length !== second.length) return false;
  const expected = new Map(second.map(run => [run.sessionKey, run]));
  return first.every(run => {
    const other = expected.get(run.sessionKey);
    return !!other && sameRun(run, other) && run.revision === other.revision;
  });
}
function validProof(value: unknown): value is StoppedCodexProof {
  return object(value) && Object.keys(value).length === 5
    && ['nodeId', 'jobId', 'fenceId', 'backupId'].every(key => identity(value[key], 256)) && count(value.verifiedAt);
}
export function initializeStoppedCodexRecovery(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS connector_codex_stopped_recovery (
    session_key TEXT PRIMARY KEY NOT NULL,
    record TEXT NOT NULL CHECK(length(CAST(record AS BLOB)) <= 8192)
  )`);
}

/** Read-side exception to the interrupted-wrapper guard, not history readiness.
 * A new execution, another installation, or a different native connection can
 * never inherit this proof. A later history-sync revision of the SAME terminal
 * is allowed: the old native process cannot be resurrected by projection reads.
 */
export function hasStoppedCodexRecovery(db: DatabaseSync, current: StoppedCodexRun & {
  phase: string; preparation?: unknown; fenced?: boolean;
}, runId: string): boolean {
  if (current.phase !== 'interrupted' || current.preparation || current.fenced || current.runId !== runId) return false;
  const row = db.prepare('SELECT record FROM connector_codex_stopped_recovery WHERE session_key = ?')
    .get(current.sessionKey) as { record: string } | undefined;
  if (!row) return false;
  let receipt: any;
  try { receipt = JSON.parse(row.record); } catch { return false; }
  const node = db.prepare('SELECT node_id FROM connector_identity WHERE singleton = 1').get() as { node_id: string } | undefined;
  return receipt?.version === 1 && validStoppedCodexRun(receipt.run) && validProof(receipt.proof)
    && receipt.proof.nodeId === node?.node_id && sameRun(receipt.run, current) && current.revision >= receipt.run.revision;
}

/** ONLY the independent node supervisor may call this, AFTER it has verified
 * the configured service cgroup empty and verified a stopped-state backup.
 * This is not an HTTP recovery endpoint or an alternative to process evidence.
 * Caller owns OS proof/authority; this layer enforces exact, all-or-nothing DB
 * identity. Never edit executions, receipts, native history, or queued payloads.
 */
export function recordStoppedCodexRecovery(db: DatabaseSync, runs: readonly StoppedCodexRun[], proof: StoppedCodexProof,
  diagnostics?: PerformanceDiagnostics, deadline?: number) {
  const requireDeadline = () => {
    if (deadline !== undefined && (!Number.isSafeInteger(deadline) || deadline <= Date.now())) throw failure();
  };
  requireDeadline();
  if (!validProof(proof) || proof.verifiedAt > Date.now() || !validStoppedCodexRuns(runs)) throw failure();
  const databases = db.prepare('PRAGMA database_list').all() as { name: string; file: string }[];
  const synchronous = db.prepare('PRAGMA synchronous').get() as { synchronous: number };
  if (!databases.some(database => database.name === 'main' && database.file) || synchronous.synchronous < 2) throw failure();
  // The owner boundary rejects foreign transactions and contains lost BEGIN,
  // COMMIT and cleanup acknowledgments without retrying this proof write.
  observedTransaction(db, 'codex-stopped-recovery', () => {
    requireDeadline();
    const node = db.prepare('SELECT node_id FROM connector_identity WHERE singleton = 1').get() as { node_id: string } | undefined;
    if (node?.node_id !== proof.nodeId) throw failure();
    for (const run of runs) {
      const row = db.prepare('SELECT fact FROM connector_codex_executions WHERE session_key = ?')
        .get(run.sessionKey) as { fact: string } | undefined;
      const fact = row ? JSON.parse(row.fact) : undefined;
      // A late same-run tool notification can increase the revision during
      // stop. Accept only the same terminal, never a new command/connection.
      if (!fact || !sameRun(run, fact) || !count(fact.revision) || fact.revision < run.revision
        || fact.phase !== 'interrupted' || fact.fenced || fact.preparation || fact.reason
        || !(['syncing', 'error'].includes(fact.sync) || (fact.sync === 'current' && fact.nativeHistory?.state === 'blocked' && fact.nativeHistory?.reason === 'cleanup-unconfirmed')) || !count(fact.updatedAt) || proof.verifiedAt < fact.updatedAt) throw failure();
    }
    requireDeadline();
    for (const run of runs) db.prepare(`INSERT INTO connector_codex_stopped_recovery VALUES (?, ?)
      ON CONFLICT(session_key) DO UPDATE SET record = excluded.record`).run(run.sessionKey, JSON.stringify({ version: 1, run, proof }));
    requireDeadline();
  }, diagnostics);
}
