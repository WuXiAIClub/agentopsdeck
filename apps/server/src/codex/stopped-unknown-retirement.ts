import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { observedTransaction } from '../storage/observed-transaction.js';
import { validStoppedUnknownProof, type StoppedUnknownProof } from './stopped-unknown-disposition.js';
import { validStoppedUnknownBatchDisposition } from './stopped-unknown-batch.js';

export type StoppedUnknownRetirementExpected = {
  sessionKey: string; commandId: string; connectionId: string; revision: number; factSha256: string;
  archiveJobId: string; archiveFactSha256: string; archiveQueueSha256: string; archiveReceiptSha256: string;
  successorsSha256: string; successorCount: number;
};
export type StoppedUnknownRetirement = {
  expected: StoppedUnknownRetirementExpected; proof: StoppedUnknownProof; consentId: string;
  action: 'retire-archived-batch-protection-without-replay';
};
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const fields = (v: unknown, names: string[]): v is Record<string, any> => !!v && typeof v === 'object'
  && !Array.isArray(v) && Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const id = (v: unknown, size = 512): v is string => typeof v === 'string' && !!v.trim()
  && !/[\x00-\x1f\x7f]/.test(v) && Buffer.byteLength(v) <= size;
const fail = () => Error('Archived unknown retirement evidence mismatch; retain original records');
export function validStoppedUnknownRetirement(v: unknown): v is StoppedUnknownRetirement {
  if (!fields(v, ['expected', 'proof', 'consentId', 'action']) || !validStoppedUnknownProof(v.proof)
    || !id(v.consentId, 256) || v.action !== 'retire-archived-batch-protection-without-replay'
    || !fields(v.expected, ['sessionKey', 'commandId', 'connectionId', 'revision', 'factSha256', 'archiveJobId',
      'archiveFactSha256', 'archiveQueueSha256', 'archiveReceiptSha256', 'successorsSha256', 'successorCount'])) return false;
  const e = v.expected;
  return id(e.sessionKey, 4096) && e.sessionKey.startsWith('codex:') && id(e.commandId) && id(e.connectionId, 128)
    && id(e.archiveJobId, 256) && Number.isSafeInteger(e.revision) && e.revision > 0
    && Number.isSafeInteger(e.successorCount) && e.successorCount >= 0 && e.successorCount < 10_000
    && ['factSha256', 'archiveFactSha256', 'archiveQueueSha256', 'archiveReceiptSha256', 'successorsSha256']
      .every(k => typeof e[k] === 'string' && /^[a-f0-9]{64}$/.test(e[k]));
}

function read(db: DatabaseSync, sessionKey: string) {
  const row = db.prepare(`SELECT fact, length(CAST(fact AS BLOB)) AS bytes
    FROM connector_codex_executions WHERE session_key=?`).get(sessionKey);
  if (!row || Number(row.bytes) > 8192) throw fail();
  const raw = String(row.fact), fact = JSON.parse(raw);
  const permitted = ['sessionKey', 'commandId', 'connectionId', 'phase', 'sync', 'revision', 'startedAt', 'updatedAt',
    'pending', 'pendingCommandTools', 'batch', 'reason'];
  if (!fact || typeof fact !== 'object' || Object.keys(fact).some(k => !permitted.includes(k))
    || fact.sessionKey !== sessionKey || !id(fact.commandId) || !id(fact.connectionId, 128)
    || fact.phase !== 'unknown' || fact.sync !== 'current' || !['restarted', 'send_unknown'].includes(fact.reason)
    || !Number.isSafeInteger(fact.revision) || fact.revision < 1
    || !Number.isSafeInteger(fact.startedAt) || !Number.isSafeInteger(fact.updatedAt) || fact.updatedAt < fact.startedAt
    || !Array.isArray(fact.pending) || fact.pending.length
    || fact.pendingCommandTools !== undefined && (!Array.isArray(fact.pendingCommandTools) || fact.pendingCommandTools.length)
    || db.prepare('SELECT 1 FROM connector_codex_native_resume WHERE session_key=?').get(sessionKey)) throw fail();
  const archive = db.prepare(`SELECT *, length(CAST(original_queue AS BLOB)) AS bytes,
    length(CAST(original_fact AS BLOB)) AS fact_bytes, length(CAST(receipt AS BLOB)) AS receipt_bytes
    FROM connector_codex_unknown_dispositions WHERE session_key=? AND command_id=?`).get(sessionKey, fact.commandId);
  if (!archive || Number(archive.bytes) > 33562624 || Number(archive.fact_bytes) > 8192
    || Number(archive.receipt_bytes) > 16384) throw fail();
  const receipt = JSON.parse(String(archive.receipt));
  if (!fields(receipt, ['version', 'expected', 'proof', 'consentId', 'action', 'disposedAt', 'executionProtectionRetained'])
    || receipt.version !== 2 || receipt.executionProtectionRetained !== true
    || !Number.isSafeInteger(receipt.disposedAt) || receipt.disposedAt > Date.now()
    || !validStoppedUnknownBatchDisposition({ expected: receipt.expected, proof: receipt.proof,
      consentId: receipt.consentId, action: receipt.action })
    || archive.job_id !== receipt.proof.jobId || receipt.expected.sessionKey !== sessionKey
    || receipt.expected.commandId !== fact.commandId || receipt.expected.connectionId !== fact.connectionId
    || receipt.expected.factSha256 !== hash(String(archive.original_fact))
    || receipt.expected.unknownSha256 !== hash(String(archive.original_queue))) throw fail();
  const original = JSON.parse(String(archive.original_fact)), members = original.batch?.members;
  const queue = JSON.parse(String(archive.original_queue));
  if (!Array.isArray(members) || !Array.isArray(queue) || queue.length !== receipt.expected.unknownCount
    || members.length !== queue.length || members.length < 2 || members.length > 16
    || original.sessionKey !== sessionKey || original.commandId !== fact.commandId || original.connectionId !== fact.connectionId
    || original.phase !== 'unknown' || original.sync !== 'current' || !['send_unknown', 'restarted'].includes(original.reason)
    || original.revision !== receipt.expected.revision || fact.revision < original.revision
    || fact.startedAt !== original.startedAt || fact.updatedAt < original.updatedAt
    || JSON.stringify(fact.batch) !== JSON.stringify(original.batch)
    || !fields(original.batch, ['separator', 'members']) || typeof original.batch.separator !== 'string'
    || !original.batch.separator || Buffer.byteLength(original.batch.separator) > 1024
    || new Set(members.map((m: any) => m.id)).size !== members.length
    || members[0]?.id !== fact.commandId
    || queue.some((q: any, i: number) => !fields(members[i], ['id', 'createdAt', 'imageCount'])
      || q.runtime !== 'codex' || q.session_key !== sessionKey || q.state !== 'outcome_unknown'
      || q.id !== members[i].id || q.created_at !== members[i].createdAt
      || !Number.isSafeInteger(q.revision) || q.revision < 1 || !/^[1-9][0-9]{0,18}$/.test(q.sequence)
      || !Number.isSafeInteger(members[i].imageCount) || members[i].imageCount < 0 || members[i].imageCount > 8
      || !Array.isArray(JSON.parse(q.payload)?.images) || JSON.parse(q.payload).images.length !== members[i].imageCount)) throw fail();
  const measured = db.prepare(`SELECT count(*) AS count, coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes
    FROM connector_turns WHERE runtime='codex' AND session_key=?`).get(sessionKey)!;
  if (Number(measured.count) >= 10_000 || Number(measured.bytes) > 32 * 1024 * 1024) throw fail();
  const successors = db.prepare(`SELECT CAST(sequence AS TEXT) AS sequence, runtime, id, session_key, created_at,
    state, payload, revision FROM connector_turns WHERE runtime='codex' AND session_key=? ORDER BY connector_turns.sequence`).all(sessionKey);
  if (successors.some(q => q.state !== 'queued' || members.some((m: any) => m.id === q.id))
    || successors.length !== receipt.expected.successorCount
    || hash(JSON.stringify(successors)) !== receipt.expected.successorsSha256) throw fail();
  const expected: StoppedUnknownRetirementExpected = {
    sessionKey, commandId: fact.commandId, connectionId: fact.connectionId, revision: fact.revision, factSha256: hash(raw),
    archiveJobId: String(archive.job_id), archiveFactSha256: hash(String(archive.original_fact)),
    archiveQueueSha256: hash(String(archive.original_queue)), archiveReceiptSha256: hash(String(archive.receipt)),
    successorsSha256: hash(JSON.stringify(successors)), successorCount: successors.length,
  };
  return { expected, raw, updatedAt: fact.updatedAt, archiveNodeId: receipt.proof.nodeId,
    archiveBackupId: receipt.proof.backupId };
}

