import type { DatabaseSync } from 'node:sqlite';
import { observedSavepoint } from '../storage/observed-savepoint.js';
import { ReadTimings } from '../storage/read-timings.js';
import { createHash } from 'node:crypto';
import { MAX_MESSAGE_CHARS, type ChatMessage } from '@agentopsdeck/shared';
import type { SdkExecution, SdkExecutionRef } from '../connector/sdk-execution-journal.js';
import { copilotMessageId, validateCopilotProjection, type CopilotProjectedMessage } from './message-projection.js';
import { validateCopilotStream, type CopilotTextStream } from './stream-projection.js';
import { COPILOT_TOOL_DETAIL_CHARS, validateCopilotToolDetail, type CopilotToolDetail } from './tool-details.js';
import { TranscriptCounts } from '../connector/transcript-counts.js';

export const COPILOT_TRANSCRIPT_PAGE_BYTES = 1_048_576;
const failure = () => new Error('Copilot transcript identity or persistence could not be confirmed');
type Stored = { sequence: number; native_session_id: string; data: string; admission_id: string | null; state?: string | null };

// Revalidate persisted/IPC data by positive selection, without accepting any
// worker-supplied admission IDs, public IDs or arbitrary ChatMessage. Optional
// file evidence is normalized separately; it never grants file access.
export function validateCopilotStoredProjection(input: CopilotProjectedMessage) {
  return validateCopilotProjection(input, {
    id: input.nativeEventId, type: input.role === 'tool'
      ? input.toolPhase === 'call' ? 'tool.execution_start' : 'tool.execution_complete' : `${input.role}.message`,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    data: { ...(input.parentToolCallId ? { parentToolCallId: input.parentToolCallId } : {}),
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      ...(input.toolPhase === 'result' ? { success: !input.toolError } : {}) },
  });
}

/** Durable, bounded display history; NOT native completion evidence. Reads
 * require separate route authorization. Uses the journal's owning database.
 * Raw tool results and native histories never enter this summary table. */
export class CopilotTranscriptStore {
  private readonly timings = new ReadTimings();
  readStats() { return this.timings.snapshot(); }
  private readonly counts: TranscriptCounts;
  private readonly fileIndex: SessionFileIndex;
  private readonly streams = new Map<string, { ref: SdkExecutionRef; message: ChatMessage }>();
  constructor(private readonly db: DatabaseSync, private readonly now = Date.now) {
    this.fileIndex = new SessionFileIndex(db);
    db.exec(`CREATE TABLE IF NOT EXISTS copilot_transcript_events (
      session_key TEXT NOT NULL, event_id TEXT NOT NULL, execution_id TEXT NOT NULL,
      native_session_id TEXT NOT NULL, data TEXT NOT NULL, root_user INTEGER NOT NULL,
      PRIMARY KEY(session_key, event_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS copilot_transcript_root_user
      ON copilot_transcript_events(session_key, execution_id) WHERE root_user = 1;
    CREATE TABLE IF NOT EXISTS copilot_transcript_messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_key TEXT NOT NULL,
      public_id TEXT NOT NULL, native_session_id TEXT NOT NULL, execution_id TEXT NOT NULL,
      event_id TEXT NOT NULL, admission_id TEXT, data TEXT NOT NULL,
      UNIQUE(session_key, public_id), UNIQUE(session_key, admission_id)
    );
    CREATE INDEX IF NOT EXISTS copilot_transcript_page ON copilot_transcript_messages(session_key, sequence);
    CREATE TABLE IF NOT EXISTS copilot_transcript_details (
      session_key TEXT NOT NULL, public_id TEXT NOT NULL, execution_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL, phase TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(session_key, public_id)
    );
    CREATE INDEX IF NOT EXISTS copilot_detail_call ON copilot_transcript_details(session_key, execution_id, tool_call_id, phase);`);
    this.counts = new TranscriptCounts(db, 'ghcp');
  }

  private execution(ref: SdkExecutionRef, stream = false) {
    const record = this.db.prepare(`SELECT data FROM sdk_agent_executions
      WHERE runtime = 'ghcp' AND session_key = ? ORDER BY sequence DESC LIMIT 1`).get(ref.key) as { data: string } | undefined;
    const execution = record && JSON.parse(record.data) as SdkExecution | undefined;
    if (!execution || execution.id !== ref.id || execution.epoch !== ref.epoch
      || !(stream ? ['dispatching', 'running'] : ['dispatching', 'running', 'settling']).includes(execution.phase)) throw failure();
    return execution;
  }

