import type { ChatMessage } from '@agentopsdeck/shared';

// Snapshots are JSON. Compare ALL fields, including future protocol additions,
// removals, media and opaque queue versions; never use a UI-only fingerprint.
function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right) || Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false;
  if (Array.isArray(left)) {
    if (left.length !== (right as unknown[]).length) return false;
  } else if (Object.getPrototypeOf(left) !== Object.prototype) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key)
    && equal((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

/** Pure sharing AFTER request/authority checks in the caller. Never merges old
 * fields, restores removed rows, or retains a second snapshot in a cache. */
export function shareMessageRows(previous: ChatMessage[], next: ChatMessage[]) {
  const key = (message: ChatMessage) => `${message.sessionKey ?? ''}\0${message.id}`;
  const before = new Map<string, ChatMessage>();
  const duplicates = new Set<string>();
  for (const message of previous) {
    const id = key(message);
    if (before.has(id)) duplicates.add(id);
    before.set(id, message);
  }
  const seen = new Set<string>();
  for (const message of next) {
    const id = key(message);
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  const rows = next.map(message => {
    const id = key(message), old = before.get(id);
    return old && !duplicates.has(id) && equal(old, message) ? old : message;
  });
  return rows.length === previous.length && rows.every((row, i) => row === previous[i]) ? previous : rows;
}
