export type OptimisticMessage = {
  id: string;
  role: string;
  text: string;
  createdAt: number;
  status?: string;
  queueVersion?: string | undefined;
};

const MAX_OPTIMISTIC_SESSIONS = 64;
const MAX_OPTIMISTIC_PER_SESSION = 32;
const optimisticStore = new Map<string, OptimisticMessage[]>();

function storeKey(scope: string | undefined, sessionKey: string): string {
  return `${scope ?? ''}\0${sessionKey}`;
}

export function readOptimisticMessages<T extends OptimisticMessage>(scope: string | undefined, sessionKey: string): T[] {
  if (!sessionKey) return [];
  const items = optimisticStore.get(storeKey(scope, sessionKey));
  return items ? [...(items as T[])] : [];
}

export function writeOptimisticMessages<T extends OptimisticMessage>(scope: string | undefined, sessionKey: string, messages: readonly T[]): T[] {
  if (!sessionKey) return [];
  const key = storeKey(scope, sessionKey);
  const bounded = messages.slice(-MAX_OPTIMISTIC_PER_SESSION);
  optimisticStore.delete(key);
  if (bounded.length > 0) {
    optimisticStore.set(key, [...bounded]);
    while (optimisticStore.size > MAX_OPTIMISTIC_SESSIONS) {
      const oldest = optimisticStore.keys().next().value;
      if (oldest === undefined) break;
      optimisticStore.delete(oldest);
    }
  }
  return [...bounded];
}

export function clearOptimisticMessages(predicate?: (sessionKey: string, scope: string) => boolean): void {
  if (!predicate) {
    optimisticStore.clear();
    return;
  }
  for (const key of [...optimisticStore.keys()]) {
    const separator = key.indexOf('\0');
    const scope = separator >= 0 ? key.slice(0, separator) : '';
    const sessionKey = separator >= 0 ? key.slice(separator + 1) : key;
    if (predicate(sessionKey, scope)) optimisticStore.delete(key);
  }
}

export function mergeMessages<T extends OptimisticMessage>(messages: T[], optimisticMessages: T[]) {
  const pending = (message: T) => message.role === 'user' && (message.status === 'queued' || message.status === 'sending');
  const compare = (a: T, b: T) => Number(pending(a)) - Number(pending(b)) || a.createdAt - b.createdAt;
  // Validate rather than assume server order. The common already-sorted case
  // needs no cloned/sorted array; queued records still sort after transcript.
  if (!optimisticMessages.length && messages.every((message, index) => index === 0 || compare(messages[index - 1]!, message) <= 0)) return messages;
  const merged = [...messages];
  const indexById = new Map<string, number>();
  for (let i = 0; i < merged.length; i += 1) indexById.set(merged[i]!.id, i);
  for (const optimistic of optimisticMessages) {
    if (!hasMatchingRealMessage(merged, optimistic)) {
      const index = indexById.get(optimistic.id);
      if (index === undefined) {
        indexById.set(optimistic.id, merged.length);
        merged.push(optimistic);
      } else {
        merged[index] = optimistic;
      }
    }
  }
  // Pending input is not part of the executed transcript yet. Keep it after
  // streaming output, in FIFO order; real history takes over by command id.
  return merged.sort(compare);
}

export function hasMatchingRealMessage<T extends OptimisticMessage>(messages: T[], optimistic: T) {
  return messages.some((message) => {
    if (message.id === optimistic.id) {
      // An unversioned pre-admission/cache projection cannot erase the atomic
      // ACK. Versions are opaque; never order them by parsing their tokens.
      return !(optimistic.status === 'queued' && optimistic.queueVersion
        && message.status === 'queued' && !message.queueVersion);
    }
    // Queued messages are not transcript echoes; they represent pending queue
    // records with edit/cancel controls. A same-text user transcript row can be
    // nearby while the queue still exists, so only exact ids may replace queued
    // optimistic rows. Otherwise the queue dock disappears even though the
    // backend queue will still send later.
    if (optimistic.status === 'sending' || optimistic.status === 'queued' || optimistic.status === 'outcome_unknown') return false;
    return message.role === optimistic.role
      && message.text.trim() === optimistic.text.trim()
      && Math.abs(message.createdAt - optimistic.createdAt) < 120_000;
  });
}
