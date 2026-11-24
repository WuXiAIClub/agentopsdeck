import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { PerformanceDiagnostics } from '../diagnostics/performance.js';
import { observedTransaction } from '../storage/observed-transaction.js';
import { validStoppedUnknownProof, type StoppedUnknownProof } from './stopped-unknown-disposition.js';

export type StoppedUnknownBatchExpected = {
  sessionKey: string; commandId: string; connectionId: string; revision: number;
  factSha256: string; unknownSha256: string; unknownCount: number; successorsSha256: string; successorCount: number;
};
export type StoppedUnknownBatchDisposition = {
  expected: StoppedUnknownBatchExpected; proof: StoppedUnknownProof; consentId: string;
  action: 'retain-batch-without-replay-hold-successors';
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
const failure = () => Error('Stopped batch disposition evidence mismatch; retain original batch and execution protection');

export function validStoppedUnknownBatchDisposition(value: unknown): value is StoppedUnknownBatchDisposition {
  if (!fields(value, ['expected', 'proof', 'consentId', 'action'])
    || value.action !== 'retain-batch-without-replay-hold-successors' || !id(value.consentId, 256)
    || !validStoppedUnknownProof(value.proof)
    || !fields(value.expected, ['sessionKey', 'commandId', 'connectionId', 'revision', 'factSha256',
      'unknownSha256', 'unknownCount', 'successorsSha256', 'successorCount'])) return false;
  const expected = value.expected;
  return id(expected.sessionKey, 4096) && expected.sessionKey.startsWith('codex:')
    && id(expected.commandId) && id(expected.connectionId, 128)
    && Number.isSafeInteger(expected.revision) && Number(expected.revision) > 0
    && ['factSha256', 'unknownSha256', 'successorsSha256'].every(name => sha(expected[name]))
    && Number.isSafeInteger(expected.unknownCount) && Number(expected.unknownCount) >= 2 && Number(expected.unknownCount) <= 16
    && Number.isSafeInteger(expected.successorCount) && Number(expected.successorCount) >= 0 && Number(expected.successorCount) < 10_000;
}

function readBatch(db: DatabaseSync, sessionKey: string) {
  const row = db.prepare('SELECT fact, length(CAST(fact AS BLOB)) AS bytes FROM connector_codex_executions WHERE session_key = ?')
    .get(sessionKey) as { fact: string; bytes: number } | undefined;
  if (!row || row.bytes > 8192) throw failure();
  const fact = JSON.parse(row.fact);
  const allowed = ['sessionKey', 'commandId', 'connectionId', 'phase', 'sync', 'revision', 'startedAt', 'updatedAt',
    'pending', 'reason', 'pendingCommandTools', 'batch'];
  if (!fact || typeof fact !== 'object' || Object.keys(fact).some(name => !allowed.includes(name))
    || fact.sessionKey !== sessionKey || !id(fact.commandId) || !id(fact.connectionId, 128)
    || fact.phase !== 'unknown' || !['send_unknown', 'restarted'].includes(fact.reason) || fact.sync !== 'current'
    || !Number.isSafeInteger(fact.revision) || fact.revision < 1
    || !Array.isArray(fact.pending) || fact.pending.length
    || fact.pendingCommandTools !== undefined && (!Array.isArray(fact.pendingCommandTools) || fact.pendingCommandTools.length)
    || !Number.isSafeInteger(fact.updatedAt) || !Number.isSafeInteger(fact.startedAt) || fact.updatedAt < fact.startedAt
    || !fields(fact.batch, ['separator', 'members']) || typeof fact.batch.separator !== 'string' || !fact.batch.separator
    || Buffer.byteLength(fact.batch.separator) > 1024 || !Array.isArray(fact.batch.members)
    || fact.batch.members.length < 2 || fact.batch.members.length > 16) throw failure();
  if (db.prepare('SELECT 1 FROM connector_codex_native_resume WHERE session_key = ?').get(sessionKey)) throw failure();
  const measured = db.prepare(`SELECT count(*) AS count, coalesce(sum(length(CAST(payload AS BLOB))), 0) AS bytes
    FROM connector_turns WHERE runtime = 'codex' AND session_key = ?`).get(sessionKey)!;
  if (Number(measured.count) < fact.batch.members.length || Number(measured.count) > 10_000
    || Number(measured.bytes) > 32 * 1024 * 1024) throw failure();
  const rows = db.prepare(`SELECT CAST(sequence AS TEXT) AS sequence, runtime, id, session_key, created_at, state, payload, revision
    FROM connector_turns WHERE runtime = 'codex' AND session_key = ? ORDER BY connector_turns.sequence`).all(sessionKey) as QueueRow[];
  const unknown = rows.slice(0, fact.batch.members.length), successors = rows.slice(fact.batch.members.length);
  if (unknown[0]?.id !== fact.commandId || new Set(unknown.map(entry => entry.id)).size !== unknown.length
    || unknown.some((entry, index) => {
      const member = fact.batch.members[index];
      if (!fields(member, ['id', 'createdAt', 'imageCount']) || member.id !== entry.id || member.createdAt !== entry.created_at
        || entry.state !== 'outcome_unknown' || !/^[1-9][0-9]{0,18}$/.test(entry.sequence)
        || !Number.isSafeInteger(entry.revision) || entry.revision < 1
        || !Number.isSafeInteger(member.imageCount) || Number(member.imageCount) < 0 || Number(member.imageCount) > 8) return true;
      const payload = JSON.parse(entry.payload);
      return !Array.isArray(payload?.images) || payload.images.length !== member.imageCount;
    }) || successors.some(entry => entry.state !== 'queued')) throw failure();
  const expected: StoppedUnknownBatchExpected = {
    sessionKey, commandId: fact.commandId, connectionId: fact.connectionId, revision: fact.revision,
    factSha256: hash(row.fact), unknownSha256: hash(JSON.stringify(unknown)), unknownCount: unknown.length,
    successorsSha256: hash(JSON.stringify(successors)), successorCount: successors.length,
  };
  return { expected, fact: row.fact, updatedAt: fact.updatedAt as number, unknown };
}

export function inspectStoppedUnknownBatch(db: DatabaseSync, sessionKey: string): StoppedUnknownBatchExpected {
  return readBatch(db, sessionKey).expected;
}

export function disposeStoppedUnknownBatch(db: DatabaseSync, disposition: StoppedUnknownBatchDisposition,
  diagnostics?: PerformanceDiagnostics, deadline = Date.now() + 30_000) {
  if (!validStoppedUnknownBatchDisposition(disposition) || !Number.isSafeInteger(deadline)) throw failure();
  const requireDeadline = () => { if (deadline <= Date.now()) throw failure(); };
  observedTransaction(db, 'codex-stopped-unknown-disposition', () => {
    requireDeadline();
    const { expected, proof } = disposition;
    const node = db.prepare('SELECT node_id FROM connector_identity WHERE singleton = 1').get();
    if (node?.node_id !== proof.nodeId || proof.verifiedAt > Date.now() || Date.now() - proof.verifiedAt > 300_000) throw failure();
    const original = readBatch(db, expected.sessionKey);
    if (Object.keys(expected).some(name => expected[name as keyof StoppedUnknownBatchExpected] !== original.expected[name as keyof StoppedUnknownBatchExpected])
      || proof.verifiedAt < original.updatedAt) throw failure();
    db.exec(`CREATE TABLE IF NOT EXISTS connector_codex_unknown_dispositions (
      job_id TEXT PRIMARY KEY NOT NULL, session_key TEXT NOT NULL, command_id TEXT NOT NULL,
      original_fact TEXT NOT NULL CHECK(length(CAST(original_fact AS BLOB)) <= 8192),
      original_queue TEXT NOT NULL CHECK(length(CAST(original_queue AS BLOB)) <= 33562624),
      receipt TEXT NOT NULL CHECK(length(CAST(receipt AS BLOB)) <= 16384),
      UNIQUE(session_key, command_id)
    )`);
    const encoded = JSON.stringify(original.unknown);
    const usage = db.prepare(`SELECT count(*) AS count, coalesce(sum(length(CAST(original_queue AS BLOB))), 0) AS bytes
      FROM connector_codex_unknown_dispositions`).get()!;
    if (Number(usage.count) >= 128 || Number(usage.bytes) + Buffer.byteLength(encoded) > 64 * 1024 * 1024) throw failure();
    db.prepare('INSERT INTO connector_codex_unknown_dispositions VALUES (?, ?, ?, ?, ?, ?)')
      .run(proof.jobId, expected.sessionKey, expected.commandId, original.fact, encoded,
        JSON.stringify({ version: 2, ...disposition, disposedAt: Date.now(), executionProtectionRetained: true }));
    for (const entry of original.unknown) {
      requireDeadline();
      const removed = db.prepare(`DELETE FROM connector_turns WHERE runtime = 'codex' AND session_key = ? AND id = ?
        AND state = 'outcome_unknown' AND sequence || ':' || revision = ? AND payload = ?`)
        .run(expected.sessionKey, entry.id, entry.sequence + ':' + entry.revision, entry.payload);
      if (removed.changes !== 1) throw failure();
    }
    if (db.prepare('SELECT fact FROM connector_codex_executions WHERE session_key = ?').get(expected.sessionKey)?.fact !== original.fact) throw failure();
    requireDeadline();
  }, diagnostics);
}
