import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { observedTransaction } from '../storage/observed-transaction.js';

export type StoppedUnknownExpected = {
  sessionKey: string; commandId: string; connectionId: string; revision: number;
  factSha256: string; queueVersion: string; queueSha256: string; successorsSha256: string; successorCount: number;
};
export type StoppedUnknownProof = {
  nodeId: string; jobId: string; backupId: string; verifiedAt: number;
  serviceInvocation: string; ownerPid: number; physicalStopSha256: string;
};
export type StoppedUnknownDisposition = {
  expected: StoppedUnknownExpected; proof: StoppedUnknownProof;
  consentId: string; action: 'retain-unknown-without-replay';
};
type QueueRow = {
  sequence: string; runtime: string; id: string; session_key: string; created_at: number;
  state: string; payload: string; revision: number;
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const fields = (value: unknown, names: string[]): value is Record<string, unknown> => !!value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const id = (value: unknown, limit = 512): value is string => typeof value === 'string' && !!value.trim()
  && !/[\x00-\x1f\x7f]/.test(value) && Buffer.byteLength(value) <= limit;
const sha = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const failure = () => Error('Stopped unknown disposition evidence mismatch; retain original records');

export function validStoppedUnknownProof(value: unknown): value is StoppedUnknownProof {
  return fields(value, ['nodeId', 'jobId', 'backupId', 'verifiedAt', 'serviceInvocation', 'ownerPid', 'physicalStopSha256'])
    && ['nodeId', 'jobId', 'backupId'].every(name => id(value[name], 256))
    && Number.isSafeInteger(value.verifiedAt) && Number(value.verifiedAt) >= 0
    && Number.isSafeInteger(value.ownerPid) && Number(value.ownerPid) > 1
    && typeof value.serviceInvocation === 'string' && /^[a-f0-9]{32}$/.test(value.serviceInvocation)
    && sha(value.physicalStopSha256);
}

export function validStoppedUnknownDisposition(value: unknown): value is StoppedUnknownDisposition {
  if (!fields(value, ['expected', 'proof', 'consentId', 'action']) || value.action !== 'retain-unknown-without-replay'
    || !id(value.consentId, 256) || !validStoppedUnknownProof(value.proof)
    || !fields(value.expected, ['sessionKey', 'commandId', 'connectionId', 'revision', 'factSha256', 'queueVersion',
      'queueSha256', 'successorsSha256', 'successorCount'])) return false;
  const expected = value.expected;
  return id(expected.sessionKey, 4096) && expected.sessionKey.startsWith('codex:')
    && id(expected.commandId) && id(expected.connectionId, 128)
    && Number.isSafeInteger(expected.revision) && Number(expected.revision) > 0
    && ['factSha256', 'queueSha256', 'successorsSha256'].every(name => sha(expected[name]))
    && typeof expected.queueVersion === 'string' && /^[1-9][0-9]{0,18}:[1-9][0-9]{0,18}$/.test(expected.queueVersion)
    && Number.isSafeInteger(expected.successorCount) && Number(expected.successorCount) >= 0 && Number(expected.successorCount) < 10_000;
}

function readUnknown(db: DatabaseSync, sessionKey: string) {
  const row = db.prepare(`SELECT fact, length(CAST(fact AS BLOB)) AS bytes FROM connector_codex_executions WHERE session_key = ?`)
    .get(sessionKey) as { fact: string; bytes: number } | undefined;
  if (!row || row.bytes > 8192) throw failure();
  const fact = JSON.parse(row.fact);
  const allowed = ['sessionKey', 'commandId', 'connectionId', 'phase', 'sync', 'revision', 'startedAt', 'updatedAt', 'pending', 'reason', 'pendingCommandTools'];
  if (Object.keys(fact).some(name => !allowed.includes(name)) || fact.sessionKey !== sessionKey || fact.phase !== 'unknown'
    || !['restarted', 'send_unknown'].includes(fact.reason) || fact.sync !== 'current' || !Array.isArray(fact.pending) || fact.pending.length
    || fact.pendingCommandTools !== undefined && (!Array.isArray(fact.pendingCommandTools) || fact.pendingCommandTools.length)
    || !Number.isSafeInteger(fact.updatedAt) || !Number.isSafeInteger(fact.startedAt) || fact.updatedAt < fact.startedAt) throw failure();
  if (db.prepare('SELECT 1 FROM connector_codex_native_resume WHERE session_key = ?').get(sessionKey)) throw failure();
  const measured = db.prepare(`SELECT count(*) AS count, coalesce(sum(length(CAST(payload AS BLOB))), 0) AS bytes
    FROM connector_turns WHERE runtime = 'codex' AND session_key = ?`).get(sessionKey)!;
  if (Number(measured.count) < 1 || Number(measured.count) > 10_000 || Number(measured.bytes) > 32 * 1024 * 1024) throw failure();
  const rows = db.prepare(`SELECT CAST(sequence AS TEXT) AS sequence, runtime, id, session_key, created_at, state, payload, revision
    FROM connector_turns WHERE runtime = 'codex' AND session_key = ? ORDER BY connector_turns.sequence`).all(sessionKey) as QueueRow[];
  const [head, ...successors] = rows;
  if (!head || head.id !== fact.commandId || head.state !== 'outcome_unknown'
    || successors.some(entry => entry.state !== 'queued')) throw failure();
  const expected: StoppedUnknownExpected = {
    sessionKey, commandId: fact.commandId, connectionId: fact.connectionId, revision: fact.revision,
    factSha256: hash(row.fact), queueVersion: head.sequence + ':' + head.revision,
    queueSha256: hash(JSON.stringify(head)), successorsSha256: hash(JSON.stringify(successors)), successorCount: successors.length,
  };
  return { expected, fact: row.fact, updatedAt: fact.updatedAt as number, head };
}

export function inspectStoppedUnknown(db: DatabaseSync, sessionKey: string): StoppedUnknownExpected {
  return readUnknown(db, sessionKey).expected;
}

export function disposeStoppedUnknown(db: DatabaseSync, disposition: StoppedUnknownDisposition,
  diagnostics?: PerformanceDiagnostics, deadline = Date.now() + 30_000) {
  if (!validStoppedUnknownDisposition(disposition) || !Number.isSafeInteger(deadline)) throw failure();
  const requireDeadline = () => { if (deadline <= Date.now()) throw failure(); };
  observedTransaction(db, 'codex-stopped-unknown-disposition', () => {
    requireDeadline();
    const { expected, proof } = disposition;
    const node = db.prepare('SELECT node_id FROM connector_identity WHERE singleton = 1').get();
    if (node?.node_id !== proof.nodeId || proof.verifiedAt > Date.now() || Date.now() - proof.verifiedAt > 300_000) throw failure();
    const original = readUnknown(db, expected.sessionKey);
    if (Object.keys(expected).some(name => expected[name as keyof StoppedUnknownExpected] !== original.expected[name as keyof StoppedUnknownExpected])
      || proof.verifiedAt < original.updatedAt) throw failure();
    db.exec(`CREATE TABLE IF NOT EXISTS connector_codex_unknown_dispositions (
      job_id TEXT PRIMARY KEY NOT NULL, session_key TEXT NOT NULL, command_id TEXT NOT NULL,
      original_fact TEXT NOT NULL CHECK(length(CAST(original_fact AS BLOB)) <= 8192),
      original_queue TEXT NOT NULL CHECK(length(CAST(original_queue AS BLOB)) <= 33562624),
      receipt TEXT NOT NULL CHECK(length(CAST(receipt AS BLOB)) <= 16384),
      UNIQUE(session_key, command_id)
    )`);
    const usage = db.prepare(`SELECT count(*) AS count, coalesce(sum(length(CAST(original_queue AS BLOB))), 0) AS bytes
      FROM connector_codex_unknown_dispositions`).get()!;
    if (Number(usage.count) >= 128 || Number(usage.bytes) + Buffer.byteLength(JSON.stringify(original.head)) > 64 * 1024 * 1024) throw failure();
    db.prepare('INSERT INTO connector_codex_unknown_dispositions VALUES (?, ?, ?, ?, ?, ?)')
      .run(proof.jobId, expected.sessionKey, expected.commandId, original.fact, JSON.stringify(original.head),
        JSON.stringify({ version: 1, ...disposition, disposedAt: Date.now() }));
    requireDeadline();
    const removedQueue = db.prepare(`DELETE FROM connector_turns WHERE runtime = 'codex' AND session_key = ? AND id = ?
      AND state = 'outcome_unknown' AND sequence || ':' || revision = ?`).run(expected.sessionKey, expected.commandId, expected.queueVersion);
    const removedFact = db.prepare('DELETE FROM connector_codex_executions WHERE session_key = ? AND fact = ?')
      .run(expected.sessionKey, original.fact);
    if (removedQueue.changes !== 1 || removedFact.changes !== 1) throw failure();
    requireDeadline();
  }, diagnostics);
}
