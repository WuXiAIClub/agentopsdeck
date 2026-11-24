import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { type ChatMessage, type SessionFileEntry, type SessionFilePage } from '@agentopsdeck/shared';
import { extractFileEvidence, FILE_INDEX_ROWS, FILE_INDEX_BYTES, FILE_PROJECTION_ROWS, FILE_PROJECTION_BYTES,
  type FileEvidence, type ProjectionFileEvidence } from './session-file-evidence.js';
import type { FileEvidenceBatch } from './session-file-rebuild.js';
import { observedSavepoint } from '../storage/observed-savepoint.js';
import { connectionRecoverySnapshot, requireConnectionReady } from '../storage/connection-recovery.js';

// Separate from transcript budgets: only small structured evidence is retained.
export { FILE_INDEX_ROWS, FILE_INDEX_BYTES } from './session-file-evidence.js';
const PROJECTION_SESSIONS = 16;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Meta = { generation: string; revision: number; source: SessionFilePage['source']; digest: string; limited: number; stale: number };
type Row = { sequence: number; data: string; bytes: number };
export class FileIndexCursorError extends Error { constructor() { super('File index changed; refresh the list'); } }

/** Connector-local, reconstructible evidence, never a source of read authority.
 * SDK callers use their existing transcript transaction. Nested savepoints
 * isolate optional-index failures from durable messages and execution receipts.
 * No method reads a file, tool body or native transcript. */
