import type { DatabaseSync } from 'node:sqlite';
import { observedSavepoint } from '../storage/observed-savepoint.js';
import { ReadTimings } from '../storage/read-timings.js';
import { MAX_MESSAGE_CHARS, type ChatMessage } from '@agentopsdeck/shared';
import type { SdkExecution, SdkExecutionRef } from '../connector/sdk-execution-journal.js';
import { validateClaudeProjection, type ClaudeProjectedMessage } from './message-projection.js';
import { claudeLiveMessageId, validateClaudeTextStream, validateClaudeStreamFinal, type ClaudeTextStream, type ClaudeStreamFinal } from './stream-projection.js';
import { CLAUDE_TOOL_DETAIL_CHARS, validateClaudeToolDetails, type ClaudeToolDetail } from './tool-details.js';
import { TranscriptCounts } from '../connector/transcript-counts.js';

/** Budget applies to serialized summary payloads, not native history.
 * Bounded text-only tool details live in a separate lazily read table. */
export const CLAUDE_TRANSCRIPT_PAGE_BYTES = 1_048_576;
export const CLAUDE_LIVE_STREAM_LIMIT = 128;
export type ClaudeStoredMessage = {
  sessionKey: string; cursor: string; executionId: string; nativeMessageId: string; createdAt: number;
  rows: ClaudeProjectedMessage[];
  /** Server-derived queue identities; never accepted from the native worker. */
  admissions?: Record<number, string>;
  admissionStatuses?: Record<number, 'sent' | 'sending' | 'outcome_unknown'>;
  displayIds?: Record<number, string>;
  detailBlocks?: number[];
};
type StoredRow = { sequence: number; execution_id: string; native_session_id: string;
  message_id: string; parent_id: string; data: string; created_at: number };
const failure = () => new Error('Claude transcript identity or persistence could not be confirmed');

/** Connector-local durable projection, not native completion proof and not
 * an authorization boundary. Callers must authorize session reads separately.
 * The journal and this table MUST be in the same owning SQLite database.
 * Final message identities are immutable; stale/rebound worker callbacks fail
 * closed instead of overwriting another turn or reviving unknown execution. */
export class ClaudeTranscriptStore {
  private readonly timings = new ReadTimings();
  readStats() { return this.timings.snapshot(); }
  private readonly counts: TranscriptCounts;
  private readonly fileIndex: SessionFileIndex;
  private readonly streams = new Map<string, { ref: SdkExecutionRef; snapshot: ClaudeTextStream; createdAt: number }>();
  constructor(private readonly db: DatabaseSync, private readonly now = Date.now) {
    this.fileIndex = new SessionFileIndex(db);
    db.exec(`CREATE TABLE IF NOT EXISTS claude_transcript_messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL, execution_id TEXT NOT NULL, native_session_id TEXT NOT NULL,
      message_id TEXT NOT NULL, parent_id TEXT NOT NULL, data TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(session_key, message_id)
    );
    CREATE INDEX IF NOT EXISTS claude_transcript_session_page ON claude_transcript_messages(session_key, sequence);`);
    // Cover counts with small indexed integers rather than parsing/scanning
    // historical summary bodies on each HTTP read (no native tool bodies).
    db.exec(`CREATE INDEX IF NOT EXISTS claude_transcript_block_counts
      ON claude_transcript_messages(session_key, sequence, json_array_length(data));
      CREATE TABLE IF NOT EXISTS claude_transcript_admissions (
        session_key TEXT NOT NULL, admission_id TEXT NOT NULL, message_id TEXT NOT NULL, block_index INTEGER NOT NULL,
        PRIMARY KEY(session_key, admission_id), UNIQUE(session_key, message_id, block_index)
      );
      CREATE TABLE IF NOT EXISTS claude_transcript_display_ids (
        session_key TEXT NOT NULL, public_id TEXT NOT NULL, message_id TEXT NOT NULL, block_index INTEGER NOT NULL,
        parent_id TEXT NOT NULL,
        PRIMARY KEY(session_key, public_id), UNIQUE(session_key, message_id, block_index)
      );`);
    db.exec(`CREATE TABLE IF NOT EXISTS claude_transcript_details (
      session_key TEXT NOT NULL, message_id TEXT NOT NULL, block_index INTEGER NOT NULL,
      execution_id TEXT NOT NULL, parent_id TEXT NOT NULL, tool_call_id TEXT NOT NULL, phase TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(session_key, message_id, block_index)
    );
    CREATE INDEX IF NOT EXISTS claude_transcript_detail_calls
      ON claude_transcript_details(session_key, execution_id, parent_id, tool_call_id, phase);`);
    this.counts = new TranscriptCounts(db, 'claude-code');
  }

