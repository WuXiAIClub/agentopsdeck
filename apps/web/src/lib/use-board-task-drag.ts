import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { BOARD_STATUSES, type BoardWrite, type BoardStatus } from '@agentopsdeck/shared';
import { type BoardTaskDrop } from './workspace-board';

type Gesture = {
  pointerId: number; handle: HTMLButtonElement; board: HTMLElement; taskId: string;
  draft: BoardWrite; key: string; startX: number; startY: number; x: number; y: number; active: boolean;
};
type Feedback = { taskId: string; target: BoardTaskDrop | null };
/** Pointer-only handle: text remains selectable; keyboard users retain status/up/down controls.
 * Hover updates are frame-bounded and never persist drafts or contact the Hub.
 */
export function useBoardTaskDrag(key: string, draft: BoardWrite | undefined, disabled: boolean,
  commit: (id: string, target: BoardTaskDrop) => void) {
  const gesture = useRef<Gesture | null>(null), frame = useRef(0);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const current = useRef({ key, draft, disabled, commit });
  current.current = { key, draft, disabled, commit };
  const cancel = useCallback(() => {
    const g = gesture.current; gesture.current = null;
    cancelAnimationFrame(frame.current); frame.current = 0;
    if (g?.handle.hasPointerCapture(g.pointerId)) g.handle.releasePointerCapture(g.pointerId);
    setFeedback(null);
  }, []);
  const valid = (g: Gesture) => !current.current.disabled && current.current.key === g.key && current.current.draft === g.draft;
  const locate = (g: Gesture): BoardTaskDrop | null => {
    const hit = document.elementFromPoint(g.x, g.y);
    if (!hit || hit.closest('.workspace-taskboard') !== g.board) return null;
    const column = hit.closest<HTMLElement>('[data-board-column]');
    const status = column?.dataset.boardColumn as BoardStatus;
    if (!column || !BOARD_STATUSES.includes(status)) return null;
    const peers = [...column.querySelectorAll<HTMLElement>('[data-board-task]')].filter(el => el.dataset.boardTask !== g.taskId);
    const before = peers.find(el => { const rect = el.getBoundingClientRect(); return g.y < rect.top + rect.height / 2; });
    const beforeId = before?.dataset.boardTask;
    return { status, ...(beforeId ? { beforeId } : {}) };
  };
  const tick = () => {
    frame.current = 0;
    const g = gesture.current;
    if (!g) return;
    if (!valid(g)) { cancel(); return; }
    if (!g.active) return;
    const column = document.elementFromPoint(g.x, g.y)?.closest<HTMLElement>('[data-board-column]');
    const scroller = column && column.closest('.workspace-taskboard') === g.board && getComputedStyle(column).overflowY === 'auto' ? column : g.board;
    const rect = scroller.getBoundingClientRect();
    // Wide boards scroll just the hovered column; single-column boards scroll together.
    const inside = g.x >= rect.left && g.x <= rect.right && g.y >= rect.top && g.y <= rect.bottom;
    const speed = inside ? g.y < rect.top + 36 ? -10 : g.y > rect.bottom - 36 ? 10 : 0 : 0;
    const top = scroller.scrollTop;
    if (speed) scroller.scrollTop += speed;
    const target = locate(g);
    setFeedback(old => old?.taskId === g.taskId && old.target?.status === target?.status && old.target?.beforeId === target?.beforeId
      ? old : { taskId: g.taskId, target });
    if (scroller.scrollTop !== top) frame.current = requestAnimationFrame(tick);
  };
  useEffect(() => { cancel(); }, [key, draft, disabled]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && gesture.current) { event.preventDefault(); event.stopPropagation(); cancel(); } };
    const hidden = () => { if (document.hidden) cancel(); };
    window.addEventListener('keydown', escape, true); window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', hidden);
    return () => { cancel(); window.removeEventListener('keydown', escape, true); window.removeEventListener('blur', cancel); document.removeEventListener('visibilitychange', hidden); };
  }, []);
  return {
    feedback,
    start(event: ReactPointerEvent<HTMLButtonElement>, taskId: string) {
      if (event.button !== 0 || !event.isPrimary || current.current.disabled || !current.current.draft || gesture.current) return;
      const board = event.currentTarget.closest<HTMLElement>('.workspace-taskboard');
      if (!board) return;
      event.preventDefault(); event.stopPropagation();
      event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId);
      gesture.current = { pointerId: event.pointerId, handle: event.currentTarget, board, taskId, draft: current.current.draft,
        key: current.current.key, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false };
    },
    move(event: ReactPointerEvent<HTMLButtonElement>) {
      const g = gesture.current;
      if (!g || g.pointerId !== event.pointerId) return;
      event.stopPropagation(); g.x = event.clientX; g.y = event.clientY;
      if (!g.active && Math.hypot(g.x - g.startX, g.y - g.startY) >= 6) g.active = true;
      if (g.active && !frame.current) frame.current = requestAnimationFrame(tick);
    },
    end(event: ReactPointerEvent<HTMLButtonElement>) {
      const g = gesture.current;
      if (!g || g.pointerId !== event.pointerId) return;
      event.stopPropagation(); g.x = event.clientX; g.y = event.clientY;
      const target = g.active && valid(g) ? locate(g) : null;
      cancel(); if (target) current.current.commit(g.taskId, target);
    },
    cancel,
  };
}
