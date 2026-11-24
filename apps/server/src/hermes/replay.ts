import { parseHermesEvent, record, sequence, type HermesEvent } from './protocol.js';

export interface HermesCursor { epoch: string; sessionId: string; seq: number }
export type HermesReplayPlan =
  | { kind: 'snapshot'; reason: 'identity' | 'epoch' | 'truncated' | 'sequence' | 'malformed' }
  | { kind: 'apply'; events: HermesEvent[]; next: HermesCursor };

/**
 * Validate the entire replay before exposing any events; callers atomically persist
 * projection + next cursor. This neither proves history completeness nor unfreezes
 * an unknown execution. Always snapshot on resume/new subscription: native replay
 * can reset a session's seq even in the same epoch after capacity eviction.
 * The caller must reconcile open_requests separately before declaring readiness.
 */
export function planHermesReplay(cursor: HermesCursor, input: unknown): HermesReplayPlan {
  if (!cursor.epoch || !cursor.sessionId || !sequence(cursor.seq)) return { kind: 'snapshot', reason: 'identity' };
  if (!record(input) || typeof input.epoch !== 'string' || typeof input.truncated !== 'boolean'
    || !sequence(input.latest_seq) || !sequence(input.count) || !Array.isArray(input.events)
    || input.count !== input.events.length) return { kind: 'snapshot', reason: 'malformed' };
  if (input.epoch !== cursor.epoch) return { kind: 'snapshot', reason: 'epoch' };
  if (input.truncated) return { kind: 'snapshot', reason: 'truncated' };
  if (input.latest_seq < cursor.seq) return { kind: 'snapshot', reason: 'sequence' };
  const events: HermesEvent[] = [];
  let seq = cursor.seq;
  try {
    for (const raw of input.events) {
      const event = parseHermesEvent(raw);
      if (event.sessionId !== cursor.sessionId) return { kind: 'snapshot', reason: 'identity' };
      if (event.seq !== seq + 1) return { kind: 'snapshot', reason: 'sequence' };
      seq = event.seq;
      events.push(event);
    }
  } catch { return { kind: 'snapshot', reason: 'malformed' }; }
  if (seq !== input.latest_seq) return { kind: 'snapshot', reason: 'sequence' };
  return { kind: 'apply', events, next: { ...cursor, seq } };
}
