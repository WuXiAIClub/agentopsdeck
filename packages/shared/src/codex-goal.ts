/** An observation from Codex, never permission to resume or spend tokens. */
export type CodexGoal = {
  status: 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';
  objective: string;
  objectiveTruncated: boolean;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
};

export function readCodexGoal(result: unknown, threadId: string): CodexGoal | null | undefined {
  if (!result || typeof result !== 'object' || !Object.hasOwn(result, 'goal')) return undefined;
  const goal = (result as { goal: unknown }).goal;
  if (goal === null) return null;
  if (!goal || typeof goal !== 'object' || Array.isArray(goal)) return undefined;
  const g = goal as Record<string, unknown>;
  if (g.threadId !== threadId || typeof g.objective !== 'string' || !g.objective.trim() || g.objective.length > 100_000
    || typeof g.status !== 'string' || !['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(g.status)
    || g.tokenBudget !== null && (!Number.isSafeInteger(g.tokenBudget) || (g.tokenBudget as number) < 0)
    || ['tokensUsed', 'timeUsedSeconds', 'createdAt', 'updatedAt'].some(k => !Number.isSafeInteger(g[k]) || (g[k] as number) < 0)
    || (g.updatedAt as number) < (g.createdAt as number)) return undefined;
  // Whitelist fields: do not leak native extras or downstream protocol data.
  return { status: g.status as CodexGoal['status'], objective: g.objective.slice(0, 2000), objectiveTruncated: g.objective.length > 2000,
    tokenBudget: g.tokenBudget as number | null, tokensUsed: g.tokensUsed as number,
    timeUsedSeconds: g.timeUsedSeconds as number, createdAt: g.createdAt as number, updatedAt: g.updatedAt as number };
}
