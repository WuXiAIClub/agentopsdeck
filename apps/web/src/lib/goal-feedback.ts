export type GoalNotice = 'idle' | 'accepted' | 'released' | 'not-sent' | 'rejected' | 'unknown';

// Recovery is a batch of independent original receipts, not last-response wins.
// A later ACK cannot hide an unresolved or rejected operation. This is display
// aggregation only; each durable receipt retains its own outcome and fence.
const priority: Record<GoalNotice, number> = { idle: 0, accepted: 1, released: 2, 'not-sent': 3, rejected: 4, unknown: 5 };
export function mergeGoalNotice(current: GoalNotice, next: GoalNotice): GoalNotice {
  return priority[current] >= priority[next] ? current : next;
}
