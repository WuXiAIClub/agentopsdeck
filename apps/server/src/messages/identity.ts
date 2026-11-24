import type { ChatMessage } from '@agentopsdeck/shared';

// Text is not identity: two separate turns may legitimately have identical content.
// Until runtime revisions are available, compare versions only within the same ID.
export function mergeMessageIdentities<T extends ChatMessage>(messages: T[]): T[] {
  const byId = new Map<string, T>();
  for (const message of messages) {
    const previous = byId.get(message.id);
    if (!previous || (message.updatedAt ?? message.createdAt ?? 0) >= (previous.updatedAt ?? previous.createdAt ?? 0)) byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}
