import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { observedTransaction } from '../storage/observed-transaction.js';
import { validOwnedThreadLoadInput } from './owned-thread-load.js';
import { validNativeResumeReceipt } from './native-resume.js';
import { validStoppedUnknownProof, type StoppedUnknownProof } from './stopped-unknown-disposition.js';

export type StoppedOwnedLoadExpected = {
  sessionKey: string; factSha256: string; intentSha256: string; queueSha256: string;
};
export type StoppedOwnedLoadRestartProof = {
  failureFact: string; failureFactSha256: string; backupId: string;
};
export type StoppedOwnedLoadRecovery = {
  action: 'recover-acknowledged-load-before-turn-start'; expected: StoppedOwnedLoadExpected;
  proof: StoppedUnknownProof; consentId: string; dispatchContractSha256: string;
  restartProof?: StoppedOwnedLoadRestartProof;
};
type Row = { sequence: string; runtime: string; id: string; session_key: string;
  created_at: number; state: string; payload: string; revision: number };
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const fields = (v: unknown, names: string[]): v is Record<string, any> => !!v && typeof v === 'object'
  && !Array.isArray(v) && Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const id = (v: unknown, limit: number): v is string => typeof v === 'string' && !!v.trim()
  && !/[\x00-\x1f\x7f]/.test(v) && Buffer.byteLength(v) <= limit;
const fail = () => Error('Stopped owned-load recovery evidence mismatch; retain original protection');

function validRestartProof(v: unknown): v is StoppedOwnedLoadRestartProof {
  return fields(v, ['failureFact', 'failureFactSha256', 'backupId'])
    && typeof v.failureFact === 'string' && Buffer.byteLength(v.failureFact) <= 8192
    && sha(v.failureFactSha256) && hash(v.failureFact) === v.failureFactSha256 && id(v.backupId, 512);
}

export function validStoppedOwnedLoadRecovery(v: unknown): v is StoppedOwnedLoadRecovery {
  const required = ['action', 'expected', 'proof', 'consentId', 'dispatchContractSha256'];
  return (fields(v, required) || fields(v, [...required, 'restartProof']) && validRestartProof(v.restartProof))
    && v.action === 'recover-acknowledged-load-before-turn-start' && validStoppedUnknownProof(v.proof)
    && id(v.consentId, 256) && sha(v.dispatchContractSha256)
    && fields(v.expected, ['sessionKey', 'factSha256', 'intentSha256', 'queueSha256'])
    && id(v.expected.sessionKey, 4096) && v.expected.sessionKey.startsWith('codex:')
    && v.expected.sessionKey.length > 6
    && ['factSha256', 'intentSha256', 'queueSha256'].every(k => sha(v.expected[k]));
}

