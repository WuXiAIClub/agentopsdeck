import { randomUUID } from 'node:crypto';
import { MAX_MESSAGE_CHARS } from '@agentopsdeck/shared';
import { requiredSynchronousEffectAuthority } from '../auth/synchronous-effect-authority.js';
import { SessionDeletionConflict, TurnAuthorizationError, type TurnQueue, type TurnQueueCommit } from '../commands/turn-queue.js';
import type { ExecutionGrantAuthority } from '../connector/execution-grants.js';
import type { HermesJournal } from './journal.js';

export type HermesMessagePayload = { text: string; images: []; actorId: string; executionGrant?: ExecutionGrantAuthority };
/** One original admission plan for runtime and worker. No native call, extra
 * connection or cached grant. The returned check runs again under queue BEGIN. */
export function prepareHermesMessageAdmission(context: { journal: HermesJournal; turns: TurnQueue;
  authorize: () => boolean; assertAvailable: () => void }, key: string, text: string,
  options: { actorId: string; executionGrant?: ExecutionGrantAuthority; signal?: AbortSignal | undefined;
    accept: (result: Record<string, unknown>) => TurnQueueCommit }) {
  const actor = { actorId: options.actorId, signal: options.signal,
    ...(options.executionGrant ? { executionGrant: { ...options.executionGrant } } : {}) };
  const check = () => {
    actor.signal?.throwIfAborted();
    requiredSynchronousEffectAuthority(context.assertAvailable);
    if (context.journal.deletion(key)) throw new SessionDeletionConflict();
    if (!context.journal.session(key)) throw new Error('Hermes session not found');
    if (context.journal.current(key)?.phase === 'unknown') throw new SessionDeletionConflict('Hermes execution outcome is unknown; automatic resend is disabled');
    if (!context.journal.checkPermission(context.authorize, [])) throw new TurnAuthorizationError();
  };
  check();
  if (!text.trim() || text.length > MAX_MESSAGE_CHARS) throw new Error(`Hermes text must contain 1–${MAX_MESSAGE_CHARS} characters`);
  const id = randomUUID(), createdAt = Date.now();
  const waiting = !context.journal.canStart(key) || context.turns.hasPending('hermes', key);
  const result = { status: 'queued', queueDisposition: waiting ? 'waiting' : 'preparing', idempotencyKey: id, media: [] };
  const accept = options.accept(result);
  const turn = { id, sessionKey: key, createdAt, payload: { text, images: [] as [], actorId: actor.actorId,
    ...(actor.executionGrant ? { executionGrant: actor.executionGrant } : {}) } };
  const commit: TurnQueueCommit = (db, admission) => { check(); return accept(db, admission); };
  return { turn, result, check, commit };
}