  private streamKey(ref: SdkExecutionRef, snapshot: Pick<ClaudeTextStream, 'messageId' | 'parentToolUseId'>) {
    return JSON.stringify([ref.key, ref.id, snapshot.parentToolUseId, snapshot.messageId]);
  }

  updateStream(ref: SdkExecutionRef, input: ClaudeTextStream) {
    const record = this.db.prepare(`SELECT data FROM sdk_agent_executions
      WHERE runtime = 'claude-code' AND session_key = ? AND id = ?`).get(ref.key, ref.id) as { data: string } | undefined;
    const execution = record && JSON.parse(record.data) as SdkExecution | undefined;
    if (!execution || execution.epoch !== ref.epoch || !['dispatching', 'running'].includes(execution.phase)) throw failure();
    const snapshot = validateClaudeTextStream(input), key = this.streamKey(ref, snapshot), previous = this.streams.get(key);
    // Optional live previews may be omitted under load. Never stop a native
    // run or discard durable final history to satisfy a display-cache limit.
    if (!previous && this.streams.size >= CLAUDE_LIVE_STREAM_LIMIT) return false;
    if (!previous && [...this.streams.values()].filter(row => row.ref.key === ref.key).length >= 16) throw failure();
    if (previous && previous.snapshot.blocks.some(block => {
      const next = snapshot.blocks.find(row => row.blockIndex === block.blockIndex);
      return !next || !next.text.startsWith(block.text) || block.truncated && !next.truncated;
    })) throw failure();
    this.streams.set(key, { ref: { ...ref }, snapshot, createdAt: previous?.createdAt ?? this.now() });
    return true;
  }

  endStreams(ref: SdkExecutionRef) {
    for (const [key, value] of this.streams) if (value.ref.key === ref.key && value.ref.id === ref.id && value.ref.epoch === ref.epoch) {
      this.streams.delete(key);
    }
  }

  /** Ephemeral text, never native completion proof. A process restart may
   * discard a partial reply, but never an already persisted final message. */
  liveMessages(key: string): ChatMessage[] {
    const messages: ChatMessage[] = [];
    for (const row of this.streams.values()) {
      if (row.ref.key !== key) continue;
      for (const block of row.snapshot.blocks) {
        if (!block.text && !block.truncated) continue;
        messages.push({ id: claudeLiveMessageId(key, row.ref.id, row.snapshot, block.blockIndex), sessionKey: key,
          role: 'assistant', turnId: row.ref.id, text: block.text, createdAt: row.createdAt,
          ...(block.truncated ? { contentTruncated: true } : {}),
          ...(row.snapshot.parentToolUseId === null ? {} : { parentToolUseId: row.snapshot.parentToolUseId }) });
      }
    }
    return messages;
  }

  displayAnchor(key: string, id: string) {
    const row = this.db.prepare(`SELECT message_id, parent_id, block_index FROM claude_transcript_display_ids
      WHERE session_key = ? AND public_id = ?`).get(key, id) as { message_id: string; parent_id: string; block_index: number } | undefined;
    return row ? { nativeMessageId: row.message_id, parentToolUseId: row.parent_id || null, blockIndex: row.block_index } : undefined;
  }

