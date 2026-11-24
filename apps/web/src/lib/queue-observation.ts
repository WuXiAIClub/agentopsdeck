import type { ChatMessage, QueuedMessagePage } from '@agentopsdeck/shared';

/** A missing row is NOT an execution receipt. It only means that repeatedly
 * enumerating the same queue cannot resolve the stale history projection. */
export function queueObservationDelay(pending: Pick<ChatMessage, 'id'>[], items: QueuedMessagePage['items'], complete: boolean): number {
  if (!complete) return 3_000;
  const ids = new Set(pending.map(message => message.id));
  return items.some(item => ids.has(item.id) && (item.state === 'queued' || item.state === 'dispatching')) ? 3_000 : 60_000;
}

export function observeQueuedMessage(message: ChatMessage, items: QueuedMessagePage['items'], complete: boolean): ChatMessage {
  if (message.status !== 'queued') return message;
  const row = items.find(item => item.id === message.id);
  // Queue enumeration can be actor-filtered even when history includes others.
  if (!row) return complete && message.localAdmission ? { ...message, queueVersion: undefined, queueObservation: 'absent' } : message;
  // A newer version without its text must NEVER authorize editing the old text.
  // Only a full message projection can restore matching text + version.
  return { ...message, queueVersion: row.version === message.queueVersion ? message.queueVersion : undefined,
    queueObservation: row.state === 'queued' ? undefined : row.state === 'outcome_unknown' ? 'unknown' : row.state };
}
