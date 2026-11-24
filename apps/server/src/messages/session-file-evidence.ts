import { normalizeSourceFiles, type ChatMessage, type SessionFileEntry } from '@agentopsdeck/shared';

export const FILE_INDEX_ROWS = 4000, FILE_INDEX_BYTES = 2 * 1024 * 1024;
export const FILE_PROJECTION_ROWS = 10_000, FILE_PROJECTION_BYTES = 4 * 1024 * 1024;
export type FileEvidence = { rows: SessionFileEntry[]; limited: boolean };
export type ProjectionFileEvidence = { index: FileEvidence; snapshot: FileEvidence } | { invalid: true };

/** Pure metadata only. Preserve original newest-first budgets independently of
 * transcript length/text/media, including conflicting duplicate detection. */
export function extractFileEvidence(key: string, messages: readonly ChatMessage[], maxRows = FILE_INDEX_ROWS, maxBytes = FILE_INDEX_BYTES): FileEvidence {
  const rows: SessionFileEntry[] = [], seen = new Map<string, string>();
  let bytes = 0, limited = messages.length > 100_000;
  outer: for (let i = messages.length - 1; i >= Math.max(0, messages.length - 100_000); i--) {
    const message = messages[i]!;
    if (message.sessionKey !== key || message.role !== 'tool' || message.toolPhase !== 'result' || message.status !== 'sent'
      || typeof message.id !== 'string' || !message.id.length || message.id.length > 4096
      || !Number.isSafeInteger(message.createdAt) || message.createdAt < 0) continue;
    for (const file of normalizeSourceFiles(message.sourceFiles)) {
      const entry = { ...file, messageId: message.id, createdAt: message.createdAt };
      const identity = JSON.stringify([entry.messageId, entry.path]), data = JSON.stringify(entry), previous = seen.get(identity);
      if (previous !== undefined) {
        if (previous !== data) throw Error('Conflicting file evidence');
        continue;
      }
      const size = Buffer.byteLength(data);
      if (rows.length >= maxRows || bytes + size > maxBytes) { limited = true; break outer; }
      seen.set(identity, data); rows.push(entry); bytes += size;
    }
  }
  return { rows: rows.reverse(), limited };
}

/** Fixed invalid evidence preserves original optional-index stale degradation,
 * without sending the conflicting transcript or its body to storage. */
export function projectionFileEvidence(key: string, messages: readonly ChatMessage[]): ProjectionFileEvidence {
  try { return { snapshot: extractFileEvidence(key, messages, FILE_PROJECTION_ROWS, FILE_PROJECTION_BYTES),
    index: extractFileEvidence(key, messages) }; }
  catch { return { invalid: true }; }
}
