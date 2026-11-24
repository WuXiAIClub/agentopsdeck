import { BOARD_STATUSES, type BoardStatus } from '@agentopsdeck/shared';

/** Only physical blank board space belongs to the creation menu. Caption
 * portals, existing tasks and interactive controls keep their own actions. */
export function taskboardContextStatus(target: Element, board: Element): BoardStatus | undefined {
  if (!board.contains(target) || target.closest('.workspace-taskboard') !== board
    || target.closest('[data-board-task], .workspace-task-card, input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="menu"]')) return;
  const status = target.closest('[data-board-column]')?.getAttribute('data-board-column');
  return BOARD_STATUSES.find(value => value === status) ?? 'todo';
}