function read(db: DatabaseSync, sessionKey: string, restartProof?: StoppedOwnedLoadRestartProof) {
  if (restartProof !== undefined && !validRestartProof(restartProof)) throw fail();
  const f = db.prepare(`SELECT fact, length(CAST(fact AS BLOB)) AS bytes
    FROM connector_codex_executions WHERE session_key=?`).get(sessionKey);
  const r = db.prepare(`SELECT record, length(CAST(record AS BLOB)) AS bytes
    FROM connector_codex_native_resume WHERE session_key=?`).get(sessionKey);
  if (!f || !r || Number(f.bytes) > 8192 || Number(r.bytes) > 8192) throw fail();
  const factRaw = String(f.fact), intentRaw = String(r.record);
  const currentFact = JSON.parse(factRaw), intent = JSON.parse(intentRaw);
  const fact = restartProof ? JSON.parse(restartProof.failureFact) : currentFact;
  if (restartProof && (!fact || typeof fact !== 'object' || Array.isArray(fact)
    || !currentFact || typeof currentFact !== 'object' || Array.isArray(currentFact)
    || !Number.isSafeInteger(currentFact.updatedAt) || currentFact.updatedAt < fact.updatedAt
    || !isDeepStrictEqual(currentFact, { ...fact, reason: 'restarted', revision: fact.revision + 1,
      updatedAt: currentFact.updatedAt }))) throw fail();
  if (!fields(intent, ['kind', 'state', 'sessionKey', 'commandId', 'connectionId', 'revision', 'proof', 'fingerprint',
    'intentId', 'nativeConnectionId']) || intent.kind !== 'owned-thread-load' || intent.state !== 'acknowledged'
    || !validOwnedThreadLoadInput({ sessionKey: intent.sessionKey, commandId: intent.commandId,
      connectionId: intent.connectionId, revision: intent.revision, proof: intent.proof, fingerprint: intent.fingerprint })
    || !validNativeResumeReceipt({ sessionKey: intent.sessionKey, intentId: intent.intentId,
      nativeConnectionId: intent.nativeConnectionId }) || intent.nativeConnectionId !== intent.connectionId) throw fail();
  const allowed = ['sessionKey', 'commandId', 'connectionId', 'phase', 'sync', 'revision', 'startedAt', 'updatedAt',
    'pending', 'pendingCommandTools', 'batch', 'reason'];
  if (!fact || typeof fact !== 'object' || Array.isArray(fact) || Object.keys(fact).some(k => !allowed.includes(k))
    || fact.sessionKey !== sessionKey || intent.sessionKey !== sessionKey || fact.commandId !== intent.commandId
    || fact.connectionId !== intent.connectionId || fact.phase !== 'unknown' || fact.sync !== 'current'
    || fact.reason !== 'send_unknown' || fact.revision !== intent.revision + 1
    || !Number.isSafeInteger(fact.revision) || !Number.isSafeInteger(fact.startedAt)
    || !Number.isSafeInteger(fact.updatedAt) || fact.startedAt < 0 || fact.updatedAt < fact.startedAt
    || !Array.isArray(fact.pending) || fact.pending.length
    || fact.pendingCommandTools !== undefined && (!Array.isArray(fact.pendingCommandTools) || fact.pendingCommandTools.length)) throw fail();
  const usage = db.prepare(`SELECT count(*) AS count, coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes
    FROM connector_turns WHERE runtime='codex' AND session_key=?`).get(sessionKey)!;
  if (Number(usage.count) < intent.proof.count || Number(usage.count) > 10_000
    || Number(usage.bytes) > 32 * 1024 * 1024) throw fail();
  const rows = db.prepare(`SELECT CAST(sequence AS TEXT) AS sequence, runtime, id, session_key, created_at,
    state, payload, revision FROM connector_turns WHERE runtime='codex' AND session_key=?
    ORDER BY connector_turns.sequence`).all(sessionKey) as Row[];
  const claimed = rows.slice(0, intent.proof.count), successors = rows.slice(intent.proof.count);
  if (claimed[0]?.id !== intent.commandId || new Set(rows.map(q => q.id)).size !== rows.length
    || rows.some(q => !/^[1-9][0-9]{0,18}$/.test(q.sequence) || BigInt(q.sequence) > 9223372036854775807n
      || !Number.isSafeInteger(q.revision) || q.revision < 1 || !Number.isSafeInteger(q.created_at))
    || claimed.some(q => q.state !== 'outcome_unknown' || q.revision < 3 || q.revision >= Number.MAX_SAFE_INTEGER)
    || successors.some(q => q.state !== 'queued')) throw fail();
  const entries = claimed.map(q => ({ id: q.id, sessionKey, createdAt: q.created_at,
    state: 'dispatching', payload: JSON.parse(q.payload) }));
  if (entries.some(e => !e.payload || typeof e.payload.text !== 'string' || !Array.isArray(e.payload.images)
    || e.payload.images.length > 8)) throw fail();
  // The only permitted intervening queue transition is original dispatching ->
  // outcome_unknown (+1). Exact stored admission proof detects edits and ABA.
  if (hash(JSON.stringify(entries.map((entry, i) => ({ entry,
    version: claimed[i]!.sequence + ':' + (claimed[i]!.revision - 1) })))) !== intent.proof.digest) throw fail();
  if (entries.length === 1 ? fact.batch !== undefined : !fields(fact.batch, ['separator', 'members'])
    || typeof fact.batch.separator !== 'string' || !fact.batch.separator || fact.batch.separator.length > 512
    || entries.some(e => e.payload.text.includes(fact.batch.separator))
    || JSON.stringify(fact.batch.members) !== JSON.stringify(entries.map(e => ({ id: e.id,
      createdAt: e.createdAt, imageCount: e.payload.images.length })))) throw fail();
  return { expected: { sessionKey, factSha256: hash(factRaw), intentSha256: hash(intentRaw),
    queueSha256: hash(JSON.stringify(rows)) }, factRaw, intentRaw, rows, claimed, updatedAt: currentFact.updatedAt };
}

