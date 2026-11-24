import { createHash } from 'node:crypto';
import { readCodexGoal, type GoalControl, type GoalControlSnapshot } from '@agentopsdeck/shared';

export class GoalControlConflict extends Error {
  constructor() { super('Goal changed or is unavailable; refresh before changing it'); }
}

export function goalSnapshot(raw: unknown, threadId: string, connectionId: string): GoalControlSnapshot {
  const goal = readCodexGoal(raw, threadId);
  if (goal === undefined) throw new GoalControlConflict();
  const native = (raw as { goal: Record<string, unknown> | null }).goal;
  // Full objective, not the 2k preview. Usage increments are not user edits.
  // This is a preflight identity, NOT a native atomic compare-and-swap token.
  const revision = createHash('sha256').update(JSON.stringify([threadId, connectionId,
    native && [native.objective, native.status, native.tokenBudget, native.createdAt]])).digest('hex');
  return { goal, revision };
}

export function goalMutation(control: GoalControl, before: GoalControlSnapshot, threadId: string) {
  if (control.expectedRevision !== before.revision || (control.action === 'create') !== (before.goal === null)) throw new GoalControlConflict();
  if (control.action === 'clear') return { method: 'thread/goal/clear', params: { threadId } };
  // Editing a paused/limited goal never silently resumes it. Only explicit
  // create/resume grants native continuation; no chat message is manufactured.
  return { method: 'thread/goal/set', params: { threadId,
    ...(control.objective !== undefined ? { objective: control.objective } : {}),
    ...(control.tokenBudget !== undefined ? { tokenBudget: control.tokenBudget } : {}),
    ...(control.action === 'pause' ? { status: 'paused' } : control.action === 'create' || control.action === 'resume' ? { status: 'active' } : {}),
  } };
}

export function goalAcknowledged(raw: unknown, control: GoalControl, threadId: string): boolean {
  if (control.action === 'clear') return !!raw && typeof raw === 'object' && (raw as { cleared?: unknown }).cleared === true;
  const goal = readCodexGoal(raw, threadId);
  if (!goal) return false;
  const native = (raw as { goal: { objective: string } }).goal;
  return (control.objective === undefined || native.objective === control.objective)
    && (control.tokenBudget === undefined || goal.tokenBudget === control.tokenBudget)
    && (control.action !== 'pause' || goal.status === 'paused')
    && (!['create', 'resume'].includes(control.action) || goal.status === 'active');
}
