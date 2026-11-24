import type { ChatMessage, ChatMessageMedia } from './index.js';
import { normalizeSourceFiles, type SourceFileChange } from './source-files.js';

/** Metadata only. A listed path never grants permission to read its contents. */
export type SessionFileEntry = SourceFileChange & { messageId: string; createdAt: number; media?: ChatMessageMedia };
export type SessionFilePage = {
  entries: SessionFileEntry[];
  generation: string;
  revision: number;
  coverage: 'unavailable' | 'partial' | 'stale';
  source: 'durable-events' | 'verified-projection' | 'none';
  limited: boolean;
  nextCursor?: string;
  /** Optional, negotiated per session; old Connectors omit this. */
  rebuildAvailable?: boolean;
  /** All retained indexed evidence, not scanned/continuous historical coverage.
   * Omitted by old Connectors or until the optional summary is rebuilt. */
  retained?: { count: number; earliest: number | null; latest: number | null };
};

export type SessionFileRebuild = {
  id: string;
  step: number;
  state: 'scanning' | 'completed' | 'cancelled' | 'conflict' | 'failed';
  scanned: number;
  bytes: number;
  found: number;
  limited: boolean;
};

export function validateSessionFileRebuild(value: SessionFileRebuild): SessionFileRebuild {
  if (!value || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id)
    || !['scanning', 'completed', 'cancelled', 'conflict', 'failed'].includes(value.state)
    || !Number.isSafeInteger(value.step) || value.step < 0 || value.step > 10_001
    || !Number.isSafeInteger(value.scanned) || value.scanned < 0 || value.scanned > 10_020
    || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.bytes > 65 * 1024 * 1024
    || !Number.isSafeInteger(value.found) || value.found < 0 || value.found > 4000
    || typeof value.limited !== 'boolean') throw new Error('Invalid file rebuild progress');
  return { id: value.id, step: value.step, state: value.state, scanned: value.scanned,
    bytes: value.bytes, found: value.found, limited: value.limited };
}

export function fileEntryMessage(entry: SessionFileEntry, sessionKey: string): ChatMessage {
  return { id: entry.messageId, sessionKey, role: 'tool', toolPhase: 'result', status: 'sent', text: '',
    createdAt: entry.createdAt, sourceFiles: [{ path: entry.path, kind: entry.kind }] };
}

/** Do not trust an upstream index to supply arbitrary media URLs or extra data. */
export function validateSessionFilePage(value: SessionFilePage): SessionFilePage {
  if (!value || !Array.isArray(value.entries) || value.entries.length > 50
    || !['unavailable', 'partial', 'stale'].includes(value.coverage)
    || !['durable-events', 'verified-projection', 'none'].includes(value.source)
    || typeof value.generation !== 'string' || value.generation.length > 128
    || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.limited !== 'boolean'
    || value.nextCursor !== undefined && (typeof value.nextCursor !== 'string' || value.nextCursor.length > 1024)) throw new Error('Invalid file index');
  const entries = value.entries.map(entry => {
    if (!entry || typeof entry.messageId !== 'string' || !entry.messageId.length || entry.messageId.length > 4096
      || ['.', '..'].includes(entry.messageId) || !Number.isSafeInteger(entry.createdAt) || entry.createdAt < 0
      || normalizeSourceFiles([entry]).length !== 1) throw new Error('Invalid file evidence');
    return { path: entry.path, kind: entry.kind, messageId: entry.messageId, createdAt: entry.createdAt };
  });
  let retained: SessionFilePage['retained'];
  if (value.retained !== undefined) {
    const row = value.retained;
    if (!row || !Number.isSafeInteger(row.count) || row.count < entries.length || row.count > 4000
      || (row.count === 0 ? row.earliest !== null || row.latest !== null
        : !Number.isSafeInteger(row.earliest) || !Number.isSafeInteger(row.latest) || row.earliest! < 0 || row.latest! < row.earliest!)
      || entries.some(entry => entry.createdAt < row.earliest! || entry.createdAt > row.latest!)) throw new Error('Invalid file index range');
    retained = { count: row.count, earliest: row.earliest, latest: row.latest };
  }
  return { entries, generation: value.generation, revision: value.revision, coverage: value.coverage,
    source: value.source, limited: value.limited, ...(value.nextCursor ? { nextCursor: value.nextCursor } : {}),
    ...(retained ? { retained } : {}),
    ...(value.rebuildAvailable === true ? { rebuildAvailable: true } : {}) };
}
