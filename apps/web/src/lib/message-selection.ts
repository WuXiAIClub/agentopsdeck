import type { ChatMessage } from '@agentopsdeck/shared';
import { mergeSelectedMessages } from './live-session';

// Freeze selected bubbles only. New messages and unselected tool updates still
// arrive; callers reapply their latest snapshot when selection is released.
export function mergeSelectionSafeMessages(current: ChatMessage[], incoming: ChatMessage[]) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return incoming;
  const range = selection.getRangeAt(0);
  const selected = new Set([...document.querySelectorAll<HTMLElement>('[data-message-search-id]')]
    .filter(node => range.intersectsNode(node)).map(node => node.dataset.messageSearchId));
  return mergeSelectedMessages(current, incoming, selected);
}
