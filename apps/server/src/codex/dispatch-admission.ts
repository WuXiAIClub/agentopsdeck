import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { types } from 'node:util';
import { observedParticipant } from '../storage/observed-participant.js';
import { TurnAuthorizationError, type TurnQueue, type QueuedTurn } from '../commands/turn-queue.js';
import type { ExecutionGrantAuthority } from '../connector/execution-grants.js';
import type { CodexExecutions, CodexDispatchFailureExpected } from './executions.js';
import { waitingBatch, type CodexBatch } from './queued-batch.js';
import type { TurnContextProof } from './turn-context.js';

type Payload = { text: string; images: unknown[]; actorId?: string; executionGrant?: ExecutionGrantAuthority };
export type CodexAdmissionProof = { count: number; digest: string };
export class CodexAdmissionConflict extends Error {
  constructor() { super('Codex queued admission changed; no native dispatch authorized'); }
}
type Owner = { turns: TurnQueue; codexExecutions: CodexExecutions };
type Allowed<T extends Payload> = (entry: QueuedTurn<T>) => boolean;

/** Captured synchronously with the original queue read. Includes durable queue
 * versions (also detects edit-away-and-back / cancel-and-reinsert ABA). Only a
 * hash and count travel into the claim command; never trust caller payloads. */
export function codexAdmissionProof<T extends Payload>(turns: TurnQueue, entries: QueuedTurn<T>[]): CodexAdmissionProof {
  if (!entries.length || entries.length > 16) throw new CodexAdmissionConflict();
  return { count: entries.length, digest: createHash('sha256').update(JSON.stringify(entries.map(entry => ({ entry,
    version: turns.version('codex', entry.sessionKey, entry.id) })))).digest('hex') };
}

export function codexAdmissionMatches<T extends Payload>(turns: TurnQueue, key: string, proof: CodexAdmissionProof,
  allowed: Allowed<T>, state: 'queued' | 'dispatching' = 'queued'): QueuedTurn<T>[] | undefined {
  if (!Number.isSafeInteger(proof.count) || proof.count < 1 || proof.count > 16 || !/^[a-f0-9]{64}$/.test(proof.digest)) return;
  const entries = turns.dispatchPrefix<T>('codex', key).slice(0, proof.count);
  if (entries.length !== proof.count || entries.some(entry => entry.state !== state)
    || codexAdmissionProof(turns, entries).digest !== proof.digest) return;
  // Check compatibility as if still waiting, but preserve original state in
  // the digest above. No authority or batch membership comes from the caller.
  if (waitingBatch(entries.map(entry => ({ ...entry, state: 'queued' as const })), allowed).length !== entries.length) return;
  return entries;
}

function checkBatch<T extends Payload>(entries: QueuedTurn<T>[], commandId: string, batch?: CodexBatch) {
  if (entries[0]?.id !== commandId) throw new CodexAdmissionConflict();
  if (entries.length === 1) { if (batch) throw new CodexAdmissionConflict(); return; }
  if (!batch || !batch.separator || batch.separator.length > 512 || entries.some(entry => entry.payload.text.includes(batch.separator))
    || JSON.stringify(batch.members) !== JSON.stringify(entries.map(entry => ({ id: entry.id,
      createdAt: entry.createdAt, imageCount: entry.payload.images.length })))) throw new CodexAdmissionConflict();
}

/** Shared production + worker domain. The original execution transaction owns
 * current authorization, exact FIFO claim, board context, journal and evidence.
 * No files/network/native effects, no retry, no callback crossing an IPC lane. */
