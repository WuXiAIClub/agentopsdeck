import type { ChatMessage } from '@agentopsdeck/shared';
import { shareMessageRows } from './message-sharing.js';

type Page = { messages: ChatMessage[]; hiddenCount?: number };

// Keep explicitly loaded older pages, but let the latest snapshot replace its
// own suffix (including removals). No overlap means a reset, not an invented gap.
export function refreshHistory(current: { items: ChatMessage[]; historyExpanded?: boolean }, page: Page) {
  const preserveOlder = current.historyExpanded || current.items.length > page.messages.length;
  let index = -1;
  let pageMatchIndex = 0;
  if (preserveOlder && page.messages.length > 0) {
    const firstPosById = new Map<string, number>();
    for (let c = 0; c < current.items.length; c += 1) {
      const id = current.items[c]!.id;
      if (!firstPosById.has(id)) firstPosById.set(id, c);
    }
    for (let i = 0; i < page.messages.length; i += 1) {
      const found = firstPosById.get(page.messages[i]!.id);
      if (found !== undefined && found > 0) { index = found; pageMatchIndex = i; break; }
    }
  }
  const latestIds = new Set(page.messages.map(item => item.id));
  // Pending rows can move across the page anchor when dispatched. Only retain
  // older transcript, never a stale queued copy or an id supplied by this page.
  const prefix = index > 0 ? current.items.slice(0, index).filter(item =>
    !latestIds.has(item.id) && !(item.role === 'user' && (item.status === 'queued' || item.status === 'sending'))) : [];
  return { items: shareMessageRows(current.items, [...prefix, ...page.messages]), hiddenCount: Math.max(0, (page.hiddenCount ?? 0) + pageMatchIndex - prefix.length),
    historyExpanded: prefix.length > 0 };
}

export function prependHistory(current: ChatMessage[], page: Page, before: string) {
  // A late page must not reintroduce messages after a session reset/deletion.
  if (current[0]?.id !== before) return undefined;
  const ids = new Set(current.map(item => item.id));
  if (page.messages.some(item => ids.has(item.id))) return undefined;
  return { items: [...page.messages, ...current], hiddenCount: page.hiddenCount ?? 0, historyExpanded: true };
}
