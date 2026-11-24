import { readCodexGoal, type CodexGoal } from './codex-goal.js';

export const goalActions = ['create', 'edit', 'pause', 'resume', 'clear'] as const;
export type GoalAction = typeof goalActions[number];
export type GoalControl = {
  action: GoalAction; expectedRevision: string;
  objective?: string; tokenBudget?: number;
};
export type GoalControlSnapshot = { revision: string; goal: CodexGoal | null };

/** Budget writes require a positive integer. Omission on edit preserves the native budget;
 * null is not accepted as an undocumented instruction to reset native usage. */
export function readGoalControl(value: unknown): GoalControl | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !['action', 'expectedRevision', 'objective', 'tokenBudget'].includes(k))
    || !goalActions.includes(v.action as GoalAction) || typeof v.expectedRevision !== 'string'
    || !/^[a-f0-9]{64}$/.test(v.expectedRevision)) return;
  const fields = Object.hasOwn(v, 'objective') || Object.hasOwn(v, 'tokenBudget');
  if (v.action !== 'create' && v.action !== 'edit' && fields) return;
  if (Object.hasOwn(v, 'objective') && (typeof v.objective !== 'string' || !v.objective.trim() || v.objective.length > 2000)) return;
  if (Object.hasOwn(v, 'tokenBudget') && (!Number.isSafeInteger(v.tokenBudget) || (v.tokenBudget as number) <= 0)) return;
  if (v.action === 'create' && (typeof v.objective !== 'string' || !Object.hasOwn(v, 'tokenBudget')) || v.action === 'edit' && !fields) return;
  return { action: v.action as GoalAction, expectedRevision: v.expectedRevision,
    ...(typeof v.objective === 'string' ? { objective: v.objective } : {}),
    ...(typeof v.tokenBudget === 'number' ? { tokenBudget: v.tokenBudget } : {}) };
}

export function readGoalControlSnapshot(value: unknown): GoalControlSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (typeof v.revision !== 'string' || !/^[a-f0-9]{64}$/.test(v.revision)) return;
  if (v.goal === null) return { revision: v.revision, goal: null };
  if (!v.goal || typeof v.goal !== 'object' || Array.isArray(v.goal)) return;
  const g = v.goal as Record<string, unknown>;
  if (typeof g.objectiveTruncated !== 'boolean') return;
  const goal = readCodexGoal({ goal: { ...g, threadId: 'snapshot' } }, 'snapshot');
  return goal ? { revision: v.revision, goal: { ...goal, objectiveTruncated: g.objectiveTruncated || goal.objectiveTruncated } } : undefined;
}
