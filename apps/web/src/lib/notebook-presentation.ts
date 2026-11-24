/** Offsets come from the Markdown parser, not a global search: repeated and
 * nested tasks must toggle only the item the user actually clicked. */
export function notebookTask(text: string, offset: number | undefined) {
  if (offset === undefined || !Number.isInteger(offset) || offset < 0) return undefined;
  const match = /^(?:[-+*]|\d+[.)])\s+\[([ xX])\](?=\s|$)/.exec(text.slice(offset));
  return match ? { offset: offset + match[0].lastIndexOf('[') + 1, checked: match[1]?.toLowerCase() === 'x' } : undefined;
}
export function toggleNotebookTask(text: string, offset: number, checked: boolean) {
  const task = notebookTask(text, offset);
  return task ? text.slice(0, task.offset) + (checked ? 'x' : ' ') + text.slice(task.offset + 1) : text;
}
export function notebookSize(width: number, height: number, availableWidth: number, availableHeight: number) {
  return { width: Math.max(208, Math.min(1600, availableWidth, width)), height: Math.max(160, Math.min(1600, availableHeight, height)) };
}
export type NotebookResizeEdge = 'corner' | 'right' | 'bottom';
export function resizeNotebook(width: number, height: number, dx: number, dy: number, edge: NotebookResizeEdge, availableWidth: number, availableHeight: number) {
  return notebookSize(width + (edge === 'bottom' ? 0 : dx), height + (edge === 'right' ? 0 : dy), availableWidth, availableHeight);
}
export const NOTEBOOK_COLORS = ['#fff7cc', '#dbeafe', '#dcfce7', '#fce7f3', '#ede9fe', '#ffedd5'] as const;