  private displayIds(key: string, message: string): Record<number, string> {
    const rows = this.db.prepare(`SELECT public_id, block_index FROM claude_transcript_display_ids
      WHERE session_key = ? AND message_id = ?`).all(key, message) as { public_id: string; block_index: number }[];
    return Object.fromEntries(rows.map(row => [row.block_index, row.public_id]));
  }

  admissionAnchor(key: string, id: string) {
    const row = this.db.prepare(`SELECT message_id, block_index FROM claude_transcript_admissions
      WHERE session_key = ? AND admission_id = ?`).get(key, id) as { message_id: string; block_index: number } | undefined;
    return row ? { nativeMessageId: row.message_id, parentToolUseId: null, blockIndex: row.block_index } : undefined;
  }

  private admissions(key: string, message: string) {
    const rows = this.db.prepare(`SELECT a.admission_id, a.block_index, t.state FROM claude_transcript_admissions a
      LEFT JOIN connector_turns t ON t.runtime = 'claude-code' AND t.session_key = a.session_key AND t.id = a.admission_id
      WHERE a.session_key = ? AND a.message_id = ?`).all(key, message) as { admission_id: string; block_index: number; state: string | null }[];
    const admissionStatuses: NonNullable<ClaudeStoredMessage['admissionStatuses']> = {};
    for (const row of rows) admissionStatuses[row.block_index] = row.state === null ? 'sent'
      : row.state === 'dispatching' ? 'sending' : 'outcome_unknown';
    return { admissions: Object.fromEntries(rows.map(row => [row.block_index, row.admission_id])), admissionStatuses,
      displayIds: this.displayIds(key, message), detailBlocks: (this.db.prepare(`SELECT block_index FROM claude_transcript_details
        WHERE session_key = ? AND message_id = ?`).all(key, message) as { block_index: number }[]).map(row => row.block_index) };
  }

  /** Called only by the separately authorized single-message endpoint. List
   * reads query small block indexes above, never the detail data column. */
  toolDetail(key: string, anchor: { nativeMessageId: string; parentToolUseId: string | null; blockIndex: number }) {
    const message = this.message(key, anchor), row = message?.rows[0];
    if (!message || row?.role !== 'tool') return;
    const read = (data: string) => {
      if (Buffer.byteLength(data) > CLAUDE_TOOL_DETAIL_CHARS * 6 + 1024) throw failure();
      const value: unknown = JSON.parse(data);
      if (!value || typeof value !== 'object' || !('text' in value) || typeof value.text !== 'string'
        || value.text.length > CLAUDE_TOOL_DETAIL_CHARS || !('truncated' in value) || typeof value.truncated !== 'boolean') throw failure();
      return { text: value.text, truncated: value.truncated };
    };
    const stored = this.db.prepare(`SELECT data FROM claude_transcript_details WHERE session_key = ? AND message_id = ? AND block_index = ?`)
      .get(key, anchor.nativeMessageId, anchor.blockIndex) as { data: string } | undefined;
    if (!stored) return;
    const detail = read(stored.data);
    if (row.toolPhase === 'result') {
      const calls = this.db.prepare(`SELECT data FROM claude_transcript_details WHERE session_key = ? AND execution_id = ?
        AND parent_id = ? AND tool_call_id = ? AND phase = 'call' LIMIT 2`)
        .all(key, message.executionId, anchor.parentToolUseId ?? '', row.toolCallId!) as { data: string }[];
      if (calls.length === 1) {
        const call = read(calls[0]!.data);
        const text = `Input\n${call.text}\n\nResult\n${detail.text}`;
        return { text: text.slice(0, CLAUDE_TOOL_DETAIL_CHARS), truncated: call.truncated || detail.truncated || text.length > CLAUDE_TOOL_DETAIL_CHARS };
      }
    }
    return detail;
  }

