import type { ChatMessage } from '@agentopsdeck/shared';

export type MessageKind = 'hidden' | 'tool' | 'chat';

/** Classification depends only on text, role and status. Weak keys do not keep
 * closed histories alive; no IDs, account namespaces or text copies are stored.
 * Non-string legacy payloads are deliberately not cached: nested edits must
 * still be observed even when their object identity is unchanged.
 */
export function memoizeMessageClassification(classify: (message: ChatMessage) => MessageKind) {
  const cache = new WeakMap<ChatMessage, {
    text: string; role: ChatMessage['role']; status: ChatMessage['status']; kind: MessageKind;
  }>();
  return (message: ChatMessage): MessageKind => {
    if (typeof message.text !== 'string') return classify(message);
    const previous = cache.get(message);
    if (previous && previous.text === message.text && previous.role === message.role && previous.status === message.status) return previous.kind;
    const kind = classify(message);
    cache.set(message, { text: message.text, role: message.role, status: message.status, kind });
    return kind;
  };
}