export function inspectStoppedOwnedLoad(db: DatabaseSync, sessionKey: string,
  restartProof?: StoppedOwnedLoadRestartProof): StoppedOwnedLoadExpected {
  return read(db, sessionKey, restartProof).expected;
}

/** Explicit stopped-only repair, NOT a generic unknown retry. The independent
 * lifecycle owner must prove physical exclusion, fresh restorable backups and
 * the pinned original dispatch contract: finish deletes this exact intent and
 * its reply is awaited BEFORE turn/start can be written. An intact ACK is a
 * durable pre-turn-start fence only under that verified contract. The digest
 * here records that external proof; it does not authenticate a caller's claim.
 *
 * Requeue never grants dispatch authority. Normal FIFO/current issuer+grant,
 * full native history/Goal/child-work proof and fresh load still apply.
 */
export function recoverStoppedOwnedLoad(db: DatabaseSync, recovery: StoppedOwnedLoadRecovery,
  deadline = Date.now() + 30_000) {
  if (!validStoppedOwnedLoadRecovery(recovery) || !Number.isSafeInteger(deadline)) throw fail();
  const fresh = () => { if (deadline <= Date.now()) throw fail(); };
  observedTransaction(db, 'codex-stopped-unknown-disposition', () => {
    fresh();
    const original = read(db, recovery.expected.sessionKey, recovery.restartProof), { proof, expected } = recovery;
    const now = Date.now();
    if (db.prepare('SELECT node_id FROM connector_identity WHERE singleton=1').get()?.node_id !== proof.nodeId
      || proof.verifiedAt > now || now - proof.verifiedAt > 300_000 || proof.verifiedAt < original.updatedAt
      || Object.keys(expected).some(k => expected[k as keyof typeof expected] !== original.expected[k as keyof typeof expected])) throw fail();
    db.exec(`CREATE TABLE IF NOT EXISTS connector_codex_owned_load_recoveries (
      job_id TEXT PRIMARY KEY NOT NULL, session_key TEXT NOT NULL, intent_sha256 TEXT NOT NULL UNIQUE,
      original_fact TEXT NOT NULL CHECK(length(CAST(original_fact AS BLOB))<=8192),
      original_intent TEXT NOT NULL CHECK(length(CAST(original_intent AS BLOB))<=8192),
      original_queue TEXT NOT NULL CHECK(length(CAST(original_queue AS BLOB))<=33562624),
      receipt TEXT NOT NULL CHECK(length(CAST(receipt AS BLOB))<=16384))`);
    const encoded = JSON.stringify(original.rows);
    const usage = db.prepare(`SELECT count(*) AS count, coalesce(sum(length(CAST(original_queue AS BLOB))),0) AS bytes
      FROM connector_codex_owned_load_recoveries`).get()!;
    if (Number(usage.count) >= 128 || Number(usage.bytes) + Buffer.byteLength(encoded) > 64 * 1024 * 1024) throw fail();
    db.prepare('INSERT INTO connector_codex_owned_load_recoveries VALUES (?,?,?,?,?,?,?)')
      .run(proof.jobId, expected.sessionKey, expected.intentSha256, original.factRaw, original.intentRaw, encoded,
        JSON.stringify({ version: 1, ...recovery, recoveredAt: now, turnStartDispatched: false,
          requeuedCount: original.claimed.length, nativeCompletionFabricated: false }));
    for (const q of original.claimed) {
      fresh();
      if (db.prepare(`UPDATE connector_turns SET state='queued', revision=revision+1
        WHERE runtime='codex' AND session_key=? AND id=? AND state='outcome_unknown'
        AND sequence || ':' || revision=? AND payload=?`).run(expected.sessionKey, q.id,
        q.sequence + ':' + q.revision, q.payload).changes !== 1) throw fail();
    }
    if (db.prepare('DELETE FROM connector_codex_native_resume WHERE session_key=? AND record=?')
      .run(expected.sessionKey, original.intentRaw).changes !== 1
      || db.prepare('DELETE FROM connector_codex_executions WHERE session_key=? AND fact=?')
        .run(expected.sessionKey, original.factRaw).changes !== 1) throw fail();
    fresh();
  });
}