  /** Pending inputs are presented after native history. Exclude durable
   * native echoes, including the small window before their ACK settles. */
  pendingPage(key: string, limit: number, waiting: boolean, before?: string) {
    if (!key.startsWith('claude-code:') || !Number.isSafeInteger(limit) || limit < 0 || limit > 200) throw failure();
    const visible = `runtime = 'claude-code' AND session_key = ? AND NOT EXISTS
      (SELECT 1 FROM claude_transcript_admissions a WHERE a.session_key = connector_turns.session_key AND a.admission_id = connector_turns.id)`;
    const count = (boundary: number) => Number((this.db.prepare(`SELECT count(*) AS total FROM connector_turns
      WHERE ${visible} AND sequence < ?`).get(key, boundary) as { total: number }).total);
    let boundary = Number.MAX_SAFE_INTEGER;
    const totalCount = count(boundary);
    if (before !== undefined) {
      const row = this.db.prepare(`SELECT sequence FROM connector_turns WHERE ${visible} AND id = ?`).get(key, before) as { sequence: number } | undefined;
      if (!row) return;
      boundary = row.sequence;
    }
    const messages: ChatMessage[] = [];
    let bytes = 0;
    for (const value of this.db.prepare(`SELECT id, created_at, state, payload, sequence || ':' || revision AS version
      FROM connector_turns WHERE ${visible} AND sequence < ? ORDER BY sequence DESC LIMIT ?`).iterate(key, boundary, limit)) {
      const row = value as { id: string; created_at: number; state: string; payload: string; version: string };
      const payload = JSON.parse(row.payload) as { text?: unknown };
      if (typeof payload.text !== 'string' || payload.text.length > MAX_MESSAGE_CHARS || !Number.isSafeInteger(row.created_at) || row.created_at < 0) throw failure();
      const message: ChatMessage = { id: row.id, sessionKey: key, role: 'user', text: payload.text, createdAt: row.created_at,
        status: row.state === 'outcome_unknown' ? 'outcome_unknown' : row.state === 'blocked' ? 'failed' : 'queued',
        queueDisposition: waiting ? 'waiting' : 'preparing', queueVersion: row.version };
      const size = Buffer.byteLength(JSON.stringify(message));
      if (bytes + size > CLAUDE_TRANSCRIPT_PAGE_BYTES) break;
      messages.unshift(message); bytes += size;
    }
    return { messages, totalCount, hiddenCount: count(boundary) - messages.length };
  }

  message(key: string, anchor: { nativeMessageId: string; parentToolUseId: string | null; blockIndex: number }) {
    const row = this.db.prepare(`SELECT t.* FROM claude_transcript_messages t JOIN sdk_agent_sessions s
      ON s.runtime = 'claude-code' AND s.session_key = t.session_key AND s.native_session_id = t.native_session_id
      WHERE t.session_key = ? AND t.message_id = ?`).get(key, anchor.nativeMessageId) as StoredRow | undefined;
    if (!row || row.parent_id !== (anchor.parentToolUseId ?? '')) return;
    if (Buffer.byteLength(row.data) > CLAUDE_TRANSCRIPT_PAGE_BYTES || !Number.isSafeInteger(row.created_at) || row.created_at < 0) throw failure();
    const rows = validateClaudeProjection(JSON.parse(row.data), row.message_id, row.parent_id || null)
      .filter(block => block.blockIndex === anchor.blockIndex);
    if (!rows.length) return;
    return { sessionKey: key, cursor: String(row.sequence), executionId: row.execution_id,
      nativeMessageId: row.message_id, createdAt: row.created_at, rows, ...this.admissions(key, row.message_id) };
  }

