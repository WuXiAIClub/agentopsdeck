import { normalizeSourceFiles, parseSourceReference, type ChatMessage, type ChatMessageMedia, type SourceFileChange, type SessionFileEntry } from '@agentopsdeck/shared';
import { isSourceMediaUrl } from './source-preview.js';

export type SessionFile = { path: string; lastSeenAt: number; messageId: string; mentions: number;
  change?: SourceFileChange['kind']; changeAt?: number; changeMessageId?: string; media?: ChatMessageMedia };

export type FileRecord = { messageId: string; createdAt: number; kind: SourceFileChange['kind']; source: 'loaded' | 'index' };

/** A bounded selection of evidence, not a version store. No body reads or inferred
 * edits; loaded authorized metadata wins over the same indexed message. */
export function fileRecordHistory(messages: readonly ChatMessage[], indexed: readonly SessionFileEntry[], sessionKey: string, path: string) {
  const records = new Map<string, FileRecord>();
  for (const entry of indexed.slice(0, 1000)) {
    if (entry.path === path) records.set(entry.messageId, { messageId: entry.messageId, createdAt: entry.createdAt, kind: entry.kind, source: 'index' });
  }
  for (const message of messages.slice(-2000)) {
    if (message.sessionKey !== sessionKey || message.role !== 'tool' || message.toolPhase !== 'result' || message.status !== 'sent') continue;
    const change = normalizeSourceFiles(message.sourceFiles).find(file => file.path === path);
    if (change) records.set(message.id, { messageId: message.id, createdAt: Number.isFinite(message.createdAt) ? message.createdAt : 0, kind: change.kind, source: 'loaded' });
  }
  const sorted = [...records.values()].sort((a, b) => b.createdAt - a.createdAt || a.messageId.localeCompare(b.messageId));
  return { records: sorted.slice(0, 40), limited: sorted.length > 40 };
}

/** Merge a small explicit index page with live loaded references. A newer
 * deletion wins; an old media handle must not silently survive a newer record. */
export function mergeIndexedSessionFiles(loaded: readonly SessionFile[], indexed: readonly SessionFileEntry[]) {
  const files = new Map(loaded.map(file => [file.path, { ...file }]));
  for (const entry of indexed.slice(0, 1000)) {
    const previous = files.get(entry.path);
    if (previous?.changeAt !== undefined && previous.changeAt > entry.createdAt) continue;
    // At equal time the loaded record is the current authorized projection.
    if (previous?.changeAt === entry.createdAt) continue;
    files.set(entry.path, { path: entry.path, lastSeenAt: Math.max(previous?.lastSeenAt ?? 0, entry.createdAt),
      messageId: entry.messageId, changeMessageId: entry.messageId, mentions: (previous?.mentions ?? 0) + 1, change: entry.kind, changeAt: entry.createdAt,
      ...(entry.kind !== 'deleted' && entry.media?.sourceReference?.path === entry.path && isSourceMediaUrl(entry.media.url) ? { media: entry.media } : {}) });
  }
  return [...files.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.path.localeCompare(b.path));
}

/** Loaded metadata only: no parsing tool bodies, disk reads, or history fetches. */
export function collectSessionFiles(messages: readonly ChatMessage[], sessionKey: string) {
  const files = new Map<string, SessionFile>();
  const previewTimes = new Map<string, number>();
  let limited = messages.length > 2000;
  for (let index = messages.length - 1; index >= Math.max(0, messages.length - 2000); index--) {
    const message = messages[index]!;
    if (message.sessionKey !== sessionKey) continue;
    const completed = message.role === 'tool' && message.toolPhase === 'result' && message.status === 'sent';
    if (message.role !== 'assistant' && !completed) continue;
    const changes = completed ? normalizeSourceFiles(message.sourceFiles) : [];
    const candidates = new Map<string, { change?: SourceFileChange['kind']; media?: ChatMessageMedia }>();
    for (const change of changes) candidates.set(change.path, { change: change.kind });
    for (const media of (Array.isArray(message.media) ? message.media : []).slice(0, 32)) {
      const ref = media?.sourceReference;
      if (!ref || typeof ref.href !== 'string' || typeof media.url !== 'string') continue;
      const parsed = parseSourceReference(ref.href);
      if (!parsed || parsed.path !== ref.path || parsed.line !== ref.line) continue;
      if (completed && !candidates.has(ref.path)) continue;
      // Only Hub-issued message media addresses, not external links or local paths.
      if (!isSourceMediaUrl(media.url)) continue;
      candidates.set(ref.path, { ...candidates.get(ref.path), media });
    }
    for (const [path, candidate] of candidates) {
      let row = files.get(path);
      const time = Number.isFinite(message.createdAt) ? message.createdAt : 0;
      if (!row) {
        if (files.size >= 80) { limited = true; continue; }
        row = { path, lastSeenAt: time, messageId: message.id, mentions: 0 };
        files.set(path, row);
      }
      row.mentions++;
      if (time >= row.lastSeenAt) { row.lastSeenAt = time; row.messageId = message.id; }
      if (candidate.change && (row.changeAt === undefined || time > row.changeAt)) {
        row.change = candidate.change; row.changeAt = time; row.changeMessageId = message.id;
        // An old handle cannot stand in for a newer edit with no preview.
        if (candidate.change === 'deleted' || time >= (previewTimes.get(path) ?? -Infinity)) {
          delete row.media; previewTimes.delete(path);
          if (candidate.change !== 'deleted' && candidate.media) { row.media = candidate.media; previewTimes.set(path, time); }
        }
      } else if (candidate.media && !row.media && row.change !== 'deleted' && (row.changeAt === undefined || time >= row.changeAt)) {
        row.media = candidate.media; previewTimes.set(path, time);
      }
    }
  }
  const rows = [...files.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.path.localeCompare(b.path));
  return { files: rows, limited };
}

/** Decode only the Connector's native fileChange result envelope. Current disk
 * contents, assistant prose and shell commands are never historical diffs. */
export function recordedFileDiff(message: ChatMessage, sessionKey: string, messageId: string, path: string) {
  if (message.sessionKey !== sessionKey || message.id !== messageId || message.role !== 'tool'
    || message.status !== 'sent' || message.toolPhase !== 'result' || message.toolName !== 'fileChange'
    || !normalizeSourceFiles(message.sourceFiles).some(file => file.path === path)
    || typeof message.text !== 'string' || message.text.length > 256 * 1024) return undefined;
  const marker = '[tool fileChange]\nstatus: completed\noutput:\n';
  if (!message.text.startsWith(marker)) return undefined;
  try {
    const result = JSON.parse(message.text.slice(marker.length));
    if (result?.status !== 'completed' || result.error || result.success === false || !Array.isArray(result.changes) || result.changes.length > 64) return undefined;
    const matches = result.changes.filter((change: { path?: unknown }) => change?.path === path);
    if (matches.length !== 1 || typeof matches[0].diff !== 'string' || !matches[0].diff.length || matches[0].diff.length > 32 * 1024) return undefined;
    return matches[0].diff as string;
  } catch { return undefined; }
}