export function inspectStoppedUnknownRetirement(db: DatabaseSync, sessionKey: string) {
  return read(db, sessionKey).expected;
}

/** An explicit disposition, NEVER a fabricated native completion. The original
 * 16 inputs/receipt remain immutable and are never copied back into the queue.
 * Only a NEW physically stopped backup owner may retire the retained fence.
 * Fresh successors still need normal FIFO/current-auth/cold-load admission. */
export function retireStoppedUnknown(db: DatabaseSync, disposition: StoppedUnknownRetirement, deadline = Date.now() + 30_000) {
  if (!validStoppedUnknownRetirement(disposition) || !Number.isSafeInteger(deadline)) throw fail();
  const fresh = () => { if (deadline <= Date.now()) throw fail(); };
  observedTransaction(db, 'codex-stopped-unknown-disposition', () => {
    fresh();
    const { expected, proof } = disposition;
    const original = read(db, expected.sessionKey);
    const node = db.prepare('SELECT node_id FROM connector_identity WHERE singleton=1').get();
    if (node?.node_id !== proof.nodeId || original.archiveNodeId !== proof.nodeId
      || proof.jobId === expected.archiveJobId || proof.backupId === original.archiveBackupId
      || proof.verifiedAt > Date.now() || Date.now() - proof.verifiedAt > 300_000
      || proof.verifiedAt < original.updatedAt
      || Object.keys(expected).some(k => expected[k as keyof typeof expected] !== original.expected[k as keyof typeof expected])) throw fail();
    db.exec(`CREATE TABLE IF NOT EXISTS connector_codex_unknown_retirements (
      job_id TEXT PRIMARY KEY NOT NULL, session_key TEXT NOT NULL, command_id TEXT NOT NULL,
      original_fact TEXT NOT NULL CHECK(length(CAST(original_fact AS BLOB))<=8192),
      receipt TEXT NOT NULL CHECK(length(CAST(receipt AS BLOB))<=16384), UNIQUE(session_key,command_id))`);
    if (Number(db.prepare('SELECT count(*) AS count FROM connector_codex_unknown_retirements').get()!.count) >= 128) throw fail();
    db.prepare('INSERT INTO connector_codex_unknown_retirements VALUES (?,?,?,?,?)').run(proof.jobId,
      expected.sessionKey, expected.commandId, original.raw,
      JSON.stringify({ version: 1, ...disposition, disposedAt: Date.now(), nativeOutcome: 'unknown', replayed: false }));
    fresh();
    if (db.prepare('DELETE FROM connector_codex_executions WHERE session_key=? AND fact=?')
      .run(expected.sessionKey, original.raw).changes !== 1) throw fail();
    fresh();
  });
}
