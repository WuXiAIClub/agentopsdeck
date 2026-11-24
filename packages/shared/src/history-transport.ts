/** A session proof is fresh for this authorized read, not a Deck-wide cursor,
 * execution-state proof, or permission to send. Unverified cached text remains
 * display-only. Omission retains the older cursor/legacy transport contract. */
export type SessionHistoryStatus = 'cached' | 'verified-session';
export type HistoryTransportPage = { messages: unknown[]; updatedAt: number; sourceCursor?: string | undefined; historyStatus?: SessionHistoryStatus };
type Entry = { etag: string; page: HistoryTransportPage; bytes: number };
export const HISTORY_DELTA_HEADER = 'x-agentopsdeck-history-delta';

/** Transport reuse, never authority or a freshness cache. Every read still
 * reaches the server. Bounds account for serialized text, not process RSS. */
export function createConditionalHistoryCache(maxBytes = 8 * 1024 * 1024, maxEntries = 32) {
  const entries = new Map<string, Entry>();
  let bytes = 0;
  function remove(key: string) {
    const entry = entries.get(key);
    if (entry) { bytes -= entry.bytes; entries.delete(key); }
  }
  return {
    get(key: string) {
      const entry = entries.get(key);
      if (entry) { entries.delete(key); entries.set(key, entry); }
      return entry;
    },
    put(key: string, etag: string | null, page: HistoryTransportPage) {
      remove(key);
      if (!etag || !/^W\/"history-[a-f0-9]{64}"$/.test(etag) || !Array.isArray(page.messages)) return;
      const size = JSON.stringify(page).length * 2;
      if (size > maxBytes || maxEntries <= 0) return;
      while (entries.size && (bytes + size > maxBytes || entries.size >= maxEntries)) remove(entries.keys().next().value!);
      entries.set(key, { etag, page, bytes: size }); bytes += size;
    },
    remove,
    clear() { entries.clear(); bytes = 0; },
  };
}

export function restoreConditionalHistory(entry: Entry | undefined, etag: string | null, metadata: string | null): HistoryTransportPage {
  if (!entry || entry.etag !== etag || !metadata) throw new Error('History validator unavailable; retry the read');
  const meta = JSON.parse(metadata);
  if (!meta || !Number.isFinite(meta.updatedAt) || !(meta.sourceCursor === null || typeof meta.sourceCursor === 'string'))
    throw new Error('Invalid history watermark; retry the read');
  return { ...entry.page, updatedAt: meta.updatedAt, sourceCursor: meta.sourceCursor ?? undefined };
}

/** Ordered slots describe the complete NEW page, not append-only events.
 * Reordering, deletion, window rollover and an edited streaming row are exact.
 * A missing/invalid base fails closed; the caller evicts it before retrying. */
export function restoreHistoryDelta(entry: Entry | undefined, body: unknown, maxBytes = 8 * 1024 * 1024): HistoryTransportPage {
  const delta = body as { historyDelta?: unknown; base?: unknown; slots?: unknown; metadata?: Record<string, unknown> } | null;
  if (!entry || !delta || delta.historyDelta !== 1 || delta.base !== entry.etag || !Array.isArray(delta.slots)
    || delta.slots.length > 1000 || !delta.metadata || typeof delta.metadata !== 'object' || Array.isArray(delta.metadata)
    || !Number.isFinite(delta.metadata.updatedAt) || 'messages' in delta.metadata
    || (delta.metadata.sourceCursor !== undefined && typeof delta.metadata.sourceCursor !== 'string'))
    throw new Error('Invalid history delta; retry the read');
  const encoder = new TextEncoder();
  let bytes = encoder.encode(JSON.stringify(delta.metadata)).length + 16;
  if (bytes > maxBytes) throw new Error('History delta exceeds size limit; retry the read');
  const messages = delta.slots.map((slot: unknown) => {
    let message: unknown;
    if (typeof slot === 'number') {
      if (!Number.isInteger(slot) || slot < 0 || slot >= entry.page.messages.length) throw new Error('Invalid history delta index; retry the read');
      message = entry.page.messages[slot];
    } else {
      if (!slot || typeof slot !== 'object' || Array.isArray(slot) || typeof (slot as { id?: unknown }).id !== 'string')
        throw new Error('Invalid history delta message; retry the read');
      message = slot;
    }
    bytes += encoder.encode(JSON.stringify(message)).length + 1;
    if (bytes > maxBytes) throw new Error('History delta exceeds size limit; retry the read');
    return message;
  });
  return { ...delta.metadata, messages } as HistoryTransportPage;
}