  append(ref: SdkExecutionRef, input: CopilotProjectedMessage, submittedText?: string, inputDetail?: CopilotToolDetail) {
    const row = validateCopilotStoredProjection(input), rootUser = row.role === 'user' && !row.agentId && !row.parentToolCallId;
    const detail = validateCopilotToolDetail(inputDetail, row);
    const publicId = copilotMessageId(ref.key, row, row.role, row.messageId ?? row.nativeEventId);
    observedSavepoint(this.db, 'copilot-transcript-append', () => {
      const execution = this.execution(ref), data = createHash('sha256').update(JSON.stringify(row)).digest('hex');
      const existing = this.db.prepare(`SELECT execution_id, native_session_id, data FROM copilot_transcript_events
        WHERE session_key = ? AND event_id = ?`).get(ref.key, row.nativeEventId) as
        { execution_id: string; native_session_id: string; data: string } | undefined;
      if (existing) {
        if (existing.execution_id !== ref.id || existing.native_session_id !== execution.nativeSessionId || existing.data !== data) throw failure();
        const saved = this.db.prepare('SELECT data FROM copilot_transcript_details WHERE session_key = ? AND public_id = ?')
          .get(ref.key, publicId) as { data: string } | undefined;
        if (saved?.data !== (detail ? JSON.stringify(detail) : undefined)) throw failure();
      } else {
        const base: ChatMessage = { id: publicId, sessionKey: ref.key, turnId: ref.id, role: row.role,
          text: row.text, createdAt: row.createdAt,
          ...(row.truncated ? { contentTruncated: true } : {}),
          ...(row.parentToolCallId ? { parentToolUseId: copilotMessageId(ref.key, row.agentId ? { agentId: row.agentId } : {}, 'tool-call', row.parentToolCallId) } : {}) };
        if (row.role === 'tool') Object.assign(base, {
          toolCallId: copilotMessageId(ref.key, row, 'tool-call', row.toolCallId!), toolPhase: row.toolPhase,
          ...(row.toolName ? { toolName: row.toolName } : {}), toolPreview: row.text,
          toolDetailAvailable: !!detail, ...(row.toolError ? { status: 'failed' } : {}),
          ...(row.toolPhase === 'result' && row.toolError === false ? { status: 'sent' as const,
            ...(row.sourceFiles?.length ? { sourceFiles: row.sourceFiles } : {}) } : {}),
        });
        let messages = [base];
        if (rootUser) {
          // submittedText is captured from the server's dispatch call, not IPC.
          if (row.truncated || submittedText === undefined || row.text !== submittedText
            || execution.nativeRequestId && execution.nativeRequestId !== row.messageId) throw failure();
          const texts = execution.batch ? row.text.split(execution.batch.separator) : [row.text];
          if (texts.length !== execution.members.length) throw failure();
          messages = texts.map((text, i) => ({ ...base, id: execution.members[i]!, text, status: 'sent' }));
        }
        this.db.prepare('INSERT INTO copilot_transcript_events VALUES (?, ?, ?, ?, ?, ?)')
          .run(ref.key, row.nativeEventId, ref.id, execution.nativeSessionId, data, rootUser ? 1 : 0);
        for (const message of messages) {
          const serialized = JSON.stringify(message);
          if (Buffer.byteLength(serialized) > COPILOT_TRANSCRIPT_PAGE_BYTES) throw failure();
          this.db.prepare(`INSERT INTO copilot_transcript_messages
            (session_key, public_id, native_session_id, execution_id, event_id, admission_id, data) VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(ref.key, message.id, execution.nativeSessionId, ref.id, row.nativeEventId, rootUser ? message.id : null, serialized);
        }
        this.fileIndex.append(ref.key, execution.nativeSessionId, messages);
        if (detail) this.db.prepare(`INSERT INTO copilot_transcript_details
          (session_key, public_id, execution_id, tool_call_id, phase, data) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(ref.key, publicId, ref.id, copilotMessageId(ref.key, row, 'tool-call', row.toolCallId!), row.toolPhase!, JSON.stringify(detail));
      }
    });
    this.streams.delete(publicId);
  }

  updateStream(ref: SdkExecutionRef, input: CopilotTextStream) {
    this.execution(ref, true);
    const snapshot = validateCopilotStream(input), id = copilotMessageId(ref.key, snapshot, 'assistant', snapshot.messageId);
    if (this.db.prepare('SELECT 1 FROM copilot_transcript_messages WHERE session_key = ? AND public_id = ?').get(ref.key, id)) throw failure();
    const previous = this.streams.get(id);
    if (previous && (previous.ref.id !== ref.id || previous.ref.epoch !== ref.epoch)) throw failure();
    if (!previous && this.streams.size >= 128) return false;
    const createdAt = previous?.message.createdAt ?? this.now();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw failure();
    this.streams.set(id, { ref: { ...ref }, message: { id, sessionKey: ref.key, turnId: ref.id, role: 'assistant',
      text: snapshot.text, createdAt, ...(snapshot.truncated ? { contentTruncated: true } : {}),
      ...(snapshot.parentToolCallId ? { parentToolUseId: copilotMessageId(ref.key, snapshot.agentId ? { agentId: snapshot.agentId } : {}, 'tool-call', snapshot.parentToolCallId) } : {}) } });
    return true;
  }
  endStreams(ref: SdkExecutionRef) {
    for (const [id, row] of this.streams) if (row.ref.key === ref.key && row.ref.id === ref.id && row.ref.epoch === ref.epoch) this.streams.delete(id);
  }
  liveMessages(key: string) { return [...this.streams.values()].filter(row => row.ref.key === key).map(row => ({ ...row.message })); }

  pendingPage(key: string, limit: number, waiting: boolean, before?: string) {
    if (!key.startsWith('ghcp:') || !Number.isSafeInteger(limit) || limit < 0 || limit > 200) throw failure();
    const visible = `runtime = 'ghcp' AND session_key = ? AND NOT EXISTS
      (SELECT 1 FROM copilot_transcript_messages a WHERE a.session_key = connector_turns.session_key AND a.admission_id = connector_turns.id)`;
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
      if (bytes + size > COPILOT_TRANSCRIPT_PAGE_BYTES) break;
      messages.unshift(message); bytes += size;
    }
    return { messages, totalCount, hiddenCount: count(boundary) - messages.length };
  }

  private read(row: Stored, key: string, nativeId: string): ChatMessage {
    if (row.native_session_id !== nativeId || Buffer.byteLength(row.data) > COPILOT_TRANSCRIPT_PAGE_BYTES) throw failure();
    const message = this.timings.parse(row.data) as ChatMessage;
    if (message.sessionKey !== key) throw failure();
    if (row.admission_id) message.status = row.state == null ? 'sent' : row.state === 'dispatching' ? 'sending' : 'outcome_unknown';
    return message;
  }
  private nativeId(key: string) {
    if (!key.startsWith('ghcp:')) throw failure();
    const session = this.db.prepare("SELECT native_session_id FROM sdk_agent_sessions WHERE runtime = 'ghcp' AND session_key = ?")
      .get(key) as { native_session_id: string } | undefined;
    if (!session) throw failure();
    return session.native_session_id;
  }
  message(key: string, publicId: string) {
    const nativeId = this.nativeId(key);
    const row = this.db.prepare(`SELECT m.*, t.state FROM copilot_transcript_messages m LEFT JOIN connector_turns t
      ON t.runtime = 'ghcp' AND t.session_key = m.session_key AND t.id = m.admission_id
      WHERE m.session_key = ? AND m.public_id = ?`).get(key, publicId) as Stored | undefined;
    return row && this.read(row, key, nativeId);
  }

  /** Only called after single-message route authorization. List reads never
   * query detail bodies. The execution and scoped tool ID prevent cross-turn
   * or child-agent input/result pairing. */
  toolDetail(key: string, publicId: string) {
    const message = this.message(key, publicId);
    if (message?.role !== 'tool' || !message.toolDetailAvailable) return;
    const read = (data: string) => {
      if (Buffer.byteLength(data) > COPILOT_TOOL_DETAIL_CHARS * 6 + 1024) throw failure();
      return validateCopilotToolDetail(JSON.parse(data), { role: 'tool' })!;
    };
    const row = this.db.prepare('SELECT * FROM copilot_transcript_details WHERE session_key = ? AND public_id = ?')
      .get(key, publicId) as { execution_id: string; tool_call_id: string; phase: string; data: string } | undefined;
    if (!row || row.execution_id !== message.turnId || row.tool_call_id !== message.toolCallId || row.phase !== message.toolPhase) throw failure();
    const detail = read(row.data);
    if (row.phase === 'result') {
      const calls = this.db.prepare(`SELECT data FROM copilot_transcript_details
        WHERE session_key = ? AND execution_id = ? AND tool_call_id = ? AND phase = 'call' LIMIT 2`)
        .all(key, row.execution_id, row.tool_call_id) as { data: string }[];
      if (calls.length === 1) {
        const call = read(calls[0]!.data), text = `Input\n${call.text}\n\nResult\n${detail.text}`;
        return { text: text.slice(0, COPILOT_TOOL_DETAIL_CHARS),
          truncated: call.truncated || detail.truncated || text.length > COPILOT_TOOL_DETAIL_CHARS };
      }
    }
    return detail;
  }
  /** Bounded summary-only scan: no COUNT, details lookup or native history I/O. */
  fileEvidencePage(key: string, before?: string) {
    const nativeId = this.nativeId(key);
    let boundary = Number.MAX_SAFE_INTEGER;
    if (before !== undefined) {
      if (!/^[1-9][0-9]*$/.test(before) || !Number.isSafeInteger(Number(before))) throw failure();
      boundary = Number(before);
    }
    const messages: ChatMessage[] = [];
    let bytes = 0, hasMore = false, cursor: string | undefined;
    for (const value of this.timings.rows(this.db.prepare(`SELECT m.*, t.state FROM copilot_transcript_messages m LEFT JOIN connector_turns t
      ON t.runtime = 'ghcp' AND t.session_key = m.session_key AND t.id = m.admission_id
      WHERE m.session_key = ? AND m.sequence < ? ORDER BY m.sequence DESC LIMIT 21`).iterate(key, boundary))) {
      const row = value as Stored & { sequence: number };
      const size = Buffer.byteLength(row.data);
      if (size > COPILOT_TRANSCRIPT_PAGE_BYTES) throw failure();
      if (messages.length >= 20 || bytes + size > COPILOT_TRANSCRIPT_PAGE_BYTES) { hasMore = true; break; }
      messages.unshift(this.read(row, key, nativeId)); bytes += size; cursor = String(row.sequence);
    }
    return { messages, bytes, scanned: messages.length, ...(hasMore ? { before: cursor } : {}) };
  }

  page(key: string, limit = 200, before?: string) {
    const nativeId = this.nativeId(key);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw failure();
    let boundary = Number.MAX_SAFE_INTEGER;
    if (before !== undefined) {
      const row = this.db.prepare('SELECT sequence FROM copilot_transcript_messages WHERE session_key = ? AND public_id = ?')
        .get(key, before) as { sequence: number } | undefined;
      if (!row) return;
      boundary = row.sequence;
    }
    const totalCount = this.counts.count(key), endCount = before === undefined ? totalCount : this.counts.count(key, boundary);
    let bytes = 0;
    const messages: ChatMessage[] = [];
    for (const value of this.timings.rows(this.db.prepare(`SELECT m.*, t.state FROM copilot_transcript_messages m LEFT JOIN connector_turns t
      ON t.runtime = 'ghcp' AND t.session_key = m.session_key AND t.id = m.admission_id
      WHERE m.session_key = ? AND m.sequence < ? ORDER BY m.sequence DESC LIMIT ?`).iterate(key, boundary, limit))) {
      const message = this.read(value as Stored, key, nativeId), size = Buffer.byteLength(JSON.stringify(message));
      if (bytes + size > COPILOT_TRANSCRIPT_PAGE_BYTES) break;
      messages.unshift(message); bytes += size;
    }
    return { messages, totalCount, hiddenCount: endCount - messages.length };
  }
}
import { SessionFileIndex } from '../messages/session-file-index.js';