  /** HTTP paging counts displayed blocks, not native envelopes. Anchors bind
   * the session, parent, native UUID and exact block; never accept file paths.
   * Iterate newest first and stop at the count/byte budget, including when a
   * single native message spans multiple public pages. */
  pageBlocks(key: string, limit = 200, anchor?: { nativeMessageId: string; parentToolUseId: string | null; blockIndex: number }) {
    if (!key.startsWith('claude-code:') || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw failure();
    const session = this.db.prepare(`SELECT native_session_id FROM sdk_agent_sessions
      WHERE runtime = 'claude-code' AND session_key = ?`).get(key) as { native_session_id: string } | undefined;
    if (!session) throw failure();
    let boundary = Number.MAX_SAFE_INTEGER, endCount: number;
    const totalCount = this.counts.count(key);
    endCount = totalCount;
    if (anchor) {
      const found = this.db.prepare(`SELECT sequence, parent_id, data FROM claude_transcript_messages
        WHERE session_key = ? AND message_id = ?`).get(key, anchor.nativeMessageId) as Pick<StoredRow, 'sequence' | 'parent_id' | 'data'> | undefined;
      if (!found || found.parent_id !== (anchor.parentToolUseId ?? '')) return;
      const rows = validateClaudeProjection(JSON.parse(found.data), anchor.nativeMessageId, anchor.parentToolUseId);
      const index = rows.findIndex(row => row.blockIndex === anchor.blockIndex);
      if (index < 0) return;
      boundary = found.sequence;
      endCount = this.counts.count(key, boundary) + index;
    }
    let bytes = 0, displayed = 0;
    const messages: ClaudeStoredMessage[] = [];
    for (const value of this.timings.rows(this.db.prepare(`SELECT sequence, execution_id, native_session_id, message_id, parent_id, data, created_at
      FROM claude_transcript_messages WHERE session_key = ? AND sequence <= ? ORDER BY sequence DESC`).iterate(key, boundary))) {
      const row = value as StoredRow;
      if (row.native_session_id !== session.native_session_id || !Number.isSafeInteger(row.sequence)
        || !Number.isSafeInteger(row.created_at) || row.created_at < 0
        || Buffer.byteLength(row.data) > CLAUDE_TRANSCRIPT_PAGE_BYTES) throw failure();
      let rows = validateClaudeProjection(this.timings.parse(row.data), row.message_id, row.parent_id || null);
      if (anchor && row.sequence === boundary) rows = rows.filter(block => block.blockIndex < anchor.blockIndex);
      const selected: ClaudeProjectedMessage[] = [];
      for (let index = rows.length - 1; index >= 0; index--) {
        const block = rows[index]!, size = Buffer.byteLength(JSON.stringify(block));
        if (displayed >= limit || bytes + size > CLAUDE_TRANSCRIPT_PAGE_BYTES) break;
        selected.unshift(block); displayed++; bytes += size;
      }
      if (selected.length) messages.unshift({ sessionKey: key, cursor: String(row.sequence), executionId: row.execution_id,
        nativeMessageId: row.message_id, createdAt: row.created_at, rows: selected, ...this.admissions(key, row.message_id) });
      if (selected.length < rows.length || displayed >= limit) break;
    }
    return { messages, totalCount, hiddenCount: endCount - displayed };
  }

  append(ref: SdkExecutionRef, input: readonly ClaudeProjectedMessage[], final?: ClaudeStreamFinal, inputDetails: readonly ClaudeToolDetail[] = []): void {
    if (!ref.key.startsWith('claude-code:')) throw failure();
    const match = final === undefined ? undefined : validateClaudeStreamFinal(final);
    const details = validateClaudeToolDetails(inputDetails, input);
    if (match && input.some(row => row.role === 'user' || match.blockIndexes[row.blockIndex] === undefined)) throw failure();
    const streamKey = match && input[0] ? this.streamKey(ref,
      { messageId: match.messageId, parentToolUseId: input[0].parentToolUseId }) : undefined;
    const stream = streamKey === undefined ? undefined : this.streams.get(streamKey);
    // One synchronous transaction with no await between identity check and
    // insert; a retired worker may never publish after recovery/new dispatch.
    observedSavepoint(this.db, 'claude-transcript-append', () => {
      const record = this.db.prepare(`SELECT data FROM sdk_agent_executions
        WHERE runtime = 'claude-code' AND session_key = ? ORDER BY sequence DESC LIMIT 1`).get(ref.key) as { data: string } | undefined;
      const execution = record && JSON.parse(record.data) as SdkExecution | undefined;
      if (!execution || execution.id !== ref.id || execution.epoch !== ref.epoch
        || !['dispatching', 'running', 'settling'].includes(execution.phase)) throw failure();
      if (input.length) {
        const first = input[0]!;
        let rows = validateClaudeProjection(input, first.nativeMessageId, first.parentToolUseId);
        const admissions: string[] = [];
        if (first.nativeMessageId === execution.id && first.parentToolUseId === null && first.role === 'user') {
          if (rows.length !== 1 || first.truncated) throw failure();
          const texts = execution.batch ? first.text.split(execution.batch.separator) : [first.text];
          if (texts.length !== execution.members.length) throw failure();
          rows = texts.map((text, blockIndex) => ({ ...rows[0]!, blockIndex, text }));
          admissions.push(...execution.members);
        }
        const data = JSON.stringify(rows);
        if (Buffer.byteLength(data) > CLAUDE_TRANSCRIPT_PAGE_BYTES) throw failure();
        const existing = this.db.prepare(`SELECT execution_id, native_session_id, parent_id, data FROM claude_transcript_messages
          WHERE session_key = ? AND message_id = ?`).get(ref.key, first.nativeMessageId) as StoredRow | undefined;
        if (existing) {
          if (existing.execution_id !== ref.id || existing.native_session_id !== execution.nativeSessionId
            || existing.parent_id !== (first.parentToolUseId ?? '') || existing.data !== data) throw failure();
        } else {
          const createdAt = stream?.createdAt ?? this.now();
          if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw failure();
          this.db.prepare(`INSERT INTO claude_transcript_messages
            (session_key, execution_id, native_session_id, message_id, parent_id, data, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`).run(ref.key, ref.id, execution.nativeSessionId,
            first.nativeMessageId, first.parentToolUseId ?? '', data, createdAt);
          for (const [blockIndex, id] of admissions.entries()) this.db.prepare(`INSERT INTO claude_transcript_admissions
            (session_key, admission_id, message_id, block_index) VALUES (?, ?, ?, ?)`).run(ref.key, id, first.nativeMessageId, blockIndex);
          if (match && stream) {
            for (const row of rows) {
              const streamIndex = match.blockIndexes[row.blockIndex]!;
              if (row.role !== 'assistant' || !stream.snapshot.blocks.some(block => block.blockIndex === streamIndex)) continue;
              this.db.prepare(`INSERT INTO claude_transcript_display_ids VALUES (?, ?, ?, ?, ?)`).run(ref.key,
                claudeLiveMessageId(ref.key, ref.id, stream.snapshot, streamIndex), first.nativeMessageId, row.blockIndex, first.parentToolUseId ?? '');
            }
          }
        }
        for (const detail of details) {
          const data = JSON.stringify(detail), row = rows.find(row => row.blockIndex === detail.blockIndex)!;
          const saved = this.db.prepare(`SELECT data FROM claude_transcript_details WHERE session_key = ? AND message_id = ? AND block_index = ?`)
            .get(ref.key, first.nativeMessageId, detail.blockIndex) as { data: string } | undefined;
          if (saved || existing) {
            if (saved?.data !== data) throw failure();
          } else this.db.prepare(`INSERT INTO claude_transcript_details VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(ref.key, first.nativeMessageId, detail.blockIndex, ref.id, first.parentToolUseId ?? '', row.toolCallId!, row.toolPhase!, data);
        }
        if (rows.some(row => row.sourceFiles?.length)) {
          const saved = this.db.prepare('SELECT created_at FROM claude_transcript_messages WHERE session_key = ? AND message_id = ?')
            .get(ref.key, first.nativeMessageId) as { created_at: number };
          this.fileIndex.append(ref.key, execution.nativeSessionId, claudeChatMessages(ref.key, [{ sessionKey: ref.key,
            cursor: '', executionId: ref.id, nativeMessageId: first.nativeMessageId, createdAt: saved.created_at, rows }]));
        }
      }
    });
    // A lost RELEASE acknowledgement must not discard the recoverable stream.
    if (match && stream && streamKey !== undefined) {
      stream.snapshot.blocks = stream.snapshot.blocks.filter(block => !match.blockIndexes.includes(block.blockIndex));
      if (!stream.snapshot.blocks.length) this.streams.delete(streamKey);
    }
  }

  /** Ascending presentation order, newest page first. Count is native
   * messages (each <=256 projected blocks). A byte budget may return fewer
   * than limit. Cursor is scoped to this session, never accepted as a path. */
  private summaryPage(key: string, limit: number, before?: string, filesOnly = false): { messages: ClaudeStoredMessage[]; hasMore: boolean; before?: string; bytes: number } {
    if (!key.startsWith('claude-code:') || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw failure();
    const session = this.db.prepare(`SELECT native_session_id FROM sdk_agent_sessions
      WHERE runtime = 'claude-code' AND session_key = ?`).get(key) as { native_session_id: string } | undefined;
    if (!session) throw failure();
    let boundary = Number.MAX_SAFE_INTEGER;
    if (before !== undefined) {
      if (!/^[1-9][0-9]*$/.test(before) || !Number.isSafeInteger(Number(before))) throw failure();
      boundary = Number(before);
      if (!this.db.prepare('SELECT 1 FROM claude_transcript_messages WHERE session_key = ? AND sequence = ?').get(key, boundary)) throw failure();
    }
    const result: ClaudeStoredMessage[] = [];
    let bytes = 0, hasMore = false;
    // Iterate instead of .all(): do not allocate limit * worst-case-message
    // bytes before applying the page budget.
    for (const value of this.db.prepare(`SELECT sequence, execution_id, native_session_id, message_id, parent_id, data, created_at
      FROM claude_transcript_messages WHERE session_key = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?`)
      .iterate(key, boundary, limit + 1)) {
      const row = value as StoredRow;
      if (row.native_session_id !== session.native_session_id || !Number.isSafeInteger(row.sequence)
        || !Number.isSafeInteger(row.created_at) || row.created_at < 0) throw failure();
      const size = Buffer.byteLength(row.data);
      if (size > CLAUDE_TRANSCRIPT_PAGE_BYTES) throw failure();
      if (result.length >= limit || bytes + size > CLAUDE_TRANSCRIPT_PAGE_BYTES) { hasMore = true; break; }
      const rows = validateClaudeProjection(JSON.parse(row.data), row.message_id, row.parent_id || null);
      if (!rows.length) throw failure();
      result.push({ sessionKey: key, cursor: String(row.sequence), executionId: row.execution_id,
        nativeMessageId: row.message_id, createdAt: row.created_at, rows,
        ...(filesOnly ? { displayIds: this.displayIds(key, row.message_id) } : this.admissions(key, row.message_id)) });
      bytes += size;
    }
    result.reverse();
    return { messages: result, hasMore, bytes, ...(hasMore && result[0] ? { before: result[0].cursor } : {}) };
  }
  page(key: string, limit = 200, before?: string) {
    const { bytes: _bytes, ...page } = this.summaryPage(key, limit, before);
    return page;
  }
  /** Stable tool IDs without admission/detail lookup or full-history counts. */
  fileEvidencePage(key: string, before?: string) {
    const page = this.summaryPage(key, 20, before, true);
    return { messages: claudeChatMessages(key, page.messages), scanned: page.messages.length, bytes: page.bytes, before: page.before };
  }
}
import { SessionFileIndex } from '../messages/session-file-index.js';
import { claudeChatMessages } from './session-view.js';
