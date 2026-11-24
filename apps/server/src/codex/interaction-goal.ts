import { createHash } from 'node:crypto';
import type { InteractionContinuation } from '../commands/interaction-continuation.js';
import { nativeGoalEvidence } from './native-history.js';

/** Interaction identity excludes consumption counters and update timestamps:
 * an active -> blocked transition is expected while a native question waits.
 * Objective, creation identity and budgets remain pinned. Maintenance's stricter
 * full snapshot fingerprint is intentionally unchanged.
 */
export function interactionGoalEvidence(result: unknown, threadId: string): InteractionContinuation['goal'] {
  const evidence = nativeGoalEvidence(result, threadId);
  if (evidence.status === 'absent') return { status: 'absent', version: 'absent' };
  const goal = (result as { goal?: Record<string, unknown> } | null)?.goal;
  if (evidence.status === 'unknown' || !goal || typeof goal.objective !== 'string' || !goal.objective.trim()
    || goal.objective.length > 100_000
    || [goal.tokenBudget, goal.timeBudgetSeconds].some(v => v != null && (!Number.isSafeInteger(v) || (v as number) < 0))) {
    return { status: 'unknown', version: '' };
  }
  return { status: evidence.status as InteractionContinuation['goal']['status'], version: createHash('sha256')
    .update(JSON.stringify([threadId, goal.createdAt, goal.objective, goal.tokenBudget ?? null, goal.timeBudgetSeconds ?? null])).digest('hex') };
}
