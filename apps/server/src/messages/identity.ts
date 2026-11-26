import type { ChatMessage } from '@agentopsdeck/shared';

// Text is not identity: two separate turns may legitimately have identical content.
// Until runtime revisions are available, compare versions only within the same ID.
// Preserve Connector page order when proxying already-paginated pages so live
// streams and queued inputs never jump ahead of the page's `before` anchor.
export function dedupeMessageIdentitiesInOrder<T extends ChatMessage>(messages: T[]): T[] {
  const byId = new Map<string, T>();
  for (const message of messages) {
    const previous = byId.get(message.id);
    if (!previous || (message.updatedAt ?? message.createdAt ?? 0) >= (previous.updatedAt ?? previous.createdAt ?? 0)) byId.set(message.id, message);
  }
  return [...byId.values()];
}

export function mergeMessageIdentities<T extends ChatMessage>(messages: T[]): T[] {
  return dedupeMessageIdentitiesInOrder(messages).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}
