import type { CodexGoal } from '@agentopsdeck/shared';
import { useI18n } from '../lib/i18n';

export const goalStatusLabels = {
  active: 'Goal running', paused: 'Goal paused', blocked: 'Goal blocked',
  usageLimited: 'Goal usage limit reached', budgetLimited: 'Goal token budget reached', complete: 'Goal complete',
} as const;

/** Read-only native observation; no timer, fetch, resume or synthetic message. */
export function SessionGoal({ goal }: { goal: CodexGoal }) {
  const { t } = useI18n();
  return <details className="goal-pause-notice" data-goal-status={goal.status}>
    <summary>{t(goalStatusLabels[goal.status])}</summary>
    <p>{goal.objective}{goal.objectiveTruncated ? `… (${t('Goal objective preview')})` : ''}</p>
    <p>{t('Goal tokens used')}: {goal.tokensUsed.toLocaleString()}
      {' · '}{t('Goal token budget')}: {goal.tokenBudget === null ? t('No token budget set') : goal.tokenBudget.toLocaleString()}
      {' · '}{t('Goal elapsed seconds')}: {goal.timeUsedSeconds.toLocaleString()}</p>
    {goal.tokenBudget !== null ? <p>{t('Goal tokens remaining')}: {Math.max(0, goal.tokenBudget - goal.tokensUsed).toLocaleString()}</p> : null}
    {goal.status === 'paused' ? <p>{t('Pausing the goal does not confirm that the current turn or sub-agents have stopped.')}</p> : null}
    {goal.status === 'budgetLimited' || goal.status === 'usageLimited' ? <p>{t('A limit was reached; the goal is not marked complete.')}</p> : null}
    <p>{t('Native goal counters are not session totals or a billing total. A completed turn does not mean the goal is complete.')}</p>
  </details>;
}
