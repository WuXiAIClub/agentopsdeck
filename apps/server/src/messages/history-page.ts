import type { ChatMessage } from '@agentopsdeck/shared';

export function clampMessageLimit(value: string | undefined) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 120;
  return Math.max(1, Math.min(500, Math.floor(parsed)));
}

// Look up stable anchors only inside the already-authorized session.
export function historyPage(messages: ChatMessage[], limit: number, before?: string) {
  // Keep admitted input in the latest window while its predecessor streams.
  // Preserve transcript order and queue FIFO without rewriting either timestamp.
  const pending = (message: ChatMessage) => message.role === 'user' && (message.status === 'queued' || message.status === 'sending');
  const ordered = [...messages.filter(message => !pending(message)), ...messages.filter(pending)];
  const end = before === undefined ? ordered.length : ordered.findIndex(message => message.id === before);
  if (end < 0) return undefined;
  const start = Math.max(0, end - limit);
  return { messages: ordered.slice(start, end), totalCount: messages.length, hiddenCount: start };
}

export function indexHistoryPages(messages: ChatMessage[]) {
  const settled: ChatMessage[] = [], pending: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === 'user' && (message.status === 'queued' || message.status === 'sending')) pending.push(message);
    else settled.push(message);
  }
  const ordered = settled.concat(pending);
  const positions = new Map(ordered.map((message, index) => [message.id, index]));
  return (limit: number, before?: string) => {
    const end = before === undefined ? ordered.length : positions.get(before);
    if (end === undefined) return undefined;
    const start = Math.max(0, end - limit);
    return { messages: ordered.slice(start, end), totalCount: ordered.length, hiddenCount: start };
  };
}
