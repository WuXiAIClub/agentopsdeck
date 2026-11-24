import type { ChatMessage } from '@agentopsdeck/shared';

/** Keep a contiguous, unmodified newest tail, including its hidden-row count.
 * localStorage accounts in UTF-16 units, not UTF-8 response bytes. Never leave
 * an old snapshot in place just because a newer conversation became larger.
 */
export function fitMessageCache<T extends { messages: ChatMessage[]; hiddenCount?: number }>(entry: T, maxMessages: number, maxBytes: number): T | undefined {
  const count = entry.messages.length;
  const tail = (length: number): T => ({ ...entry, messages: entry.messages.slice(count - length),
    hiddenCount: (entry.hiddenCount ?? 0) + count - length });
  const fits = (value: T) => JSON.stringify(value).length * 2 <= maxBytes;
  let low = count ? 1 : 0, high = Math.min(count, maxMessages);
  if (high < low) return undefined;
  // Most histories fit. Avoid serializing every binary-search midpoint when
  // the complete allowed tail already meets the exact existing byte budget.
  const full = tail(high);
  if (fits(full)) return full;
  if (high === low || !fits(tail(low))) return undefined;
  high--;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(tail(middle))) low = middle;
    else high = middle - 1;
  }
  return tail(low);
}
