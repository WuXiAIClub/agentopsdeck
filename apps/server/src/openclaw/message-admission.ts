import type { TurnQueueCommit } from '../commands/turn-queue.js';
import type { MirrorOutbox } from '../messages/mirror.js';
import type { OpenClawQueuedTurn } from './turn-queue.js';

/** The original queue, mirror and receipt participants share ONE transaction.
 * No filesystem/native work or asynchronous callbacks may enter this boundary. */
export function openClawMessageCommit(turn: Omit<OpenClawQueuedTurn, 'state'>,
  mirrorOutbox: MirrorOutbox | undefined, commitReceipt?: TurnQueueCommit): TurnQueueCommit {
  return (db, admission) => {
    if (turn.payload.deliveryMode === 'mirror') {
      if (!mirrorOutbox || !turn.payload.explicitRoute) throw new Error('Mirror admission is not configured');
      mirrorOutbox.admitInTransaction(db, { sessionKey: turn.sessionKey, after: turn.createdAt, inputText: turn.payload.message,
        explicitRoute: turn.payload.explicitRoute, idempotencyKey: turn.id,
        ...(turn.payload.actorId ? { actorId: turn.payload.actorId } : {}),
        ...(turn.payload.executionGrant ? { executionGrant: turn.payload.executionGrant } : {}) });
    }
    commitReceipt?.(db, admission);
  };
}
