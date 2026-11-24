import { MAX_MESSAGE_CHARS } from '@agentopsdeck/shared';
import type { TurnQueue, TurnQueueCommit } from '../commands/turn-queue.js';

/** Shared original transaction kernel; projection/native effects stay outside. */
export function editHermesQueued(turns: TurnQueue, key: string, id: string, text: string,
  version: string, commit?: TurnQueueCommit) {
  if (!text.trim() || text.length > MAX_MESSAGE_CHARS) throw new Error('Invalid Hermes queued text');
  return turns.edit<{ text: string }>('hermes', key, id, payload => ({ ...payload, text }), version, commit);
}
export function cancelHermesQueued(turns: TurnQueue, key: string, id: string, version: string, commit?: TurnQueueCommit) {
  return turns.cancel('hermes', key, id, version, commit);
}