export function admitCodexQueued<T extends Payload>(owner: Owner, key: string, commandId: string, connectionId: string,
  proof: CodexAdmissionProof, allowed: Allowed<T>, options: { preparing?: boolean; batch?: CodexBatch;
    blockedGoalInput?: boolean; context?: TurnContextProof; predecessor?: CodexDispatchFailureExpected } = {}) {
  const before = owner.codexExecutions.get(key);
  const continuing = !options.preparing && before?.commandId === commandId && before.connectionId === connectionId
    && before.phase === 'starting' && before.preparation === 'ready' && !before.reason;
  let nextProof: CodexAdmissionProof | undefined;
  const accepted = owner.codexExecutions.begin(key, commandId, connectionId, options.preparing, options.batch,
    options.blockedGoalInput, options.context, (db: DatabaseSync) => {
      const authorize = (entry: QueuedTurn<T>) => {
        if (types.isAsyncFunction(allowed)) throw new TurnAuthorizationError();
        const permitted = observedParticipant(db, 'execution-issuer-check', () => allowed(entry)) === true;
        if (!permitted) throw new TurnAuthorizationError();
        return true;
      };
      const entries = codexAdmissionMatches(owner.turns, key, proof, authorize, continuing ? 'dispatching' : 'queued');
      if (!entries) throw new CodexAdmissionConflict();
      checkBatch(entries, commandId, options.batch);
      if (!continuing && !owner.turns.startBatchInTransaction(db, 'codex', key, entries.map(entry => entry.id))) throw new CodexAdmissionConflict();
      // Save the exact post-claim versions for preparation -> real dispatch.
      // Never expose a speculative receipt if any later transaction step fails.
      nextProof = codexAdmissionProof(owner.turns, owner.turns.dispatchPrefix<T>('codex', key).slice(0, proof.count));
    }, options.predecessor);
  if (!accepted) return null;
  if (!nextProof) throw new CodexAdmissionConflict();
  return { proof: nextProof, execution: owner.codexExecutions.get(key)! };
}

export function acknowledgeCodexDispatch(owner: Owner, key: string, commandId: string, connectionId: string, runId: string) {
  const fact = owner.codexExecutions.get(key);
  if (!fact || fact.commandId !== commandId || fact.connectionId !== connectionId) return false;
  const ids = fact.batch?.members.map(member => member.id) ?? [fact.commandId];
  return owner.codexExecutions.acknowledge(key, commandId, connectionId, runId, db => {
    for (const id of ids) owner.turns.completeInTransaction(db, 'codex', id);
  });
}

/** Original catch + worker use the same complete transaction. The queue proof
 * is a failure receipt, not authority to start/retry an effect. Authorization
 * failures additionally need current original authority to be denied. */
export function settleCodexDispatchFailure<T extends Payload>(owner: Owner, key: string, commandId: string,
  expected: CodexDispatchFailureExpected, proof: CodexAdmissionProof, authorizationFailure: boolean, allowed: Allowed<T>) {
  try {
    return owner.codexExecutions.settleDispatchFailure(key, commandId, expected, authorizationFailure, (db, outcome, fact) => {
      const owns = fact?.commandId === commandId;
      const entries = codexAdmissionMatches<T>(owner.turns, key, proof, () => true, owns ? 'dispatching' : 'queued');
      if (!entries || entries[0]!.id !== commandId) throw new CodexAdmissionConflict();
      const ids = entries.map(entry => entry.id);
      if (owns && JSON.stringify(ids) !== JSON.stringify(fact.batch?.members.map(member => member.id) ?? [commandId]))
        throw new CodexAdmissionConflict();
      if (authorizationFailure) {
        if (types.isAsyncFunction(allowed)) throw new TurnAuthorizationError();
        let denied = false;
        for (const entry of entries) if (observedParticipant(db, 'execution-issuer-check', () => allowed(entry)) !== true) denied = true;
        if (!denied) throw new CodexAdmissionConflict();
      }
      if (outcome === 'blocked') {
        for (const entry of entries) if (!owner.turns.blockInTransaction(db, 'codex', key, entry.id)) throw new CodexAdmissionConflict();
      } else owner.turns.settleClaimedBatchInTransaction(db, 'codex', key, ids, 'unknown');
    });
  } catch (error) {
    if (error instanceof CodexAdmissionConflict) return null;
    throw error;
  }
}