export class SessionFileIndex {
  private available = true;
  private invalidated = new Set<string>();
  constructor(private readonly db: DatabaseSync) {
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS session_file_indexes (
        session_key TEXT PRIMARY KEY, generation TEXT NOT NULL, revision INTEGER NOT NULL,
        source TEXT NOT NULL, digest TEXT NOT NULL, limited INTEGER NOT NULL, stale INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS session_file_evidence (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_key TEXT NOT NULL, identity TEXT NOT NULL,
          data TEXT NOT NULL, bytes INTEGER NOT NULL, UNIQUE(session_key, identity));
        CREATE INDEX IF NOT EXISTS session_file_page ON session_file_evidence(session_key, sequence);
        CREATE TABLE IF NOT EXISTS session_file_summary (
          session_key TEXT PRIMARY KEY, generation TEXT NOT NULL, revision INTEGER NOT NULL,
          count INTEGER NOT NULL, earliest INTEGER, latest INTEGER);
        CREATE TABLE IF NOT EXISTS session_file_projection_snapshots (
          session_key TEXT PRIMARY KEY, generation TEXT NOT NULL, digest TEXT NOT NULL, limited INTEGER NOT NULL,
          sequence INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS session_file_projection_rows (
          session_key TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL, bytes INTEGER NOT NULL,
          PRIMARY KEY(session_key, position));`);
    } catch { this.available = false; }
  }

  private meta(key: string) { return this.db.prepare('SELECT * FROM session_file_indexes WHERE session_key = ?').get(key) as Meta | undefined; }
  /** Recomputed only when indexed evidence changes, inside the same savepoint.
   * At most 4000 rows / 2 MiB; list requests never scan all retained JSON.
   * A legacy writer changes revision and thereby invalidates this optional summary. */
  private summarize(key: string, meta: Meta) {
    const range = this.db.prepare(`SELECT count(*) AS count, min(json_extract(data, '$.createdAt')) AS earliest,
      max(json_extract(data, '$.createdAt')) AS latest FROM session_file_evidence WHERE session_key = ?`).get(key) as NonNullable<SessionFilePage['retained']>;
    this.db.prepare('INSERT OR REPLACE INTO session_file_summary VALUES (?, ?, ?, ?, ?, ?)')
      .run(key, meta.generation, meta.revision, range.count, range.earliest, range.latest);
  }
  /** Opaque optimistic fence; does not allocate/read the evidence list. */
  fence(key: string) {
    if (!this.available || this.invalidated.has(key)) throw new Error('File index unavailable');
    const meta = this.meta(key);
    return JSON.stringify(meta ? [meta.generation, meta.revision] : null);
  }

  /** Explicit SDK rebuild: failure rolls back, never destroys the previous index.
   * Caller supplies oldest-first, bounded entries from a verified native binding. */
  replaceDurable(key: string, nativeId: string, expected: string, entries: readonly SessionFileEntry[], limited: boolean,
    source: 'durable-events' | 'verified-projection' = 'durable-events') {
    if (this.fence(key) !== expected) throw new FileIndexCursorError();
    if (entries.length > FILE_INDEX_ROWS || Buffer.byteLength(JSON.stringify(entries)) > FILE_INDEX_BYTES) throw new Error('File index budget exceeded');
    observedSavepoint(this.db, 'session-file-index-rebuild', () => {
      const prior = this.meta(key);
      this.db.prepare('DELETE FROM session_file_evidence WHERE session_key = ?').run(key);
      for (const entry of entries) this.insert(key, entry);
      this.db.prepare('INSERT OR REPLACE INTO session_file_indexes VALUES (?, ?, ?, ?, ?, ?, 0)')
        .run(key, hash(JSON.stringify([key, nativeId])), (prior?.revision ?? 0) + 1, source, '', Number(limited));
      this.summarize(key, this.meta(key)!);
    });
  }
  private write(key: string, operation: () => void) {
    if (!this.available) return;
    requireConnectionReady(this.db);
    try {
      observedSavepoint(this.db, 'session-file-index-change', () => {
        const before = this.meta(key);
        operation();
        const after = this.meta(key);
        if (after && (before?.generation !== after.generation || before?.revision !== after.revision)) this.summarize(key, after);
      });
      this.invalidated.delete(key);
    } catch (error) {
      this.invalidated.add(key);
      // Optional metadata failure may degrade the index, not let the native
      // owner commit abandoned writes when savepoint cleanup itself failed.
      if (connectionRecoverySnapshot(this.db).state !== 'ready') throw error;
      try {
        this.db.prepare('UPDATE session_file_indexes SET stale = 1, revision = revision + 1 WHERE session_key = ?').run(key);
        this.invalidated.delete(key);
      } catch {
        // Even a read-only disk can prevent persisting stale=1. Fail closed for
        // this process until a verified refresh successfully commits again.
        this.invalidated.add(key);
      }
    }
  }

  private entries(key: string, messages: readonly ChatMessage[], maxRows = FILE_INDEX_ROWS, maxBytes = FILE_INDEX_BYTES) {
    return extractFileEvidence(key, messages, maxRows, maxBytes);
  }

  private insert(key: string, entry: SessionFileEntry) {
    const identity = hash(JSON.stringify([entry.messageId, entry.path])), data = JSON.stringify(entry);
    const previous = this.db.prepare('SELECT data FROM session_file_evidence WHERE session_key = ? AND identity = ?').get(key, identity) as { data: string } | undefined;
    if (previous) {
      if (previous.data !== data) throw new Error('Conflicting file evidence');
      return false;
    }
    this.db.prepare('INSERT INTO session_file_evidence(session_key, identity, data, bytes) VALUES (?, ?, ?, ?)')
      .run(key, identity, data, Buffer.byteLength(data));
    return true;
  }

  /** Successful native projection only, not DeckStore's merged/pending view.
   * Coverage stays partial: absent custom tools/old metadata cannot be inferred. */
  replaceProjection(key: string, messages: readonly ChatMessage[]) {
    if (!this.available) return;
    this.write(key, () => {
      if (key.startsWith('codex:')) this.captureProjection(key, messages);
      this.replaceIndex(key, this.entries(key, messages));
    });
  }

  /** Worker-only prevalidated structured metadata; same optional transaction as
   * synchronous hydration. Does not import raw history or grant file access. */
  replaceProjectionEvidence(key: string, evidence: ProjectionFileEvidence) {
    this.write(key, () => {
      if ('invalid' in evidence) throw Error('Conflicting file evidence');
      this.captureProjectionEvidence(key, evidence.snapshot);
      this.replaceIndex(key, evidence.index);
    });
  }

  private replaceIndex(key: string, { rows, limited }: FileEvidence) {
    const digest = hash(JSON.stringify([rows, limited])), prior = this.meta(key);
    if (prior?.digest === digest && !prior.stale) return;
    this.db.prepare('DELETE FROM session_file_evidence WHERE session_key = ?').run(key);
    for (const entry of rows) this.insert(key, entry);
    this.db.prepare('INSERT OR REPLACE INTO session_file_indexes VALUES (?, ?, ?, ?, ?, ?, 0)')
      .run(key, randomUUID(), (prior?.revision ?? 0) + 1, 'verified-projection', digest, Number(limited));
  }

  /** Capture ONLY structured evidence during the existing verified hydration.
   * This disposable snapshot is independent of the UI/index retention window.
   * No additional native read, raw-history scan or tool-body access is involved.
   * Bound retained snapshots globally (16 x 4 MiB) as well as per session. */
  private captureProjection(key: string, messages: readonly ChatMessage[]) {
    this.captureProjectionEvidence(key, this.entries(key, messages, FILE_PROJECTION_ROWS, FILE_PROJECTION_BYTES));
  }

  private captureProjectionEvidence(key: string, { rows, limited }: FileEvidence) {
    const digest = hash(JSON.stringify([rows, limited]));
    const prior = this.db.prepare('SELECT digest FROM session_file_projection_snapshots WHERE session_key = ?').get(key) as { digest: string } | undefined;
    if (prior?.digest === digest) return;
    const sequence = (this.db.prepare('SELECT coalesce(max(sequence), 0) + 1 AS next FROM session_file_projection_snapshots').get() as { next: number }).next;
    this.db.prepare('DELETE FROM session_file_projection_rows WHERE session_key = ?').run(key);
    const insert = this.db.prepare('INSERT INTO session_file_projection_rows VALUES (?, ?, ?, ?)');
    rows.forEach((entry, position) => { const data = JSON.stringify(entry); insert.run(key, position, data, Buffer.byteLength(data)); });
    this.db.prepare('INSERT OR REPLACE INTO session_file_projection_snapshots VALUES (?, ?, ?, ?, ?)')
      .run(key, randomUUID(), digest, Number(limited), sequence);
    const evicted = this.db.prepare('SELECT session_key FROM session_file_projection_snapshots ORDER BY sequence DESC LIMIT -1 OFFSET ?')
      .all(PROJECTION_SESSIONS) as { session_key: string }[];
    for (const row of evicted) {
      this.db.prepare('DELETE FROM session_file_projection_rows WHERE session_key = ?').run(row.session_key);
      this.db.prepare('DELETE FROM session_file_projection_snapshots WHERE session_key = ?').run(row.session_key);
    }
  }

  projectionBinding(key: string): string | undefined {
    if (!this.available || this.invalidated.has(key) || !key.startsWith('codex:')) return undefined;
    try {
      if (this.meta(key)?.stale) return undefined;
      return (this.db.prepare('SELECT generation FROM session_file_projection_snapshots WHERE session_key = ?').get(key) as { generation: string } | undefined)?.generation;
    } catch { return undefined; }
  }

  /** Indexed random access, at most 20 metadata rows per step. Cursor identity
   * includes both session and immutable snapshot; it conveys no authority. */
  projectionEvidencePage(key: string, cursor?: string): FileEvidenceBatch {
    const generation = this.projectionBinding(key);
    if (!generation) throw new FileIndexCursorError();
    let before = FILE_PROJECTION_ROWS;
    if (cursor !== undefined) {
      try {
        if (cursor.length > 1024) throw new Error();
        const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (value.key !== hash(key) || value.generation !== generation || !Number.isSafeInteger(value.before)
          || value.before <= 0 || value.before > FILE_PROJECTION_ROWS) throw new Error();
        before = value.before;
      } catch { throw new FileIndexCursorError(); }
    }
    const rows = this.db.prepare('SELECT position, data, bytes FROM session_file_projection_rows WHERE session_key = ? AND position < ? ORDER BY position DESC LIMIT 21')
      .all(key, before) as { position: number; data: string; bytes: number }[];
    const page = rows.slice(0, 20), last = page.at(-1);
    const limited = !!(this.db.prepare('SELECT limited FROM session_file_projection_snapshots WHERE session_key = ?').get(key) as { limited: number }).limited;
    return { scanned: page.length, bytes: page.reduce((sum, row) => sum + row.bytes, 0),
      // A snapshot budget only terminates the rebuild after its retained pages.
      ...(!rows[20] && limited ? { limited: true } : {}),
      ...(rows[20] && last ? { before: Buffer.from(JSON.stringify({ key: hash(key), generation, before: last.position })).toString('base64url') } : {}),
      messages: page.reverse().map(row => {
        const { messageId, createdAt, ...file } = JSON.parse(row.data) as SessionFileEntry;
        return { id: messageId, sessionKey: key, role: 'tool', toolPhase: 'result', status: 'sent', text: '', createdAt, sourceFiles: [file] };
      }) };
  }

  /** New durable SDK evidence only; deliberately no implicit historical backfill. */
  append(key: string, nativeSessionId: string, messages: readonly ChatMessage[]) {
    if (!this.available) return;
    this.write(key, () => {
      const { rows, limited } = this.entries(key, messages);
      const generation = hash(JSON.stringify([key, nativeSessionId])), prior = this.meta(key);
      // Binding changes invalidate old evidence even if the new messages have
      // no files. A same-binding empty append remains a no-op unless coverage
      // became limited (which must also fence pending rebuilds and cursors).
      if (prior?.generation !== generation) {
        this.db.prepare('DELETE FROM session_file_evidence WHERE session_key = ?').run(key);
        this.db.prepare('INSERT OR REPLACE INTO session_file_indexes VALUES (?, ?, ?, ?, ?, 0, 0)')
          .run(key, generation, (prior?.revision ?? 0) + 1, 'durable-events', '');
      }
      let changed = limited && (prior?.generation !== generation || !prior.limited);
      if (changed) this.db.prepare('UPDATE session_file_indexes SET limited = 1 WHERE session_key = ?').run(key);
      for (const entry of rows) changed = this.insert(key, entry) || changed;
      if (!changed) return;
      const totals = this.db.prepare('SELECT count(*) AS count, coalesce(sum(bytes), 0) AS bytes FROM session_file_evidence WHERE session_key = ?')
        .get(key) as { count: number; bytes: number };
      while (totals.count > FILE_INDEX_ROWS || totals.bytes > FILE_INDEX_BYTES) {
        const first = this.db.prepare('SELECT sequence, bytes FROM session_file_evidence WHERE session_key = ? ORDER BY sequence LIMIT 1').get(key) as Row;
        this.db.prepare('DELETE FROM session_file_evidence WHERE sequence = ?').run(first.sequence);
        totals.count--; totals.bytes -= first.bytes;
        this.db.prepare('UPDATE session_file_indexes SET limited = 1 WHERE session_key = ?').run(key);
      }
      this.db.prepare('UPDATE session_file_indexes SET revision = revision + 1 WHERE session_key = ?').run(key);
    });
  }

  page(key: string, cursor?: string, nativeSessionId?: string): SessionFilePage {
    const unavailable: SessionFilePage = { entries: [], generation: '', revision: 0, coverage: 'unavailable', source: 'none', limited: false };
    if (!this.available) return unavailable;
    try {
      if (this.invalidated.has(key)) {
        if (cursor) throw new FileIndexCursorError();
        return { ...unavailable, coverage: 'stale' };
      }
      const meta = this.meta(key);
      if (!meta) { if (cursor) throw new FileIndexCursorError(); return unavailable; }
      if (nativeSessionId !== undefined && meta.generation !== hash(JSON.stringify([key, nativeSessionId]))) {
        if (cursor) throw new FileIndexCursorError();
        return unavailable;
      }
      let before = Number.MAX_SAFE_INTEGER;
      if (cursor !== undefined) {
        try {
          if (cursor.length > 1024) throw new Error();
          const value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
          if (value.key !== hash(key) || value.generation !== meta.generation || value.revision !== meta.revision
            || !Number.isSafeInteger(value.before) || value.before < 1) throw new Error();
          before = value.before;
        } catch { throw new FileIndexCursorError(); }
      }
      const rows = this.db.prepare('SELECT sequence, data, bytes FROM session_file_evidence WHERE session_key = ? AND sequence < ? ORDER BY sequence DESC LIMIT 51')
        .all(key, before) as Row[];
      const entries: SessionFileEntry[] = [];
      let bytes = 0;
      for (const row of rows.slice(0, 50)) {
        if (bytes + row.bytes > 96 * 1024) break;
        entries.push(JSON.parse(row.data)); bytes += row.bytes;
      }
      const retained = this.db.prepare('SELECT count, earliest, latest FROM session_file_summary WHERE session_key = ? AND generation = ? AND revision = ?')
        .get(key, meta.generation, meta.revision) as SessionFilePage['retained'];
      return { entries, generation: meta.generation, revision: meta.revision, coverage: meta.stale ? 'stale' : 'partial',
        source: meta.source, limited: !!meta.limited,
        ...(retained ? { retained: { ...retained } } : {}),
        ...(rows.length > entries.length && entries.length ? { nextCursor: Buffer.from(JSON.stringify({ key: hash(key),
          generation: meta.generation, revision: meta.revision, before: rows[entries.length - 1]!.sequence })).toString('base64url') } : {}) };
    } catch (error) { if (error instanceof FileIndexCursorError) throw error; return unavailable; }
  }
}
